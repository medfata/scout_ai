import { z } from "zod";

import { normalizeDomain } from "@/src/domain/suppression";
import { getEnv, hasVendorVar, type VendorVar } from "@/src/lib/env";
import { ConfigurationError, VendorError } from "@/src/lib/errors";
import { logger } from "@/src/lib/logger";
import type { LeadCandidate, LeadSource } from "@/src/ports/lead-source";
import { assertExaQuota, recordExaSearch } from "@/src/services/quota";

/**
 * Exa adapter (section 2: "Fuzzy or niche ICPs, web research"). The natural-language
 * query and its criteria come from `icp.searchFilters.exa`, never from the model at
 * sourcing time (section 6).
 *
 * Every call goes through the Exa quota (section 0: 45/day, ~1,400/month). The hooks
 * are injectable so a test or a spike can run without a database; the defaults are the
 * real `assertExaQuota` / `recordExaSearch` service functions.
 */

const EXA_URL = "https://api.exa.ai/search";
const EXA_TIMEOUT_MS = 20_000;
const EXA_MAX_RESULTS = 100;
const EXA_MAX_CRITERIA = 5;

export const EXA_RESPONSE_SCHEMA = z.looseObject({
  requestId: z.string().optional(),
  results: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        title: z.string().nullish(),
        url: z.string(),
        publishedDate: z.string().nullish(),
        author: z.string().nullish(),
        text: z.string().nullish(),
      }),
    )
    .default([]),
});

export interface ExaQuotaHooks {
  assert(): Promise<void>;
  record(input: { query: string; icpId?: string; count?: number }): Promise<void>;
}

export interface ExaSourceOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  quota?: ExaQuotaHooks;
}

const DEFAULT_QUOTA: ExaQuotaHooks = {
  assert: () => assertExaQuota(),
  record: (input) => recordExaSearch(input),
};

