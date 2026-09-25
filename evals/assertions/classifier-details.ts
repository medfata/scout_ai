/**
 * Structured extras for the replies where the intent alone is not enough: out-of-office
 * return dates (present/absent/exact), not-now follow-up dates, and named referrals.
 * Only fixtures that state an expectation are checked.
 */
import { asString, grade, isRecord, readScoutPayload, type GradingResult } from "../lib/grading";
import { replyById } from "../golden/leads";

export default function checkClassifierDetails(_output: unknown, context: unknown): GradingResult {
  const payload = readScoutPayload(context);
  if (payload === null) return grade(false, "classifier details: no provider metadata reached the assertion");

  const replyId = asString(payload.replyId);
  if (replyId === null) return grade(false, "classifier details: provider metadata has no replyId");

  const fixture = replyById(replyId);
  const expect = fixture.expect;
  if (!expect) return grade(true, `${replyId}: no structured expectations`);

  const problems: string[] = [];
  const returnDate = asString(payload.returnDate);
  const followUpAfter = asString(payload.followUpAfter);

  if (expect.returnDate) {
    if (expect.returnDate.present && returnDate === null) {
      problems.push("returnDate expected but missing");
    }
    if (!expect.returnDate.present && returnDate !== null) {
      problems.push(`returnDate should be absent, got a value`);
    }
    if (returnDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) {
      problems.push(`returnDate is not YYYY-MM-DD: ${returnDate}`);
    }
    if (expect.returnDate.exact !== undefined && returnDate !== expect.returnDate.exact) {
      problems.push(`returnDate expected ${expect.returnDate.exact}, got ${returnDate ?? "(none)"}`);
    }
  }

  if (expect.followUpAfter) {
    if (expect.followUpAfter.present && followUpAfter === null) problems.push("followUpAfter expected but missing");
    if (!expect.followUpAfter.present && followUpAfter !== null) problems.push("followUpAfter should be absent");
    if (followUpAfter !== null && !/^\d{4}-\d{2}-\d{2}$/.test(followUpAfter)) {
      problems.push(`followUpAfter is not YYYY-MM-DD: ${followUpAfter}`);
    }
  }

  if (expect.referralName !== undefined) {
    const referral = isRecord(payload.referral) ? payload.referral : null;
    const name = referral ? asString(referral.name) : null;
    if (name === null || !name.toLowerCase().includes(expect.referralName.toLowerCase())) {
      problems.push(`referral name expected to contain "${expect.referralName}", got "${name ?? "(none)"}"`);
    }
  }

  if (problems.length > 0) return grade(false, `${replyId}: ${problems.join(" | ")}`);
  return grade(true, `${replyId}: structured extras agree`);
}
