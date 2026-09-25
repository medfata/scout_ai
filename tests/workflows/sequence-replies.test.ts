import { addBusinessDaysToDateOnly } from "@/src/domain";
import { instantForDateOnly } from "@/src/lib/time-windows";
import { createEnrollment as enrollLead } from "@/src/services/enrollment";
import { isContactSuppressed } from "@/src/services/leads";
import { handleInboundReply } from "@/src/services/reply-handling";
import { getSettings } from "@/src/services/settings";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SequenceResult } from "@/src/workflows/sequence";
import { createInboundMessage, createMessage } from "../factories";
import { closeTestDatabase, hasDatabase, resetDatabase } from "../setup/db";
import {
  PACING_TOLERANCE_MS,
  addDays,
  advance,
  cancelRun,
  closeGoogle,
  createGoogleFake,
  expectAround,
  getMessageForStep,
  listenToGoogle,
  releasePacing,
  resumeLeadEventWhenReady,
  seedSequence,
  startSequence,
  waitForApprovalHook,
  waitForEnrollmentStatus,
  waitForLeadHook,
  waitForMessageStatus,
  waitForNextActionAt,
  waitForSleepTarget,
  wakeAllSleeps,
  type SequenceRun,
} from "./harness";

/**
 * Phase 5 gate, scenarios 2, 3, 4 and 9 (docs/review-2026-09-25.md, section A):
 *
 *  2. reply on day 5 → nothing after it; enrollment `replied`;
 *  3. out-of-office with a return date → next send is return date + 1 business day;
 *  4. opt-out → suppressed, stopped, and a new enrollment for that email is refused;
 *  9. reply arrives while waiting for approval → the approval race ends and the sequence
 *     stops.
 *
 * The lead events are injected through `resumeLeadEventWhenReady`, the same hook the reply
 * workflow uses, so no classifier (and no model call) is involved. Waiting for the hook
 * first is what keeps the event from racing the workflow's hook registration.
 */

const databaseAvailable = await hasDatabase();

