import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer, type SetupServer } from "msw/node";
import { waitForHook } from "@workflow/vitest";
import { getRun, start, type Run } from "workflow/api";

import { getDb } from "@/src/db/client";
import {
  connectedAccounts,
  enrollments,
  messages as messagesTable,
  type Contact,
  type Enrollment,
  type Message,
} from "@/src/db/schema";
import type { LeadEvent, MessageStatus } from "@/src/domain/types";
import { approvalToken, leadEventToken } from "@/src/lib/ids";
import type { UpsertAccountInput } from "@/src/services/accounts";
import { resumeApproval, resumeLeadEvent, type ResumeResult } from "@/src/services/hooks";
import type { SettingsPatch } from "@/src/services/settings";
import { sequenceWorkflow, type SequenceResult } from "@/src/workflows/sequence";
import {
  configureSettings,
  createContact,
  createEmailAccount,
  createEnrollment,
  createIcp,
  createMessage,
} from "../factories";

/**
 * Shared harness for the phase 5 time-travel tests.
 *
 * The pre-built step bundle inlines every local module, so `vi.mock` and the in-memory
 * `tests/fakes/channel.ts` cannot reach the workflow's `sendMessage` call (verified
 * against `@workflow/vitest` 4.0.25). The vendor boundary is faked with MSW instead —
 * section 10 rule 4's other sanctioned mechanism, already used by `gmail.test.ts` — so
 * the real send guard and the real Gmail adapter are exercised, and no test calls Google.
 *
 * Time travel: `@workflow/vitest`'s `waitForSleep` returns only the correlation id, but the
 * tests also need the instant a sleep is targeting (scenario 8 proves the day-3 follow-up
 * is measured from email 1). The Local World persists each wait as a `wait_created` event
 * with `eventData.resumeAt`, so `pendingWaits()` reads that event log. The data directory
 * is the plugin default (`.workflow-data`, see vitest.workflows.config.ts).
 */

// ---------------------------------------------------------------------------
// Google fake (MSW)
// ---------------------------------------------------------------------------

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_LIST_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleFake {
  server: SetupServer;
  /** Every message the real Gmail adapter handed to the fake API, in order. */
  readonly sendCalls: Array<{ raw: string; threadId: string | null }>;
  reset(): void;
}

export function createGoogleFake(): GoogleFake {
  const sendCalls: Array<{ raw: string; threadId: string | null }> = [];
  const server = setupServer(
    http.post(GMAIL_TOKEN_URL, () =>
      HttpResponse.json({
        access_token: "test-access-token-refreshed",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.send",
      }),
    ),
    http.post(GMAIL_SEND_URL, async ({ request }) => {
      const body = (await request.json()) as { raw?: string; threadId?: string };
      sendCalls.push({ raw: body.raw ?? "", threadId: body.threadId ?? null });
      const index = sendCalls.length;
      return HttpResponse.json({ id: `provider-${index}`, threadId: body.threadId ?? `thread-${index}`, labelIds: ["SENT"] });
    }),
    http.get(GMAIL_LIST_URL, () => HttpResponse.json({ messages: [] })),
  );

  return {
    server,
    sendCalls,
    reset() {
      sendCalls.length = 0;
      server.resetHandlers();
    },
  };
}

/** Starts the fake API; `onUnhandledRequest: "error"` makes a stray Google call fail loudly. */
export function listenToGoogle(fake: GoogleFake): void {
  fake.server.listen({ onUnhandledRequest: "error" });
}

