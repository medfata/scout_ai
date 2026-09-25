import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/src/db/client";
import { sendCounters } from "@/src/db/schema";
import { updateSettings } from "@/src/services/settings";
import { getSendCounters } from "@/src/services/quota";
import { wakeParkedRuns } from "@/src/services/enrollment";
import { dateOnlyInZone } from "@/src/lib/time-windows";
import type { SequenceResult } from "@/src/workflows/sequence";
import { seedSendCounters } from "../factories";
import { closeTestDatabase, hasDatabase, resetDatabase } from "../setup/db";
import {
  PACING_TOLERANCE_MS,
  addDays,
  advance,
  cancelRun,
  closeGoogle,
  createGoogleFake,
  driveUntil,
  getEnrollment,
  getMessageForStep,
  listenToGoogle,
  seedSequence,
  startSequence,
  waitFor,
  waitForMessageStatus,
  waitForPendingSleep,
  waitForSleepTarget,
  type SequenceRun,
} from "./harness";

/**
 * Phase 5 gate, scenarios 6, 7 and 8 (docs/review-2026-09-25.md, section A):
 *
 *  6. starting the same enrollment twice → one run exits `duplicate_run`, one email sent;
 *  7. kill switch on then off → pauses, resumes, sends exactly once;
 *  8. daily cap full → email 1 slips a day and the day-3 follow-up keeps its spacing
 *     (review item B1: measured from email 1's sentAt, not from `started_at`).
 */

const databaseAvailable = await hasDatabase();

describe.skipIf(!databaseAvailable)("sequence workflow: run and guard edges", () => {
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

  it("lets one of two runs win and the other exit as duplicate_run", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({});
    const first = await startSequence(seed.enrollment.id);
    runs.push(first);
    // The lead hook is registered before the first sleep, so the second run sees it.
    await waitForPendingSleep(first.runId);

    const second = await startSequence(seed.enrollment.id);
    runs.push(second);

    const duplicate: SequenceResult = await second.returnValue;
    expect(duplicate).toEqual({ status: "stopped", reason: "duplicate_run" });

    // The losing run must not have touched the enrollment.
    const untouched = await getEnrollment(seed.enrollment.id);
    expect(untouched.status).toBe("active");
    expect(untouched.currentStep).toBe(0);

    await advance(first.runId, seed.enrollment.id);
    await waitForMessageStatus(seed.enrollment.id, 0, "sent");
    expect(google.sendCalls).toHaveLength(1);
  });

  it("pauses on the kill switch, resumes when it goes off, and sends exactly once", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ settings: { killSwitch: true } });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    // First slot: the guard blocks and the run parks until the next window.
    await advance(run.runId, seed.enrollment.id);
    await waitFor(async () => ((await getEnrollment(seed.enrollment.id)).nextActionAt ? true : null), "the run to park");
    expect(google.sendCalls).toHaveLength(0);

    // The owner turns the kill switch off; the settings path wakes parked runs.
    await updateSettings({ killSwitch: false });
    const woken = await wakeParkedRuns("kill_switch_off");
    expect(woken.resumed).toBe(1);

    await driveUntil(
      run.runId,
      seed.enrollment.id,
      async () => (await getMessageForStep(seed.enrollment.id, 0)).status === "sent",
    );
    expect(google.sendCalls).toHaveLength(1);

    // The counters were consumed exactly once for the one send.
    const today = dateOnlyInZone(new Date(), "UTC");
    const counters = await getSendCounters(seed.accountId!, today);
    expect(counters).toEqual({ new: 1, total: 1 });
  });

  it("slips email 1 past a full daily cap and keeps the day-3 follow-up three days after it", { timeout: 240_000 }, async () => {
    // The enrollment was approved two days ago; the cap kept email 1 from leaving. That
    // gap is exactly what review item B1 protects: today's code would schedule the "day 3"
    // follow-up for tomorrow, only one day after the email that finally went out.
    const startedAt = addDays(new Date(), -2);
    const seed = await seedSequence({ startedAt, warmupStage: 1 });
    if (!seed.accountId) throw new Error("seed did not create a mailbox");
    await seedSendCounters(seed.accountId, dateOnlyInZone(new Date(), "UTC"), { new: 5, total: 5 });

    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    // First wake: the cap blocks, so the run parks at the next counter day.
    await advance(run.runId, seed.enrollment.id);
    await waitForSleepTarget(run.runId, (at) => at.getTime() > Date.now() + 60 * 60 * 1000);
    expect(google.sendCalls).toHaveLength(0);

    // The next counter day arrives (the test frees today's counter and time-travels).
    await getDb().delete(sendCounters).where(eq(sendCounters.accountId, seed.accountId));
    await driveUntil(
      run.runId,
      seed.enrollment.id,
      async () => (await getMessageForStep(seed.enrollment.id, 0)).status === "sent",
    );
    const email1 = await waitForMessageStatus(seed.enrollment.id, 0, "sent");

    // Review item B1: the day-3 target is email 1's sentAt + 3 days, not startedAt + 3.
    const day3Target = await waitForSleepTarget(
      run.runId,
      (at) => Math.abs(at.getTime() - addDays(email1.sentAt!, 3).getTime()) <= PACING_TOLERANCE_MS,
    );
    expect(day3Target.getTime()).toBeGreaterThan(addDays(startedAt, 3).getTime() + 12 * 60 * 60 * 1000);

    await driveUntil(
      run.runId,
      seed.enrollment.id,
      async () => (await getMessageForStep(seed.enrollment.id, 3)).status === "sent",
    );
    const followUp = await waitForMessageStatus(seed.enrollment.id, 3, "sent");
    expect(followUp.sentAt!.getTime()).toBeGreaterThan(email1.sentAt!.getTime());
    expect(google.sendCalls).toHaveLength(2);
  });
});
