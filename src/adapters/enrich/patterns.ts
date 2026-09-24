import {
  COMMON_EMAIL_PATTERNS,
  guessEmailCandidates,
  type EmailPatternGuesser,
} from "@/src/ports/email-verifier";

/**
 * Email pattern guesser (section 12, "Free-first swaps": name + domain guesses checked
 * with Reoon and ZeroBounce instead of spending Apollo credits).
 *
 * `guessEmailCandidates` lives in the port file because the port owns the contract; this
 * module re-exports it and adds the pattern-labelled variant the enrichment service
 * stores on the contact, plus the `EmailPatternGuesser` adapter.
 */

export { COMMON_EMAIL_PATTERNS, guessEmailCandidates };

export interface EmailPatternCandidate {
  email: string;
  /** Which pattern produced it, e.g. `first.last` — recorded for audits. */
  pattern: string;
}

/**
 * Same ordering and de-duplication as `guessEmailCandidates`, but each candidate keeps
 * the pattern that produced it. A pattern that cannot be applied (no last name, or a
 * duplicate of an earlier pattern) is skipped without shifting the labels.
 */
export function guessEmailCandidatesWithPatterns(input: {
  fullName: string;
  domain: string;
  patterns?: readonly string[];
}): EmailPatternCandidate[] {
  const patterns = input.patterns ?? COMMON_EMAIL_PATTERNS;
  const seen = new Set<string>();
  const candidates: EmailPatternCandidate[] = [];

  for (const pattern of patterns) {
    const [email] = guessEmailCandidates({ fullName: input.fullName, domain: input.domain, patterns: [pattern] });
    if (!email || seen.has(email)) continue;
    seen.add(email);
    candidates.push({ email, pattern });
  }

  return candidates;
}

export function createEmailPatternGuesser(): EmailPatternGuesser {
  return {
    name: "patterns",
    candidates: ({ fullName, domain }) => guessEmailCandidates({ fullName, domain }),
  };
}
