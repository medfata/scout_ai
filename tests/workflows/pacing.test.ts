import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/src/db/client";
import { messages, type Contact, type Enrollment, type Message } from "@/src/db/schema";
import type { SendingWindow } from "@/src/domain/types";
import { isWithinWindow } from "@/src/lib/time-windows";
import { getSendCounters } from "@/src/services/quota";
import {
  configureSettings,
  createContact,
  createEmailAccount,
  createEnrollment,
  createIcp,
  createMessage,
} from "../factories";
import { closeTestDatabase, hasDatabase, resetDatabase } from "../setup/db";
import {
  cancelRun,
  closeGoogle,
  createGoogleFake,
  delay,
  getMessageForStep,
  listenToGoogle,
  startSequence,
  wakeAllSleeps,
  type SequenceRun,
} from "./harness";

/**
 * Review item 1: stale pacing slots, end to end.
 *
 * Ten approved first touches share one mailbox on warmup week 1 (section 7: five new
 * conversations and five sends a day). The sending window closes while the queue is still
 * being paced, so most messages reserved a slot beyond it and are blocked by
 * `sending_window`; some are blocked by `daily_cap`. The next morning every blocked message
 * must take a fresh place in the mailbox queue — section 7 spaces email sends 3–9 minutes
 * apart — instead of keeping yesterday's slot and all sending the instant the window opens.
 *
 * Time travel: `@workflow/vitest` wakes sleeps without moving the clock, so this test drives
 * a fake `Date` forward across the days (`vi.useFakeTimers({ toFake: ["Date"] })`) and wakes
 * each run when its reserved slot arrives. Only `Date` is faked: the Local World's real
 * timers, MSW and the HTTP fake all keep working.
 */

const TIME_ZONE = "UTC";
/** `configureSettings` keeps the owner timezone at UTC; the window closes mid-queue. */
const WINDOW: SendingWindow = { days: [1, 2, 3, 4, 5, 6, 7], start: "08:00", end: "08:44" };
const DAY_ONE = new Date("2026-09-25T08:30:00Z");
const DAY_TWO = new Date("2026-09-26T08:00:00Z");
const DAY_THREE = new Date("2026-09-27T08:00:00Z");
/** Long past the simulated days, so the adapter never has to refresh a token. */
const TOKEN_EXPIRY_MS = new Date("2027-01-01T00:00:00Z").getTime();
/** Warmup week 1 (section 0/7). */
const CAP = 5;
const NEW_CONVERSATIONS = 10;
/** Section 7's minimum email spacing. */
const MIN_SPACING_MS = 3 * 60 * 1000;
/** The clock is moved just past a slot, as the durable sleep would have been. */
const SLOT_LEEWAY_MS = 2_000;
/**
 * Between successive wakes of the same run. Waking too eagerly makes the Local World's
 * Windows file renames collide (the EPERM storm its own testing docs warn about), so a wake
 * is retried only after this long.
 */
const WAKE_INTERVAL_MS = 5_000;
/** Lets the Local World finish writing one run's files before the next run is woken. */
const RUN_SETTLE_MS = 300;

interface FirstTouch {
  enrollment: Enrollment;
  contact: Contact;
  /** The step-0 message; the one this test drives. */
  message: Message;
}

interface SeededPacing {
  accountId: string;
  touches: FirstTouch[];
}

interface DayDrive {
  sent: Message[];
  /** Messages blocked by `sending_window` while their reserved slot was outside it. */
  windowBlocked: number;
  /** Messages blocked by `daily_cap`. */
  capBlocked: number;
}

const databaseAvailable = await hasDatabase();

describe.skipIf(!databaseAvailable)("sequence workflow: pacing after a closed window (review item 1)", () => {
  const google = createGoogleFake();
  const activeRuns: SequenceRun[] = [];

  beforeAll(() => listenToGoogle(google));

  beforeEach(async () => {
    await resetDatabase();
    activeRuns.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAY_ONE);
  });

  afterEach(async () => {
    // Restore the clock before the harness's real-time waits (cancelRun polls with real
    // timers) and before the next test file.
    vi.useRealTimers();
    for (const run of activeRuns) await cancelRun(run.runId);
    google.reset();
  });

  afterAll(async () => {
    closeGoogle(google);
    await closeTestDatabase();
  });

  it("paces the next morning's sends after the window closes mid-queue", { timeout: 420_000 }, async () => {
    const { accountId, touches } = await seedFirstTouches(NEW_CONVERSATIONS);
    const runs = new Map<string, SequenceRun>();

    // --- day 1: the window closes with messages still queued -----------------
    const dayOne = await driveDay(touches, runs, activeRuns, DAY_ONE);
    expect(dayOne.sent.length).toBeLessThanOrEqual(CAP);
    // At least the reservations that land after 08:44 must have been blocked by the window,
    // which is the block this test exists for.
    expect(dayOne.windowBlocked).toBeGreaterThanOrEqual(1);
    // The cap was never exceeded: every send on the day is counted, and the counter agrees.
    expect(await getSendCounters(accountId, "2026-09-25")).toEqual({
      new: dayOne.sent.length,
      total: dayOne.sent.length,
    });
    expectSpaced(dayOne.sent);
    await expectPendingSlotsCleared(touches);

    // --- day 2: the next window opens ---------------------------------------
    vi.setSystemTime(DAY_TWO);
    const dayTwo = await driveDay(touches, runs, activeRuns, DAY_TWO);
    // Five first touches are due (the cap), and none may bunch up: each takes the mailbox's
    // next 3–9 minute slot.
    expect(dayTwo.sent).toHaveLength(CAP);
    expectSpaced(dayTwo.sent);
    expect(await getSendCounters(accountId, "2026-09-26")).toEqual({
      new: dayTwo.sent.length,
      total: dayTwo.sent.length,
    });
    await expectPendingSlotsCleared(touches);

    // --- day 3: whatever the cap left over still paces ----------------------
    const pending = await pendingTouches(touches);
    if (pending.length > 0) {
      vi.setSystemTime(DAY_THREE);
      const dayThree = await driveDay(touches, runs, activeRuns, DAY_THREE);
      expectSpaced(dayThree.sent);
      await expectPendingSlotsCleared(touches);
    }

    const all = await touchRows(touches);
    expect([...all.values()].every((row) => row.status === "sent")).toBe(true);
    expect(google.sendCalls).toHaveLength(NEW_CONVERSATIONS);
  });
});

