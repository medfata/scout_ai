import { generateStructured, type StructuredCallResult } from "@/src/ai/client";
import {
  SCORE_PROMPT_VERSION,
  scoreRepairHint,
  scoreSystemPrompt,
  scoreUserPrompt,
  type ScorePromptInput,
} from "@/src/ai/prompts/score";
import { LeadScoreSchema, type LeadScoreOutput } from "@/src/ai/schemas";
import { allowsEmailEnrichment, passesResearchGate, tierFor, TIER_THRESHOLDS } from "@/src/domain/scoring";
import type { EmailStatus, Tier } from "@/src/domain/types";
import { logger } from "@/src/lib/logger";

/**
 * Section 6: "Scorer | Fast | Brief, ICP rubric | Score 0–100, tier, reasons | LLM
 * rubric; code rules override."
 *
 * The model judges the nuance; `applyScoreRules` below owns the rules that must never
 * depend on a model: suppression, ICP disqualifiers, email sendability and the tier
 * cutoffs from `src/domain/scoring.ts`.
 */

export interface ScoreLeadInput extends ScorePromptInput {
  contactId: string;
  icpId: string;
}

export interface ScoreRulesContext {
  /** True when `isContactSuppressed` matched the contact, its email domain or LinkedIn. */
  suppressed: boolean;
  emailStatus: EmailStatus;
  /** Lower-cased text the ICP disqualifiers are matched against: title + company + industry. */
  matchText: string;
  disqualifiers: string[];
}

export interface FinalLeadScore {
  score: number;
  tier: Tier | null;
  reasons: string[];
  disqualified: boolean;
  disqualifiedReason: string | null;
}

/**
 * Pure, exported and directly testable: the code half of "code rules override".
 * The returned score is the one Scout persists, so the approval inbox and the email
 * enrichment gate both read the corrected number.
 */
export function applyScoreRules(model: LeadScoreOutput, context: ScoreRulesContext): FinalLeadScore {
  const reasons = [...model.reasons];

  const disqualifier = context.disqualifiers
    .map((entry) => entry.toLowerCase().trim())
    .filter((entry) => entry.length > 3)
    .find((entry) => context.matchText.toLowerCase().includes(entry));

  if (context.suppressed) {
    return {
      score: model.score,
      tier: null,
      reasons,
      disqualified: true,
      disqualifiedReason: "On the do-not-contact list (email, domain or LinkedIn is suppressed).",
    };
  }

  if (disqualifier) {
    return {
      score: model.score,
      tier: null,
      reasons: [...reasons, `Matches disqualifier "${disqualifier}".`],
      disqualified: true,
      disqualifiedReason: `Matches ICP disqualifier "${disqualifier}".`,
    };
  }

  if (model.disqualified) {
    return {
      score: model.score,
      tier: null,
      reasons,
      disqualified: true,
      disqualifiedReason: model.disqualifiedReason?.trim() || "The model disqualified this lead.",
    };
  }

  let score = model.score;

  // Section 6/9: "send only to valid"; catch-all addresses go LinkedIn-first. A lead
  // without a sendable email may still be a good fit, but it cannot be tier A while the
  // email path is blocked.
  const tierAAllowed = context.emailStatus === "valid" || context.emailStatus === "catch_all";
  if (tierFor(score) === "A" && !tierAAllowed) {
    score = TIER_THRESHOLDS.A - 1;
    reasons.push(
      `Email status "${context.emailStatus}" is not "valid" or "catch_all", so the lead cannot be tier A; score capped at ${score}.`,
    );
  }

  const tier = tierFor(score);
  if (tier === null) {
    return {
      score,
      tier: null,
      reasons,
      disqualified: true,
      disqualifiedReason: `Score ${score} is below the C-tier threshold (${TIER_THRESHOLDS.C}).`,
    };
  }

  return { score, tier, reasons, disqualified: false, disqualifiedReason: null };
}

export type ScoreModelCall = (input: {
  contactId: string | null;
  prompt: ScorePromptInput;
}) => Promise<StructuredCallResult<LeadScoreOutput>>;

export interface ScoreLeadDeps {
  /** Test seam; the default calls the fast model through the AI Gateway. */
  call?: ScoreModelCall;
}

export interface ScoreLeadResult extends FinalLeadScore {
  model: string;
  promptVersion: string;
  costUsd: number;
  attempts: number;
  /**
   * Section 6 cost control, exposed so the pipeline can gate: research only happens for
   * leads whose pre-score passed, and only 60+ leads get email enrichment credits.
   */
  gates: {
    research: boolean;
    emailEnrichment: boolean;
  };
}

const defaultCall: ScoreModelCall = (input) =>
  generateStructured({
    component: "score",
    promptVersion: SCORE_PROMPT_VERSION,
    role: "copy",
    schema: LeadScoreSchema,
    system: scoreSystemPrompt(),
    prompt: scoreUserPrompt(input.prompt),
    temperature: 0.1,
    contactId: input.contactId,
    repairHint: scoreRepairHint(),
  });

export async function scoreLead(input: ScoreLeadInput, deps: ScoreLeadDeps = {}): Promise<ScoreLeadResult> {
  const call = deps.call ?? defaultCall;
  const promptInput: ScorePromptInput = { icp: input.icp, lead: input.lead, brief: input.brief };

  const result = await call({ contactId: input.contactId, prompt: promptInput });

  const context: ScoreRulesContext = {
    suppressed: input.lead.suppressed,
    emailStatus: input.lead.emailStatus,
    disqualifiers: input.icp.disqualifiers,
    matchText: [input.lead.title, input.lead.companyName, input.lead.industry].filter(Boolean).join(" "),
  };

  const final = applyScoreRules(result.object, context);
  if (final.disqualified) {
    logger.info("score.disqualified", {
      contactId: input.contactId,
      icpId: input.icpId,
      reason: final.disqualifiedReason,
    });
  }

  return {
    ...final,
    model: result.model,
    promptVersion: result.promptVersion,
    costUsd: result.costUsd,
    attempts: result.attempts,
    gates: {
      research: passesResearchGate(final.score),
      emailEnrichment: !final.disqualified && allowsEmailEnrichment(final.score),
    },
  };
}
