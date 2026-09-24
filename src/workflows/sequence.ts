import { defineHook, sleep } from "workflow";

import {
  applyLeadEvent,
  emailCapsForWarmup,
  getSequence,
  getStep,
  isHumanIntent,
  type SequenceStep,
} from "@/src/domain";
import type { LeadEvent } from "@/src/domain/types";
import { getEnv } from "@/src/lib/env";
import { approvalToken, idempotencyKey, leadEventToken } from "@/src/lib/ids";
import { isWithinWindow, jitterMs, nextWindowStart, spacingMinutesFor } from "@/src/lib/time-windows";
import { recordActivity } from "@/src/services/activity";
import { draftEnrollmentStep } from "@/src/services/drafting";
import {
  approveEnrollment,
  completeEnrollment,
  getEnrollment,
  loadSequencePlan,
  stopEnrollment,
  transitionEnrollment,
} from "@/src/services/enrollment";
import { getMessageByIdempotencyKey, skipMessage } from "@/src/services/messages";
import { sendMessage } from "@/src/services/sending";
import { getSettings } from "@/src/services/settings";

/**
 * Section 7: "Each enrollment is one durable workflow run that sleeps until its next send
 * slot and wakes early if a lead event arrives. Follow-ups are drafted just in time, so
 * they can reference the thread and fresh signals."
 *
 * The `"use workflow"` body is deterministic (section 10 rule 8): no clock reads, no
 * randomness, no database access. Every one of those lives in a `"use step"` function
 * below, which is why the workflow can be replayed for weeks and still take the same path.
 */

/** Reply | accepted | ooo | bounce | optout — the reasons a sleeping sequence wakes early. */
export const leadEventHook = defineHook<LeadEvent>();

/** The owner's decision on a step that needed approval before it could send. */
export const approvalHook = defineHook<{ approved: boolean }>();

/** Section 7: an approval that is not answered within three days expires and the step is skipped. */
const APPROVAL_WINDOW = "3d";

/** Section 0: when a quota runs out, the stage pauses. Cap the pause at one hour per check. */
const CAP_RETRY_DELAY_MS = 60 * 60 * 1000;

/** A run that keeps re-scheduling without progressing is a bug, not a slow lead. */
const MAX_LOOP_ITERATIONS = 120;

export type SequenceResult =
  | { status: "completed"; reason: string }
  | { status: "stopped"; reason: string }
  | { status: "replied"; reason: string }
  | { status: "skipped"; reason: string };

