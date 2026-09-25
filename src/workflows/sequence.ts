import { eq } from "drizzle-orm";
import { defineHook, sleep } from "workflow";
import { HookConflictError } from "workflow/errors";

import { getDb } from "@/src/db/client";
import { enrollments } from "@/src/db/schema";
import {
  applyLeadEvent,
  emailCapsForWarmup,
  getSequence,
  getStep,
  isHumanIntent,
  type SequenceStep,
} from "@/src/domain";
import type { LeadEvent } from "@/src/domain/types";
import { isScoutError, type SendGuardRule } from "@/src/lib/errors";
import { getEnv } from "@/src/lib/env";
import { approvalToken, idempotencyKey, leadEventToken } from "@/src/lib/ids";
import {
  instantForDateOnly,
  isWithinWindow,
  jitterMs,
  nextWindowStart,
  spacingMinutesFor,
} from "@/src/lib/time-windows";
import { getPrimaryEmailAccount } from "@/src/services/accounts";
import { recordActivity } from "@/src/services/activity";
import { draftEnrollmentStep } from "@/src/services/drafting";
import {
  activateEnrollment,
  approveEnrollment,
  completeEnrollment,
  getEnrollment,
  loadSequencePlan,
  stopEnrollment,
  transitionEnrollment,
  type ParkedReason,
} from "@/src/services/enrollment";
import { getMessageByIdempotencyKey, skipMessage } from "@/src/services/messages";
import { nextCounterDayStart } from "@/src/services/quota";
import { sendMessage, type SendOutcome } from "@/src/services/sending";
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

/** A run that keeps re-scheduling without progressing is a bug, not a slow lead. */
const MAX_LOOP_ITERATIONS = 120;

/**
 * Review item 9: a guard block pauses a run, it never ends it. Every pause writes a real
 * instant to `nextActionAt`, so none of these delays can produce a busy loop.
 */
const UNCLASSIFIED_INBOUND_RETRY_MS = 15 * 60 * 1000;
const SEND_RETRY_MS = 15 * 60 * 1000;
const BLOCK_RETRY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Review item B3: these blocks are fixed by the owner, not by waiting a few minutes, so
 * they park the run at the next sending window instead of polling hourly. Turning the
 * kill switch off, completing the sending identity or reconnecting the mailbox wakes the
 * matching parks directly (review stage 1, item 2), without a blanket wake of every run.
 */
const PARK_RULES: ReadonlySet<SendGuardRule> = new Set(["kill_switch", "config_incomplete", "dry_run_unconfigured"]);

/** The rules that park, as a narrow type so every park records a reason. */
type ParkRule = "kill_switch" | "config_incomplete" | "dry_run_unconfigured";

function isParkRule(rule: SendGuardRule): rule is ParkRule {
  return PARK_RULES.has(rule);
}

/**
 * Review stage 1, item 2: the reason recorded on the enrollment. `config_incomplete`
 * covers two owner-fixable causes, and they are woken by different events, so the cause
 * is resolved here: a missing signature or postal address vs. a missing/paused mailbox.
 */
