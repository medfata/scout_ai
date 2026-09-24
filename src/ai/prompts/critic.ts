import type { DraftOutput, ResearchBriefOutput } from "@/src/ai/schemas";
import type { ChannelKind } from "@/src/domain/types";
import type { StepKind } from "@/src/domain/sequence";

/**
 * Section 6: the critic is the "fast" evaluator in the copywriter's evaluator–optimizer
 * loop. It judges meaning; `src/domain/copy-rules.ts` judges the mechanical rules. A
 * draft passes only when both agree.
 *
 * The violation codes below overlap the code checks on purpose: `mergeVerdicts` dedupes
 * by code, so the owner sees one violation, not two.
 */

export const CRITIC_PROMPT_VERSION = "critic.v1";

export interface CriticStepContext {
  key: string;
  kind: StepKind;
  channel: ChannelKind;
  isFirstTouch: boolean;
  wordLimit: number | null;
  charLimit: number | null;
}

export interface CriticPromptInput {
  draft: DraftOutput;
  brief: ResearchBriefOutput;
  step: CriticStepContext;
  angleKeys: string[];
  proofCount: number;
  signatureBlock: string;
  optOutLine: string;
  language: string | null;
  /** For follow-ups: the previous message, to check the draft adds something new. */
  thread: { subject: string | null; body: string } | null;
}

/** Static context first (section 6, prompt caching). */
export function criticSystemPrompt(): string {
  return [
    "You are Scout's critic. You review ONE outreach draft against a fixed rulebook and",
    "return a verdict. You are strict by design: a false pass costs the sender's domain",
    "reputation, while a false fail only costs the owner a minute.",
    "",
    "## Rulebook",
    "- Length: first email <= 110 words, follow-up <= 70 words, LinkedIn <= 300 characters.",
    "  Subject <= 60 characters.",
    "- Exactly one observation, one concrete idea, one low-friction question.",
    "- Every company fact in the body must be grounded in the brief; each claim must point",
    "  at a signal index that exists. Statements the brief does not support fail.",
    "- Proof (clients, results, numbers) may only come from the offer's proof list.",
    "  A number the proof list does not back is an invented number.",
    "- Plain text. A link in a first email (outside the signature) fails.",
    "- Banned: \"just following up\", \"circling back\", \"touching base\",",
    "  \"hope this email finds you well\", \"quick question for you\", \"game-changer\",",
    "  \"cutting-edge\", \"synergy\", \"leverage\", \"unlock the power\", \"no-brainer\",",
    "  flattery and fake familiarity.",
    "- Every email ends with the exact signature block and the opt-out line. If either is",
    "  missing or rewritten, fail it.",
    "- A follow-up must add something new; repeating the previous email fails.",
    "- The message must say who the sender is and must not promise results.",
    "",
    "## Output",
    "Return JSON: passed (boolean), violations (array of { code, message, severity }),",
    "fix (one concrete instruction, required when passed is false).",
    "Use these codes when they fit: too_long, subject_too_long, ungrounded_claim,",
    "no_cta_question, multiple_ctas, link_in_first_email, banned_phrase, missing_opt_out,",
    "missing_signature, invented_number, angle_mismatch, hype, flattery, fake_familiarity,",
    "multiple_ideas, repeated_follow_up, not_in_language, no_observation, vague_ask.",
  ].join("\n");
}

export function criticUserPrompt(input: CriticPromptInput): string {
  const { draft, brief, step } = input;
  return [
    "## Step",
    `Key: ${step.key} (${step.kind}, ${step.channel})`,
    step.wordLimit !== null ? `Word limit: ${step.wordLimit}` : "",
    step.charLimit !== null ? `Character limit: ${step.charLimit}` : "",
    `Allowed angle keys: ${input.angleKeys.join(", ") || "none"}`,
    `Offer proof entries available: ${input.proofCount}`,
    input.language ? `Required language: ${input.language}` : "",
    "",
    "## Draft under review",
    `Subject: ${draft.subject ?? "(none)"}`,
    "Body:",
    draft.body,
    "",
    `Declared angle: ${draft.angle}`,
    `Declared CTA: ${draft.cta}`,
    "Claims:",
    ...(draft.claims.length > 0
      ? draft.claims.map((claim) => `  - "${claim.text}" -> signal ${claim.signalIndex}`)
      : ["  none — company-specific statements without claims fail"]),
    "",
    "## Brief the draft must be grounded in",
    `Summary: ${brief.summary}`,
    "Signals:",
    ...(brief.signals.length > 0
      ? brief.signals.map((signal, index) => `  [${index}] ${signal.fact} (${signal.url})`)
      : ["  none"]),
    "",
    input.thread
      ? ["## Previous message in the thread", input.thread.body, ""].join("\n")
      : "",
    "## Required ending",
    "The body must end with this block (plus the opt-out line):",
    input.signatureBlock,
    input.optOutLine,
    "",
    "Review the draft and return the verdict JSON now.",
  ]
    .filter((section) => section.length > 0)
    .join("\n");
}

/** Appended to the single retry after a schema failure (section 10 rule 5). */
export function criticRepairHint(): string {
  return [
    "Return ONLY the JSON object: { passed: boolean, violations: [{ code, message,",
    "severity: \"error\"|\"warning\" }], fix?: string }. When passed is false, `fix` is required.",
  ].join("\n");
}
