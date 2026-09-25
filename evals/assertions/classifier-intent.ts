/**
 * Reply-intent agreement, in code: the provider's label must equal the fixture's label.
 *
 * All 11 intents from `ReplyLabelSchema` are covered; the ≥90% bar across the whole labelled
 * set is enforced by `PROMPTFOO_PASS_RATE_THRESHOLD=90` on the classifier run (see
 * `evals/README.md`), not by per-test grading.
 */
import { asString, grade, readScoutPayload, type GradingResult } from "../lib/grading";
import { replyById } from "../golden/leads";

export default function checkClassifierIntent(_output: unknown, context: unknown): GradingResult {
  const payload = readScoutPayload(context);
  if (payload === null) return grade(false, "classifier eval: no provider metadata reached the assertion");

  const replyId = asString(payload.replyId);
  const actual = asString(payload.intent);
  if (replyId === null || actual === null) {
    return grade(false, "classifier eval: provider metadata has no replyId or intent");
  }

  const expected = replyById(replyId).intent;
  if (actual !== expected) {
    return grade(false, `${replyId}: expected ${expected}, got ${actual}`);
  }
  return grade(true, `${replyId}: ${actual}`);
}
