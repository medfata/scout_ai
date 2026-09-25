import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { start } from "workflow/api";

import { getDb, withTransaction } from "@/src/db/client";
import {
  companies,
  contacts,
  enrollments,
  icps,
  messages,
  type Company,
  type Contact,
  type Enrollment,
} from "@/src/db/schema";
import {
  assertTransition,
  getSequence,
  getStep,
  isLive,
  resolveStepEligibility,
  type LeadContext,
  type SequenceTemplate,
  type StepEligibility,
} from "@/src/domain";
import type { EnrollmentStatus } from "@/src/domain/types";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { recordActivity } from "./activity";
import { loadLeadContext } from "./leads";
import { countryRequiresConsent } from "./settings";

/**
 * Enrollment use cases: creating, approving, skipping, stopping and completing.
 * Everything here goes through `assertTransition`, so section 5's state diagram is the
 * only way an enrollment can move.
 */

export interface CreateEnrollmentInput {
  contactId: string;
  icpId: string;
  sequenceKey?: string;
  angle: string | null;
  /** Section 9's autonomy levels decide whether the first touch waits for approval. */
  needsApproval: boolean;
}

export async function createEnrollment(input: CreateEnrollmentInput): Promise<Enrollment> {
  const sequence = getSequence(input.sequenceKey ?? "email_linkedin_v1");

  const enrollment = await withTransaction(async (tx) => {
    const [created] = await tx
      .insert(enrollments)
      .values({
        contactId: input.contactId,
        icpId: input.icpId,
        sequenceKey: sequence.key,
        sequenceVersion: sequence.version,
        angle: input.angle,
        status: input.needsApproval ? "pending_approval" : "active",
        currentStep: 0,
        startedAt: input.needsApproval ? null : new Date(),
      })
      // A live enrollment already exists for this lead and sequence: return it instead
      // of throwing, so a retried workflow step is harmless (section 10 rule 7).
      .onConflictDoNothing()
      .returning();

    if (created) return created;

    const [existing] = await tx
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.contactId, input.contactId), eq(enrollments.sequenceKey, sequence.key)))
      .orderBy(desc(enrollments.createdAt))
      .limit(1);
    if (!existing) throw new Error("Enrollment insert conflicted but no live enrollment was found.");
    return existing;
  });

  if (enrollment.status === "pending_approval" || enrollment.status === "active") {
    await recordActivity({
      actor: "system",
      entityType: "enrollment",
      entityId: enrollment.id,
      type: "enrollment.created",
      data: { contactId: input.contactId, icpId: input.icpId, sequenceKey: sequence.key, angle: input.angle },
    });
  }

  return enrollment;
}

export async function getEnrollment(enrollmentId: string): Promise<Enrollment | null> {
  const db = getDb();
  const [row] = await db.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).limit(1);
  return row ?? null;
}

export async function requireEnrollment(enrollmentId: string): Promise<Enrollment> {
  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) throw new Error(`Enrollment ${enrollmentId} not found`);
  return enrollment;
}

export interface TransitionOptions {
  tx?: Parameters<Parameters<typeof withTransaction>[0]>[0];
  patch?: Partial<Pick<Enrollment, "currentStep" | "workflowRunId" | "nextActionAt" | "startedAt" | "completedAt" | "angle">>;
  reason?: string;
  actor?: "system" | "owner";
}

/** The only writer of `enrollments.status`. */
export async function transitionEnrollment(
  enrollmentId: string,
  to: EnrollmentStatus,
  options: TransitionOptions = {},
): Promise<Enrollment> {
  const run = async (tx: NonNullable<TransitionOptions["tx"]>) => {
    const [current] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).limit(1);
    if (!current) throw new Error(`Enrollment ${enrollmentId} not found`);
    if (current.status === to) return current;

    assertTransition(current.status, to);

    const [updated] = await tx
      .update(enrollments)
      .set({ status: to, updatedAt: new Date(), ...(options.patch ?? {}) })
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.status, current.status)))
      .returning();

    // A concurrent writer changed the status first; re-read and let the caller retry.
    if (!updated) {
      const [latest] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).limit(1);
      if (!latest) throw new Error(`Enrollment ${enrollmentId} disappeared`);
      return latest;
    }
    return updated;
  };

  const updated = options.tx ? await run(options.tx) : await withTransaction(run);

  await recordActivity({
    actor: options.actor ?? "system",
    entityType: "enrollment",
    entityId: enrollmentId,
    type: activityTypeFor(to),
    data: { to, reason: options.reason ?? null },
  });

  return updated;
}

