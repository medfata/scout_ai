import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import { enrollments } from "@/src/db/schema";
import { isLive } from "@/src/domain/enrollment";
import { tierFor } from "@/src/domain/scoring";
import { getSequence } from "@/src/domain/sequence";
import type { Tier } from "@/src/domain/types";
import { ConfigurationError } from "@/src/lib/errors";
import { logger } from "@/src/lib/logger";
import { createEnrollment } from "@/src/services/enrollment";
import { draftEnrollmentStep } from "@/src/services/drafting";
import { getLatestLeadScore } from "@/src/services/leads";
import {
  researchLeadForContact,
  resolveResearchAdapterDeps,
  scoreLeadForContact,
} from "@/src/services/research";

/**
 * Phase 3: research → score → (when the tier allows) draft + critic.
 *
 * Section 10 rule 8: this workflow body only awaits steps and branches on their results.
 * Every clock read, database query and model call happens inside a `"use step"` function,
 * so a replay produces the same path and every side effect is retry-safe.
 */

export type ResearchAndDraftOutcome =
  | { status: "research_failed"; reason: "suppressed" | "missing_lead" | "missing_icp" | "validation" | "quota" | "unavailable" }
  | { status: "score_failed"; reason: "missing_lead" | "missing_icp" | "missing_brief" | "validation" | "quota" }
  | { status: "not_qualified"; reason: "disqualified" | "below_c_tier" }
  | {
      status: "no_draft";
      reason:
        | "missing_enrollment"
        | "missing_step"
        | "missing_lead"
        | "missing_brief"
        | "missing_icp"
        | "validation"
        | "quota"
        | "enrollment_closed"
        | "enrollment_mismatch";
    }
  | { status: "drafted"; messageId: string; needsOwner: boolean; messageStatus: "approved" | "pending_approval" };

export async function researchAndDraftWorkflow(contactId: string, icpId: string): Promise<ResearchAndDraftOutcome> {
  "use workflow";

  const research = await researchStep(contactId, icpId);
  if (!research.ok) return { status: "research_failed", reason: research.reason };

  const score = await scoreStep(contactId, icpId);
  if (!score.ok) return { status: "score_failed", reason: score.reason };
  if (score.disqualified) return { status: "not_qualified", reason: "disqualified" };
  if (score.tier === null) return { status: "not_qualified", reason: "below_c_tier" };

  const draft = await draftStep(contactId, icpId);
  if (!draft.ok) return { status: "no_draft", reason: draft.reason };

  return {
    status: "drafted",
    messageId: draft.messageId,
    needsOwner: draft.needsOwner,
    messageStatus: draft.messageStatus,
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type ResearchStepResult =
  | { ok: true }
  | { ok: false; reason: "suppressed" | "missing_lead" | "missing_icp" | "validation" | "quota" | "unavailable" };

async function researchStep(contactId: string, icpId: string): Promise<ResearchStepResult> {
  "use step";

  let deps;
  try {
    deps = resolveResearchAdapterDeps();
  } catch (error) {
    // A missing adapter (or key) is a configuration state, not a per-lead failure; the
    // owner sees it once in the logs and the daily digest instead of a retry storm.
    if (error instanceof ConfigurationError) {
      logger.error("workflow.research_unavailable", { reason: error.message });
      return { ok: false, reason: "unavailable" };
    }
    throw error;
  }

  const outcome = await researchLeadForContact({ contactId, icpId }, deps);
  if (outcome.ok) return { ok: true };
  return { ok: false, reason: outcome.reason };
}

type ScoreStepResult =
  | { ok: true; score: number; tier: Tier | null; disqualified: boolean }
  | { ok: false; reason: "missing_lead" | "missing_icp" | "missing_brief" | "validation" | "quota" };

async function scoreStep(contactId: string, icpId: string): Promise<ScoreStepResult> {
  "use step";

  // Rule 7: a retried step reuses the stored score instead of paying for another call.
  const existing = await getLatestLeadScore(contactId, icpId);
  if (existing) {
    return {
      ok: true,
      score: existing.score,
      tier: existing.tier ?? null,
      disqualified: Boolean(existing.disqualifiedReason),
    };
  }

  const outcome = await scoreLeadForContact({ contactId, icpId });
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }

  // `tierFor` is the code-side authority; the agent already applied it, this is a guard.
  return {
    ok: true,
    score: outcome.result.score,
    tier: outcome.result.tier ?? tierFor(outcome.result.score),
    disqualified: outcome.result.disqualified,
  };
}

type DraftStepResult =
  | { ok: true; messageId: string; needsOwner: boolean; messageStatus: "approved" | "pending_approval" }
  | {
      ok: false;
      reason:
        | "missing_enrollment"
        | "missing_step"
        | "missing_lead"
        | "missing_brief"
        | "missing_icp"
        | "validation"
        | "quota"
        | "enrollment_closed"
        | "enrollment_mismatch";
    };

async function draftStep(contactId: string, icpId: string): Promise<DraftStepResult> {
  "use step";

  const sequence = getSequence("email_linkedin_v1");
  const db = getDb();
  const [latest] = await db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.contactId, contactId), eq(enrollments.sequenceKey, sequence.key)))
    .orderBy(desc(enrollments.createdAt))
    .limit(1);

  if (latest) {
    if (!isLive(latest.status)) return { ok: false, reason: "enrollment_closed" };
    if (latest.icpId !== icpId) return { ok: false, reason: "enrollment_mismatch" };
  }

  const enrollment = latest ?? (await createEnrollment({ contactId, icpId, angle: null, needsApproval: true }));

  // Step 0 is the first touch. Later steps are drafted just in time by the sequence
  // workflow (phase 5), which owns their slots.
  const outcome = await draftEnrollmentStep({ enrollmentId: enrollment.id, step: 0 });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  if (!outcome.result) return { ok: false, reason: "missing_step" };

  return {
    ok: true,
    messageId: outcome.message.id,
    needsOwner: outcome.result.needsOwner,
    messageStatus: outcome.result.status,
  };
}
