import type { Angle, EmailStatus, IcpScores, SizeBand, Tier } from "@/src/domain/types";

/**
 * Section 6, "Cost control is two-pass. Code pre-scores on title, industry and size
 * first. Only passing leads get researched, and only leads scoring 60+ get email
 * enrichment credits."
 *
 * The pre-score is code, not a model call: it runs over hundreds of candidates for
 * free, and it keeps obviously wrong leads out of the expensive path.
 */

export const PRE_SCORE_RESEARCH_THRESHOLD = 50;
export const RESEARCH_SCORE_ENRICHMENT_THRESHOLD = 60;

/** Tier cutoffs. Starting defaults, flagged for owner review in DECISIONS.md (Q5). */
export const TIER_THRESHOLDS = {
  A: 80,
  B: 60,
  C: 40,
} as const;

export interface PreScoreInput {
  title: string | null;
  companyIndustry: string | null;
  companySizeBand: SizeBand | null;
  companyCountry: string | null;
  icp: {
    titles: string[];
    industries: string[];
    sizeBands: SizeBand[];
    geos: string[];
    disqualifiers: string[];
  };
}

export interface PreScoreResult {
  score: number;
  reasons: string[];
  disqualifiedReason: string | null;
}

const WEIGHTS = {
  title: 45,
  industry: 25,
  size: 20,
  geo: 10,
} as const;

export function preScore(input: PreScoreInput): PreScoreResult {
  const reasons: string[] = [];

  const titleMatch = bestMatch(input.title, input.icp.titles);
  const industryMatch = bestMatch(input.companyIndustry, input.icp.industries);
  const sizeMatch = input.companySizeBand !== null && input.icp.sizeBands.includes(input.companySizeBand);
  const geoMatch = input.companyCountry !== null && matchGeo(input.companyCountry, input.icp.geos);

  let score = 0;
  score += WEIGHTS.title * titleMatch;
  score += WEIGHTS.industry * industryMatch;
  score += sizeMatch ? WEIGHTS.size : 0;
  score += geoMatch ? WEIGHTS.geo : 0;

  if (titleMatch > 0) reasons.push(`Title matches the ICP (${Math.round(titleMatch * 100)}%).`);
  else reasons.push("Title does not match any ICP title.");
  if (industryMatch > 0) reasons.push(`Industry matches (${Math.round(industryMatch * 100)}%).`);
  if (sizeMatch) reasons.push(`Company size is inside ${input.companySizeBand}.`);
  if (geoMatch) reasons.push("Company is in a target geography.");

  const disqualifier = input.icp.disqualifiers
    .map((entry) => entry.toLowerCase().trim())
    .filter((entry) => entry.length > 3)
    .find((entry) => {
      const haystack = `${input.title ?? ""} ${input.companyIndustry ?? ""}`.toLowerCase();
      return haystack.includes(entry);
    });

  if (disqualifier) {
    return {
      score: Math.round(score),
      reasons: [...reasons, `Matches disqualifier "${disqualifier}".`],
      disqualifiedReason: disqualifier,
    };
  }

  return { score: Math.round(score), reasons, disqualifiedReason: null };
}

export function passesResearchGate(score: number): boolean {
  return score >= PRE_SCORE_RESEARCH_THRESHOLD;
}

export function allowsEmailEnrichment(score: number): boolean {
  return score >= RESEARCH_SCORE_ENRICHMENT_THRESHOLD;
}

export function tierFor(score: number): Tier | null {
  if (score >= TIER_THRESHOLDS.A) return "A";
  if (score >= TIER_THRESHOLDS.B) return "B";
  if (score >= TIER_THRESHOLDS.C) return "C";
  return null;
}

export function shouldDisqualify(score: number): boolean {
  return tierFor(score) === null;
}

// ---------------------------------------------------------------------------
// ICP ranking (section 6: "Rank by the sum; ties go to reachability")
// ---------------------------------------------------------------------------

export function icpScoreTotal(scores: IcpScores): number {
  return scores.pain + scores.budget + scores.reach + scores.proofFit + scores.speed;
}

export function rankIcps<T extends { scores: IcpScores }>(icps: T[]): T[] {
  return [...icps].sort((a, b) => {
    const total = icpScoreTotal(b.scores) - icpScoreTotal(a.scores);
    if (total !== 0) return total;
    return b.scores.reach - a.scores.reach;
  });
}

export function validateIcpScores(scores: IcpScores): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(scores)) {
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      errors.push(`${key} must be between 1 and 5, received ${value}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Email sendability
// ---------------------------------------------------------------------------

/** Section 9: "Verify every address; send only to 'valid'." */
export function isSendableEmailStatus(status: EmailStatus): boolean {
  return status === "valid";
}

export function needsLinkedInFirst(status: EmailStatus): boolean {
  return status === "catch_all" || status === "risky";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Case- and separator-insensitive token match; returns 0, 0.5 or 1. */
function bestMatch(value: string | null, candidates: string[]): number {
  if (!value || candidates.length === 0) return 0;
  const needle = normalise(value);
  if (needle.length === 0) return 0;
  for (const candidate of candidates) {
    const haystack = normalise(candidate);
    if (haystack.length === 0) continue;
    if (needle === haystack) return 1;
    if (needle.includes(haystack) || haystack.includes(needle)) return 0.75;
    if (tokens(needle).some((token) => tokens(haystack).includes(token))) return 0.5;
  }
  return 0;
}

function matchGeo(country: string, geos: string[]): boolean {
  if (geos.length === 0) return true;
  const needle = normalise(country);
  return geos.some((geo) => {
    const haystack = normalise(geo);
    return haystack.length > 0 && (needle === haystack || needle.includes(haystack) || haystack.includes(needle));
  });
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string): string[] {
  return value.split(" ").filter((token) => token.length > 2);
}

export function pickAngle(angles: Angle[], key: string | null): Angle | null {
  if (angles.length === 0) return null;
  if (!key) return angles[0] ?? null;
  return angles.find((angle) => angle.key === key) ?? angles[0] ?? null;
}
