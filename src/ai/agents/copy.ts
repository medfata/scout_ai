import {
  COPY_PROMPT_VERSION,
  copyRepairHint,
  copySystemPrompt,
  copyUserPrompt,
  type CopyPromptInput,
  type CopyRevisionContext,
} from "@/src/ai/prompts/copy";
import type { CriticPromptInput } from "@/src/ai/prompts/critic";
import { generateStructured, LlmValidationError, type StructuredCallResult } from "@/src/ai/client";
import { DraftSchema, type DraftOutput, type ResearchBriefOutput } from "@/src/ai/schemas";
import { charLimitForStep, isFirstTouch, wordLimitForStep, type SequenceStep } from "@/src/domain/sequence";
import { buildSignature, DEFAULT_OPT_OUT_LINE, type CopyRuleInput } from "@/src/domain/copy-rules";
import { maySendWithoutApproval } from "@/src/domain/settings-defaults";
import type { Angle, AutonomyLevel, ChannelKind, ProofItem, Tier } from "@/src/domain/types";
import { logger } from "@/src/lib/logger";
import { critiqueDraft, type CritiqueDraftResult, type DraftVerdict } from "./critic";

/**
 * Section 6, copywriter: "Evaluator–optimizer with the critic", "Up to 2 revision loops,
 * then owner edits."
 *
 * The loop below never sends anything (section 10 rule 6) and never touches the database;
 * the service persists the result through `createDraft`. The critic and the code checks
 * both have to agree before a draft is marked as passing.
 */

/** Section 6: "Up to 2 revision loops, then owner edits." */
export const MAX_REVISIONS = 2;

export interface DraftMessageInput {
  enrollmentId: string;
  contactId: string;
  /** The sequence step being drafted. */
  step: SequenceStep;
  /** Redundant with `step.channel`, kept explicit because the caller drafts per channel. */
  channel: ChannelKind;
  /** The previous message when `step.thread === "same"` (section 7). */
  threadContext: { subject: string | null; body: string } | null;
  offer: { title: string; description: string; proof: ProofItem[] };
  icp: { name: string; angles: Angle[] };
  /** The angle selected for this enrollment; falls back to the ICP's first angle. */
  angle: Angle | null;
  brief: ResearchBriefOutput;
  recipient: { companyName: string | null; contactTitle: string | null };
  settings: { signature: string; postalAddress: string; autonomyLevel: AutonomyLevel };
  tier: Tier | null;
  language: string | null;
}

export interface RevisionContext {
  contactId: string | null;
  /** The copy prompt without the per-attempt revision block. */
  prompt: Omit<CopyPromptInput, "revision">;
  /** The critic prompt without the draft under review. */
  criticPrompt: Omit<CriticPromptInput, "draft">;
  /** The static inputs to `evaluateCopyRules`; the loop adds body/subject/claims/angle. */
  copyRules: Omit<CopyRuleInput, "body" | "subject" | "claims" | "angle" | "hasSignature">;
  /** Name + postal address as the body must carry them. */
  signatureBlock: string;
}

export type DraftCall = (input: { contactId: string | null; prompt: CopyPromptInput }) => Promise<
  StructuredCallResult<DraftOutput>
>;

export type CritiqueCall = (input: {
  contactId: string | null;
  draft: DraftOutput;
  prompt: CriticPromptInput;
  copyRules: CopyRuleInput;
}) => Promise<CritiqueDraftResult>;

export interface RevisionLoopDeps {
  draft: DraftCall;
  critique: CritiqueCall;
}

export interface RevisionLoopResult {
  outcome: "passed" | "needs_owner";
  draft: DraftOutput | null;
  verdict: DraftVerdict | null;
  attempts: number;
  model: string;
  promptVersion: string;
  costUsd: number;
  /** True when a model output failed schema validation twice (section 10 rule 5). */
  validationError: boolean;
}

/**
 * The evaluator–optimizer loop. Pure orchestration: `deps.draft` and `deps.critique` are
 * injected, so the tests drive it with fakes and the real path wires the models.
 */
