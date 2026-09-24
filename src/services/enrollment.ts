import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb, withTransaction } from "@/src/db/client";
import { companies, contacts, enrollments, icps, type Company, type Contact, type Enrollment } from "@/src/db/schema";
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
  /** Section 0 locks v1 to assisted; the flag comes from env, never from the database. */
  linkedinMode: "assisted" | "automated";
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

  const steps: SequencePlanStep[] = sequence.steps.map((step, index) => ({
    index,
    key: step.key,
    channel: step.channel,
    kind: step.kind,
    dayOffset: step.dayOffset,
    thread: step.thread,
    eligibility: resolveStepEligibility(step, lead, { linkedinAutomationEnabled, now }),
  }));

  return { enrollment, sequence, lead, steps, linkedinMode: env.LINKEDIN_MODE };
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