function activityTypeFor(status: EnrollmentStatus) {
  switch (status) {
    case "active":
      return "enrollment.approved" as const;
    case "skipped":
      return "enrollment.skipped" as const;
    case "stopped":
      return "enrollment.stopped" as const;
    case "completed":
      return "enrollment.completed" as const;
    case "replied":
      return "enrollment.replied" as const;
    default:
      return "enrollment.transition" as const;
  }
}

export async function approveEnrollment(enrollmentId: string): Promise<Enrollment> {
  return transitionEnrollment(enrollmentId, "active", {
    actor: "owner",
    reason: "approved",
    patch: { startedAt: new Date() },
  });
}

export async function skipEnrollment(enrollmentId: string, reason = "owner_skipped"): Promise<Enrollment> {
  return transitionEnrollment(enrollmentId, "skipped", { actor: "owner", reason });
}

export async function stopEnrollment(enrollmentId: string, reason: string): Promise<Enrollment> {
  return transitionEnrollment(enrollmentId, "stopped", { reason });
}

export async function completeEnrollment(enrollmentId: string): Promise<Enrollment> {
  return transitionEnrollment(enrollmentId, "completed", { reason: "sequence_finished", patch: { completedAt: new Date(), nextActionAt: null } });
}

export async function markReplied(enrollmentId: string, reason: string): Promise<Enrollment> {
  return transitionEnrollment(enrollmentId, "replied", { reason, patch: { nextActionAt: null } });
}

export async function setWorkflowRunId(enrollmentId: string, runId: string | null): Promise<void> {
  const db = getDb();
  await db.update(enrollments).set({ workflowRunId: runId, updatedAt: new Date() }).where(eq(enrollments.id, enrollmentId));
}

/** Prefix for a run id that has been claimed but whose `start()` has not returned yet. */
const STARTING_RUN_PREFIX = "starting:";

/** A claim older than this is assumed dead (the process died between claim and start). */
export const START_CLAIM_STALE_MS = 15 * 60 * 1000;

export interface ActivationResult {
  started: boolean;
  reason?: "run_exists" | "not_found" | "not_live" | "start_failed";
  runId?: string;
}

/**
 * Review item 1: nothing started `sequenceWorkflow`, so approvals moved a message to
 * `approved` and the pipeline stopped there.
 *
 * The claim is a single conditional `UPDATE … WHERE workflow_run_id IS NULL RETURNING`,
 * which is the only way two callers (the owner's approval and the drafting step's
 * autonomy path) can race safely. No row returned means a run already exists and this
 * call does nothing. The real run id replaces the claim afterwards; if `start()` throws,
 * the claim is released so the daily reconcile step can try again.
 *
 * Idempotent by construction, which is what lets a retried workflow step call it
 * (section 10 rule 7) and what makes the reconcile step safe.
 */