// ---------------------------------------------------------------------------
// Driving the durable runs through simulated days
// ---------------------------------------------------------------------------

/**
 * One day of the queue. Round 1 wakes every unsent first touch once, so each either takes
 * the free slot or reserves its own. Round 2 moves the clock to each reserved slot in
 * order; the guard then sends, or blocks by window/cap and clears the slot (review item 1).
 *
 * The day's sends are read from the final rows (`sentAt` inside the simulated day) rather
 * than counted as each wake resolves: a wake returns before the step's commit lands, and an
 * observation race must not make a real send invisible to the cap assertion.
 */
async function driveDay(
  touches: FirstTouch[],
  runs: Map<string, SequenceRun>,
  activeRuns: SequenceRun[],
  dayStart: Date,
): Promise<DayDrive> {
  let windowBlocked = 0;
  let capBlocked = 0;

  for (const touch of touches) {
    const before = await readTouch(touch);
    if (!before || before.status === "sent") continue;

    // Starts are staggered with the first wake (one run in flight at a time): ten runs
    // starting together makes the Local World write ten run files at once, which is the
    // Windows EPERM storm that stalls the world for minutes.
    const run = runs.get(touch.enrollment.id) ?? (await startRun(touch, runs, activeRuns));

    const baselineSlot = before.scheduledFor?.getTime() ?? null;
    await wakeUntil(
      run,
      async () => {
        const current = await readTouch(touch);
        if (!current) return false;
        if (current.status === "sent") return true;
        return (current.scheduledFor?.getTime() ?? null) !== baselineSlot;
      },
      `first touch ${touch.enrollment.id} to send or reserve a slot`,
    );
    await delay(RUN_SETTLE_MS);
  }

  for (;;) {
    const rows = await touchRows(touches);
    const pending = touches
      .map((touch) => ({ touch, row: rows.get(touch.message.id) }))
      .filter((entry) => entry.row !== undefined && entry.row.status !== "sent");
    const next = pending
      .filter((entry) => entry.row?.scheduledFor)
      .sort((left, right) => (left.row?.scheduledFor?.getTime() ?? 0) - (right.row?.scheduledFor?.getTime() ?? 0))[0];
    const slotAt = next?.row?.scheduledFor ?? null;
    if (!next || !slotAt) break;

    const outsideWindow = !isWithinWindow(slotAt, TIME_ZONE, WINDOW);
    vi.setSystemTime(new Date(Math.max(Date.now(), slotAt.getTime()) + SLOT_LEEWAY_MS));
    await wakeUntil(
      requireRun(runs, next.touch),
      async () => {
        const current = await readTouch(next.touch);
        if (!current) return false;
        if (current.status === "sent") return true;
        // A block (`approved`, slot cleared) is final for the day. A message still `sending`
        // is not: its commit has not landed yet, so keep waiting for it.
        return current.status !== "sending" && current.scheduledFor === null;
      },
      `first touch ${next.touch.enrollment.id} at slot ${slotAt.toISOString()} to send or be blocked`,
    );

    const after = await readTouch(next.touch);
    if (after?.status !== "sent") {
      if (outsideWindow) windowBlocked += 1;
      else capBlocked += 1;
    }
    await delay(RUN_SETTLE_MS);
  }

  await waitForSettled(touches);
  const rows = await touchRows(touches);
  const sent = touches
    .map((touch) => rows.get(touch.message.id))
    .filter(
      (row): row is Message =>
        row !== undefined && row.status === "sent" && row.sentAt !== null && isWithinDay(row.sentAt, dayStart),
    )
    .sort((left, right) => (left.sentAt?.getTime() ?? 0) - (right.sentAt?.getTime() ?? 0));

  return { sent, windowBlocked, capBlocked };
}

