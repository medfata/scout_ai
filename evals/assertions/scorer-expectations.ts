/**
 * Scorer expectations, checked in code against the real `applyScoreRules` result.
 *
 * The fixture says what the lead is (clear fit, weak fit, disqualifier, suppressed…); the
 * provider returns what the model scored and what the code rules did with it. This assertion
 * only compares the two — no model grading, no judgement calls.
 */
import { asNumber, asString, asBoolean, grade, readScoutPayload, type GradingResult } from "../lib/grading";
import { leadById } from "../golden/leads";

export default function checkScorerExpectations(_output: unknown, context: unknown): GradingResult {
  const payload = readScoutPayload(context);
  if (payload === null) return grade(false, "scorer eval: no provider metadata reached the assertion");

  const leadId = asString(payload.leadId);
  if (leadId === null) return grade(false, "scorer eval: provider metadata has no leadId");

  const lead = leadById(leadId);
  const score = asNumber(payload.score);
  const tier = payload.tier === null ? null : asString(payload.tier);
  const disqualified = asBoolean(payload.disqualified);
  const reason = asString(payload.disqualifiedReason);

  if (score === null || disqualified === null) {
    return grade(false, `scorer eval: score or disqualified missing for ${lead.id}`);
  }
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    return grade(false, `scorer eval: score ${score} is outside 0..100`);
  }

  const problems: string[] = [];
  const expect = lead.expect;

  if (expect.disqualified !== "either" && disqualified !== expect.disqualified) {
    problems.push(`expected disqualified=${expect.disqualified}, got ${disqualified}`);
  }
  if (disqualified && tier !== null) {
    problems.push(`a disqualified lead must have no tier, got ${tier}`);
  }
  if (!disqualified && tier === null) {
    problems.push("a non-disqualified lead must have a tier");
  }
  if (expect.tier !== undefined && tier !== expect.tier) {
    problems.push(`expected tier ${String(expect.tier)}, got ${String(tier)}`);
  }
  if (expect.minScore !== undefined && score < expect.minScore) {
    problems.push(`expected score >= ${expect.minScore}, got ${score}`);
  }
  if (expect.maxScore !== undefined && score > expect.maxScore) {
    problems.push(`expected score <= ${expect.maxScore}, got ${score}`);
  }
  if (expect.disqualifiedReasonIncludes !== undefined) {
    const needle = expect.disqualifiedReasonIncludes.toLowerCase();
    if (reason === null || !reason.toLowerCase().includes(needle)) {
      problems.push(`expected reason to contain "${expect.disqualifiedReasonIncludes}", got "${reason ?? "(none)"}"`);
    }
  }

  if (problems.length > 0) return grade(false, `${lead.id}: ${problems.join(" | ")}`);
  return grade(true, `${lead.id}: score ${score}, tier ${String(tier)}, disqualified ${disqualified}`);
}
