import { eq } from "drizzle-orm";

import { draftMessage, type DraftMessageDeps, type DraftMessageResult } from "@/src/ai/agents/copy";
import { LlmValidationError } from "@/src/ai/client";
import { getDb } from "@/src/db/client";
import {
  icps,
  offers,
  type Enrollment,
  type Icp,
  type Message,
  type Offer,
} from "@/src/db/schema";
import { pickAngle } from "@/src/domain/scoring";
import { getSequence, getStep } from "@/src/domain/sequence";
import type { ChannelKind } from "@/src/domain/types";
import { QuotaExceededError } from "@/src/lib/errors";
import { idempotencyKey } from "@/src/lib/ids";
import { logger } from "@/src/lib/logger";
import { recordActivity } from "./activity";
import { getEnrollment, transitionEnrollment } from "./enrollment";
import { getLead, getLatestLeadScore, getResearchBrief } from "./leads";
import {
  createDraft,
  getMessageByIdempotencyKey,
  getThreadAnchor,
  type CreateDraftInput,
} from "./messages";
import { assertAiBudget, recordAiCall } from "./quota";
import { getSettings } from "./settings";

/**
 * The drafting use case: load everything the copywriter needs, run the
 * evaluator–optimizer loop, persist exactly one message per enrollment/step/channel and
 * route it to `pending_approval` or `approved` per the autonomy level.
 *
 * Section 10 rule 6: this file never sends. Only `src/services/sending.ts` sends.
 */

export interface DraftEnrollmentStepInput {
  enrollmentId: string;
  /** Zero-based step index inside the enrollment's sequence. */
  step: number;
  /** Test seam; production uses the real copywriter and critic. */
  deps?: DraftMessageDeps;
}

export type DraftEnrollmentStepOutcome =
  | {
      ok: true;
      message: Message;
      enrollment: Enrollment;
      /** True when an existing draft answered and no model call was made. */
      skipped: boolean;
      result: DraftMessageResult | null;
    }
  | {
      ok: false;
      reason:
        | "missing_enrollment"
        | "missing_step"
        | "missing_lead"
        | "missing_brief"
        | "missing_icp"
        | "validation"
        | "quota";
      message?: string;
    };

interface IcpWithOffer {
  icp: Icp;
  offer: Offer;
}

async function loadIcpWithOffer(icpId: string): Promise<IcpWithOffer | null> {
  const db = getDb();
  const [row] = await db
    .select({ icp: icps, offer: offers })
    .from(icps)
    .innerJoin(offers, eq(icps.offerId, offers.id))
    .where(eq(icps.id, icpId))
    .limit(1);
  return row ?? null;
}

