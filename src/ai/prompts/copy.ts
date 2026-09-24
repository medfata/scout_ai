import type { DraftOutput, ResearchBriefOutput } from "@/src/ai/schemas";
import type { ChannelKind, ProofItem } from "@/src/domain/types";
import type { StepKind } from "@/src/domain/sequence";

/**
 * Section 6: "Copywriter ... Evaluator–optimizer with the critic". This prompt writes
 * ONE message, given the brief, the ICP angle, the offer's proof and the sequence step.
 *
 * The section 6 copy rules are repeated here for the model, but they are enforced in
 * code by `src/domain/copy-rules.ts` and by the critic agent — the prompt is advice, the
 * checks are law.
 */

export const COPY_PROMPT_VERSION = "copy.v1";

export interface CopyOfferContext {
  title: string;
  description: string;
  /** The only proof a draft may cite (section 6: "proof comes only from the offer record"). */
  proof: ProofItem[];
}

export interface CopyAngleContext {
  key: string;
  hook: string;
  /** Every angle key the ICP declares; `Draft.angle` must be one of them. */
  allowedKeys: string[];
}

export interface CopyStepContext {
  key: string;
  kind: StepKind;
  channel: ChannelKind;
  dayOffset: number;
  isFirstTouch: boolean;
  /** From `wordLimitForStep` / `charLimitForStep`; null when the limit does not apply. */
  wordLimit: number | null;
  charLimit: number | null;
}

export interface CopyThreadContext {
  subject: string | null;
  body: string;
}

export interface CopyRecipientContext {
  companyName: string | null;
  contactTitle: string | null;
}

export interface CopyRevisionContext {
  /** 2 = first revision after the initial draft. */
  attempt: number;
  previousDraft: DraftOutput;
  /** Human-readable violations from the critic and the code checks. */
  violations: string[];
  fix: string | null;
}

export interface CopyPromptInput {
  offer: CopyOfferContext;
  angle: CopyAngleContext;
  step: CopyStepContext;
  recipient: CopyRecipientContext;
  brief: ResearchBriefOutput;
  /** For `thread: "same"` follow-ups: the message this one continues. */
  thread: CopyThreadContext | null;
  /** Name + postal address, exactly as it must appear at the end of an email. */
  signatureBlock: string;
  optOutLine: string;
  language: string | null;
  revision: CopyRevisionContext | null;
}

/** Static context first so provider prompt caching applies (section 6). */
export function copySystemPrompt(): string {
  return [
    "You are Scout's copywriter. You write ONE cold outreach message for ONE recipient.",
    "The owner sends it from their own name; you never claim a relationship that does not",
    "exist and you never invent a fact.",
    "",
    "## Rules the reviewer enforces",
    "1. Length: a first email is at most 110 words, a follow-up at most 70 words, a LinkedIn",
    "   message at most 300 characters. Shorter is better.",
    "2. Structure: exactly one observation about the company that comes from a real signal,",
    "   one concrete idea, and one low-friction question as the call to action.",
    "3. Grounding: every factual statement about the company must appear in the brief and be",
    "   listed in `claims` with the index of the signal it came from. No signal, no claim.",
    "4. Proof: only cite a result, client or number that appears in the offer's proof list.",
    "   If the proof list is empty, make no such claim at all.",
    "5. Plain text. No images, no HTML, no links in the first email. The signature block is",
    "   the only exception and only for follow-ups.",
    "6. Never use these: \"just following up\", \"following up on my last email\",",
    "   \"circling back\", \"touching base\", \"hope this email finds you well\",",
    "   \"quick question for you\", \"game-changer\", \"cutting-edge\", \"synergy\",",
    "   \"leverage\", \"unlock the power\", \"no-brainer\", plus any flattery or fake",
    "   familiarity (\"big fan\", \"love what you're doing\", \"as a fellow\").",
    "7. Every email ends with the exact signature block provided, which includes the opt-out",
    "   line. Do not rewrite, shorten or reorder it.",
    "8. Each follow-up must add something new: a different angle, a new signal or a useful",
    "   example. Never a reminder that you wrote before.",
    "",
    "## Output",
    "Return only the JSON object: subject (emails only, max 60 chars, no clickbait), body,",
    "claims (each { text, signalIndex }), cta (the question), angle (one of the allowed keys).",
  ].join("\n");
}

export function copyUserPrompt(input: CopyPromptInput): string {
  const { offer, angle, step, recipient, brief, thread, revision } = input;
  return [
    "## Sender",
    `Offer: ${offer.title}`,
    `What it is: ${offer.description}`,
    `Proof you may cite: ${proofText(offer.proof)}`,
    "",
    "## Angle for this message",
    `Key: ${angle.key}`,
    `Hook: ${angle.hook}`,
    `Allowed angle keys: ${angle.allowedKeys.join(", ") || "none"}`,
    "",
    "## Recipient",
    `Company: ${recipient.companyName ?? "unknown"}`,
    `Role: ${recipient.contactTitle ?? "unknown"}`,
    input.language ? `Language to write in: ${input.language}` : "Write in English.",
    "",
    "## Step",
    `Sequence step: ${step.key} (${step.kind}, day ${step.dayOffset}, ${step.channel})`,
    step.wordLimit !== null ? `Maximum: ${step.wordLimit} words.` : "",
    step.charLimit !== null ? `Maximum: ${step.charLimit} characters.` : "",
    "",
    "## Research brief",
    `Summary: ${brief.summary}`,
    `Likely pains: ${listOrNone(brief.likelyPains)}`,
    `AI opportunity: ${brief.aiOpportunity}`,
    "Signals (use the index in `claims`):",
    ...(brief.signals.length > 0
      ? brief.signals.map((signal, index) => `  [${index}] ${signal.fact} (${signal.url})`)
      : ["  none — make no company-specific claims"]),
    "Candidate hooks:",
    ...(brief.hooks.length > 0 ? brief.hooks.map((hook) => `  - ${hook.text} (signal ${hook.signalIndex})`) : ["  none"]),
    "",
    thread
      ? [
          "## Thread being continued",
          "The recipient already received this message. Continue the same email thread; do not",
          "repeat its opening or its question.",
          `Subject: ${thread.subject ?? "(none)"}`,
          "Body:",
          thread.body,
          "",
        ].join("\n")
      : "",
    "## Required ending for emails",
    "End the body with exactly this block:",
    input.signatureBlock,
    input.optOutLine,
    "",
    revision
      ? [
          `## Revision ${revision.attempt}`,
          "The previous attempt failed review. Fix every violation and keep what worked.",
          "Violations:",
          ...revision.violations.map((violation) => `  - ${violation}`),
          revision.fix ? `Reviewer instruction: ${revision.fix}` : "",
          "Previous attempt JSON:",
          JSON.stringify(revision.previousDraft),
          "",
        ].join("\n")
      : "",
    "Return the JSON object now.",
  ]
    .filter((section) => section.length > 0)
    .join("\n");
}

/** Appended to the single retry after a schema failure (section 10 rule 5). */
export function copyRepairHint(): string {
  return [
    "Return ONLY the JSON object. Required fields: body (string), claims (array of",
    '{ text, signalIndex }), cta (string), angle (one of the allowed keys).',
    "`subject` is optional for LinkedIn and required for email first touches.",
  ].join("\n");
}

function proofText(proof: ProofItem[]): string {
  if (proof.length === 0) return "none — do not cite results, clients or numbers";
  return proof.map((item) => `${item.label}: ${item.detail}`).join(" | ");
}

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join("; ") : "none";
}
