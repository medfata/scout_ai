/**
 * Helpers shared by every promptfoo `file://` assertion in `evals/assertions`.
 *
 * Promptfoo hands a JS assertion `(output, context)`. Both arrive untyped, so everything here
 * narrows with `unknown`, never `any`. Raw model output travels in the provider's `metadata`
 * (under `scout`) so the printed eval table stays free of message bodies and addresses
 * (section 10 rule 11).
 */

export interface GradingResult {
  pass: boolean;
  score: number;
  reason: string;
}

export function grade(pass: boolean, reason: string, score?: number): GradingResult {
  return { pass, score: score ?? (pass ? 1 : 0), reason };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Reads `vars.<name>` from an assertion context, whatever shape promptfoo passed. */
export function readVar(context: unknown, name: string): string | null {
  if (!isRecord(context)) return null;
  const vars = context.vars;
  if (!isRecord(vars)) return null;
  return asString(vars[name]);
}

/**
 * The raw payload a Scout provider put in `providerResponse.metadata.scout`.
 * Returns null when the assertion ran without a provider or the provider failed.
 */
export function readScoutPayload(context: unknown): Record<string, unknown> | null {
  if (!isRecord(context)) return null;

  const candidates: unknown[] = [];
  if (isRecord(context.providerResponse)) candidates.push(context.providerResponse.metadata);
  candidates.push(context.metadata);

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const scout = candidate.scout;
    if (isRecord(scout)) return scout;
  }
  return null;
}

/** Parses a provider output that is a JSON string; returns null when it is not an object. */
export function parseOutputObject(output: unknown): Record<string, unknown> | null {
  if (isRecord(output)) return output;
  const text = asString(output);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Joins reasons for a multi-check assertion. */
export function joinReasons(reasons: string[]): string {
  return reasons.length > 0 ? reasons.join(" | ") : "passed";
}
