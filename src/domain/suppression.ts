import type { SuppressionKind } from "@/src/domain/types";

/**
 * Section 6: "dedupe, respect a do-not-contact list". Section 9: opt-outs go to
 * `suppressions` "instantly and permanently".
 *
 * Matching is normalised first, so `Jo@Acme.com` and `jo@acme.com` are the same
 * suppression, and a domain suppression catches every address on it.
 *
 * Review item 19: matching compares `value_hash`, never the plaintext `value`. The phase 8
 * retention job nulls the plaintext, so a predicate that reads `value` would un-suppress
 * everyone. The hash is an HMAC keyed with `ENCRYPTION_KEY` (`hashValue()` in
 * `src/lib/crypto.ts`), which means rotating that key silently invalidates the whole
 * do-not-contact list — documented as D11; Q12 proposes a dedicated `SUPPRESSION_HASH_KEY`.
 * The key is deliberately absent from this file: the service injects the hasher so the
 * domain stays pure (section 10 rule 3).
 */

export interface SuppressionEntry {
  kind: SuppressionKind;
  /** Plaintext until phase 8 nulls it. Matching never reads this field (review item 19). */
  value: string | null;
  valueHash: string;
}

export interface SuppressionTarget {
  email: string | null;
  companyDomain: string | null;
  linkedinUrl: string | null;
}

/** Injected by the service (`hashValue`), so this module never touches env or crypto. */
export type SuppressionHasher = (kind: SuppressionKind, normalizedValue: string) => string;

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
 * Every `(kind, normalised value)` pair this target can match: email, the email's domain,
 * the company domain and the LinkedIn URL. Review item 19 fixes that set in code so the
 * service builds exactly one indexed query per candidate.
 *
 * Pure and exported so both the query builder and the tests agree on what "the four
 * lookups" means.
 */
export function suppressionCandidatesFor(target: SuppressionTarget): Array<{ kind: SuppressionKind; value: string }> {
  const candidates: Array<{ kind: SuppressionKind; value: string }> = [];
  const seen = new Set<string>();

  const add = (kind: SuppressionKind, value: string | null): void => {
    if (!value) return;
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ kind, value });
  };

  const email = target.email ? normalizeEmail(target.email) : null;
  if (email) {
    add("email", email);
    add("domain", domainFromEmail(email));
  }
  add("domain", target.companyDomain ? normalizeDomain(target.companyDomain) : null);
  add("linkedin", target.linkedinUrl ? normalizeLinkedin(target.linkedinUrl) : null);

  return candidates;
}

/**
 * Pure, hash-based predicate. `hash` is injected (`hashValue` from `src/lib/crypto.ts`) so
 * this file stays free of env and crypto (section 10 rule 3) and the function can be tested
 * with a fake hasher. Entries must come from `loadSuppressionEntries(target)`, which already
 * filtered by the same hashes, so a hit is a real match (review item 19).
 */
export function isSuppressed(
  target: SuppressionTarget,
  entries: readonly SuppressionEntry[],
  hash: SuppressionHasher,
): boolean {
  const wanted = new Set(suppressionCandidatesFor(target).map((candidate) => `${candidate.kind}:${hash(candidate.kind, candidate.value)}`));
  if (wanted.size === 0) return false;
  return entries.some((entry) => wanted.has(`${entry.kind}:${entry.valueHash}`));
}

export function suppressionTargetsFor(kind: SuppressionKind, value: string): { value: string } {
  return { value: normalizeSuppressionValue(kind, value) };
}

/**
 * Section 9: opt-outs, hard bounces and unsubscribe requests map to a suppression kind.
 * A hard bounce is email-only (review item 20): the mailbox rejected the address, not the
 * whole company.
 */
export function suppressionKindForOptOut(hasEmail: boolean, hasLinkedin: boolean): SuppressionKind[] {
  const kinds: SuppressionKind[] = [];
  if (hasEmail) kinds.push("email");
  if (hasLinkedin) kinds.push("linkedin");
  return kinds;
}

/**
 * Consumer mailbox domains. Review item 20: a domain suppression on one of these blocks
 * every Gmail/Outlook/Yahoo contact at once, so `addSuppression` refuses to create one —
 * a single contact is still reachable through the email and LinkedIn kinds.
 */
const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "126.com",
  "163.com",
  "aol.com",
  "att.net",
  "bigpond.com",
  "bk.ru",
  "bluewin.ch",
  "bol.com.br",
  "btinternet.com",
  "charter.net",
  "comcast.net",
  "cox.net",
  "daum.net",
  "fastmail.com",
  "free.fr",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hanmail.net",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "hotmail.de",
  "hotmail.fr",
  "icloud.com",
  "inbox.ru",
  "interia.pl",
  "laposte.net",
  "libero.it",
  "list.ru",
  "live.com",
  "live.co.uk",
  "mac.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "msn.com",
  "naver.com",
  "ntlworld.com",
  "o2.pl",
  "orange.fr",
  "outlook.com",
  "outlook.de",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "rambler.ru",
  "rediffmail.com",
  "rocketmail.com",
  "rogers.com",
  "sbcglobal.net",
  "seznam.cz",
  "shaw.ca",
  "sina.com",
  "sky.com",
  "t-online.de",
  "telus.net",
  "terra.com.br",
  "tutanota.com",
  "uol.com.br",
  "verizon.net",
  "virgilio.it",
  "virginmedia.com",
  "wanadoo.fr",
  "web.de",
  "wp.pl",
  "ya.ru",
  "yahoo.com",
  "yahoo.co.uk",
  "yandex.com",
  "yandex.ru",
  "ymail.com",
  "zoho.com",
]);

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(normalizeDomain(domain));
}
