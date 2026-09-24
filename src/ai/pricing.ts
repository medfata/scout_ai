/**
 * Token prices in USD, read from the Vercel AI Gateway model list.
 * Regenerate with `pnpm tsx scripts/refresh-models.ts` (section 10 rule 1: "Read current
 * docs, never memory").
 *
 * Generated 2026-09-24 from https://ai-gateway.vercel.sh/v1/models
 * Keys with a provider prefix are Gateway ids; bare keys are Google AI Studio ids used
 * with GEMINI_API_KEY (the free research tier, section 0).
 */

export interface TokenPrice {
  /** USD per input token. */
  input: number;
  /** USD per output token. */
  output: number;
  /** USD per cached input token read. */
  cacheRead: number;
  /** USD per cached input token written. */
  cacheWrite: number;
}

export const MODEL_PRICES: Readonly<Record<string, TokenPrice>> = Object.freeze({
  "anthropic/claude-haiku-4.5": { input: 0.000001, output: 0.000005, cacheRead: 0.0000001, cacheWrite: 0.00000125 },
  "anthropic/claude-sonnet-5": { input: 0.000002, output: 0.00001, cacheRead: 0.0000002, cacheWrite: 0.0000025 },
  "anthropic/claude-sonnet-4.6": { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  "google/gemini-3.8-flash": { input: 0.00000075, output: 0.00000375, cacheRead: 0.000000075, cacheWrite: 0 },
  "gemini-3.8-flash": { input: 0.00000075, output: 0.00000375, cacheRead: 0.000000075, cacheWrite: 0 },
  "google/gemini-3.7-flash": { input: 0.00000075, output: 0.00000375, cacheRead: 0.000000075, cacheWrite: 0 },
  "gemini-3.7-flash": { input: 0.00000075, output: 0.00000375, cacheRead: 0.000000075, cacheWrite: 0 },
  "google/gemini-2.5-flash": { input: 0.0000003, output: 0.0000025, cacheRead: 0.00000003, cacheWrite: 0 },
  "gemini-2.5-flash": { input: 0.0000003, output: 0.0000025, cacheRead: 0.00000003, cacheWrite: 0 },
  "google/gemini-3.5-flash": { input: 0.0000015, output: 0.000009, cacheRead: 0.00000015, cacheWrite: 0 },
  "gemini-3.5-flash": { input: 0.0000015, output: 0.000009, cacheRead: 0.00000015, cacheWrite: 0 },
});

export interface UsageLike {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined } | undefined;
}

/**
 * Cost in USD for one call. Falls back to 0 for an unknown model rather than guessing a
 * price; the unknown case is logged so the owner can add the model.
 */
export function costOfUsage(model: string, usage: UsageLike): { costUsd: number; known: boolean } {
  const price = MODEL_PRICES[model];
  if (!price) return { costUsd: 0, known: false };

  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const freshInput = Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  const output = usage.outputTokens ?? 0;

  const costUsd =
    freshInput * price.input + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite + output * price.output;

  return { costUsd, known: true };
}
