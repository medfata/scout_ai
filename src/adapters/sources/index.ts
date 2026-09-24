import { hasVendorVar } from "@/src/lib/env";
import type { LeadSource, SignalSource } from "@/src/ports/lead-source";
import { createApolloSource } from "./apollo";
import { createCsvSource } from "./csv";
import { createExaSource } from "./exa";
import { createHackerNewsSource } from "./hn";

/**
 * The source registry. Factories throw a readable `ConfigurationError` when their key
 * is missing, but `getLeadSources()` checks first and simply leaves that source out —
 * the caller (the sourcing service) decides what a missing source means, so a missing
 * Apollo key cannot take down the app at import time (section 0, section 10 rule 12).
 *
 * CSV is not in the registry: it needs pasted text, so the UI/server action creates one
 * with `createCsvSource(text)` for that import only.
 */

export { createApolloSource, createCsvSource, createExaSource, createHackerNewsSource };
export { mapColumns, parseCsv, sizeBandFromEmployees } from "./csv";
export type { CsvField, CsvSourceOptions } from "./csv";
export type { ApolloSourceOptions } from "./apollo";
export type { ExaQuotaHooks, ExaSourceOptions } from "./exa";
export type { HackerNewsSourceOptions } from "./hn";

export function getLeadSources(): LeadSource[] {
  const sources: LeadSource[] = [];
  if (hasVendorVar("APOLLO_API_KEY")) sources.push(createApolloSource());
  if (hasVendorVar("EXA_API_KEY")) sources.push(createExaSource());
  return sources;
}

/** Hacker News is public and keyless, so it is always available (section 2). */
export function getSignalSources(): SignalSource[] {
  return [createHackerNewsSource()];
}
