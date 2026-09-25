import { getRun } from "workflow/api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { approveMessage } from "@/src/services/messages";
import { resumeApproval } from "@/src/services/hooks";
import type { SequenceResult } from "@/src/workflows/sequence";
import { closeTestDatabase, hasDatabase, resetDatabase } from "../setup/db";
import {
  addDays,
  advance,
  cancelRun,
  closeGoogle,
  createGoogleFake,
  getMessageForStep,
  listenToGoogle,
  resumeApprovalWhenReady,
  seedSequence,
  startSequence,
  waitForApprovalHook,
  waitForEnrollmentStatus,
  waitForMessageStatus,
  waitForPendingSleep,
  type SequenceRun,
} from "./harness";

/**
 * Phase 5 gate, scenario 5: "Approval: approve before the hook exists, approve while
 * waiting, expire after 3 days, approve after expiry (sends), reject; a first-touch expiry
 * stops the enrollment" (docs/review-2026-09-25.md, section A).
 *
 * The sleep in the approval race *is* the 3-day window (`APPROVAL_WINDOW`), so waking it
 * is time travel past the window. A real Approve/Reject click writes the message row and
 * resumes the hook; `resumeApprovalWhenReady` waits for the hook registration first, except
 * in the one test that deliberately approves before the run exists.
 */

const databaseAvailable = await hasDatabase();

describe.skipIf(!databaseAvailable)("sequence workflow: approval", () => {
  const google = createGoogleFake();
  const runs: SequenceRun[] = [];

  beforeAll(() => listenToGoogle(google));
  beforeEach(async () => {
    await resetDatabase();
    runs.length = 0;
  });
  afterEach(async () => {
    for (const run of runs) await cancelRun(run.runId);
    google.reset();
  });
  afterAll(async () => {
    closeGoogle(google);
    await closeTestDatabase();
  });

  it("sends when the owner approved before the run started (deliberately no hook to resume)", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ messageStatus: { 0: "pending_approval" } });
    const message = seed.messages.get(0);
    if (!message) throw new Error("seed did not create step 0");

    // This is the one test that must NOT wait for a hook: the approval happens before the
    // run exists, so `resumeApproval` fails with "Hook not found" by design. The database
    // status is the source of truth and the sequencer's post-registration re-check must
    // find it (review item 3). Do not "fix" this by adding `waitForHook`.
    await approveMessage(message.id);
    const earlyResume = await resumeApproval(seed.enrollment.id, 0, true);
    expect(earlyResume.resumed).toBe(false);

    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    await advance(run.runId, seed.enrollment.id);
    await waitForMessageStatus(seed.enrollment.id, 0, "sent");
    expect(google.sendCalls).toHaveLength(1);
  });

  it("sends after the owner approves while the run waits on the hook", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ messageStatus: { 0: "pending_approval" } });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    await advance(run.runId, seed.enrollment.id);

    // Pin the state under test first: the sequencer must be parked in the approval race.
    // Approving before this point would make `prepareStep` see an `approved` message, send
    // it without ever creating the hook, and this test would wait forever.
    await waitForApprovalHook(run, seed.enrollment.id, 0);

    // The inbox's Approve action writes the message status and wakes the hook (see
    // app/(app)/inbox/actions.ts); both are required for the send to pass the guard.
    const message = seed.messages.get(0);
    if (!message) throw new Error("seed did not create step 0");
    await approveMessage(message.id);
    const result = await resumeApprovalWhenReady(run, seed.enrollment.id, 0, true);
    expect(result.resumed).toBe(true);

    await waitForMessageStatus(seed.enrollment.id, 0, "sent");
    expect(google.sendCalls).toHaveLength(1);

    // The sequence advances to the LinkedIn step; the first touch is the anchor.
    const enrollment = await waitForEnrollmentStatus(seed.enrollment.id, "waiting");
    expect(enrollment.currentStep).toBe(1);
  });

  it("skips the draft and stops the enrollment when the first touch expires", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ messageStatus: { 0: "pending_approval" } });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    await advance(run.runId, seed.enrollment.id);
    await waitForApprovalHook(run, seed.enrollment.id, 0);
    const window = await waitForPendingSleep(run.runId);

    await getRun(run.runId).wakeUp({ correlationIds: [window.correlationId] });

    const result: SequenceResult = await run.returnValue;
    expect(result).toEqual({ status: "stopped", reason: "approval_expired" });
    expect((await getMessageForStep(seed.enrollment.id, 0)).status).toBe("skipped");
    await waitForEnrollmentStatus(seed.enrollment.id, "stopped");
    expect(google.sendCalls).toHaveLength(0);
  });

  it("sends a first touch approved after the window expired", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ messageStatus: { 0: "pending_approval" } });
    const message = seed.messages.get(0);
    if (!message) throw new Error("seed did not create step 0");

    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    await advance(run.runId, seed.enrollment.id);
    await waitForApprovalHook(run, seed.enrollment.id, 0);
    const window = await waitForPendingSleep(run.runId);

    // The window lapses, but the inbox approval beat the sequencer's final read.
    await approveMessage(message.id);
    await getRun(run.runId).wakeUp({ correlationIds: [window.correlationId] });

    await waitForMessageStatus(seed.enrollment.id, 0, "sent");
    expect(google.sendCalls).toHaveLength(1);
  });

  it("stops the enrollment when the owner rejects the first touch", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ messageStatus: { 0: "pending_approval" } });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    await advance(run.runId, seed.enrollment.id);

    await resumeApprovalWhenReady(run, seed.enrollment.id, 0, false);

    const result: SequenceResult = await run.returnValue;
    expect(result).toEqual({ status: "stopped", reason: "approval_rejected" });
    expect((await getMessageForStep(seed.enrollment.id, 0)).status).toBe("skipped");
    await waitForEnrollmentStatus(seed.enrollment.id, "stopped");
    expect(google.sendCalls).toHaveLength(0);
  });

  it("skips an expired follow-up and keeps the sequence moving", { timeout: 240_000 }, async () => {
    const startedAt = addDays(new Date(), -1);
    const seed = await seedSequence({
      startedAt,
      currentStep: 3,
      sent: [{ step: 0, sentAt: startedAt }],
      messageStatus: { 3: "pending_approval" },
    });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    // The run reaches the day-3 step and waits for approval on it.
    await advance(run.runId, seed.enrollment.id);
    await waitForApprovalHook(run, seed.enrollment.id, 3);
    const window = await waitForPendingSleep(run.runId);

    await getRun(run.runId).wakeUp({ correlationIds: [window.correlationId] });
    const expired = await waitForMessageStatus(seed.enrollment.id, 3, "skipped");

    expect(expired.status).toBe("skipped");

    // A follow-up expiry is not terminal: the day-7 email still goes out.
    await advance(run.runId, seed.enrollment.id);
    await waitForMessageStatus(seed.enrollment.id, 4, "sent");
    const enrollment = await waitForEnrollmentStatus(seed.enrollment.id, "waiting");
    expect(enrollment.status).toBe("waiting");
  });
});
