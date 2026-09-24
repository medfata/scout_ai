import { generateStructured, type StructuredCallResult } from "@/src/ai/client";
import {
  CRITIC_PROMPT_VERSION,
  criticRepairHint,
  criticSystemPrompt,
  criticUserPrompt,
  type CriticPromptInput,
} from "@/src/ai/prompts/critic";
import { CriticResultSchema, type CriticResultOutput } from "@/src/ai/schemas";
import { evaluateCopyRules, type CopyRuleInput, type Violation } from "@/src/domain/copy-rules";

/**
 * Section 6: "Critic | Fast | Draft, brief, rules | Pass or violations + fix | Up to 2
 * revision loops, then owner edits." Section 6 also decides the merge rule for this
 * file: "A draft may only be marked as passing when both the critic and the code checks
 * agree. Merge violations, dedupe by code."
 *
 * The code checks in `src/domain/copy-rules.ts` run on every attempt and can veto the
 * critic: a model that says "pass" cannot override a missing opt-out line.
 */

export interface DraftViolation {
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface DraftVerdict {
  /** True only when the critic passed AND no code violation has severity "error". */
  passed: boolean;
  criticPassed: boolean;
  /** Critic violations merged with the code violations, deduped by code. */
  violations: DraftViolation[];
  /** Concrete instruction for the next revision; required when `passed` is false. */
  fix: string | null;
  critic: CriticResultOutput;
  codeViolations: Violation[];
}

/**
 * Pure merge used by the critic and by the inbox. Exported so the "never passes when a
 * code error exists" rule is testable without a model.
 */
export function mergeVerdicts(critic: CriticResultOutput, codeViolations: Violation[]): {
  passed: boolean;
  violations: DraftViolation[];
  fix: string | null;
} {
  const merged = dedupeViolations([
    ...critic.violations.map((violation) => ({
      code: violation.code,
      message: violation.message,
      severity: violation.severity,
    })),
    ...codeViolations.map((violation) => ({
      code: violation.code,
      message: violation.message,
      severity: violation.severity,
    })),
  ]);

  const hasCodeError = codeViolations.some((violation) => violation.severity === "error");
  const hasError = merged.some((violation) => violation.severity === "error");
  const passed = critic.passed && !hasCodeError && !hasError;
  const fix = passed ? null : critic.fix?.trim() || composeFix(merged);

  return { passed, violations: merged, fix };
}

/** Keeps the most severe entry per code, preserving first-seen order. */
export function dedupeViolations(violations: DraftViolation[]): DraftViolation[] {
  const byCode = new Map<string, DraftViolation>();
  for (const violation of violations) {
    const existing = byCode.get(violation.code);
    if (!existing || (existing.severity === "warning" && violation.severity === "error")) {
      byCode.set(violation.code, violation);
    }
  }
  return [...byCode.values()];
}

export type CriticModelCall = (input: {
  contactId: string | null;
  prompt: CriticPromptInput;
}) => Promise<StructuredCallResult<CriticResultOutput>>;

export interface CritiqueDraftInput {
  contactId: string | null;
  /** The draft and brief, as the critic prompt needs them. */
  prompt: CriticPromptInput;
  /** The exact inputs to the code checks: limits, signal count, angle keys, proof count. */
  copyRules: CopyRuleInput;
}

export interface CritiqueDraftResult {
  verdict: DraftVerdict;
  model: string;
  promptVersion: string;
  costUsd: number;
  attempts: number;
}

const defaultCall: CriticModelCall = (input) =>
  generateStructured({
    component: "critic",
    promptVersion: CRITIC_PROMPT_VERSION,
    role: "copy",
    schema: CriticResultSchema,
    system: criticSystemPrompt(),
    prompt: criticUserPrompt(input.prompt),
    temperature: 0,
    contactId: input.contactId,
    repairHint: criticRepairHint(),
  });

/**
 * Runs the critic model and the code checks, always both, and returns the merged verdict.
 * Throws `LlmValidationError` when the critic itself cannot produce valid JSON twice; the
 * revision loop turns that into "needs owner" rather than letting a bad draft through.
 */
export async function critiqueDraft(
  input: CritiqueDraftInput,
  deps: { call?: CriticModelCall } = {},
): Promise<CritiqueDraftResult> {
  const call = deps.call ?? defaultCall;
  const codeViolations = evaluateCopyRules(input.copyRules);
  const result = await call({ contactId: input.contactId, prompt: input.prompt });
  const merged = mergeVerdicts(result.object, codeViolations);

  return {
    verdict: {
      passed: merged.passed,
      criticPassed: result.object.passed,
      violations: merged.violations,
      fix: merged.fix,
      critic: result.object,
      codeViolations,
    },
    model: result.model,
    promptVersion: result.promptVersion,
    costUsd: result.costUsd,
    attempts: result.attempts,
  };
}

function composeFix(violations: DraftViolation[]): string {
  const errors = violations.filter((violation) => violation.severity === "error");
  const target = errors.length > 0 ? errors : violations;
  return `Fix these violations: ${target.map((violation) => `${violation.code} — ${violation.message}`).join("; ")}.`;
}