export function closeGoogle(fake: GoogleFake): void {
  fake.server.close();
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** The steps that can actually send in v1: the email steps (LinkedIn is assisted). */
export const EMAIL_STEPS = [0, 3, 4, 5] as const;

export interface SentMessageSeed {
  step: number;
  sentAt: Date;
  threadId?: string;
  rfcMessageId?: string;
}

export interface SeedSequenceOptions {
  /** Enrollment start; defaults to now. Ignored when `status` is `pending_approval`. */
  startedAt?: Date;
  currentStep?: number;
  status?: Enrollment["status"];
  /** Steps to create; defaults to every email step. */
  steps?: number[];
  /** Steps already sent before the run starts. */
  sent?: SentMessageSeed[];
  /** Per-step override for messages that are not already sent. Default `approved`. */
  messageStatus?: Record<number, MessageStatus>;
  settings?: SettingsPatch;
  /** `null` disconnects the mailbox; otherwise merged into the one v1 account. */
  account?: Partial<UpsertAccountInput> | null;
  warmupStage?: number;
}

export interface SequenceSeed {
  enrollment: Enrollment;
  contact: Contact;
  icpId: string;
  accountId: string | null;
  messages: Map<number, Message>;
}

export async function seedSequence(options: SeedSequenceOptions = {}): Promise<SequenceSeed> {
  const now = new Date();
  await configureSettings(options.settings ?? {});

  let accountId: string | null = null;
  if (options.account !== null) {
    const account = await createEmailAccount({
      // A valid access token means the OAuth client never refreshes, keeping the fake API
      // surface as small as possible while still exercising the real adapter.
      credentials: { accessToken: "test-access-token", accessTokenExpiresAt: Date.now() + 60 * 60 * 1000 },
      warmupStage: options.warmupStage ?? 5,
      ...options.account,
    });
    accountId = account.id;
  }

  const contact = await createContact();
  const icp = await createIcp();
  const status = options.status ?? "active";
  const enrollment = await createEnrollment({
    contactId: contact.id,
    icpId: icp.id,
    status,
    currentStep: options.currentStep ?? 0,
    startedAt: status === "pending_approval" ? null : (options.startedAt ?? now),
  });

  const sentByStep = new Map((options.sent ?? []).map((message) => [message.step, message]));
  const messages = new Map<number, Message>();

  for (const step of options.steps ?? [...EMAIL_STEPS]) {
    const sent = sentByStep.get(step);
    if (sent) {
      messages.set(
        step,
        await createMessage({
          enrollmentId: enrollment.id,
          contactId: contact.id,
          step,
          status: "sent",
          sentAt: sent.sentAt,
          providerMessageId: `provider-seed-${step}`,
          threadId: sent.threadId ?? "thread-seeded",
          rfcMessageId: sent.rfcMessageId ?? `<seed-${step}@scoutmail.example>`,
        }),
      );
      continue;
    }

    messages.set(
      step,
      await createMessage({
        enrollmentId: enrollment.id,
        contactId: contact.id,
        step,
        status: options.messageStatus?.[step] ?? "approved",
      }),
    );
  }

  return { enrollment, contact, icpId: icp.id, accountId, messages };
}

// ---------------------------------------------------------------------------
// Reading the Local World event log
// ---------------------------------------------------------------------------

export interface PendingWait {
  correlationId: string;
  resumeAt: Date;
}

const WORKFLOW_EVENTS_DIR = join(process.cwd(), ".workflow-data", "events");

/**
 * Every `wait_created` without a matching `wait_completed` for this run. A sleep that lost
 * a `Promise.race` to a lead event stays in the log as pending forever, so callers must
 * treat the list as "all sleeps this run has ever created", not "the sleep it is on".
 */
export function pendingWaits(runId: string): PendingWait[] {
  const events = runEvents(runId);

  const completed = new Set(events.filter((event) => event.eventType === "wait_completed").map((event) => event.correlationId));
  return events
    .filter((event) => event.eventType === "wait_created" && event.correlationId && event.eventData?.resumeAt)
    .filter((event) => !completed.has(event.correlationId))
    .map((event) => ({ correlationId: event.correlationId as string, resumeAt: new Date(event.eventData?.resumeAt as string) }))
    .sort((left, right) => left.resumeAt.getTime() - right.resumeAt.getTime());
}

interface WorkflowEventFile {
  eventType?: string;
  correlationId?: string;
  eventData?: { resumeAt?: string };
}

/**
 * Event files are written once and never change, so each one is parsed once per worker.
 * Re-reading them on every poll held handles open on Windows while world-local renamed
 * temporary files over the same paths, which exhausted its EPERM retries and turned into
 * five-second queue-retry storms that outlived the test. `readdirSync` stays per poll, so
 * new events are picked up as they appear.
 */
const eventCache = new Map<string, WorkflowEventFile | null>();

function runEvents(runId: string): WorkflowEventFile[] {
  const events: WorkflowEventFile[] = [];
  for (const file of readdirSync(WORKFLOW_EVENTS_DIR)) {
    if (!file.startsWith(runId) || !file.endsWith(".json")) continue;

    const cached = eventCache.get(file);
    if (cached !== undefined) {
      if (cached) events.push(cached);
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(join(WORKFLOW_EVENTS_DIR, file), "utf8")) as WorkflowEventFile;
      eventCache.set(file, parsed);
      events.push(parsed);
    } catch {
      // A half-written event is retried on the next poll; nothing is cached for it.
    }
  }
  return events;
}

/**
 * The workflow engine's own counters for progress. `wait_completed` is excluded on
 * purpose: a wake-up writes it even when its resume message races the suspension and is
 * lost, which is exactly the case the callers must retry.
 */
function stepEventCount(runId: string): number {
  return runEvents(runId).filter((event) => event.eventType?.startsWith("step_")).length;
}

