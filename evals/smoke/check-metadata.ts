/**
 * Smoke assertion: fails unless promptfoo handed the provider's `metadata.scout` payload to a
 * TypeScript `file://` assertion. No model calls, no key required.
 */
import { grade, readScoutPayload, readVar, type GradingResult } from "../lib/grading";

export default function checkMetadata(_output: unknown, context: unknown): GradingResult {
  const payload = readScoutPayload(context);
  if (payload === null) {
    return grade(false, "providerResponse.metadata.scout did not reach the assertion");
  }
  const smokeId = readVar(context, "smokeId");
  if (payload.payload !== "from-metadata") {
    return grade(false, `unexpected metadata payload: ${String(payload.payload)}`);
  }
  if (smokeId !== null && payload.smokeId !== smokeId) {
    return grade(false, "test vars and provider metadata disagree");
  }
  return grade(true, "metadata and vars plumbed through");
}