export async function activateEnrollment(enrollmentId: string): Promise<ActivationResult> {
  const db = getDb();
  const claimId = `${STARTING_RUN_PREFIX}${crypto.randomUUID()}`;

  const claimed = await db
    .update(enrollments)
    .set({ workflowRunId: claimId, updatedAt: new Date() })
    .where(
      and(
        eq(enrollments.id, enrollmentId),
        isNull(enrollments.workflowRunId),
        // A terminal enrollment must never get a fresh run; the claim only makes sense
        // while the lead is still in play (section 5).
        inArray(enrollments.status, ["active", "waiting"]),
      ),
    )
    .returning({ id: enrollments.id });

  if (claimed.length === 0) {
    const existing = await getEnrollment(enrollmentId);
    if (!existing) return { started: false, reason: "not_found" };
    if (existing.workflowRunId) return { started: false, reason: "run_exists", runId: existing.workflowRunId };
    return { started: false, reason: "not_live" };
  }

  try {
    // Dynamic import because `sequence.ts` imports this module; the cycle is harmless at
    // call time and keeps the workflow engine out of this module's top level.
    const { sequenceWorkflow } = await import("@/src/workflows/sequence");
    const run = await start(sequenceWorkflow, [enrollmentId]);
    await setWorkflowRunId(enrollmentId, run.runId);
    await recordActivity({
      actor: "system",
      entityType: "enrollment",
      entityId: enrollmentId,
      type: "enrollment.transition",
      data: { reason: "workflow_started", runId: run.runId },
    });
    return { started: true, runId: run.runId };
  } catch (error) {
    // Release only our own claim so the reconcile step can restart it; never leave the
    // enrollment claiming a run that does not exist, and never clobber a run another
    // caller stored in the meantime.
    await clearWorkflowRunId(enrollmentId, claimId);
    logger.error("enrollment.activate_failed", {
      enrollmentId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { started: false, reason: "start_failed" };
  }
}

/**
 * Review item 1's reconcile input: every enrollment that should be sitting in a durable
 * run. The daily planner checks each run's status and restarts the ones that are gone.
 */
export async function listEnrollmentsForReconcile(limit = 200): Promise<Enrollment[]> {
  const db = getDb();
  return db
    .select()
    .from(enrollments)
    .where(inArray(enrollments.status, ["active", "waiting"]))
    .orderBy(enrollments.updatedAt)
    .limit(limit);
}

/** Clears a run id only if it still matches, so a concurrent start is never clobbered. */
export async function clearWorkflowRunId(enrollmentId: string, expected: string | null): Promise<void> {
  const db = getDb();
  const matches = expected === null ? isNull(enrollments.workflowRunId) : eq(enrollments.workflowRunId, expected);
  await db
    .update(enrollments)
    .set({ workflowRunId: null, updatedAt: new Date() })
    .where(and(eq(enrollments.id, enrollmentId), matches));
}

/**
 * Review stage 1, item 2: why a run is parked. Stored in `enrollments.parked_reason` so a
 * settings save wakes only the enrollments whose block it actually cleared.
 */
export type ParkedReason = "kill_switch" | "config_incomplete" | "mailbox" | "dry_run_unconfigured";

/** The owner actions that clear a park, named the way the call sites talk about them. */
export type ParkWakeReason = "settings_saved" | "mailbox_reconnected" | "kill_switch_off";

/**
 * Which parked reasons each named event clears. `mailbox_reconnected` includes
 * `config_incomplete` because a missing or paused mailbox is reported by the send guard as
 * `config_incomplete` (section 7 rule 0, review item 18).
 */
const REASONS_CLEARED_BY_EVENT: Record<ParkWakeReason, readonly ParkedReason[]> = {
  kill_switch_off: ["kill_switch"],
  mailbox_reconnected: ["mailbox", "config_incomplete"],
  // A generic "settings saved" clears nothing on its own: `updateSettings` passes the
  // reasons its patch actually cleared (review stage 1, item 2), so an unrelated save
  // never wakes a run parked on a block it did not touch.
  settings_saved: [],
};

/** One page of parked rows; the walk keeps going until a page comes back short. */
const WAKE_PAGE_SIZE = 200;

export interface WakeParkedResult {
  /** Parked enrollments examined across every page. */
  checked: number;
  /** Enrollments whose live run accepted the `resume` event. */
  resumed: number;
}

/**
 * Review item B3 + stage 1 item 2: wake the runs parked on a reason the owner's change
 * cleared. Only rows whose `parked_reason` matches are resumed, so saving caps cannot wake
 * a run parked on a missing signature, and turning the kill switch off cannot wake a run
 * parked on an unconnected mailbox.
 *
 * The walk is keyset-paged by id: a single `limit(200)` would silently leave every run
 * after the first page parked. A successful resume clears the row's reason so the same
 * park is not woken twice; a run that is still blocked re-parks with a fresh reason.
 *
 * Callers (the settings and mailbox paths) schedule this through `scheduleWakeParkedRuns`
 * and ignore the result; failing to wake one enrollment must never fail the owner's save.
 */
export async function wakeParkedRuns(cleared: ParkWakeReason | readonly ParkedReason[]): Promise<WakeParkedResult> {
  const reasons = typeof cleared === "string" ? REASONS_CLEARED_BY_EVENT[cleared] : cleared;
  if (reasons.length === 0) return { checked: 0, resumed: 0 };

  const { resumeLeadEvent } = await import("@/src/services/hooks");

  let checked = 0;
  let resumed = 0;
  let afterId: string | null = null;

  for (;;) {
    const page = await listParkedPage(reasons, afterId);
    if (page.length === 0) break;

    for (const row of page) {
      checked += 1;
      const result = await resumeLeadEvent(row.id, { type: "resume" });
      if (result.resumed) {
        resumed += 1;
        await clearParkedReason(row.id, row.parkedReason);
      }
    }

    if (page.length < WAKE_PAGE_SIZE) break;
    const last = page[page.length - 1];
    if (!last) break;
    afterId = last.id;
  }

  await recordActivity({
    actor: "system",
    entityType: "enrollment",
    entityId: null,
    type: "enrollment.transition",
    data: { reason: "parked_runs_woken", cleared: [...reasons], checked, resumed },
  });

  return { checked, resumed };
}

/** Keyset page so concurrent wakes and status changes cannot skip rows between pages. */
async function listParkedPage(
  reasons: readonly ParkedReason[],
  afterId: string | null,
): Promise<Array<{ id: string; parkedReason: string | null }>> {
  const db = getDb();
  const conditions = [
    inArray(enrollments.status, ["active", "waiting"]),
    inArray(enrollments.parkedReason, [...reasons]),
  ];
  if (afterId !== null) conditions.push(gt(enrollments.id, afterId));

  return db
    .select({ id: enrollments.id, parkedReason: enrollments.parkedReason })
    .from(enrollments)
    .where(and(...conditions))
    .orderBy(enrollments.id)
    .limit(WAKE_PAGE_SIZE);
}

/** Clears a park only if it is still the one we woke, so a fresh park is never clobbered. */
async function clearParkedReason(enrollmentId: string, expected: string | null): Promise<void> {
  const db = getDb();
  await db
    .update(enrollments)
    .set({ parkedReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(enrollments.id, enrollmentId),
        expected === null ? isNull(enrollments.parkedReason) : eq(enrollments.parkedReason, expected),
      ),
    );
}

/**
 * Review stage 1, item 2: `wakeParkedRuns` is a paged walk over every matching enrollment,
 * so it must not run inside the owner's Server Action. `after()` runs it once the response
 * has been sent. Outside a Next.js request scope (workflow tests, scripts) there is no
 * response to schedule against; the change is still durable and each run wakes at its next
 * sending window, so this logs and moves on instead of waking inline.
 */
export async function scheduleWakeParkedRuns(cleared: readonly ParkedReason[]): Promise<void> {
  if (cleared.length === 0) return;

  try {
    const { after } = await import("next/server");
    after(async () => {
      await wakeParkedRuns(cleared);
    });
  } catch (error) {
    logger.info("enrollment.wake_not_scheduled", {
      reason: error instanceof Error ? error.message : "unknown",
      cleared: [...cleared],
    });
  }
}

// ---------------------------------------------------------------------------
// Sequence plan (read side, used by the sequence workflow's steps)
// ---------------------------------------------------------------------------

export interface SequencePlanStep {
  index: number;
  key: string;
  channel: "email" | "linkedin";
  kind: string;
  dayOffset: number;
  thread: "new" | "same" | "none";
  eligibility: StepEligibility;
}

export interface SequencePlan {
  enrollment: Enrollment;
  sequence: SequenceTemplate;
  lead: LeadContext & { contact: Contact; company: Company | null };
  steps: SequencePlanStep[];
  /** True when an outbound message for this enrollment has actually been sent. */
  hasSentAnchor: boolean;
  /** Review item B1: the sent message every later step's day offset is measured from. */
  sendAnchor: SendAnchor | null;
  /** Section 0 locks v1 to assisted; the flag comes from env, never from the database. */
  linkedinMode: "assisted" | "automated";
}

/**
 * Review item B1: step day offsets are relative to the first email that actually left,
 * not to `enrollments.started_at`. A first touch delayed by a full daily cap must not be
 * followed minutes later by the "day 3" email.
 */
export interface SendAnchor {
  /** Zero-based step index of the first outbound message that was sent. */
  step: number;
  /** `sentAt` when the provider recorded one, otherwise the reserved `scheduledFor`. */
  at: Date;
}

/**
 * Review item 4: a `thread: "same"` follow-up is only eligible when the enrollment has a
 * sent anchor. Review item B1: the same row is the time anchor for every day offset.
 * Read once here, next to the lead, so the workflow and the send guard see the same one.
 */
export async function getSendAnchor(enrollmentId: string): Promise<SendAnchor | null> {
  const db = getDb();
  const [row] = await db
    .select({ step: messages.step, sentAt: messages.sentAt, scheduledFor: messages.scheduledFor })
    .from(messages)
    .where(
      and(
        eq(messages.enrollmentId, enrollmentId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
      ),
    )
    .orderBy(asc(messages.step), asc(messages.sentAt))
    .limit(1);

  if (!row) return null;
  const at = row.sentAt ?? row.scheduledFor;
  return at ? { step: row.step, at } : null;
}

export async function hasSentAnchor(enrollmentId: string): Promise<boolean> {
  return (await getSendAnchor(enrollmentId)) !== null;
}

export async function loadSequencePlan(enrollmentId: string): Promise<SequencePlan> {
  const enrollment = await requireEnrollment(enrollmentId);
  const sequence = getSequence(enrollment.sequenceKey);
  const env = getEnv();

  const lead = await loadLeadContext(enrollment.contactId, enrollmentId);
  if (!lead) throw new Error(`Lead for enrollment ${enrollmentId} not found`);

  const now = new Date();
  // Automated LinkedIn is not part of v1; assisted mode produces owner tasks instead,
  // and the task queue ships in phase 6.
  const linkedinAutomationEnabled = env.LINKEDIN_MODE === "automated";
  const sendAnchor = await getSendAnchor(enrollmentId);
  const sent = sendAnchor !== null;
  // Section 9: countries that require a form of consent are excluded from cold email. The
  // lookup normalises both sides, so a stored "Germany" still matches the ISO default "DE"
  // (review item 17) — a raw string compare silently let those leads through.
  const requiresConsent = await countryRequiresConsent(lead.company?.country);

  const steps: SequencePlanStep[] = sequence.steps.map((step, index) => ({
    index,
    key: step.key,
    channel: step.channel,
    kind: step.kind,
    dayOffset: step.dayOffset,
    thread: step.thread,
    eligibility: resolveStepEligibility(step, lead, {
      linkedinAutomationEnabled,
      now,
      hasSentAnchor: sent,
      requiresConsent,
    }),
  }));

  return { enrollment, sequence, lead, steps, hasSentAnchor: sent, sendAnchor, linkedinMode: env.LINKEDIN_MODE };
}

export function stepAt(sequence: SequenceTemplate, index: number) {
  return getStep(sequence, index);
}

// ---------------------------------------------------------------------------
// Queues for the UI
// ---------------------------------------------------------------------------

export interface PendingEnrollmentRow {
  enrollment: Enrollment;
  contactName: string;
  companyName: string | null;
  icpName: string | null;
}

export async function listEnrollmentsForApproval(limit = 100): Promise<PendingEnrollmentRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      enrollment: enrollments,
      contactName: contacts.fullName,
      companyName: companies.name,
      icpName: icps.name,
    })
    .from(enrollments)
    .innerJoin(contacts, eq(enrollments.contactId, contacts.id))
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .leftJoin(icps, eq(enrollments.icpId, icps.id))
    .where(eq(enrollments.status, "pending_approval"))
    .orderBy(desc(enrollments.createdAt))
    .limit(limit);
  return rows;
}