export async function waitForPendingSleep(runId: string, timeoutMs = 60_000): Promise<PendingWait> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waits = pendingWaits(runId);
    if (waits.length > 0) return waits[waits.length - 1] as PendingWait;
    await delay(150);
  }
  throw new Error(`The sequence for run ${runId} never reached a sleep within ${timeoutMs}ms.`);
}

/** Waits for the sleep whose target satisfies `predicate`; returns its target instant. */
export async function waitForSleepTarget(
  runId: string,
  predicate: (at: Date) => boolean,
  timeoutMs = 60_000,
): Promise<Date> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = pendingWaits(runId).find((wait) => predicate(wait.resumeAt));
    if (match) return match.resumeAt;
    await delay(150);
  }
  throw new Error(`No pending sleep for run ${runId} matched the target predicate within ${timeoutMs}ms.`);
}

/**
 * Simulates the arrival of the currently awaited sleep. All pending waits are completed:
 * sleeps that lost a race are inert, and only the run's current race can resume.
 */
export async function wakeAllSleeps(runId: string): Promise<void> {
  await getRun(runId).wakeUp();
}

/**
 * Frees the mailbox pacing state so the next simulated slot arrives cleanly: the mailbox
 * may send now, and no message reserves a slot in the future (review item B2).
 */
export async function releasePacing(enrollmentId: string): Promise<void> {
  const db = getDb();
  await db.update(connectedAccounts).set({ nextSendAt: null, updatedAt: new Date() });
  await db
    .update(messagesTable)
    .set({ scheduledFor: null, updatedAt: new Date() })
    .where(eq(messagesTable.enrollmentId, enrollmentId));
}

/** Time-travels the workflow to its current sleep and lets it send. */
export async function advance(runId: string, enrollmentId: string): Promise<void> {
  await waitForPendingSleep(runId);
  await releasePacing(enrollmentId);
  await wakeUntilStep(runId);
}

/**
 * `wakeUp()` can land while the workflow handler is still committing its suspension; the
 * `wait_completed` event is written but the resume message is lost. Retry the wake until
 * the run has actually executed another step.
 */
async function wakeUntilStep(runId: string, timeoutMs = 45_000): Promise<void> {
  const before = stepEventCount(runId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wakeAllSleeps(runId);
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (stepEventCount(runId) > before) return;
      await delay(100);
    }
  }
  throw new Error(`Run ${runId} did not execute a step after waking its sleep.`);
}

/**
 * Time-travels until `done()` is true. Use this instead of `advance()` when a lead event
 * already moved the run: a sleep that lost a race stays pending forever, so one `wakeUp`
 * can complete a stale wait and miss the run's actual slot. Each round wakes every pending
 * wait, so the loop converges without knowing which sleep is current.
 */
export async function driveUntil(
  runId: string,
  enrollmentId: string,
  done: () => Promise<boolean>,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastWakeAt = 0;
  while (Date.now() < deadline) {
    if (await done()) return;
    if (Date.now() - lastWakeAt > 400) {
      await releasePacing(enrollmentId);
      try {
        await wakeAllSleeps(runId);
      } catch {
        // The run may have finished between the check and the wake; `done()` decides.
      }
      lastWakeAt = Date.now();
    }
    await delay(100);
  }
  throw new Error(`Timed out driving run ${runId} to the expected state.`);
}

// ---------------------------------------------------------------------------
// DB polling helpers (the workflow steps run out-of-band)
// ---------------------------------------------------------------------------

export async function waitForMessageStatus(
  enrollmentId: string,
  step: number,
  status: MessageStatus,
  timeoutMs = 60_000,
): Promise<Message> {
  return waitFor(
    async () => {
      const [row] = await getDb()
        .select()
        .from(messagesTable)
        .where(and(eq(messagesTable.enrollmentId, enrollmentId), eq(messagesTable.step, step)))
        .limit(1);
      return row?.status === status ? row : null;
    },
    `message ${step} to be ${status}`,
    timeoutMs,
  );
}

export async function getMessageForStep(enrollmentId: string, step: number): Promise<Message> {
  const [row] = await getDb()
    .select()
    .from(messagesTable)
    .where(and(eq(messagesTable.enrollmentId, enrollmentId), eq(messagesTable.step, step)))
    .limit(1);
  if (!row) throw new Error(`No message for enrollment ${enrollmentId} step ${step}.`);
  return row;
}

export async function getEnrollment(enrollmentId: string): Promise<Enrollment> {
  const [row] = await getDb().select().from(enrollments).where(eq(enrollments.id, enrollmentId)).limit(1);
  if (!row) throw new Error(`Enrollment ${enrollmentId} not found.`);
  return row;
}