export function createExaSource(options: ExaSourceOptions = {}): LeadSource {
  const apiKey = options.apiKey ?? requireVendorKey("EXA_API_KEY");
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? EXA_URL;
  const timeoutMs = options.timeoutMs ?? EXA_TIMEOUT_MS;
  const quota = options.quota ?? DEFAULT_QUOTA;

  return {
    name: "exa",
    searchesPerCall: 1,
    async search(input) {
      const query = buildExaQuery(input.icp);
      const body: Record<string, unknown> = {
        query: query.text,
        numResults: Math.min(Math.max(input.limit, 1), EXA_MAX_RESULTS),
        type: "auto",
      };
      if (input.excludeDomains.length > 0) body.excludeDomains = input.excludeDomains.slice(0, 100);

      await quota.assert();

      let response: Response;
      try {
        response = await fetchImpl(baseUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Count the attempt: over-counting pauses the stage early, never late (section 0).
        await quota.record({ query: query.base, icpId: input.icp.id });
        throw new VendorError("exa", `Search request failed: ${messageOf(error)}`, {
          code: "vendor_unavailable",
          retryable: true,
          cause: error,
        });
      }

      // The request reached Exa, so the search is counted before the body is read
      // (a malformed body must not silently skip metering).
      await quota.record({ query: query.base, icpId: input.icp.id });
      const payload = await parseJsonSafely(response, "exa");

      if (!response.ok) {
        throw VendorError.fromStatus("exa", response.status, typeof payload === "string" ? payload : JSON.stringify(payload));
      }

      const parsed = EXA_RESPONSE_SCHEMA.safeParse(payload);
      if (!parsed.success) {
        throw new VendorError("exa", "Exa returned an unexpected search shape.", {
          code: "vendor_unavailable",
          context: { issues: parsed.error.issues.length },
        });
      }

      return parsed.data.results
        .map(toCandidate)
        .filter((candidate): candidate is LeadCandidate => candidate !== null)
        .slice(0, input.limit);
    },
  };
}

/** Pure: query plus at most five criteria, in the order the ICP generator produced them. */
export function buildExaQuery(icp: { name: string; searchFilters: { exa?: { query: string; criteria: string[] } } }): {
  base: string;
  text: string;
} {
  const filters = icp.searchFilters.exa;
  const base = filters?.query?.trim() ?? "";
  if (!base) {
    throw new ConfigurationError(
      `ICP "${icp.name}" has no Exa search filters. Regenerate the ICP or remove Exa from this sourcing run.`,
      { vendor: "exa", icp: icp.name },
    );
  }
  const criteria = (filters?.criteria ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, EXA_MAX_CRITERIA);
  const text = criteria.length > 0 ? `${base}\nMust match all of these criteria:\n- ${criteria.join("\n- ")}` : base;
  if (criteria.length > 0) logger.debug("exa.query_built", { criteria: criteria.length });
  return { base, text };
}

/**
 * Exa results are web pages. Only person profile pages become candidates: a company
 * page has no decision-maker attached, so inventing one would be a hallucination.
 * LinkedIn profiles are kept even without a company domain; Apollo/CSV cover the rest.
 */
export function toCandidate(result: z.infer<typeof EXA_RESPONSE_SCHEMA>["results"][number]): LeadCandidate | null {
  const slug = /linkedin\.com\/(?:in|pub)\/([^/?#]+)/i.exec(result.url);
  if (!slug) return null;

  const person = parseLinkedinTitle(result.title ?? "");
  const author = result.author?.trim() ?? "";
  const name = person?.name ?? author;
  if (!isPersonName(name)) return null;

  const parsedUrl = safeUrl(result.url);
  const domain = parsedUrl && !parsedUrl.hostname.includes("linkedin.com") ? normalizeDomain(parsedUrl.hostname) : null;

  return {
    fullName: name,
    title: person?.title ?? null,
    companyName: person?.companyName ?? null,
    companyDomain: domain || null,
    companyLinkedinUrl: null,
    companyIndustry: null,
    companySizeBand: null,
    companyCountry: null,
    linkedinUrl: `https://www.linkedin.com/in/${slug[1]}`,
    /** Exa never returns a verified address; section 12 finds it by pattern guessing. */
    email: null,
    source: "exa",
    raw: { ...result } as Record<string, unknown>,
  };
}

/**
 * LinkedIn page titles follow a few shapes:
 *   "Marta Kowalska - Head of Customer Support at Northwind Logistics | LinkedIn"
 *   "Tomas Becker | LinkedIn"
 */
export function parseLinkedinTitle(rawTitle: string): { name: string; title: string | null; companyName: string | null } | null {
  const cleaned = rawTitle.replace(/\s*\|\s*linkedin\s*$/i, "").trim();
  const segments = cleaned.split(/\s+[-–—]\s+/);
  const name = (segments[0] ?? "").trim();
  if (!isPersonName(name)) return null;

  let rest = segments.slice(1).join(" - ").trim();
  if (rest.toLowerCase() === "linkedin") rest = "";
  let companyName: string | null = null;
  const at = /\s+at\s+(.+)$/i.exec(rest);
  if (at?.[1] && at.index !== undefined) {
    companyName = at[1].trim() || null;
    rest = rest.slice(0, at.index).trim();
  }

  return { name, title: rest || null, companyName };
}

function isPersonName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[0-9@|/]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => /^[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+$/.test(word));
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function requireVendorKey(name: VendorVar): string {
  if (!hasVendorVar(name)) {
    throw new ConfigurationError(`${name} is not set. Add it to .env.local (see .env.example) or skip this lead source.`, {
      vendor: "exa",
    });
  }
  const value = getEnv()[name];
  if (!value) throw new ConfigurationError(`${name} is empty.`, { vendor: "exa" });
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "network error";
}

/** Returns the parsed JSON, or the response text when the body is not JSON. */
async function parseJsonSafely(response: Response, vendor: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new VendorError(vendor, "Response was not valid JSON.", {
        code: "vendor_unavailable",
        retryable: true,
      });
    }
    return text;
  }
}