export async function draftEnrollmentStep(input: DraftEnrollmentStepInput): Promise<DraftEnrollmentStepOutcome> {
  const enrollment = await getEnrollment(input.enrollmentId);
  if (!enrollment) return { ok: false, reason: "missing_enrollment" };

  const step = getStep(getSequence(enrollment.sequenceKey), input.step);
  if (!step) return { ok: false, reason: "missing_step" };

  // Section 10 rule 7: a retried workflow step finds its draft and stops, so the model
  // is never called twice for the same message.
  const existing = await getMessageByIdempotencyKey(idempotencyKey(enrollment.id, input.step, step.channel));
  if (existing) {
    return { ok: true, message: existing, enrollment, skipped: true, result: null };
  }

  const lead = await getLead(enrollment.contactId);
  if (!lead) return { ok: false, reason: "missing_lead" };

  const brief = await getResearchBrief(enrollment.contactId);
  if (!brief) return { ok: false, reason: "missing_brief" };

  const icpWithOffer = await loadIcpWithOffer(enrollment.icpId);
  if (!icpWithOffer) return { ok: false, reason: "missing_icp" };

  const score = await getLatestLeadScore(enrollment.contactId, enrollment.icpId);
  const settings = await getSettings();

  const threadContext =
    step.thread === "same" ? await loadThreadContext(enrollment.id, input.step, step.channel) : null;

  try {
    // Section 9: "Daily AI spend above DAILY_AI_BUDGET_USD: stop research and drafting
    // until tomorrow."
    await assertAiBudget();

    const result = await draftMessage(
      {
        enrollmentId: enrollment.id,
        contactId: enrollment.contactId,
        step,
        channel: step.channel,
        threadContext,
        offer: {
          title: icpWithOffer.offer.title,
          description: icpWithOffer.offer.description,
          proof: icpWithOffer.offer.proof,
        },
        icp: { name: icpWithOffer.icp.name, angles: icpWithOffer.icp.angles },
        angle: pickAngle(icpWithOffer.icp.angles, enrollment.angle),
        brief: {
          summary: brief.summary,
          signals: brief.signals,
          likelyPains: brief.likelyPains,
          aiOpportunity: brief.aiOpportunity,
          hooks: brief.hooks,
          confidence: brief.confidence,
        },
        recipient: {
          companyName: lead.company?.name ?? null,
          contactTitle: lead.contact.title,
        },
        settings: {
          signature: settings.signature,
          postalAddress: settings.postalAddress,
          autonomyLevel: settings.autonomyLevel,
        },
        tier: score?.tier ?? null,
        language: lead.contact.language,
      },
      input.deps ?? {},
    );

    if (!result.draft) {
      // The model could not produce a parsable draft twice (section 10 rule 5). Nothing
      // is persisted; the owner sees the contact flagged in the audit log.
      await recordActivity({
        actor: "ai",
        entityType: "enrollment",
        entityId: enrollment.id,
        type: "draft.needs_owner",
        data: { step: input.step, channel: step.channel, reason: "validation" },
      });
      return { ok: false, reason: "validation", message: "The draft model failed schema validation twice." };
    }

    const draftInput: CreateDraftInput = {
      enrollmentId: enrollment.id,
      contactId: enrollment.contactId,
      channel: step.channel,
      step: input.step,
      stepKey: step.key,
      subject: result.draft.subject ?? null,
      body: result.draft.body,
      status: result.status,
      model: result.model,
      promptVersion: result.promptVersion,
      costUsd: result.costUsd,
      needsOwner: result.needsOwner,
    };
    const message = await createDraft(draftInput);

    await recordAiCall({
      component: "copy",
      model: result.model,
      promptVersion: result.promptVersion,
      costUsd: result.costUsd,
      contactId: enrollment.contactId,
    });

    // The verdict is not a column on `messages`, so the approval inbox reads it from
    // `activity_events` (entityType "message", entityId = message id). createDraft's own
    // `draft.created` event records the row; this one records the review. `claims` and
    // `angle` are stored so the inbox can re-run the code checks on an edited draft
    // without another model call.
    await recordActivity({
      actor: "ai",
      entityType: "message",
      entityId: message.id,
      type: result.needsOwner ? "draft.needs_owner" : "draft.created",
      data: {
        enrollmentId: enrollment.id,
        contactId: enrollment.contactId,
        step: input.step,
        channel: step.channel,
        status: result.status,
        attempts: result.attempts,
        promptVersion: result.promptVersion,
        model: result.model,
        passed: result.verdict?.passed ?? false,
        criticPassed: result.verdict?.criticPassed ?? false,
        fix: result.verdict?.fix ?? null,
        violations: result.verdict?.violations ?? [],
        claims: result.draft.claims,
        angle: result.draft.angle,
        cta: result.draft.cta,
      },
    });

    // Section 9: when the autonomy level approves the message, the enrollment must be
    // active for the send guard to let it through. An existing "waiting" enrollment is
    // left to the sequencer, which owns that transition.
    let currentEnrollment = enrollment;
    if (result.status === "approved" && enrollment.status === "pending_approval") {
      currentEnrollment = await transitionEnrollment(enrollment.id, "active", {
        reason: `autonomy:${settings.autonomyLevel}`,
        patch: { startedAt: new Date() },
      });
    }

    return { ok: true, message, enrollment: currentEnrollment, skipped: false, result };
  } catch (error) {
    if (error instanceof LlmValidationError) {
      await recordActivity({
        actor: "ai",
        entityType: "enrollment",
        entityId: enrollment.id,
        type: "draft.needs_owner",
        data: { step: input.step, channel: step.channel, reason: "validation" },
      });
      return { ok: false, reason: "validation", message: error.message };
    }
    if (error instanceof QuotaExceededError) {
      logger.warn("drafting.quota_exceeded", { enrollmentId: enrollment.id, reason: error.message });
      return { ok: false, reason: "quota", message: error.message };
    }
    throw error;
  }
}

/**
 * Section 7: "Follow-ups are drafted just in time, so they can reference the thread."
 * Only sent email messages count; a draft the owner skipped is not the thread anchor.
 */
export async function loadThreadContext(
  enrollmentId: string,
  stepIndex: number,
  channel: ChannelKind,
): Promise<{ subject: string | null; body: string } | null> {
  const anchor = await getThreadAnchor(enrollmentId);
  if (!anchor.threadId && !anchor.rfcMessageId) return null;

  for (let index = stepIndex - 1; index >= 0; index -= 1) {
    const previous = await getMessageByIdempotencyKey(idempotencyKey(enrollmentId, index, channel));
    if (previous && previous.status === "sent" && previous.direction === "outbound") {
      return { subject: previous.subject, body: previous.body };
    }
  }
  return null;
}