export async function runRevisionLoop(
  context: RevisionContext,
  deps: RevisionLoopDeps,
  options: { maxRevisions?: number } = {},
): Promise<RevisionLoopResult> {
  const maxAttempts = (options.maxRevisions ?? MAX_REVISIONS) + 1;
  let costUsd = 0;
  let model = "";
  let lastDraft: DraftOutput | null = null;
  let lastVerdict: DraftVerdict | null = null;
  let revision: CopyRevisionContext | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let drafted: StructuredCallResult<DraftOutput>;
    try {
      drafted = await deps.draft({
        contactId: context.contactId,
        prompt: { ...context.prompt, revision },
      });
    } catch (error) {
      if (error instanceof LlmValidationError) {
        logger.warn("copy.draft_validation_failed", { contactId: context.contactId, attempt });
        return {
          outcome: "needs_owner",
          draft: lastDraft,
          verdict: lastVerdict,
          attempts: attempt,
          model,
          promptVersion: COPY_PROMPT_VERSION,
          costUsd: roundUsd(costUsd),
          validationError: true,
        };
      }
      throw error;
    }

    costUsd += drafted.costUsd;
    model = drafted.model;
    lastDraft = drafted.object;

    const copyRules: CopyRuleInput = {
      ...context.copyRules,
      body: lastDraft.body,
      subject: lastDraft.subject ?? null,
      claims: lastDraft.claims,
      angle: lastDraft.angle,
      hasSignature: bodyHasSignature(lastDraft.body, context.signatureBlock),
    };

    let critique: CritiqueDraftResult;
    try {
      critique = await deps.critique({
        contactId: context.contactId,
        draft: lastDraft,
        prompt: { ...context.criticPrompt, draft: lastDraft },
        copyRules,
      });
    } catch (error) {
      if (error instanceof LlmValidationError) {
        logger.warn("copy.critic_validation_failed", { contactId: context.contactId, attempt });
        return {
          outcome: "needs_owner",
          draft: lastDraft,
          verdict: lastVerdict,
          attempts: attempt,
          model,
          promptVersion: COPY_PROMPT_VERSION,
          costUsd: roundUsd(costUsd),
          validationError: true,
        };
      }
      throw error;
    }

    costUsd += critique.costUsd;
    lastVerdict = critique.verdict;

    if (critique.verdict.passed) {
      return {
        outcome: "passed",
        draft: lastDraft,
        verdict: lastVerdict,
        attempts: attempt,
        model,
        promptVersion: COPY_PROMPT_VERSION,
        costUsd: roundUsd(costUsd),
        validationError: false,
      };
    }

    if (attempt < maxAttempts) {
      revision = {
        attempt: attempt + 1,
        previousDraft: lastDraft,
        violations: lastVerdict.violations.map(
          (violation) => `[${violation.severity}] ${violation.code}: ${violation.message}`,
        ),
        fix: lastVerdict.fix,
      };
    }
  }

  return {
    outcome: "needs_owner",
    draft: lastDraft,
    verdict: lastVerdict,
    attempts: maxAttempts,
    model,
    promptVersion: COPY_PROMPT_VERSION,
    costUsd: roundUsd(costUsd),
    validationError: false,
  };
}

export interface DraftMessageResult {
  outcome: "passed" | "needs_owner" | "failed";
  draft: DraftOutput | null;
  verdict: DraftVerdict | null;
  needsOwner: boolean;
  /** Status the service must persist; never "sent". */
  status: "approved" | "pending_approval";
  attempts: number;
  model: string;
  promptVersion: string;
  costUsd: number;
}

export interface DraftMessageDeps {
  /** Test seam; the default calls Claude Haiku 4.5 through the AI Gateway. */
  draft?: DraftCall;
  critique?: CritiqueCall;
  maxRevisions?: number;
}

const defaultDraft: DraftCall = (input) =>
  generateStructured({
    component: "copy.draft",
    promptVersion: COPY_PROMPT_VERSION,
    role: "copy",
    schema: DraftSchema,
    system: copySystemPrompt(),
    prompt: copyUserPrompt(input.prompt),
    temperature: 0.6,
    contactId: input.contactId,
    repairHint: copyRepairHint(),
  });

