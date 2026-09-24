import type { WebsiteContent } from "./website-reader";

/**
 * Ports for turning a candidate into something contactable: an email address, a
 * verified status, and a readable company website.
 */

export interface EnrichInput {
  contactId: string;
  fullName: string;
  companyDomain: string | null;
  companyName: string | null;
  title: string | null;
}

export interface EmailCandidate {
  email: string;
  /** Which pattern produced it, e.g. `first.last`. Recorded on the contact for audits. */
  pattern: string;
  /** `provided` when the source already had it, `guessed` when derived from the name. */
  origin: "provided" | "guessed";
}

/**
 * Section 12, "Free-first swaps": emails are found by name + domain pattern guesses and
 * then checked with the verifier, instead of spending Apollo credits. An Enricher
 * therefore returns *candidates*; only the verifier decides what is sendable.
 */
export interface Enricher {
  readonly name: string;
  findEmailCandidates(input: EnrichInput): Promise<EmailCandidate[]>;
}

export interface EnricherDeps {
  readWebsite: (url: string) => Promise<WebsiteContent>;
}
