import type { ChannelKind, DraftClaim } from "@/src/domain/types";
import { COPY_LIMITS, isFirstTouch, type SequenceStep } from "@/src/domain/sequence";

/**
 * Section 6, "Copy rules the critic enforces". The critic model checks meaning;
 * these checks are the code half of "AI decides content, code decides actions", and
 * they are what the approval inbox shows the owner before a message can be sent.
 *
 * Nothing here is a style preference: every rule maps to a line in the plan.
 */

export type ViolationCode =
  | "too_long"
  | "subject_too_long"
  | "ungrounded_claim"
  | "no_cta_question"
  | "multiple_ctas"
  | "link_in_first_email"
  | "banned_phrase"
  | "missing_opt_out"
  | "missing_signature"
  | "empty_body"
  | "angle_mismatch"
  | "invented_number";

export interface Violation {
  code: ViolationCode;
  message: string;
  severity: "error" | "warning";
}

export interface CopyRuleInput {
  step: SequenceStep;
  channel: ChannelKind;
  body: string;
  subject?: string | null;
  claims: DraftClaim[];
  /** Number of signals in the research brief; `claims[].signalIndex` must point inside it. */
  signalCount: number;
  /** Angle keys the ICP allows; the draft must declare one of them. */
  angleKeys: string[];
  angle: string;
  /** Entries in the offer's `proof` array. Zero means the draft may not cite results. */
  proofCount: number;
  /** True when the body already carries the owner's signature block. */
  hasSignature: boolean;
}

/** Plain-text marketing speak the plan bans. Kept in code so prompts and checks agree. */
export const BANNED_PHRASES: readonly string[] = [
  "just following up",
  "following up on my last email",
  "circling back",
  "touching base",
  "hope this email finds you well",
  "hope this finds you well",
  "i hope you're doing well",
  "quick question for you",
  "i'll keep this brief",
  "as per my last email",
  "bumping this",
  "any thoughts?",
  "game-changer",
  "game changer",
  "revolutionary",
  "cutting-edge",
  "synergy",
  "leverage",
  "disrupt",
  "unlock the power",
  "10x",
  "skyrocket",
  "no-brainer",
  "i noticed that you",
  "as a fellow",
  "big fan of your work",
  "love what you're doing",
];

/** Phrases that count as the opt-out line required on every email (section 9). */
export const OPT_OUT_PHRASES: readonly string[] = [
  "opt out",
  "opt-out",
  "unsubscribe",
  "stop these emails",
  "say no and i'll stop",
  "reply stop",
  "don't want to hear from me",
  "do not want to hear from me",
  "no thanks and i'll",
  // `DEFAULT_OPT_OUT_LINE` below is the line the copy prompt mandates, so the critic has to
  // accept it. Without these two the default line matched nothing and every draft failed
  // `missing_opt_out` — caught by the evals before a single model call was paid for.
  'reply "no"',
  "won't email you again",
];

const LINK_PATTERN = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i;
const NUMBER_PATTERN = /\b\d+(?:[.,]\d+)?\s*(?:%|x|k|m|hours?|days?|weeks?|months?|clients?|customers?|users?|leads?|revenue|arr|mrr)\b/gi;

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0).length;
}