export async function waitForEnrollmentStatus(
  enrollmentId: string,
  status: Enrollment["status"],
  timeoutMs = 60_000,
): Promise<Enrollment> {
  return waitFor(
    async () => {
      const [row] = await getDb().select().from(enrollments).where(eq(enrollments.id, enrollmentId)).limit(1);
      return row?.status === status ? row : null;
    },
    `enrollment to be ${status}`,
    timeoutMs,
  );
}

export async function waitForNextActionAt(enrollmentId: string, at: Date, timeoutMs = 60_000): Promise<void> {
  await waitFor(
    async () => {
      const enrollment = await getEnrollment(enrollmentId);
      return enrollment.nextActionAt?.getTime() === at.getTime() ? enrollment : null;
    },
    `nextActionAt to be ${at.toISOString()}`,
    timeoutMs,
  );
}

export async function waitFor<T>(check: () => Promise<T | null>, description: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type SequenceRun = Run<SequenceResult>;

export async function startSequence(enrollmentId: string): Promise<SequenceRun> {
  return start(sequenceWorkflow, [enrollmentId]);
}

/**
 * Cancels a run that is still live. The run is first given a moment to reach a sleep: a
 * `cancel()` that interrupts an in-flight step leaves the world retrying that step's
 * delivery ("Step not found") for minutes, which slows every later test in the worker.
 */
export async function cancelRun(runId: string): Promise<void> {
  try {
    const run = getRun(runId);
    const status = await run.status;
    if (status !== "pending" && status !== "running") return;

    const settleDeadline = Date.now() + 5_000;
    while (Date.now() < settleDeadline) {
      if (pendingWaits(runId).length > 0) break;
      const current = await run.status.catch(() => "cancelled" as const);
      if (current !== "pending" && current !== "running") return;
      await delay(100);
    }

    await run.cancel();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const current = await run.status.catch(() => "cancelled" as const);
      if (current !== "pending" && current !== "running") break;
      await delay(100);
    }
  } catch {
    // The run may already have left the world; there is nothing to cancel.
  }
}

/**
 * Delivers a lead event only once the run's `lead:<enrollmentId>` hook is registered.
 *
 * `defineHook.create()` does not register a hook — registration is committed when the
 * workflow suspends on it (`await events.getConflict()` in the sequencer). Resuming a token
 * before that commit throws "Hook not found" and the event is lost, which is the race that
 * made the suite flaky. `waitForHook` (node_modules/workflow/docs/foundations/hooks.mdx)
 * polls until the hook exists, and `leadEventToken` keeps the token identical to the
 * workflow's.
 */
export async function resumeLeadEventWhenReady(
  run: SequenceRun,
  enrollmentId: string,
  event: LeadEvent,
): Promise<ResumeResult> {
  await waitForLeadHook(run, enrollmentId);
  return resumeLeadEvent(enrollmentId, event);
}

/**
 * The approval-hook equivalent: wait until the sequencer has committed
 * `approval:<enrollmentId>:<step>` before clicking Approve/Reject. The inbox action writes
 * the message row *and* resumes the hook, so callers that represent a real click pair this
 * with `approveMessage`.
 */
export async function resumeApprovalWhenReady(
  run: SequenceRun,
  enrollmentId: string,
  step: number,
  approved: boolean,
): Promise<ResumeResult> {
  await waitForApprovalHook(run, enrollmentId, step);
  return resumeApproval(enrollmentId, step, approved);
}

/**
 * Waits for a hook without resuming it, for tests that must pin a state (the lead hook
 * proves the run is live; the approval hook proves the sequencer is in the approval race).
 */
export async function waitForLeadHook(run: SequenceRun, enrollmentId: string): Promise<void> {
  await waitForHook(run, {
    token: leadEventToken(enrollmentId),
    timeout: HOOK_TIMEOUT_MS,
    pollInterval: HOOK_POLL_MS,
  });
}

export async function waitForApprovalHook(run: SequenceRun, enrollmentId: string, step: number): Promise<void> {
  await waitForHook(run, {
    token: approvalToken(enrollmentId, step),
    timeout: HOOK_TIMEOUT_MS,
    pollInterval: HOOK_POLL_MS,
  });
}

/**
 * The SDK's `waitForHook` re-reads every event file on each poll; 100ms of that on Windows
 * races world-local's atomic renames and exhausts its EPERM retries. 400ms still reacts
 * quickly for a durable workflow and keeps the file system quiet.
 */
const HOOK_POLL_MS = 400;
const HOOK_TIMEOUT_MS = 90_000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** All sleeps carry 3–9 minutes of pacing jitter, so exact targets need a tolerance. */
export const PACING_TOLERANCE_MS = 10 * 60 * 1000;

export function expectAround(actual: Date, expected: Date, toleranceMs = PACING_TOLERANCE_MS): void {
  expect(Math.abs(actual.getTime() - expected.getTime())).toBeLessThanOrEqual(toleranceMs);
}
