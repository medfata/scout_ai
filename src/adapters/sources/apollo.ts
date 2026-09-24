import { z } from "zod";

import { SIZE_BAND_TO_APOLLO_RANGE } from "@/src/domain/sequence";
import { normalizeDomain } from "@/src/domain/suppression";
import { getEnv, hasVendorVar, type VendorVar } from "@/src/lib/env";
import { ConfigurationError, VendorError } from "@/src/lib/errors";
import type { IcpSearchInput, LeadCandidate, LeadSource } from "@/src/ports/lead-source";
import { sizeBandFromEmployees } from "./csv";

/**
 * Apollo adapter. Section 6: "Apollo filters are built by the Apollo adapter from
 * `titles`, `industries`, `sizeBands` and `geos`, not by the model." The model never
 * sees an Apollo field name; everything here is derived from the ICP row.
 *
 * The endpoint is the one the current docs publish:
 * `POST https://api.apollo.io/api/v1/mixed_people/api_search` with an `x-api-key`
 * header (docs.apollo.io/reference/people-api-search, read 2026-09-24). On the free
 * plan it requires an account registered with a work email and it returns obfuscated
 * last names plus no email or company domain. If the key's plan cannot call it, the
 * error is a `vendor_auth` VendorError that names the plan problem — Scout never falls
 * back to another provider on its own (section 0).
 */

const APOLLO_URL = "https://api.apollo.io/api/v1/mixed_people/api_search";
const APOLLO_TIMEOUT_MS = 20_000;
const APOLLO_MAX_PER_PAGE = 100;

export const APOLLO_RESPONSE_SCHEMA = z.looseObject({
  total_entries: z.number().optional(),
  people: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        first_name: z.string().nullish(),
        /** The documented field on the free tier. */
        last_name_obfuscated: z.string().nullish(),
        /** Present on plans that return full records. */
        last_name: z.string().nullish(),
        title: z.string().nullish(),
        organization: z
          .looseObject({
            name: z.string().nullish(),
            industry: z.string().nullish(),
            primary_domain: z.string().nullish(),
            website_url: z.string().nullish(),
            estimated_num_employees: z.number().nullish(),
            country: z.string().nullish(),
          })
          .nullish(),
      }),
    )
    .default([]),
});

export type ApolloPerson = z.infer<typeof APOLLO_RESPONSE_SCHEMA>["people"][number];

export interface ApolloSourceOptions {
  /** Explicit key for spikes/tests; defaults to `APOLLO_API_KEY` from the env. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createApolloSource(options: ApolloSourceOptions = {}): LeadSource {
  const apiKey = options.apiKey ?? requireVendorKey("APOLLO_API_KEY");
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? APOLLO_URL;
  const timeoutMs = options.timeoutMs ?? APOLLO_TIMEOUT_MS;

  return {
    name: "apollo",
    searchesPerCall: 0,
    async search(input) {
      const body = buildApolloBody(input.icp, input.limit, input.excludeDomains);

      let response: Response;
      try {
        response = await fetchImpl(baseUrl, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "content-type": "application/json",
            "cache-control": "no-cache",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new VendorError("apollo", `People search request failed: ${messageOf(error)}`, {
          code: "vendor_unavailable",
          retryable: true,
          cause: error,
        });
      }

      if (response.status === 403 || response.status === 404) {
        throw new VendorError(
          "apollo",
          `Apollo rejected the people search (HTTP ${response.status}). The Apollo free plan may not include people search ` +
            "(it requires an account registered with a work email), or this key may lack the mixed_people_api_search scope. " +
            "Scout did not switch providers — check the Apollo plan or import a CSV instead. See DECISIONS.md.",
          { code: "vendor_auth", status: response.status, context: { endpoint: "mixed_people/api_search" } },
        );
      }
      if (!response.ok) {
        throw VendorError.fromStatus("apollo", response.status, await readBodyText(response), {
          endpoint: "mixed_people/api_search",
        });
      }

      const payload = await parseJson(response, "apollo");
      const parsed = APOLLO_RESPONSE_SCHEMA.safeParse(payload);
      if (!parsed.success) {
        throw new VendorError("apollo", "Apollo returned an unexpected people search shape.", {
          code: "vendor_unavailable",
          context: { issues: parsed.error.issues.length },
        });
      }

      return parsed.data.people
        .map(toCandidate)
        .filter((candidate): candidate is LeadCandidate => candidate !== null)
        .slice(0, input.limit);
    },
  };
}

/** Pure: the same ICP always produces the same Apollo body, which is what tests assert. */
export function buildApolloBody(
  icp: IcpSearchInput,
  limit: number,
  excludeDomains: string[] = [],
): Record<string, unknown> {
  const explicit = icp.searchFilters.apollo;

  const body: Record<string, unknown> = {
    person_titles: unique([...(explicit?.person_titles ?? []), ...icp.titles]),
    person_locations: unique([...(explicit?.person_locations ?? []), ...icp.geos]),
    organization_num_employees_ranges: unique([
      ...(explicit?.organization_num_employees_ranges ?? []),
      ...icp.sizeBands.map((band) => SIZE_BAND_TO_APOLLO_RANGE[band]),
    ]),
    page: 1,
    per_page: Math.min(Math.max(limit, 1), APOLLO_MAX_PER_PAGE),
  };

  const industries = unique([...(explicit?.organization_industries ?? []), ...icp.industries]);
  if (industries.length > 0) body.organization_industries = industries;

  const notTitles = unique([...(explicit?.person_not_titles ?? []), ...icp.disqualifiers]);
  if (notTitles.length > 0) body.person_not_titles = notTitles;

  const excluded = unique(excludeDomains);
  if (excluded.length > 0) body.not_organization_websites_list = excluded.slice(0, 1000);

  return body;
}

function toCandidate(person: ApolloPerson): LeadCandidate | null {
  const fullName = [person.first_name, person.last_name ?? person.last_name_obfuscated]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .trim();
  if (!fullName) return null;

  const organization = person.organization ?? null;
  const domain = organization?.primary_domain ?? organization?.website_url ?? null;
  const employees = organization?.estimated_num_employees ?? null;

  return {
    fullName,
    title: person.title ?? null,
    companyName: organization?.name ?? null,
    companyDomain: domain ? normalizeDomain(domain) || null : null,
    companyLinkedinUrl: null,
    companyIndustry: organization?.industry ?? null,
    companySizeBand: employees !== null ? sizeBandFromEmployees(String(employees)) : null,
    companyCountry: organization?.country ?? null,
    /** This endpoint returns neither: email comes from verification, LinkedIn from Exa/CSV. */
    linkedinUrl: null,
    email: null,
    source: "apollo",
    raw: { ...person } as Record<string, unknown>,
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

function requireVendorKey(name: VendorVar): string {
  if (!hasVendorVar(name)) {
    throw new ConfigurationError(`${name} is not set. Add it to .env.local (see .env.example) or skip this lead source.`, {
      vendor: "apollo",
    });
  }
  const value = getEnv()[name];
  if (!value) throw new ConfigurationError(`${name} is empty.`, { vendor: "apollo" });
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "network error";
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function parseJson(response: Response, vendor: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new VendorError(vendor, "Response was not valid JSON.", {
      code: "vendor_unavailable",
      retryable: true,
      cause: error,
    });
  }
}
