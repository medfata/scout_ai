import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CAPS } from "@/src/domain";
import { wakeParkedRuns } from "@/src/services/enrollment";
import { parkReasonsClearedByPatch, updateSettings } from "@/src/services/settings";
import { createContact, createEnrollment, createIcp } from "../factories";
import { closeTestDatabase, hasDatabase, resetDatabase } from "../setup/db";
import {
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
  type SequenceRun,
} from "./harness";

/**
 * Review stage 1, item 2: `wakeParkedRuns` is reason-aware. A park records why it is
 * parked (`enrollments.parked_reason`), and only a change that clears that reason may wake
 * the run — saving caps must not wake a run parked on a missing signature. The walk is
 * keyset-paged so more than one page of parked runs is still woken.
 *
 * `updateSettings` schedules the wake through `after()`, which has no request scope in a
 * workflow test, so the tests below call `wakeParkedRuns` with the exact reasons the
 * settings path would pass. The settings path's reason computation itself is covered by
 * the `parkReasonsClearedByPatch` cases at the bottom.
 */

const databaseAvailable = await hasDatabase();

describe.skipIf(!databaseAvailable)("parked runs wake only for the reason that cleared", () => {
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

  it("wakes a kill_switch park when the kill switch goes off, and sends once", { timeout: 240_000 }, async () => {
    const seed = await seedSequence({ settings: { killSwitch: true } });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    // First slot: the guard blocks and the park records its reason.
    await advance(run.runId, seed.enrollment.id);
    const parked = await waitForParked(seed.enrollment.id, "kill_switch");
    expect(parked.nextActionAt).not.toBeNull();
    expect(google.sendCalls).toHaveLength(0);

    // A change for a different park must not touch it.
    const wrong = await wakeParkedRuns("mailbox_reconnected");
    expect(wrong).toEqual({ checked: 0, resumed: 0 });
    expect((await getEnrollment(seed.enrollment.id)).parkedReason).toBe("kill_switch");
    expect(google.sendCalls).toHaveLength(0);

    // The owner turns the kill switch off. In production `updateSettings` schedules this
    // wake through `after()`; the test delivers the same reason directly.
    await updateSettings({ killSwitch: false });
    const woken = await wakeParkedRuns("kill_switch_off");
    expect(woken.resumed).toBe(1);

    await driveUntil(
      run.runId,
      seed.enrollment.id,
      async () => (await getMessageForStep(seed.enrollment.id, 0)).status === "sent",
    );
    expect(google.sendCalls).toHaveLength(1);
    expect((await getEnrollment(seed.enrollment.id)).parkedReason).toBeNull();
  });

  it("leaves a config_incomplete park parked until the identity save clears it", { timeout: 240_000 }, async () => {
    // Section 7 rule 0 / review item 18: signature and postal address missing blocks every
    // send; the run parks on `config_incomplete`.
    const seed = await seedSequence({ settings: { signature: "", postalAddress: "" } });
    const run = await startSequence(seed.enrollment.id);
    runs.push(run);

    await advance(run.runId, seed.enrollment.id);
    await waitForParked(seed.enrollment.id, "config_incomplete");
    expect(google.sendCalls).toHaveLength(0);

    // Saving caps is unrelated to the missing identity: nothing may be woken.
    await updateSettings({ caps: { ...DEFAULT_CAPS, emailNew: 3 } });
    expect((await getEnrollment(seed.enrollment.id)).parkedReason).toBe("config_incomplete");
    expect((await getMessageForStep(seed.enrollment.id, 0)).status).toBe("approved");
    expect(google.sendCalls).toHaveLength(0);

    // A wake for another reason must not pick it up either.
    const wrong = await wakeParkedRuns(["kill_switch"]);
    expect(wrong).toEqual({ checked: 0, resumed: 0 });
    expect((await getEnrollment(seed.enrollment.id)).parkedReason).toBe("config_incomplete");

    // Filling both fields is what clears the park (the same reasons `updateSettings` passes).
    await updateSettings({ signature: "— Scout Test Owner", postalAddress: "1 Test Street, Testville" });
    const woken = await wakeParkedRuns(["config_incomplete"]);
    expect(woken.resumed).toBe(1);

    await driveUntil(
      run.runId,
      seed.enrollment.id,
      async () => (await getMessageForStep(seed.enrollment.id, 0)).status === "sent",
    );
    expect(google.sendCalls).toHaveLength(1);
  });

  it("wakes past the first page of 200 parked enrollments", { timeout: 120_000 }, async () => {
    // Rows without a workflow run still prove the walk visits every page: a single
    // `limit(200)` would report 200 and leave the 201st parked.
    const contact = await createContact();
    const icp = await createIcp();
    for (let index = 0; index < 201; index += 1) {
      await createEnrollment({
        contactId: contact.id,
        icpId: icp.id,
        sequenceKey: `page_test_${index}`,
        status: "waiting",
        parkedReason: "kill_switch",
        nextActionAt: new Date(),
      });
    }

    const woken = await wakeParkedRuns(["kill_switch"]);
    expect(woken.checked).toBe(201);
    // No runs exist for these rows, so every resume reports "no sleeping sequence".
    expect(woken.resumed).toBe(0);
  });
});

/**
 * The settings half of review stage 1, item 2: only a real transition clears a park, so an
 * unrelated save passes an empty reason list and `wakeParkedRuns` is never scheduled.
 */
describe("parkReasonsClearedByPatch", () => {
  const identity = { signature: "— Scout Test Owner", postalAddress: "1 Test Street, Testville" };
  const incomplete = { signature: "", postalAddress: "" };

  it("returns config_incomplete only when the identity became complete", () => {
    expect(parkReasonsClearedByPatch({ ...incomplete, killSwitch: false }, { ...identity, killSwitch: false })).toEqual([
      "config_incomplete",
    ]);
    expect(parkReasonsClearedByPatch({ ...identity, killSwitch: false }, { ...incomplete, killSwitch: false })).toEqual([]);
    // Only one field missing is still incomplete: there is nothing to clear yet.
    expect(
      parkReasonsClearedByPatch(
        { ...incomplete, killSwitch: false },
        { signature: "— Scout Test Owner", postalAddress: "", killSwitch: false },
      ),
    ).toEqual([]);
  });

  it("returns kill_switch only when the switch goes on to off", () => {
    expect(parkReasonsClearedByPatch({ ...identity, killSwitch: true }, { ...identity, killSwitch: false })).toEqual([
      "kill_switch",
    ]);
    expect(parkReasonsClearedByPatch({ ...identity, killSwitch: false }, { ...identity, killSwitch: true })).toEqual([]);
    // The caps save that parks stay parked: no reason is cleared.
    expect(parkReasonsClearedByPatch({ ...identity, killSwitch: false }, { ...identity, killSwitch: false })).toEqual([]);
  });
});

/** Waits until the workflow has written the park reason the test expects. */
async function waitForParked(enrollmentId: string, parkedReason: string) {
  return waitFor(
    async () => {
      const enrollment = await getEnrollment(enrollmentId);
      return enrollment.parkedReason === parkedReason ? enrollment : null;
    },
    `enrollment to park on ${parkedReason}`,
  );
}
