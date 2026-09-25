import { describe, expect, it } from "vitest";

import {
  domainFromEmail,
  isSuppressed,
  normalizeDomain,
  normalizeLinkedin,
  normalizeSuppressionValue,
  suppressionCandidatesFor,
  type SuppressionEntry,
  type SuppressionHasher,
  type SuppressionTarget,
} from "@/src/domain";
import type { SuppressionKind } from "@/src/domain/types";
import { hashValue } from "@/src/lib/crypto";

/**
 * Section 9: opt-outs go to `suppressions` "instantly and permanently".
 *
 * Review item 19 is the point of this file: matching compares `(kind, value_hash)` and
 * never the plaintext `value`. The phase 8 retention job nulls `value`, so a predicate
 * that read it would un-suppress everyone. The hasher is injected, exactly as the service
 * injects `hashValue`, and the tests use the real HMAC so a drift in `hashValue`'s input
 * shape (`kind:value`) fails here.
 */

const hash: SuppressionHasher = (kind, value) => hashValue(kind, value);

/** Mirrors `addSuppression`: normalise first, then hash `(kind, normalisedValue)`. */
function entry(kind: SuppressionKind, value: string | null, hashed?: string): SuppressionEntry {
  const normalized = value === null ? null : normalizeSuppressionValue(kind, value);
  return { kind, value: normalized, valueHash: hashed ?? hash(kind, normalized ?? "") };
}

function target(overrides: Partial<SuppressionTarget> = {}): SuppressionTarget {
  return { email: null, companyDomain: null, linkedinUrl: null, ...overrides };
}

describe("normalisation", () => {
  it("lower-cases and trims an email", () => {
    expect(domainFromEmail("  Jo@Acme.Example ")).toBe("acme.example");
  });

  it("strips scheme, www, path and trailing dot from a domain", () => {
    expect(normalizeDomain(" HTTPS://WWW.Acme.example/path?q=1 ")).toBe("acme.example");
    expect(normalizeDomain("acme.example.")).toBe("acme.example");
  });

  it("reduces every LinkedIn URL shape to the slug", () => {
    expect(normalizeLinkedin("https://www.linkedin.com/in/Jo-Smith/?trk=abc")).toBe("jo-smith");
    expect(normalizeLinkedin("linkedin.com/pub/jo-smith")).toBe("jo-smith");
    expect(normalizeLinkedin("JO-SMITH")).toBe("jo-smith");
  });

  it("builds email, email-domain, company-domain and LinkedIn candidates once each", () => {
    const candidates = suppressionCandidatesFor(
      target({ email: "Jo@Acme.example", companyDomain: "https://www.acme.example/", linkedinUrl: "linkedin.com/in/jo" }),
    );

    expect(candidates).toEqual([
      { kind: "email", value: "jo@acme.example" },
      { kind: "domain", value: "acme.example" },
      { kind: "linkedin", value: "jo" },
    ]);
    // The email's domain and the company domain are the same lookup here, and the
    // duplicate is collapsed rather than queried twice.
    expect(new Set(candidates.map((candidate) => `${candidate.kind}:${candidate.value}`)).size).toBe(3);
  });
});

describe("isSuppressed", () => {
  it("matches an email suppression regardless of case or whitespace", () => {
    const entries = [entry("email", "JO@ACME.EXAMPLE")];

    expect(isSuppressed(target({ email: "jo@acme.example" }), entries, hash)).toBe(true);
    expect(isSuppressed(target({ email: "  Jo@Acme.Example  " }), entries, hash)).toBe(true);
  });

  it("matches a suppression on the email's own domain", () => {
    const entries = [entry("domain", "acme.example")];

    expect(isSuppressed(target({ email: "jo@acme.example" }), entries, hash)).toBe(true);
    expect(isSuppressed(target({ email: "jo@other.example" }), entries, hash)).toBe(false);
  });

  it("matches a suppression on the company domain even when the email is elsewhere", () => {
    const entries = [entry("domain", "acme.example")];

    expect(isSuppressed(target({ email: "jo@personal.example", companyDomain: "acme.example" }), entries, hash)).toBe(true);
  });

  it("matches a LinkedIn suppression across URL shapes", () => {
    const entries = [entry("linkedin", "https://www.linkedin.com/in/Jo-Smith/")];

    expect(isSuppressed(target({ linkedinUrl: "linkedin.com/in/jo-smith?trk=abc" }), entries, hash)).toBe(true);
    expect(isSuppressed(target({ linkedinUrl: "linkedin.com/in/someone-else" }), entries, hash)).toBe(false);
  });

  it("does not cross kinds: an email entry never matches a domain target", () => {
    const entries = [entry("email", "acme.example")];

    expect(isSuppressed(target({ companyDomain: "acme.example" }), entries, hash)).toBe(false);
  });

  it("still matches a row whose plaintext value is NULL (review item 19)", () => {
    const entries = [entry("email", null, hash("email", "jo@acme.example"))];

    expect(entries[0]?.value).toBeNull();
    expect(isSuppressed(target({ email: "jo@acme.example" }), entries, hash)).toBe(true);
    expect(isSuppressed(target({ email: "someone-else@acme.example" }), entries, hash)).toBe(false);
  });

  it("does not match when the hash was computed for another value", () => {
    const entries = [entry("email", null, hash("email", "other@acme.example"))];

    expect(isSuppressed(target({ email: "jo@acme.example" }), entries, hash)).toBe(false);
  });

  it("returns false for a target with nothing to look up", () => {
    const entries = [entry("email", "jo@acme.example")];

    expect(isSuppressed(target(), entries, hash)).toBe(false);
    expect(isSuppressed(target(), [], hash)).toBe(false);
  });
});
