/**
 * Section 6 copy rules, in code, for the copywriter + critic eval.
 *
 * The real checks are `evaluateCopyRules` from `src/domain/copy-rules.ts` — this file adds
 * nothing that is already there. It asserts zero **errors** (warnings are reported, not
 * failed), plus the extra code checks stage 1b asks for: a valid `DraftSchema` parse, exactly
 * one CTA question outside the signature/opt-out, a subject on first-touch emails, and a
 * draft the critic and the code both passed.
 *
 * Every message here is violation text or an id; no body, no address (section 10 rule 11).
 */
import { DraftSchema } from "@/src/ai/schemas";
import { evaluateCopyRules, type CopyRuleInput } from "@/src/domain/copy-rules";
import { EMAIL_LINKEDIN_V1 } from "@/src/domain/sequence";

import { countCtaQuestions, countWords } from "../lib/copy-check";
import {
  asBoolean,
  asNumber,
  asString,
  asArray,
  grade,
  isRecord,
  readScoutPayload,
  type GradingResult,
} from "../lib/grading";

export default function checkCopyRules(_output: unknown, context: unknown): GradingResult {
  const payload = readScoutPayload(context);
  if (payload === null) return grade(false, "copy eval: no provider metadata reached the assertion");

  const stepKey = asString(payload.stepKey);
  const step = EMAIL_LINKEDIN_V1.steps.find((candidate) => candidate.key === stepKey);
  if (!step) return grade(false, `copy eval: unknown step key "${stepKey ?? "(missing)"}"`);

  const draft = payload.draft;
  const parsed = DraftSchema.safeParse(draft);
  if (!parsed.success) {
    return grade(false, `copy eval: draft failed DraftSchema: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }

  const signalCount = asNumber(payload.signalCount);
  const proofCount = asNumber(payload.proofCount);
  const angle = asString(payload.angle);
  const angleKeys = asArray(payload.angleKeys)?.filter((key): key is string => typeof key === "string") ?? [];
  const hasSignature = asBoolean(payload.hasSignature);
  const signatureBlock = asString(payload.signatureBlock);
  const optOutLine = asString(payload.optOutLine);
  if (
    signalCount === null ||
    proofCount === null ||
    angle === null ||
    hasSignature === null ||
    signatureBlock === null ||
    optOutLine === null ||
    angleKeys.length === 0
  ) {
    return grade(false, "copy eval: provider metadata is incomplete (signalCount, proofCount, angle, angleKeys, signature)");
  }

  const body = parsed.data.body;
  const copyRules: CopyRuleInput = {
    step,
    channel: step.channel,
    body,
    subject: parsed.data.subject ?? null,
    claims: parsed.data.claims,
    signalCount,
    angleKeys,
    angle,
    proofCount,
    hasSignature,
  };

  const violations = evaluateCopyRules(copyRules);
  const errors = violations.filter((violation) => violation.severity === "error");
  const warnings = violations.filter((violation) => violation.severity === "warning");
  const problems: string[] = [];

  if (errors.length > 0) {
    problems.push(...errors.map((violation) => `${violation.code}: ${violation.message}`));
  }

  const ctaQuestions = countCtaQuestions(body, signatureBlock, optOutLine);
  if (ctaQuestions !== 1) {
    problems.push(`exactly one CTA question expected outside the signature; found ${ctaQuestions}`);
  }

  if (step.channel === "email" && parsed.data.subject === undefined) {
    problems.push("email steps need a subject");
  }

  const verdict = isRecord(payload.verdict) ? payload.verdict : null;
  const outcome = asString(payload.outcome);
  const criticPassed = verdict ? asBoolean(verdict.criticPassed) : null;
  const mergedPassed = verdict ? asBoolean(verdict.passed) : null;
  if (outcome !== "passed" || mergedPassed !== true) {
    const violationList = verdict ? asArray(verdict.violations) : null;
    const codes = violationList
      ? violationList.filter((entry): entry is string => typeof entry === "string").join(", ")
      : "none";
    problems.push(`the critic + code merge did not pass (outcome=${outcome ?? "missing"}, critic=${String(criticPassed)}, violations: ${codes})`);
  }

  if (problems.length > 0) return grade(false, problems.join(" | "));

  const detail = [`${countWords(body)} words`, `${body.length} chars`];
  if (warnings.length > 0) detail.push(`warnings: ${warnings.map((warning) => warning.code).join(", ")}`);
  return grade(true, `copy rules, DraftSchema and one-question CTA all pass (${detail.join(", ")})`);
}
