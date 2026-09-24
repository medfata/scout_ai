import type { EmailStatus } from "@/src/domain/types";

/**
 * Port: is this address safe to cold-email? Section 9 requires "send only to valid";
 * catch-all addresses go LinkedIn-first.
 */
export interface VerifiedEmail {
  email: string;
  status: EmailStatus;
  provider: string;
  /** Raw provider payload, stored on the activity event for audits. */
  raw?: Record<string, unknown>;
}

export interface EmailVerifier {
  readonly name: string;
  /** How many checks this call costs against the daily verification quota. */
  readonly checksPerCall: number;
  verify(email: string): Promise<VerifiedEmail>;
}

/**
 * Adapter contract for the pattern-guessing path: given a name and domain, propose the
 * likely addresses in the order they should be checked. Providers differ on catch-all
 * handling, so the order matters as much as the list.
 */
export interface EmailPatternGuesser {
  readonly name: string;
  candidates(input: { fullName: string; domain: string }): string[];
}

export const COMMON_EMAIL_PATTERNS: readonly string[] = [
  "first.last",
  "first",
  "firstlast",
  "f.last",
  "first_last",
  "flast",
  "last.first",
];

export function guessEmailCandidates(input: { fullName: string; domain: string; patterns?: readonly string[] }): string[] {
  const { first, last } = splitName(input.fullName);
  if (!first || !last) return [];
  const patterns = input.patterns ?? COMMON_EMAIL_PATTERNS;
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const pattern of patterns) {
    const local = applyPattern(pattern, first, last);
    if (!local) continue;
    const email = `${local}@${input.domain.toLowerCase()}`;
    if (seen.has(email)) continue;
    seen.add(email);
    candidates.push(email);
  }
  return candidates;
}

function applyPattern(pattern: string, first: string, last: string): string | null {
  switch (pattern) {
    case "first.last":
      return `${first}.${last}`;
    case "first":
      return first;
    case "firstlast":
      return `${first}${last}`;
    case "f.last":
      return `${first[0]}.${last}`;
    case "first_last":
      return `${first}_${last}`;
    case "flast":
      return `${first[0]}${last}`;
    case "last.first":
      return `${last}.${first}`;
    default:
      return null;
  }
}

function splitName(fullName: string): { first: string | null; last: string | null } {
  const tokens = fullName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[\s-]+/)
    .map((token) => token.replace(/[^a-z]/g, ""))
    .filter((token) => token.length > 1);
  if (tokens.length < 2) return { first: tokens[0] ?? null, last: null };
  return { first: tokens[0] ?? null, last: tokens[tokens.length - 1] ?? null };
}
