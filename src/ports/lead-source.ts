import type { IcpSearchFilters, SizeBand } from "@/src/domain/types";

/**
 * Port: where candidate leads come from. Adapters: `apollo`, `exa`, `csv`, `hn`.
 * The interface deliberately speaks Scout's vocabulary, not any vendor's: the Apollo
 * adapter builds Apollo filters from these fields, no model ever sees vendor names
 * (section 6).
 */

export interface IcpSearchInput {
  id: string;
  name: string;
  titles: string[];
  industries: string[];
  sizeBands: SizeBand[];
  geos: string[];
  pains: string[];
  triggers: string[];
  disqualifiers: string[];
  /** Provider-specific extras produced by the ICP generator. */
  searchFilters: IcpSearchFilters;
}

export interface LeadCandidate {
  fullName: string;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  companyLinkedinUrl: string | null;
  companyIndustry: string | null;
  companySizeBand: SizeBand | null;
  companyCountry: string | null;
  linkedinUrl: string | null;
  email: string | null;
  /** Which adapter produced this row; stored on `companies.source` / `contacts.source`. */
  source: string;
  raw: Record<string, unknown>;
}

export interface LeadSourceSearchInput {
  icp: IcpSearchInput;
  limit: number;
  /** Domains already in the database, so adapters can skip them server-side when they can. */
  excludeDomains: string[];
}

export interface LeadSource {
  /** Stable identifier stored on rows this adapter produces. */
  readonly name: string;
  /** How many searches this call costs against the daily Exa quota, if any. */
  readonly searchesPerCall: number;
  search(input: LeadSourceSearchInput): Promise<LeadCandidate[]>;
}

/** Signals are a separate port shape because they are read, not enrolled. */
export interface SignalSource {
  readonly name: string;
  /** Hacker News "Who is hiring" and similar boards are signal sources (section 2). */
  search(input: { query: string; limit: number }): Promise<SignalCandidate[]>;
}

export interface SignalCandidate {
  companyName: string;
  companyDomain: string | null;
  /** e.g. "hiring 3+ support agents". */
  signal: string;
  url: string;
  postedAt: string | null;
  source: string;
}