const defaultCritique: CritiqueCall = (input) =>
  critiqueDraft({ contactId: input.contactId, prompt: input.prompt, copyRules: input.copyRules });

/**
 * Wires the real models into the revision loop and decides the message status from the
 * autonomy level. Section 9: "At every level, replies from humans go to the owner.
 * Scout never auto-replies to a person." Nothing here sends.
 */
export async function draftMessage(
  input: DraftMessageInput,
  deps: DraftMessageDeps = {},
): Promise<DraftMessageResult> {
  const angle = input.angle ?? input.icp.angles[0] ?? null;
  const allowedKeys = input.icp.angles.map((candidate) => candidate.key);
  const firstTouch = isFirstTouch(input.step);
  const signatureBlock = buildSignature(input.settings.signature, input.settings.postalAddress);

  const context: RevisionContext = {
    contactId: input.contactId,
    prompt: {
      offer: input.offer,
      angle: {
        key: angle?.key ?? "",
        hook: angle?.hook ?? "",
        allowedKeys,
      },
      step: {
        key: input.step.key,
        kind: input.step.kind,
        channel: input.step.channel,
        dayOffset: input.step.dayOffset,
        isFirstTouch: firstTouch,
        wordLimit: wordLimitForStep(input.step),
        charLimit: charLimitForStep(input.step),
      },
      recipient: input.recipient,
      brief: input.brief,
      thread: input.threadContext,
      signatureBlock,
      optOutLine: DEFAULT_OPT_OUT_LINE,
      language: input.language,
    },
    criticPrompt: {
      brief: input.brief,
      step: {
        key: input.step.key,
        kind: input.step.kind,
        channel: input.step.channel,
        isFirstTouch: firstTouch,
        wordLimit: wordLimitForStep(input.step),
        charLimit: charLimitForStep(input.step),
      },
      angleKeys: allowedKeys,
      proofCount: input.offer.proof.length,
      signatureBlock,
      optOutLine: DEFAULT_OPT_OUT_LINE,
      language: input.language,
      thread: input.threadContext,
    },
    copyRules: {
      step: input.step,
      channel: input.channel,
      signalCount: input.brief.signals.length,
      angleKeys: allowedKeys,
      proofCount: input.offer.proof.length,
    },
    signatureBlock,
  };

  const loop = await runRevisionLoop(
    context,
    {
      draft: deps.draft ?? defaultDraft,
      critique: deps.critique ?? defaultCritique,
    },
    deps.maxRevisions !== undefined ? { maxRevisions: deps.maxRevisions } : {},
  );

  const needsOwner = loop.outcome !== "passed";
  const status = decideDraftStatus({
    autonomyLevel: input.settings.autonomyLevel,
    step: input.step,
    tier: input.tier,
    passed: loop.outcome === "passed",
    needsOwner,
  });

  return {
    outcome: loop.draft === null ? "failed" : needsOwner ? "needs_owner" : "passed",
    draft: loop.draft,
    verdict: loop.verdict,
    needsOwner,
    status,
    attempts: loop.attempts,
    model: loop.model,
    promptVersion: loop.promptVersion,
    costUsd: loop.costUsd,
  };
}

/**
 * Section 9's autonomy table, through `maySendWithoutApproval` — the single source of
 * truth for L0/L1/L2. A draft that needs the owner can never be auto-approved.
 */
export function decideDraftStatus(input: {
  autonomyLevel: AutonomyLevel;
  step: SequenceStep;
  tier: Tier | null;
  passed: boolean;
  needsOwner: boolean;
}): "approved" | "pending_approval" {
  if (input.needsOwner || !input.passed) return "pending_approval";
  const allowed = maySendWithoutApproval({
    autonomyLevel: input.autonomyLevel,
    isFirstTouch: isFirstTouch(input.step),
    isLinkedIn: input.step.channel === "linkedin",
    tier: input.tier,
    criticPassed: input.passed,
  });
  return allowed ? "approved" : "pending_approval";
}

/** True when the body carries the signature block (or at least its first line). */
export function bodyHasSignature(body: string, signatureBlock: string): boolean {
  const lines = signatureBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0];
  if (!firstLine) return false;
  return body.includes(firstLine);
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}
