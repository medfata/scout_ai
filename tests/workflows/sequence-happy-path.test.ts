import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SequenceResult } from "@/src/workflows/sequence";
import { closeTestDatabase, hasDatabase, resetDatabase } from "../setup/db";
import {
  PACING_TOLERANCE_MS,
  addDays,
  advance,
  cancelRun,
  closeGoogle,
  createGoogleFake,
  expectAround,
  listenToGoogle,
  seedSequence,
  startSequence,
  waitForEnrollmentStatus,
  waitForMessageStatus,
  waitForSleepTarget,
  type SequenceRun,
} from "./harness";

/**
 * Phase 5 gate, scenario 1: "No reply → email 1, then day 3, 7 and 14 follow-ups;
 * enrollment `completed`" (docs/review-2026-09-25.md, section A).
 *
 * The LinkedIn steps are ineligible in v1 (assisted mode), so the run skips them without a
 * wake; the four email steps are pre-created as approved drafts so the test never calls a
 * model. Every wake is time travel: the sleep targets are asserted before they are skipped.
 */

const databaseAvailable = await hasDatabase();

describe.skipIf(!databaseAvailable)("sequence workflow: no reply", () => {
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

  it("sends email 1 then the day 3, 7 and 14 follow-ups and completes", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ startedAt: new Date() });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    // Day 0: email 1.
    await advance(run.runId, seed.enrollment.id);
    const email1 = await waitForMessageStatus(seed.enrollment.id, 0, "sent");

    // Day 3: follow-up 1. Its target is measured from email 1's sentAt (review item B1).
    const day3Target = await waitForSleepTarget(
      run.runId,
      (at) => Math.abs(at.getTime() - addDays(email1.sentAt!, 3).getTime()) <= PACING_TOLERANCE_MS,
    );
    expectAround(day3Target, addDays(email1.sentAt!, 3));
    await advance(run.runId, seed.enrollment.id);
    await waitForMessageStatus(seed.enrollment.id, 3, "sent");

    // Day 7: follow-up 2, still measured from email 1.
    const day7Target = await waitForSleepTarget(
      run.runId,
      (at) => Math.abs(at.getTime() - addDays(email1.sentAt!, 7).getTime()) <= PACING_TOLERANCE_MS,
    );
    expectAround(day7Target, addDays(email1.sentAt!, 7));
    await advance(run.runId, seed.enrollment.id);
    await waitForMessageStatus(seed.enrollment.id, 4, "sent");

    // Day 14: the polite close.
    const day14Target = await waitForSleepTarget(
      run.runId,
      (at) => Math.abs(at.getTime() - addDays(email1.sentAt!, 14).getTime()) <= PACING_TOLERANCE_MS,
    );
    expectAround(day14Target, addDays(email1.sentAt!, 14));
    await advance(run.runId, seed.enrollment.id);
    await waitForMessageStatus(seed.enrollment.id, 5, "sent");

    const result: SequenceResult = await run.returnValue;
    expect(result).toEqual({ status: "completed", reason: "sequence_finished" });
    await waitForEnrollmentStatus(seed.enrollment.id, "completed");

    // Four emails left, one per email step, all through the one guarded send path.
    expect(google.sendCalls).toHaveLength(4);
  });

  it("carries In-Reply-To and References on every follow-up", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ startedAt: new Date() });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    await advance(run.runId, seed.enrollment.id);
    const email1 = await waitForMessageStatus(seed.enrollment.id, 0, "sent");

    await advance(run.runId, seed.enrollment.id);
    await waitForMessageStatus(seed.enrollment.id, 3, "sent");

    const followUpRaw = decodeRaw(google.sendCalls[1]?.raw ?? "");
    expect(followUpRaw).toContain(`In-Reply-To: ${email1.rfcMessageId}`);
    expect(followUpRaw).toContain(`References: ${email1.rfcMessageId}`);
  });
});

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}