export async function sequenceWorkflow(enrollmentId: string): Promise<SequenceResult> {
  "use workflow";

  const plan = await loadPlanStep(enrollmentId);
  if (!plan.live) return { status: "stopped", reason: `enrollment_${plan.status}` };

  // One hook per enrollment: any lead event that arrives while this run sleeps wakes it.
  const events = leadEventHook.create({ token: leadEventToken(enrollmentId) });
  const iterator = events[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<LeadEvent>> | null = iterator.next();

  let index = plan.currentStep;
  let iterations = 0;

  while (index < plan.stepCount) {
    iterations += 1;
    if (iterations > MAX_LOOP_ITERATIONS) {
      return await stopStep(enrollmentId, "loop_guard", { status: "stopped", reason: "loop_guard" });
    }

    // --- wait for the slot, or for an event that arrives first ------------------
    const slot = await nextSendSlotStep(enrollmentId, index);
    if (slot.action === "finished") return await completeStep(enrollmentId);
    if (slot.action === "skip") {
      index += 1;
      continue;
    }

    const event = await Promise.race([
      sleep(new Date(slot.at)).then(() => null),
      pending ? pending.then((result) => result.value ?? null) : Promise.resolve(null),
    ]);

    if (event) {
      pending = iterator.next();
      const decision = await applyEventStep(enrollmentId, event);
      if (decision.stop) return await stopStep(enrollmentId, decision.reason, { status: "stopped", reason: decision.reason });
      // Recompute the slot for the same step: an acceptance or an out-of-office reply
      // moves the clock, and `nextActionAt` carries that decision forward.
      continue;
    }

    // --- draft (or reuse) the message ------------------------------------------
    const prepared = await prepareStep(enrollmentId, index);
    if (prepared.action === "skip" || prepared.action === "wait") {
      index += 1;
      continue;
    }
    if (prepared.action === "stop") {
      return await stopStep(enrollmentId, prepared.reason, { status: "stopped", reason: prepared.reason });
    }

    // --- the owner's approval, on the fast path --------------------------------
    if (prepared.needsApproval) {
      const hook = approvalHook.create({ token: approvalToken(enrollmentId, index) });
      const approved = await Promise.race([hook.then((payload) => payload.approved), sleep(APPROVAL_WINDOW).then(() => false)]);
      if (!approved) {
        await expireApprovalStep(enrollmentId, index);
        index += 1;
        continue;
      }
    }

    // --- send through the one guarded path -------------------------------------
    const outcome = await sendStep(enrollmentId, index);
    if (outcome.action === "sent" || outcome.action === "skipped" || outcome.action === "skip") {
      index += 1;
      continue;
    }
    if (outcome.action === "stop") {
      return await stopStep(enrollmentId, outcome.reason, { status: "stopped", reason: outcome.reason });
    }
    if (outcome.action === "replied") {
      return { status: "replied", reason: outcome.reason };
    }
    // `retry` persisted a `nextActionAt`; the loop recomputes the slot from it. This is
    // how the sequencer respects a closed sending window or a full daily cap without
    // burning workflow events on a busy loop.
  }

  return await completeStep(enrollmentId);
}

// ---------------------------------------------------------------------------
// Steps — the only place with I/O, clocks or randomness
// ---------------------------------------------------------------------------

interface PlanSummary {
  live: boolean;
  status: string;
  currentStep: number;
  stepCount: number;
  sequenceKey: string;
}

async function loadPlanStep(enrollmentId: string): Promise<PlanSummary> {
  "use step";
  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return { live: false, status: "missing", currentStep: 0, stepCount: 0, sequenceKey: "" };
  const sequence = getSequence(enrollment.sequenceKey);
  return {
    live: enrollment.status === "active" || enrollment.status === "waiting",
    status: enrollment.status,
    currentStep: enrollment.currentStep,
    stepCount: sequence.steps.length,
    sequenceKey: sequence.key,
  };
}

export type SlotOutcome =
  | { action: "sleep"; at: string }
  | { action: "skip"; reason: string }
  | { action: "finished" };

/**
 * When the next send may happen: the later of the step's day offset and the enrollment's
 * `nextActionAt` (set by an out-of-office reply, a "not now", or a blocked send), moved
 * forward to the next open sending window in the *recipient's* timezone (section 7), plus
 * the spacing jitter from the pacing table.
 */
async function nextSendSlotStep(enrollmentId: string, index: number): Promise<SlotOutcome> {
  "use step";

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return { action: "skip", reason: "missing_enrollment" };
  if (enrollment.status !== "active" && enrollment.status !== "waiting") {
    return { action: "skip", reason: `enrollment_${enrollment.status}` };
  }

  const sequence = getSequence(enrollment.sequenceKey);
  const step = getStep(sequence, index);
  if (!step) return { action: "finished" };

  const plan = await loadSequencePlan(enrollmentId);
  const planStep = plan.steps[index];
  if (!planStep) return { action: "finished" };
  if (!planStep.eligibility.eligible) {
    await recordActivity({
      actor: "system",
      entityType: "enrollment",
      entityId: enrollmentId,
      type: "message.skipped",
      data: { step: index, reason: planStep.eligibility.reason },
    });
    return { action: "skip", reason: planStep.eligibility.reason ?? "not_eligible" };
  }

  const settings = await getSettings();
  const now = new Date();
  const startedAt = enrollment.startedAt ?? enrollment.createdAt;
  const dayTarget = new Date(startedAt.getTime() + step.dayOffset * 24 * 60 * 60 * 1000);

  const nextActionAt = enrollment.nextActionAt && enrollment.nextActionAt > now ? enrollment.nextActionAt : now;
  const earliest = dayTarget > nextActionAt ? dayTarget : nextActionAt;

  const timeZone = plan.lead.contact.timezone ?? settings.timezone;
  const window = step.channel === "email" ? settings.sendingWindows.email : settings.sendingWindows.linkedin;
  const windowStart = nextWindowStart(earliest, timeZone, window);

  const kind = step.kind === "first_touch" ? "new" : step.kind === "invite" ? "invite" : step.kind === "linkedin_message" ? "message" : "followup";
  const spacing = spacingMinutesFor(step.channel, kind);
  const jittered = new Date(windowStart.getTime() + jitterMs(spacing.min, spacing.max));
  const at = isWithinWindow(jittered, timeZone, window) ? jittered : windowStart;

  return { action: "sleep", at: at.toISOString() };
}

export interface EventOutcome {
  stop: boolean;
  reason: string;
}

/** Section 7: "Any human reply on any channel stops every remaining step." */
async function applyEventStep(enrollmentId: string, event: LeadEvent): Promise<EventOutcome> {
  "use step";

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return { stop: true, reason: "missing_enrollment" };

  const decision = applyLeadEvent(enrollment.status, event);

  switch (decision.action) {
    case "stop": {
      const terminal = event.type === "reply" && isHumanIntent(event.intent) ? "replied" : "stopped";
      if (terminal === "replied") {
        await transitionEnrollment(enrollmentId, "replied", { reason: decision.reason, patch: { nextActionAt: null } });
      } else {
        await stopEnrollment(enrollmentId, decision.reason);
      }
      return { stop: true, reason: decision.reason };
    }
    case "reschedule": {
      // Section 7: out-of-office replies reschedule to the return date plus one business
      // day; the date is turned into an instant in the owner's timezone here, in a step.
      const settings = await getSettings();
      const { instantForDateOnly } = await import("@/src/lib/time-windows");
      const at = instantForDateOnly(decision.notBefore, settings.sendingWindows.email.start, settings.timezone);
      const { getDb } = await import("@/src/db/client");
      const { enrollments } = await import("@/src/db/schema");
      const { eq } = await import("drizzle-orm");
      await getDb().update(enrollments).set({ nextActionAt: at, updatedAt: new Date() }).where(eq(enrollments.id, enrollmentId));
      await recordActivity({
        actor: "system",
        entityType: "enrollment",
        entityId: enrollmentId,
        type: "enrollment.transition",
        data: { reason: decision.reason, nextActionAt: at.toISOString() },
      });
      return { stop: false, reason: decision.reason };
    }
    case "continue":
      return { stop: false, reason: decision.reason };
  }
}

export type PrepareOutcome =
  | { action: "ready"; needsApproval: boolean }
  | { action: "skip"; reason: string }
  | { action: "wait"; reason: string }
  | { action: "stop"; reason: string };

/**
 * Drafts the message just in time (section 7). `draftEnrollmentStep` is idempotent, so a
 * replayed step reuses the stored draft instead of paying for a second model call, and the
 * autonomy level from section 9 decides whether the message may send itself.
 */
async function prepareStep(enrollmentId: string, index: number): Promise<PrepareOutcome> {
  "use step";

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return { action: "stop", reason: "missing_enrollment" };

  const sequence = getSequence(enrollment.sequenceKey);
  const step = getStep(sequence, index);
  if (!step) return { action: "skip", reason: "missing_step" };

  const key = idempotencyKey(enrollment.id, index, step.channel);
  const existing = await getMessageByIdempotencyKey(key);
  if (existing?.status === "sent") return { action: "skip", reason: "already_sent" };

  if (existing && (existing.status === "approved" || existing.status === "sending")) {
    return { action: "ready", needsApproval: false };
  }
  if (existing && (existing.status === "pending_approval" || existing.status === "drafted")) {
    return { action: "ready", needsApproval: true };
  }

  const drafted = await draftEnrollmentStep({ enrollmentId, step: index });
  if (!drafted.ok) {
    if (drafted.reason === "quota") return { action: "wait", reason: "quota" };
    return { action: "skip", reason: drafted.reason };
  }

  return { action: "ready", needsApproval: drafted.message.status === "pending_approval" || drafted.message.status === "drafted" };
}

export type SendOutcomeStep =
  | { action: "sent" }
  | { action: "skipped"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "stop"; reason: string }
  | { action: "replied"; reason: string };

/**
 * Calls the one guarded send path (section 10 rule 6). The guard decides; this step only
 * translates its verdict into "move on", "try again later" or "stop the sequence".
 */
async function sendStep(enrollmentId: string, index: number): Promise<SendOutcomeStep> {
  "use step";

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return { action: "stop", reason: "missing_enrollment" };

  const sequence = getSequence(enrollment.sequenceKey);
  const step = getStep(sequence, index);
  if (!step) return { action: "skip", reason: "missing_step" };

  const outcome = await sendMessage({ enrollmentId, step: index, channel: step.channel, stepDefinition: step });

  switch (outcome.status) {
    case "sent":
      await advanceStep(enrollmentId, index, step);
      return { action: "sent" };
    case "skipped":
      await recordActivity({
        actor: "system",
        entityType: "enrollment",
        entityId: enrollmentId,
        type: "message.skipped",
        data: { step: index, reason: outcome.reason },
      });
      await advanceStep(enrollmentId, index, step);
      return { action: "skipped", reason: outcome.reason };
    case "failed":
      // The guard released a retryable failure back to `approved`; anything else is now
      // `failed` and stays visible in the inbox for the owner.
      return { action: "skip", reason: "send_failed" };
    case "blocked": {
      switch (outcome.rule) {
        case "sending_window":
          await setNextAction(enrollmentId, outcome.nextAt ?? new Date(Date.now() + CAP_RETRY_DELAY_MS));
          return { action: "retry", reason: "sending_window" };
        case "daily_cap":
          await setNextAction(enrollmentId, nextLocalWindowStartFallback());
          return { action: "retry", reason: "daily_cap" };
        case "unclassified_inbound":
          // The reply workflow is about to stop this enrollment; stopping here is the
          // same outcome and avoids a race with the classifier.
          await stopEnrollment(enrollmentId, "unclassified_inbound");
          return { action: "replied", reason: "unclassified_inbound" };
        case "suppressed":
          await stopEnrollment(enrollmentId, "suppressed");
          return { action: "stop", reason: "suppressed" };
        case "kill_switch":
        case "enrollment_status":
        case "idempotency":
        case "not_approved":
        default:
          await stopEnrollment(enrollmentId, outcome.rule);
          return { action: "stop", reason: outcome.rule };
      }
    }
  }
}

async function advanceStep(enrollmentId: string, index: number, step: SequenceStep): Promise<void> {
  "use step";

  await transitionEnrollment(enrollmentId, "waiting", {
    reason: `step_${index}_sent`,
    patch: { currentStep: index + 1, nextActionAt: null },
  });

  if (step.channel === "linkedin" && step.kind === "invite") {
    await recordActivity({
      actor: "system",
      entityType: "enrollment",
      entityId: enrollmentId,
      type: "enrollment.invite_sent",
      data: { step: index },
    });
  }
}

async function setNextAction(enrollmentId: string, at: Date): Promise<void> {
  "use step";
  const { getDb } = await import("@/src/db/client");
  const { enrollments } = await import("@/src/db/schema");
  const { eq } = await import("drizzle-orm");
  await getDb().update(enrollments).set({ nextActionAt: at, updatedAt: new Date() }).where(eq(enrollments.id, enrollmentId));
}

async function expireApprovalStep(enrollmentId: string, index: number): Promise<void> {
  "use step";

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return;
  const sequence = getSequence(enrollment.sequenceKey);
  const step = getStep(sequence, index);
  if (!step) return;

  const message = await getMessageByIdempotencyKey(idempotencyKey(enrollment.id, index, step.channel));
  if (message && (message.status === "pending_approval" || message.status === "drafted")) {
    await skipMessage(message.id, "approval_expired");
  }
  await recordActivity({
    actor: "system",
    entityType: "enrollment",
    entityId: enrollmentId,
    type: "message.skipped",
    data: { step: index, reason: "approval_expired" },
  });
}

async function completeStep(enrollmentId: string): Promise<SequenceResult> {
  "use step";
  const enrollment = await getEnrollment(enrollmentId);
  if (enrollment && (enrollment.status === "active" || enrollment.status === "waiting")) {
    await completeEnrollment(enrollmentId);
  }
  return { status: "completed", reason: "sequence_finished" };
}

async function stopStep(enrollmentId: string, reason: string, result: SequenceResult): Promise<SequenceResult> {
  "use step";
  const enrollment = await getEnrollment(enrollmentId);
  if (enrollment && (enrollment.status === "active" || enrollment.status === "waiting" || enrollment.status === "pending_approval")) {
    await stopEnrollment(enrollmentId, reason);
  }
  return result;
}

/**
 * The first send slot of the next day, used when a daily cap is hit. The exact hour does
 * not matter — `nextSendSlotStep` moves it into the window on the next pass — so this is
 * just "come back tomorrow".
 */
function nextLocalWindowStartFallback(): Date {
  return new Date(Date.now() + 12 * 60 * 60 * 1000);
}

/** Section 9, L1/L2: the owner raising autonomy is what turns approvals into auto-sends. */
export async function noteManualApproval(enrollmentId: string): Promise<void> {
  "use step";
  const enrollment = await getEnrollment(enrollmentId);
  if (enrollment?.status === "pending_approval") {
    await approveEnrollment(enrollmentId);
  }
}

/** Section 0: the free tier caps new conversations, so the planner checks this before sourcing. */
export async function emailCapsToday(): Promise<{ newConversations: number; totalSends: number }> {
  "use step";
  const settings = await getSettings();
  const { getPrimaryEmailAccount } = await import("@/src/services/accounts");
  const account = await getPrimaryEmailAccount();
  const caps = emailCapsForWarmup(account?.warmupStage ?? 1, settings.caps);
  return { newConversations: caps.newConversations, totalSends: caps.totalSends };
}

export const SEQUENCE_LIMITS = {
  approvalWindow: APPROVAL_WINDOW,
  maxLoopIterations: MAX_LOOP_ITERATIONS,
} as const;

export { getEnv };