/** Every step's commit has landed: nothing is mid-send and no pending touch owns a slot. */
async function waitForSettled(touches: FirstTouch[], timeoutMs = 60_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const rows = await touchRows(touches);
    const busy = [...rows.values()].some((row) => row.status === "sending");
    const pendingWithSlot = [...rows.values()].some((row) => row.status !== "sent" && row.scheduledFor !== null);
    if (!busy && !pendingWithSlot) return;
    await delay(250);
  }
  throw new Error("The first touches did not settle; a wake never reached its guard.");
}

/**
 * Wakes a run until `check` passes. A wake can land while a step is still executing (the
 * `wake_completed` event is written but the resume message is lost), so the wake is retried
 * until the database shows the outcome. `performance.now()` measures the timeout because
 * `Date.now()` is the simulated clock under test.
 */
async function wakeUntil(
  run: SequenceRun,
  check: () => Promise<boolean>,
  description: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastWakeAt = 0;
  while (performance.now() < deadline) {
    if (await check()) return;
    if (performance.now() - lastWakeAt > WAKE_INTERVAL_MS) {
      try {
        await wakeAllSleeps(run.runId);
      } catch {
        // The run may be between suspensions; the next poll tries again.
      }
      lastWakeAt = performance.now();
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * One healthy mailbox on warmup week 1 and `count` active enrollments whose first touch is
 * approved. Every email step also has an approved message so the sequencer never drafts one
 * (that would call a model); only step 0 is driven here.
 */
async function seedFirstTouches(count: number): Promise<SeededPacing> {
  await configureSettings({ sendingWindows: { email: WINDOW, linkedin: WINDOW } });
  const account = await createEmailAccount({
    // The token must outlive the simulated days: a refresh would need the MSW token
    // endpoint, and this test is about pacing, not OAuth. The deterministic Message-ID
    // (review item 3) is what keeps the adapter from inventing an id.
    credentials: { accessToken: "test-access-token", accessTokenExpiresAt: TOKEN_EXPIRY_MS },
    warmupStage: 1,
  });

  const touches: FirstTouch[] = [];
  for (let index = 0; index < count; index += 1) {
    const contact = await createContact();
    const icp = await createIcp();
    const enrollment = await createEnrollment({ contactId: contact.id, icpId: icp.id, status: "active" });
    for (const step of [0, 3, 4, 5]) {
      await createMessage({ enrollmentId: enrollment.id, contactId: contact.id, step, status: "approved" });
    }
    touches.push({ enrollment, contact, message: await getMessageForStep(enrollment.id, 0) });
  }

  return { accountId: account.id, touches };
}

// ---------------------------------------------------------------------------
// Reads and assertions
// ---------------------------------------------------------------------------

async function readTouch(touch: FirstTouch): Promise<Message | null> {
  const [row] = await getDb().select().from(messages).where(eq(messages.id, touch.message.id)).limit(1);
  return row ?? null;
}

async function touchRows(touches: FirstTouch[]): Promise<Map<string, Message>> {
  const rows = await getDb()
    .select()
    .from(messages)
    .where(inArray(messages.id, touches.map((touch) => touch.message.id)));
  return new Map(rows.map((row) => [row.id, row]));
}

async function pendingTouches(touches: FirstTouch[]): Promise<FirstTouch[]> {
  const rows = await touchRows(touches);
  return touches.filter((touch) => rows.get(touch.message.id)?.status !== "sent");
}

/** Review item 1: a blocked message may not keep a slot it can no longer use. */
async function expectPendingSlotsCleared(touches: FirstTouch[]): Promise<void> {
  const rows = await touchRows(touches);
  for (const touch of touches) {
    const row = rows.get(touch.message.id);
    if (row && row.status !== "sent") expect(row.scheduledFor).toBeNull();
  }
}

/** Section 7: email sends are spaced at least three minutes apart. */
function expectSpaced(sent: Message[]): void {
  const times = sent
    .map((message) => message.sentAt?.getTime())
    .filter((time): time is number => typeof time === "number")
    .sort((left, right) => left - right);
  for (let index = 1; index < times.length; index += 1) {
    expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(MIN_SPACING_MS);
  }
}

function requireRun(runs: Map<string, SequenceRun>, touch: FirstTouch): SequenceRun {
  const run = runs.get(touch.enrollment.id);
  if (!run) throw new Error(`No sequence run for enrollment ${touch.enrollment.id}.`);
  return run;
}

/** Starts (once) a first touch's durable run, staggered so only one run starts at a time. */
async function startRun(
  touch: FirstTouch,
  runs: Map<string, SequenceRun>,
  activeRuns: SequenceRun[],
): Promise<SequenceRun> {
  const run = await startSequence(touch.enrollment.id);
  activeRuns.push(run);
  runs.set(touch.enrollment.id, run);
  await delay(RUN_SETTLE_MS);
  return run;
}

/** True when `at` falls inside the 24 hours starting at `dayStart` (the simulated day). */
function isWithinDay(at: Date, dayStart: Date): boolean {
  const atMs = at.getTime();
  return atMs >= dayStart.getTime() && atMs < dayStart.getTime() + 24 * 60 * 60 * 1000;
}