async function parkedReasonFor(rule: ParkRule, channel: "email" | "linkedin" | undefined): Promise<ParkedReason> {
  switch (rule) {
    case "kill_switch":
      return "kill_switch";
    case "dry_run_unconfigured":
      return "dry_run_unconfigured";
    case "config_incomplete": {
      const settings = await getSettings();
      if (!settings.signature.trim() || !settings.postalAddress.trim()) return "config_incomplete";
      if (channel === "email" && !(await getPrimaryEmailAccount())) return "mailbox";
      return "config_incomplete";
    }
  }
}

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
  using events = leadEventHook.create({ token: leadEventToken(enrollmentId) });

  // Review item 1's backstop: two runs must never drive the same enrollment. `getConflict()`
  // registers the hook and reports the other live owner; if this run is a duplicate it
  // exits without touching the enrollment, which belongs to the run that got here first.
  try {
    const conflict = await events.getConflict();
    if (conflict) {
      await recordDuplicateRunStep(enrollmentId, conflict.runId);
      return { status: "stopped", reason: "duplicate_run" };
    }
  } catch (error) {
    if (HookConflictError.is(error)) {
      await recordDuplicateRunStep(enrollmentId);
      return { status: "stopped", reason: "duplicate_run" };
    }
    throw error;
  }

  const iterator = events[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<LeadEvent>> = iterator.next();

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
    if (slot.action === "exit") {
      return slot.reason === "enrollment_replied"
        ? { status: "replied", reason: slot.reason }
        : { status: "stopped", reason: slot.reason };
    }
    if (slot.action === "skip") {
      // Review item 4: the first touch is the anchor. Skipping it means this lead was
      // never contacted, so the run stops instead of drafting a follow-up into nothing.
      if (index === 0) return await stopFirstTouchStep(enrollmentId, `first_touch_${slot.reason}`);
      index += 1;
      iterations = 0;
      continue;
    }

    const event = await Promise.race([
      sleep(new Date(slot.at)).then(() => null as LeadEvent | null),
      pending.then((result) => (result.done ? null : result.value ?? null)),
    ]);

    if (event) {
      pending = iterator.next();
      const decision = await applyEventStep(enrollmentId, event);
      if (decision.stop) {
        return await stopStep(enrollmentId, decision.reason, { status: "stopped", reason: decision.reason });
      }
      // Recompute the slot for the same step: an acceptance or an out-of-office reply
      // moves the clock, and `nextActionAt` carries that decision forward.
      iterations = 0;
      continue;
    }

    // Section 5: "waiting --> active: timer fires". The send guard requires `active`, so
    // the transition happens here, in a step, once the slot has actually arrived.
    const activation = await activateForSendStep(enrollmentId);
    if (!activation.ok) return { status: "stopped", reason: activation.reason };

    // --- draft (or reuse) the message ------------------------------------------
    const prepared = await prepareStep(enrollmentId, index);
    if (prepared.action === "wait") {
      // Review item 5: a quota pauses the stage (section 0). Park the enrollment at the
      // start of the next counter day and retry the SAME step.
      await postponeToNextCounterDayStep(enrollmentId);
      iterations = 0;
      continue;
    }
    if (prepared.action === "skip") {
      if (index === 0 && prepared.reason !== "already_sent") {
        return await stopFirstTouchStep(enrollmentId, `first_touch_${prepared.reason}`);
      }
      index += 1;
      iterations = 0;
      continue;
    }
    if (prepared.action === "stop") {
      return await stopStep(enrollmentId, prepared.reason, { status: "stopped", reason: prepared.reason });
    }

    // --- the owner's approval ---------------------------------------------------
    if (prepared.needsApproval) {
      // Review item 3: the hook is created BEFORE the status is re-read. An approval that
      // arrived between drafting and this point (or while the run was restarting) is then
      // never lost: either the re-read sees it or the hook receives it.
      {
        using hook = approvalHook.create({ token: approvalToken(enrollmentId, index) });
        // Register the hook *before* the re-read. An approval that arrives after this
        // point is delivered to the hook; one that arrived before it is seen by the
        // re-read below. Either way the owner's click is never lost.
        const conflict = await hook.getConflict();
        if (conflict) {
          await recordDuplicateRunStep(enrollmentId, conflict.runId);
          return { status: "stopped", reason: "duplicate_run" };
        }

        const precheck = await readApprovalStep(enrollmentId, index);
        if (precheck.action === "skip") {
          // Review item 4: a skipped first touch means the lead was never contacted.
          if (index === 0) return await stopFirstTouchStep(enrollmentId, `first_touch_${precheck.reason}`);
          index += 1;
          iterations = 0;
          continue;
        }
        if (precheck.action === "stop") {
          return await stopStep(enrollmentId, precheck.reason, { status: "stopped", reason: precheck.reason });
        }

        if (precheck.action === "wait") {
          const approval = await Promise.race([
            hook.then((payload) => ({ kind: "approval" as const, approved: payload.approved })),
            sleep(APPROVAL_WINDOW).then(() => ({ kind: "expiry" as const })),
            pending.then((result) => ({
              kind: "lead" as const,
              event: result.done ? null : result.value ?? null,
            })),
          ]);

          if (approval.kind === "lead") {
            pending = iterator.next();
            if (approval.event) {
              const decision = await applyEventStep(enrollmentId, approval.event);
              if (decision.stop) {
                return await stopStep(enrollmentId, decision.reason, { status: "stopped", reason: decision.reason });
              }
            }
            iterations = 0;
            continue;
          }

          if (approval.kind === "expiry" || !approval.approved) {
            const reason = approval.kind === "expiry" ? "approval_expired" : "approval_rejected";
            const finalized = await finalizeApprovalStep(enrollmentId, index, reason);
            // On expiry the message may have been approved in the meantime; send it
            // rather than skipping it (review item 3).
            if (finalized.action === "send") {
              // fall through to the send path
            } else if (finalized.action === "stop") {
              return await stopStep(enrollmentId, finalized.reason, { status: "stopped", reason: finalized.reason });
            } else {
              index += 1;
              iterations = 0;
              continue;
            }
          }
        }
      }
    }

    // --- send through the one guarded path -------------------------------------
    const outcome = await sendStep(enrollmentId, index);
    if (outcome.action === "sent") {
      index += 1;
      iterations = 0;
      continue;
    }
    if (outcome.action === "skipped") {
      // A first touch that could not send leaves no anchor, so the run stops instead of
      // advancing into a follow-up (review item 4). `already_sent` is the one exception:
      // the anchor exists and this is a replayed step.
      if (index === 0 && outcome.reason !== "already_sent") {
        return await stopFirstTouchStep(enrollmentId, `first_touch_${outcome.reason}`);
      }
      index += 1;
      iterations = 0;
      continue;
    }
    if (outcome.action === "skip") {
      // A permanent failure on the first touch must not leave a follow-up behind it.
      if (index === 0) return await stopFirstTouchStep(enrollmentId, outcome.reason);
      index += 1;
      iterations = 0;
      continue;
    }
    if (outcome.action === "stop") {
      return await stopStep(enrollmentId, outcome.reason, { status: "stopped", reason: outcome.reason });
    }
    // `retry` persisted a `nextActionAt`; the loop recomputes the slot from it. This is
    // how the sequencer respects a closed sending window, a full daily cap or a paused
    // stage without burning workflow events on a busy loop. A guard block is a pause,
    // never a termination (review item 9), so the loop counter is reset too.
    iterations = 0;
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

/** The duplicate-run backstop's audit trail; the surviving run keeps the enrollment. */
async function recordDuplicateRunStep(enrollmentId: string, conflictingRunId?: string): Promise<void> {
  "use step";
  await recordActivity({
    actor: "system",
    entityType: "enrollment",
    entityId: enrollmentId,
    type: "enrollment.transition",
    data: { reason: "duplicate_run", conflictingRunId: conflictingRunId ?? null },
  });
}

export type SlotOutcome =
  | { action: "sleep"; at: string }
  | { action: "skip"; reason: string }
  /** The enrollment is missing or no longer live: this run has nothing left to do. */
  | { action: "exit"; reason: string }
  | { action: "finished" };

/**
 * When the next send may happen: the later of the step's day offset and the enrollment's
 * `nextActionAt` (set by an out-of-office reply, a "not now", or a paused stage), moved
 * forward to the next open sending window in the *recipient's* timezone (section 7), plus
 * the spacing jitter from the pacing table.
 */
async function nextSendSlotStep(enrollmentId: string, index: number): Promise<SlotOutcome> {
  "use step";

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return { action: "exit", reason: "missing_enrollment" };
  if (enrollment.status !== "active" && enrollment.status !== "waiting") {
    return { action: "exit", reason: `enrollment_${enrollment.status}` };
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
  // Review item B1: every step's day offset is measured from the first message that
  // actually left, not from `enrollments.started_at`. A first touch delayed by a full
  // daily cap must not be followed minutes later by the "day 3" email. Before any message
  // has sent, the enrollment's start is still the only anchor there is.
  const anchor = plan.sendAnchor;
  const anchorOffset = anchor ? (getStep(sequence, anchor.step)?.dayOffset ?? 0) : 0;
  const base = anchor ? anchor.at : (enrollment.startedAt ?? enrollment.createdAt);
  const dayTarget = new Date(base.getTime() + (step.dayOffset - anchorOffset) * DAY_MS);

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

/**
 * Section 5: "waiting --> active: timer fires". Called once the slot has arrived and no
 * lead event interrupted the sleep. A terminal enrollment makes the run exit cleanly.
 */
async function activateForSendStep(enrollmentId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  "use step";

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return { ok: false, reason: "missing_enrollment" };
  if (enrollment.status === "waiting") {
    await transitionEnrollment(enrollmentId, "active", { reason: "send_slot" });
    return { ok: true };
  }
  if (enrollment.status !== "active") return { ok: false, reason: `enrollment_${enrollment.status}` };
  return { ok: true };
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
      const at = instantForDateOnly(decision.notBefore, settings.sendingWindows.email.start, settings.timezone);
      await updateNextAction(enrollmentId, at);
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
      // `auto_reply`, an accepted invite and a `resume` from `wakeParkedRuns` all keep the
      // run alive; the caller recomputes the slot from `nextActionAt` and the day offset.
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
  if (existing) {
    switch (existing.status) {
      case "sent":
        return { action: "skip", reason: "already_sent" };
      case "approved":
      case "sending":
        return { action: "ready", needsApproval: false };
      case "drafted":
      case "pending_approval":
        return { action: "ready", needsApproval: true };
      default:
        // `failed`, `skipped`, `cancelled`: the owner has to see this one, not the
        // sequencer. A first touch here stops the run (review item 4).
        return { action: "skip", reason: `message_${existing.status}` };
    }
  }

  const drafted = await draftEnrollmentStep({ enrollmentId, step: index });
  if (!drafted.ok) {
    if (drafted.reason === "quota") return { action: "wait", reason: "quota" };
    return { action: "skip", reason: drafted.reason };
  }

  // A validation failure persists a `needs_owner` message (review item 5), so it arrives
  // here as an ordinary approval step instead of a skip.
  return { action: "ready", needsApproval: drafted.message.status === "pending_approval" || drafted.message.status === "drafted" };
}

export type SendOutcomeStep =
  | { action: "sent" }
  | { action: "skipped"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "stop"; reason: string };

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

  // Review stage 1, item 2: this attempt reached the send path again, so the recorded park
  // no longer applies. A block below re-parks with a fresh reason; a send leaves it clear.
  if (enrollment.parkedReason !== null) {
    await clearParkedReason(enrollmentId);
  }

  let outcome: SendOutcome;
  try {
    outcome = await sendMessage({ enrollmentId, step: index, channel: step.channel, stepDefinition: step });
  } catch (error) {
    // A retryable provider failure (429/5xx) is thrown with `retryable: true`. The
    // idempotency key makes the next attempt safe, so this is another pause (item 9).
    if (isScoutError(error) && error.retryable) {
      await updateNextAction(enrollmentId, new Date(Date.now() + SEND_RETRY_MS));
      return { action: "retry", reason: "provider_retryable" };
    }
    throw error;
  }

  switch (outcome.status) {
    case "sent":
      await advanceStep(enrollmentId, index, step);
      return { action: "sent" };
    case "skipped":
      // Only suppression stops; every other skip is a step that cannot run for this lead
      // and the sequence moves on (a first-touch skip is handled by the caller).
      if (outcome.reason === "suppressed") {
        await stopEnrollment(enrollmentId, "suppressed");
        return { action: "stop", reason: "suppressed" };
      }
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
      // A permanent provider failure stays `failed` for the owner. The caller stops the
      // run when it happened on the first touch (review item 4).
      return { action: "skip", reason: "send_failed" };
    case "blocked": {
      const nextAt = outcome.nextAt && outcome.nextAt.getTime() > Date.now() ? outcome.nextAt : null;
      if (isParkRule(outcome.rule)) {
        // Review item B3: an owner-fixable block parks the run until the next sending
        // window, recording why. `wakeParkedRuns()` interrupts only the parks the owner's
        // change actually cleared (review stage 1, item 2).
        await parkUntilNextWindowStep(enrollmentId, index, outcome.rule);
        return { action: "retry", reason: outcome.rule };
      }
      switch (outcome.rule) {
        case "suppressed":
          await stopEnrollment(enrollmentId, "suppressed");
          return { action: "stop", reason: "suppressed" };
        case "unclassified_inbound":
          // Section 7: "blocks further sends" until the classifier resolves it. Stopping
          // here would break out-of-office rescheduling (review item 9), so pause and
          // let the reply workflow's hook decide. Review item B3 keeps this at 15 minutes:
          // classification is a short, in-flight state.
          await updateNextAction(enrollmentId, new Date(Date.now() + UNCLASSIFIED_INBOUND_RETRY_MS));
          return { action: "retry", reason: "unclassified_inbound" };
        case "pacing":
          // Review item B2: the message owns the slot; wait for it, never push it later.
          await updateNextAction(enrollmentId, nextAt ?? new Date(Date.now() + SEND_RETRY_MS));
          return { action: "retry", reason: "pacing" };
        case "sending_window":
          await updateNextAction(enrollmentId, nextAt ?? new Date(Date.now() + SEND_RETRY_MS));
          return { action: "retry", reason: "sending_window" };
        case "daily_cap": {
          // Review item 12: the start of the next counter day in the owner's timezone,
          // moved into the recipient's window. Never "now plus twelve hours".
          const at = await capRetryAtStep(enrollmentId);
          await updateNextAction(enrollmentId, at);
          return { action: "retry", reason: "daily_cap" };
        }
        default:
          // Review item 9: blocks pause, never terminate. Only suppression, a human
          // reply, a bounce and an opt-out end a sequence; `enrollment_status`,
          // `not_approved` and `idempotency` wait for the condition to change.
          await updateNextAction(enrollmentId, nextAt ?? new Date(Date.now() + BLOCK_RETRY_MS));
          return { action: "retry", reason: outcome.rule };
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

/** The next counter day, moved into the recipient's email window (review item 12). */
async function capRetryAtStep(enrollmentId: string): Promise<Date> {
  "use step";
  const settings = await getSettings();
  const plan = await loadSequencePlan(enrollmentId);
  const timeZone = plan.lead.contact.timezone ?? settings.timezone;
  const counterDayStart = nextCounterDayStart(new Date(), settings.timezone);
  return nextWindowStart(counterDayStart, timeZone, settings.sendingWindows.email);
}

/**
 * Review item B3: a kill switch, incomplete config, missing DRY_RUN redirect or a paused
 * mailbox parks the run at the next moment the channel may legally send — the next window
 * start — instead of waking every hour to ask the same question. The park records *why*
 * (review stage 1, item 2), so the dashboard can explain it and `wakeParkedRuns()` can
 * wake only the runs whose reason the owner's change actually cleared.
 */
async function parkUntilNextWindowStep(enrollmentId: string, index: number, rule: ParkRule): Promise<void> {
  "use step";

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return;

  const step = getStep(getSequence(enrollment.sequenceKey), index);
  const settings = await getSettings();
  const plan = await loadSequencePlan(enrollmentId);
  const timeZone = plan.lead.contact.timezone ?? settings.timezone;
  const window = step?.channel === "linkedin" ? settings.sendingWindows.linkedin : settings.sendingWindows.email;
  const at = nextWindowStart(new Date(), timeZone, window);
  const parkedReason = await parkedReasonFor(rule, step?.channel);

  await updateNextAction(enrollmentId, at, parkedReason);
  await recordActivity({
    actor: "system",
    entityType: "enrollment",
    entityId: enrollmentId,
    type: "guard.blocked",
    data: { step: index, reason: "parked", parkedReason, nextActionAt: at.toISOString() },
  });
}

/** Review item 5: quota pauses the stage; the same step retries after the counter resets. */
async function postponeToNextCounterDayStep(enrollmentId: string): Promise<void> {
  "use step";
  const settings = await getSettings();
  const at = nextCounterDayStart(new Date(), settings.timezone);
  await updateNextAction(enrollmentId, at);
  await recordActivity({
    actor: "system",
    entityType: "enrollment",
    entityId: enrollmentId,
    type: "enrollment.transition",
    data: { reason: "quota_pause", nextActionAt: at.toISOString() },
  });
}

/**
 * The one writer of `enrollments.nextActionAt`; callable from a step or from a step's
 * helper. Only a park passes a `parkedReason`; every other wait clears it, so a run that
 * moved on is never woken for a block it already left (review stage 1, item 2).
 */
async function updateNextAction(enrollmentId: string, at: Date, parkedReason: ParkedReason | null = null): Promise<void> {
  const db = getDb();
  await db
    .update(enrollments)
    .set({ nextActionAt: at, parkedReason, updatedAt: new Date() })
    .where(eq(enrollments.id, enrollmentId));
}

/** Review stage 1, item 2: the run reached the send path, so the recorded park is stale. */
async function clearParkedReason(enrollmentId: string): Promise<void> {
  const db = getDb();
  await db.update(enrollments).set({ parkedReason: null, updatedAt: new Date() }).where(eq(enrollments.id, enrollmentId));
}

export type ApprovalCheck =
  | { action: "wait" }
  | { action: "send" }
  | { action: "skip"; reason: string }
  | { action: "stop"; reason: string };

/**
 * Review item 3's re-read. Called right after the approval hook is registered (so an
 * approval that beat the hook is not lost) and again when the approval window expires
 * (so a late approval still sends instead of being skipped).
 */
async function readApprovalStep(enrollmentId: string, index: number): Promise<ApprovalCheck> {
  "use step";

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return { action: "stop", reason: "missing_enrollment" };

  const step = getStep(getSequence(enrollment.sequenceKey), index);
  if (!step) return { action: "skip", reason: "missing_step" };

  const message = await getMessageByIdempotencyKey(idempotencyKey(enrollment.id, index, step.channel));
  if (!message) return { action: "skip", reason: "missing_message" };

  switch (message.status) {
    case "approved":
    case "sending":
    case "sent":
      return { action: "send" };
    case "drafted":
    case "pending_approval":
      return { action: "wait" };
    default:
      return { action: "skip", reason: `message_${message.status}` };
  }
}

/**
 * Ends an approval window: re-reads the message, skips it when it is still waiting, and
 * tells the caller whether to send anyway (a late approval) or to move on. A first touch
 * never leaves the enrollment alive without an anchor (review item 4).
 */
async function finalizeApprovalStep(
  enrollmentId: string,
  index: number,
  reason: "approval_expired" | "approval_rejected",
): Promise<ApprovalCheck> {
  "use step";

  const check = await readApprovalStep(enrollmentId, index);
  if (check.action !== "wait") {
    // A first touch that ends without approval (skipped elsewhere, failed, cancelled)
    // must not leave the enrollment alive without an anchor (review item 4).
    if (check.action === "skip" && index === 0) return { action: "stop", reason: check.reason };
    return check;
  }

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment) return { action: "stop", reason: "missing_enrollment" };

  const step = getStep(getSequence(enrollment.sequenceKey), index);
  if (!step) return { action: "skip", reason: "missing_step" };

  const message = await getMessageByIdempotencyKey(idempotencyKey(enrollment.id, index, step.channel));
  if (message) await skipMessage(message.id, reason);

  await recordActivity({
    actor: "system",
    entityType: "enrollment",
    entityId: enrollmentId,
    type: "message.skipped",
    data: { step: index, reason },
  });

  if (index === 0) return { action: "stop", reason };
  return { action: "skip", reason };
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

/** A first-touch failure stops the enrollment: no follow-up without a sent anchor (item 4). */
async function stopFirstTouchStep(enrollmentId: string, reason: string): Promise<SequenceResult> {
  "use step";
  const enrollment = await getEnrollment(enrollmentId);
  if (enrollment && (enrollment.status === "active" || enrollment.status === "waiting" || enrollment.status === "pending_approval")) {
    await stopEnrollment(enrollmentId, reason);
  }
  return { status: "stopped", reason };
}

/** Section 9, L1/L2: the owner raising autonomy is what turns approvals into auto-sends. */
export async function noteManualApproval(enrollmentId: string): Promise<void> {
  "use step";
  const enrollment = await getEnrollment(enrollmentId);
  if (enrollment?.status === "pending_approval") {
    await approveEnrollment(enrollmentId);
    // Review item 1: approving the first touch is what starts the durable run.
    await activateEnrollment(enrollmentId);
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