describe.skipIf(!databaseAvailable)("sequence workflow: replies and opt-outs", () => {
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

  it("stops everything and marks the enrollment replied when a reply lands on day 5", { timeout: 240_000 }, async () => {
    const startedAt = addDays(new Date(), -6);
    const email1At = startedAt;
    const seed = await seedSequence({
      startedAt,
      currentStep: 4,
      sent: [
        { step: 0, sentAt: email1At },
        { step: 3, sentAt: addDays(startedAt, 3) },
      ],
    });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    // The run is sleeping on the day-7 follow-up when the reply arrives (day 5).
    await waitForSleepTarget(
      run.runId,
      (at) => Math.abs(at.getTime() - addDays(email1At, 7).getTime()) <= PACING_TOLERANCE_MS,
    );

    await resumeLeadEventWhenReady(run, seed.enrollment.id, { type: "reply", intent: "interested" });

    const result: SequenceResult = await run.returnValue;
    expect(result.status).toBe("stopped");
    expect(result.reason).toContain("reply:interested");
    await waitForEnrollmentStatus(seed.enrollment.id, "replied");

    // Nothing after the reply: the day-7 and day-14 drafts stay untouched.
    expect((await getMessageForStep(seed.enrollment.id, 4)).status).toBe("approved");
    expect((await getMessageForStep(seed.enrollment.id, 5)).status).toBe("approved");
    expect(google.sendCalls).toHaveLength(0);
  });

  it("reschedules an out-of-office reply to the return date plus one business day", { timeout: 240_000 }, async () => {
    const startedAt = addDays(new Date(), -1);
    const email1At = startedAt;
    const seed = await seedSequence({ startedAt, currentStep: 3, sent: [{ step: 0, sentAt: email1At }] });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    await waitForSleepTarget(
      run.runId,
      (at) => Math.abs(at.getTime() - addDays(email1At, 3).getTime()) <= PACING_TOLERANCE_MS,
    );

    // A Friday return date makes the business-day rule visible: the next send is Monday.
    const returnDate = nextFriday();
    const notBefore = addBusinessDaysToDateOnly(returnDate, 1);
    const settings = await getSettings();
    const expectedAt = instantForDateOnly(notBefore, settings.sendingWindows.email.start, settings.timezone);

    await resumeLeadEventWhenReady(run, seed.enrollment.id, { type: "reply", intent: "out_of_office", returnDate });

    await waitForNextActionAt(seed.enrollment.id, expectedAt);
    const rescheduled = await waitForSleepTarget(
      run.runId,
      (at) => Math.abs(at.getTime() - expectedAt.getTime()) <= PACING_TOLERANCE_MS,
    );
    expectAround(rescheduled, expectedAt);

    // Time travel to the rescheduled slot: the next follow-up sends.
    await releasePacing(seed.enrollment.id);
    await wakeAllSleeps(run.runId);
    const followUp = await waitForMessageStatus(seed.enrollment.id, 3, "sent");
    expect(followUp.sentAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("suppresses and stops an opt-out, and a new enrollment for that email is refused", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ startedAt: addDays(new Date(), -1), currentStep: 3, sent: [{ step: 0, sentAt: addDays(new Date(), -1) }] });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    // The run must be live and past its hook registration before the reply workflow stops
    // the enrollment: otherwise `loadPlanStep` sees `stopped` and the run ends without
    // ever creating the hook the opt-out event is delivered to.
    await waitForLeadHook(run, seed.enrollment.id);

    // The reply workflow's routing half: classify (pre-set here), then code routes.
    const inbound = await createInboundMessage({
      contactId: seed.contact.id,
      enrollmentId: seed.enrollment.id,
      intent: "unsubscribe",
      fromEmail: seed.contact.email,
    });
    const handled = await handleInboundReply({ messageId: inbound.id });
    expect(handled.suppressed).toBe(true);
    expect(handled.stopped).toBe(true);

    // The sleeping sequence then wakes on the opt-out event and ends.
    await resumeLeadEventWhenReady(run, seed.enrollment.id, { type: "optout" });
    const result: SequenceResult = await run.returnValue;
    expect(result.status).toBe("stopped");
    await waitForEnrollmentStatus(seed.enrollment.id, "stopped");

    expect(await isContactSuppressed({ email: seed.contact.email, companyDomain: null, linkedinUrl: null })).toBe(true);

    // A fresh enrollment for the same person must not send a single message.
    const second = await enrollLead({
      contactId: seed.contact.id,
      icpId: seed.icpId,
      angle: null,
      needsApproval: false,
    });
    await createMessage({ enrollmentId: second.id, contactId: seed.contact.id, step: 0, status: "approved" });
    const secondRun = await startSequence(second.id);
    runs.push(secondRun);

    await advance(secondRun.runId, second.id);
    const refused: SequenceResult = await secondRun.returnValue;
    expect(refused).toEqual({ status: "stopped", reason: "suppressed" });
    await waitForEnrollmentStatus(second.id, "stopped");
    expect(google.sendCalls).toHaveLength(0);
  });

  it("ends the approval race and stops when a reply arrives while waiting for approval", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ messageStatus: { 0: "pending_approval" } });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    // The day-0 slot fires first; the approval race comes after it.
    await advance(run.runId, seed.enrollment.id);

    // Pin the "while waiting for approval" state, then deliver the reply on the lead
    // hook, which the helper waits for before resuming.
    await waitForApprovalHook(run, seed.enrollment.id, 0);
    await resumeLeadEventWhenReady(run, seed.enrollment.id, { type: "reply", intent: "meeting_request" });

    const result: SequenceResult = await run.returnValue;
    expect(result.status).toBe("stopped");
    expect(result.reason).toContain("reply:meeting_request");
    await waitForEnrollmentStatus(seed.enrollment.id, "replied");

    // The unapproved draft stays in the inbox; the reply stopped it, nothing was sent.
    expect((await getMessageForStep(seed.enrollment.id, 0)).status).toBe("pending_approval");
    expect(google.sendCalls).toHaveLength(0);
  });
});

/** The next Friday at least a week out, so the return date is always in the future. */
function nextFriday(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7);
  while (date.getUTCDay() !== 5) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