export function evaluateCopyRules(input: CopyRuleInput): Violation[] {
  const violations: Violation[] = [];
  const body = input.body.trim();
  const lowerBody = body.toLowerCase();

  if (body.length === 0) {
    violations.push({ code: "empty_body", message: "Body is empty.", severity: "error" });
    return violations;
  }

  if (!input.angleKeys.includes(input.angle)) {
    violations.push({
      code: "angle_mismatch",
      message: `Draft declares angle "${input.angle}", which is not one of the ICP angles (${input.angleKeys.join(", ")}).`,
      severity: "error",
    });
  }

  // Word and character limits.
  const limit = wordLimitFor(input.step);
  if (limit !== null) {
    const words = countWords(body);
    if (words > limit) {
      violations.push({
        code: "too_long",
        message: `Body is ${words} words; the limit for ${input.step.key} is ${limit}.`,
        severity: "error",
      });
    }
  }
  if (input.channel === "linkedin" && body.length > COPY_LIMITS.linkedinMessageMaxChars) {
    violations.push({
      code: "too_long",
      message: `LinkedIn message is ${body.length} characters; the limit is ${COPY_LIMITS.linkedinMessageMaxChars}.`,
      severity: "error",
    });
  }
  if (input.subject && input.subject.length > COPY_LIMITS.subjectMaxChars) {
    violations.push({
      code: "subject_too_long",
      message: `Subject is ${input.subject.length} characters; the limit is ${COPY_LIMITS.subjectMaxChars}.`,
      severity: "warning",
    });
  }

  // Grounding: every claim points at a signal that exists.
  for (const claim of input.claims) {
    if (!Number.isInteger(claim.signalIndex) || claim.signalIndex < 0 || claim.signalIndex >= input.signalCount) {
      violations.push({
        code: "ungrounded_claim",
        message: `Claim "${claim.text.slice(0, 60)}" points at signal ${claim.signalIndex}, but the brief has ${input.signalCount}.`,
        severity: "error",
      });
    }
  }

  // One concrete idea, one low-friction question as the call to action.
  const questionCount = (body.match(/\?/g) ?? []).length;
  if (questionCount === 0) {
    violations.push({
      code: "no_cta_question",
      message: "No question in the body. The call to action must be a low-friction question.",
      severity: "error",
    });
  } else if (questionCount > 2) {
    violations.push({
      code: "multiple_ctas",
      message: `${questionCount} questions in the body; keep one clear call to action.`,
      severity: "warning",
    });
  }

  // Plain text, no links in the first email except the signature.
  if (isFirstTouch(input.step) && input.channel === "email") {
    const bodyWithoutSignature = input.hasSignature ? stripSignature(body) : body;
    if (LINK_PATTERN.test(bodyWithoutSignature)) {
      violations.push({
        code: "link_in_first_email",
        message: "Email 1 contains a link outside the signature. Section 6 requires plain text with no links in email 1.",
        severity: "error",
      });
    }
  }

  for (const phrase of BANNED_PHRASES) {
    if (lowerBody.includes(phrase)) {
      violations.push({
        code: "banned_phrase",
        message: `Banned phrase found: "${phrase}".`,
        severity: "error",
      });
    }
  }

  // Never invent results, clients or numbers; proof comes only from the offer record.
  const numbers = body.match(NUMBER_PATTERN) ?? [];
  if (numbers.length > 0 && input.proofCount === 0 && !hasOfferBackedClaim(input.claims, input.proofCount)) {
    violations.push({
      code: "invented_number",
      message: `Body cites ${numbers.join(", ")} but the offer has no proof entries to back a number.`,
      severity: "error",
    });
  }

  if (input.channel === "email") {
    if (!OPT_OUT_PHRASES.some((phrase) => lowerBody.includes(phrase))) {
      violations.push({
        code: "missing_opt_out",
        message: "No opt-out line. Section 9 requires an easy opt-out on every email.",
        severity: "error",
      });
    }
    if (!input.hasSignature) {
      violations.push({
        code: "missing_signature",
        message: "Body has no signature block; emails must say who the owner is.",
        severity: "warning",
      });
    }
  }

  return violations;
}

export function hasBlockingViolations(violations: Violation[]): boolean {
  return violations.some((violation) => violation.severity === "error");
}

function wordLimitFor(step: SequenceStep): number | null {
  if (step.channel !== "email") return null;
  return isFirstTouch(step) ? COPY_LIMITS.emailFirstTouchMaxWords : COPY_LIMITS.emailFollowUpMaxWords;
}

function stripSignature(body: string): string {
  // Signatures are conventionally separated by a blank line followed by "--".
  const index = body.search(/\n\s*(?:--|—)\s*\n/);
  return index === -1 ? body : body.slice(0, index);
}

function hasOfferBackedClaim(claims: DraftClaim[], proofCount: number): boolean {
  return proofCount > 0 && claims.length > 0;
}

/**
 * Renders the owner's signature for a channel. Kept here so the copywriter, the
 * approval inbox and the send path all produce identical text.
 */
export function buildSignature(signature: string, postalAddress: string, optOutLine?: string): string {
  const parts = [signature.trim()];
  if (postalAddress.trim()) parts.push(postalAddress.trim());
  if (optOutLine) parts.push(optOutLine);
  return parts.filter((part) => part.length > 0).join("\n");
}

export const DEFAULT_OPT_OUT_LINE =
  "Not interested? Reply \"no\" and I won't email you again.";