export async function listLiveEnrollments(limit = 200) {
  const db = getDb();
  return db
    .select({ enrollment: enrollments, contactName: contacts.fullName, companyName: companies.name })
    .from(enrollments)
    .innerJoin(contacts, eq(enrollments.contactId, contacts.id))
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(inArray(enrollments.status, ["drafted", "pending_approval", "active", "waiting"]))
    .orderBy(desc(enrollments.updatedAt))
    .limit(limit);
}

/** Section 7: the workflow is re-attached after a deploy by finding enrollments that sleep. */
export async function listSleepingEnrollments(limit = 100): Promise<Enrollment[]> {
  const db = getDb();
  return db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.status, "waiting"), sql`${enrollments.nextActionAt} is not null`))
    .orderBy(enrollments.nextActionAt)
    .limit(limit);
}

export async function countLiveEnrollments(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(inArray(enrollments.status, ["drafted", "pending_approval", "active", "waiting"]));
  return Number(row?.value ?? 0);
}

export function isLiveEnrollment(enrollment: Enrollment): boolean {
  return isLive(enrollment.status);
}

export async function logWorkflowFailure(enrollmentId: string, message: string): Promise<void> {
  logger.error("enrollment.workflow_failed", { enrollmentId, reason: message });
  await recordActivity({
    actor: "system",
    entityType: "enrollment",
    entityId: enrollmentId,
    type: "workflow.failed",
    data: { message },
  });
}
