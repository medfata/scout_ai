import type { SuppressionKind } from "@/src/domain/types";

/**
 * Section 6: "dedupe, respect a do-not-contact list". Section 9: opt-outs go to
 * `suppressions` "instantly and permanently".
 *
 * Matching is normalised first, so `Jo@Acme.com` and `jo@acme.com` are the same
 * suppression, and a domain suppression catches every address on it.
 */

export interface SuppressionEntry {
  kind: SuppressionKind;
  value: string | null;
  valueHash: string;
}

export interface SuppressionTarget {
  email: string | null;
  companyDomain: string | null;
  linkedinUrl: string | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

export function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * LinkedIn profile URLs come in several shapes; the slug identifies the person.
 * A raw slug (no URL) is also accepted.
 */
export function normalizeLinkedin(urlOrSlug: string): string {
  const value = urlOrSlug.trim().toLowerCase();
  const match = /linkedin\.com\/(?:in|pub)\/([^/?#]+)/.exec(value);
  if (match?.[1]) return match[1];
  return value.replace(/\/+$/, "");
}

export function normalizeSuppressionValue(kind: SuppressionKind, value: string): string {
  switch (kind) {
    case "email":
      return normalizeEmail(value);
    case "domain":
      return normalizeDomain(value);
    case "linkedin":
      return normalizeLinkedin(value);
  }
}

/**
 * Pure predicate: true when the lead matches any suppression entry. The service loads
 * the entries once per batch and calls this, so a sourcing run does one query, not N.
 */
export function isSuppressed(target: SuppressionTarget, entries: SuppressionEntry[]): boolean {
  const email = target.email ? normalizeEmail(target.email) : null;
  const emailDomain = email ? domainFromEmail(email) : null;
  const linkedin = target.linkedinUrl ? normalizeLinkedin(target.linkedinUrl) : null;
  const companyDomain = target.companyDomain ? normalizeDomain(target.companyDomain) : null;

  for (const entry of entries) {
    if (!entry.value) continue;
    switch (entry.kind) {
      case "email":
        if (email && entry.value === email) return true;
        break;
      case "domain":
        if (emailDomain && entry.value === emailDomain) return true;
        if (companyDomain && entry.value === companyDomain) return true;
        break;
      case "linkedin":
        if (linkedin && entry.value === linkedin) return true;
        break;
    }
  }
  return false;
}

export function suppressionTargetsFor(kind: SuppressionKind, value: string): { value: string } {
  return { value: normalizeSuppressionValue(kind, value) };
}

/**
 * Section 9: opt-outs, hard bounces and unsubscribe requests map to a suppression kind.
 */
export function suppressionKindForOptOut(hasEmail: boolean, hasLinkedin: boolean): SuppressionKind[] {
  const kinds: SuppressionKind[] = [];
  if (hasEmail) kinds.push("email");
  if (hasLinkedin) kinds.push("linkedin");
  return kinds;
}

export function domainSuppressionFor(email: string, reason: string): { kind: SuppressionKind; value: string; reason: string } | null {
  const domain = domainFromEmail(email);
  if (!domain) return null;
  return { kind: "domain", value: domain, reason: `domain of ${reason}` };
}
