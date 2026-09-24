import { describe, expect, it } from "vitest";

import { guessEmailCandidates, guessEmailCandidatesWithPatterns } from "@/src/adapters/enrich/patterns";
import type { Company, Contact } from "@/src/db/schema";
import { preScore } from "@/src/domain/scoring";
import type { EmailStatus, SizeBand } from "@/src/domain/types";
import { QuotaExceededError, VendorError } from "@/src/lib/errors";
import type { Logger } from "@/src/lib/logger";
import type { EmailVerifier } from "@/src/ports/email-verifier";
import type { ActivityType } from "./activity";
import { buildCandidates, enrichLead, type EnrichmentDeps } from "./enrichment";
import type { LeadWithCompany } from "./leads";

/**
 * Enrichment tests (phase 2). No database, no network: the verifier and the lead store
 * are in-memory fakes (section 10 rule 4).
 *
 * The pre-score tests live here too because this phase owns no other service test file;
 * `preScore` is the code gate that runs before any verification spend (section 6).
 */

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

const CONTACT_ID = "11111111-1111-1111-1111-111111111111";
const COMPANY_ID = "22222222-2222-2222-2222-222222222222";

function makeLead(contactOverrides: Partial<Contact> = {}, company: Partial<Company> | null = {}): LeadWithCompany {
  const contact: Contact = {
    id: CONTACT_ID,
    companyId: company ? COMPANY_ID : null,
    fullName: "Marta Kowalska",
    title: "Head of Customer Support",
    email: null,
    emailStatus: "unknown",
    linkedinUrl: null,
    linkedinProviderId: null,
    timezone: null,
    language: null,
    source: "csv",
    collectedAt: new Date("2026-09-01T00:00:00Z"),
    stage: "new",
    deletedAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...contactOverrides,
  };

  const companyRow: Company | null = company
    ? {
        id: COMPANY_ID,
        domain: "northwind-logistics.example",
        name: "Northwind Logistics",
        linkedinUrl: null,
        industry: "logistics",
        sizeBand: "51-200",
        country: "Germany",
        source: "csv",
        raw: {},
        enrichedAt: null,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        updatedAt: new Date("2026-09-01T00:00:00Z"),
        ...company,
      }
    : null;

  return { contact, company: companyRow };
}

type VerifyOutcome = EmailStatus | { status: EmailStatus; raw?: Record<string, unknown> } | Error;

function createFakeVerifier(respond: (email: string) => VerifyOutcome): EmailVerifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake-verify",
    checksPerCall: 1,
    calls,
    async verify(email) {
      calls.push(email);
      const outcome = respond(email);
      if (outcome instanceof Error) throw outcome;
      if (typeof outcome === "string") return { email, status: outcome, provider: "fake", raw: {} };
      return { email, status: outcome.status, provider: "fake", raw: outcome.raw ?? {} };
    },
  };
}

function createDeps(options: { lead: LeadWithCompany | null; verifier: EmailVerifier }) {
  const savedEmails: Array<{ email: string; status: EmailStatus }> = [];
  const timezones: string[] = [];
  const events: Array<{ type: ActivityType; entityType?: string; data?: Record<string, unknown> }> = [];

  const deps: EnrichmentDeps = {
    loadLead: async () => options.lead,
    verifier: options.verifier,
    setEmail: async (_contactId, email, status) => {
      savedEmails.push({ email, status });
    },
    setTimezone: async (_contactId, timezone) => {
      timezones.push(timezone);
    },
    record: async (input) => {
      events.push({ type: input.type, entityType: input.entityType, data: input.data });
    },
    logger: noopLogger,
  };

  return { deps, savedEmails, timezones, events };
}

const GUESS_ORDER = [
  "marta.kowalska@northwind-logistics.example",
  "marta@northwind-logistics.example",
  "martakowalska@northwind-logistics.example",
  "m.kowalska@northwind-logistics.example",
  "marta_kowalska@northwind-logistics.example",
  "mkowalska@northwind-logistics.example",
  "kowalska.marta@northwind-logistics.example",
];

describe("email pattern guesser (re-export of the port contract)", () => {
  it("orders candidates from the shared pattern list and lower-cases the domain", () => {
    expect(guessEmailCandidates({ fullName: "Marta Kowalska", domain: "Northwind-Logistics.Example" })).toEqual(GUESS_ORDER);
  });

  it("returns nothing when the name has no usable last name", () => {
    expect(guessEmailCandidates({ fullName: "Marta", domain: "northwind-logistics.example" })).toEqual([]);
  });

  it("labels each candidate with the pattern that produced it", () => {
    expect(guessEmailCandidatesWithPatterns({ fullName: "Marta Kowalska", domain: "northwind-logistics.example" })).toEqual([
      { email: GUESS_ORDER[0], pattern: "first.last" },
      { email: GUESS_ORDER[1], pattern: "first" },
      { email: GUESS_ORDER[2], pattern: "firstlast" },
      { email: GUESS_ORDER[3], pattern: "f.last" },
      { email: GUESS_ORDER[4], pattern: "first_last" },
      { email: GUESS_ORDER[5], pattern: "flast" },
      { email: GUESS_ORDER[6], pattern: "last.first" },
    ]);
  });

  it("puts a provided address first and never duplicates it as a guess", () => {
    const candidates = buildCandidates({
      fullName: "Marta Kowalska",
      domain: "northwind-logistics.example",
      providedEmail: "Marta.Kowalska@northwind-logistics.example",
    });

    expect(candidates[0]).toEqual({
      email: "marta.kowalska@northwind-logistics.example",
      pattern: "provided",
      origin: "provided",
    });
    expect(candidates.filter((candidate) => candidate.email === GUESS_ORDER[0])).toHaveLength(1);
    expect(candidates).toHaveLength(7);
  });
});

describe("enrichLead", () => {
  it("verifies guesses in pattern order and stops at the first valid address", async () => {
    const verifier = createFakeVerifier((email) => (email === GUESS_ORDER[2] ? "valid" : "invalid"));
    const { deps, savedEmails, events } = createDeps({ lead: makeLead(), verifier });

    const outcome = await enrichLead(CONTACT_ID, deps);

    expect(verifier.calls).toEqual(GUESS_ORDER.slice(0, 3));
    expect(savedEmails).toEqual([{ email: GUESS_ORDER[2], status: "valid" }]);
    expect(outcome).toEqual({ status: "verified", email: GUESS_ORDER[2], pattern: "firstlast" });
    expect(events.map((event) => event.type)).toEqual([
      "enrichment.patterns_generated",
      "enrichment.email_rejected",
      "enrichment.email_rejected",
    ]);
  });

  it("verifies a provided address before guessing anything", async () => {
    const verifier = createFakeVerifier(() => "valid");
    const lead = makeLead({ email: "Marta@Northwind-Logistics.example", emailStatus: "unknown" });
    const { deps, savedEmails, events } = createDeps({ lead, verifier });

    const outcome = await enrichLead(CONTACT_ID, deps);

    expect(verifier.calls).toEqual(["marta@northwind-logistics.example"]);
    expect(savedEmails).toEqual([{ email: "marta@northwind-logistics.example", status: "valid" }]);
    expect(outcome).toEqual({ status: "verified", email: "marta@northwind-logistics.example", pattern: "provided" });
    expect(events[0]).toMatchObject({ type: "enrichment.patterns_generated", data: { provided: true } });
  });

  it("stores a catch-all address but never as valid", async () => {
    const verifier = createFakeVerifier((email) => (email === GUESS_ORDER[0] ? "catch_all" : "invalid"));
    const { deps, savedEmails, events } = createDeps({ lead: makeLead(), verifier });

    const outcome = await enrichLead(CONTACT_ID, deps);

    expect(outcome).toEqual({ status: "catch_all", email: GUESS_ORDER[0], pattern: "first.last" });
    expect(savedEmails).toEqual([{ email: GUESS_ORDER[0], status: "catch_all" }]);
    expect(savedEmails.some((saved) => saved.status === "valid")).toBe(false);
    expect(verifier.calls).toHaveLength(GUESS_ORDER.length);
    expect(events.filter((event) => event.type === "enrichment.email_rejected")).toHaveLength(GUESS_ORDER.length);
  });

  it("gives up cleanly when every candidate is rejected", async () => {
    const verifier = createFakeVerifier(() => "invalid");
    const { deps, savedEmails, events } = createDeps({ lead: makeLead(), verifier });

    const outcome = await enrichLead(CONTACT_ID, deps);

    expect(outcome).toEqual({ status: "gave_up", reason: "all_rejected" });
    expect(savedEmails).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "enrichment.gave_up",
      data: { reason: "all_rejected", checked: GUESS_ORDER.length },
    });
  });

  it("does nothing when the contact already has a valid address", async () => {
    const verifier = createFakeVerifier(() => {
      throw new Error("must not be called");
    });
    const lead = makeLead({ email: "marta@northwind-logistics.example", emailStatus: "valid" });
    const { deps, savedEmails } = createDeps({ lead, verifier });

    const outcome = await enrichLead(CONTACT_ID, deps);

    expect(outcome).toEqual({ status: "already_valid", email: "marta@northwind-logistics.example" });
    expect(verifier.calls).toHaveLength(0);
    expect(savedEmails).toHaveLength(0);
  });

  it("gives up when there is no company domain to guess on", async () => {
    const verifier = createFakeVerifier(() => "valid");
    const lead = makeLead({ email: null, linkedinUrl: "https://www.linkedin.com/in/marta-kowalska" }, null);
    const { deps, savedEmails, events } = createDeps({ lead, verifier });

    const outcome = await enrichLead(CONTACT_ID, deps);

    expect(outcome).toEqual({ status: "gave_up", reason: "no_company_domain" });
    expect(savedEmails).toHaveLength(0);
    expect(events).toEqual([{ type: "enrichment.gave_up", entityType: undefined, data: { reason: "no_company_domain" } }]);
  });

  it("pauses on quota exhaustion instead of burning checks", async () => {
    const verifier = createFakeVerifier((email) =>
      email === GUESS_ORDER[1] ? new QuotaExceededError("email_verifications", 23, 23, "day") : "invalid",
    );
    const { deps, savedEmails, events } = createDeps({ lead: makeLead(), verifier });

    const outcome = await enrichLead(CONTACT_ID, deps);

    expect(outcome).toEqual({ status: "gave_up", reason: "quota_exhausted" });
    expect(verifier.calls).toHaveLength(2);
    expect(savedEmails).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "quota.exhausted",
      entityType: "quota",
      data: { resource: "email_verifications", stage: "verification" },
    });
  });

  it("pauses when the verifier itself is unavailable", async () => {
    const verifier = createFakeVerifier(() => new VendorError("reoon", "both providers down", { code: "vendor_unavailable" }));
    const { deps, savedEmails, events } = createDeps({ lead: makeLead(), verifier });

    const outcome = await enrichLead(CONTACT_ID, deps);

    expect(outcome).toEqual({ status: "gave_up", reason: "verifier_unavailable" });
    expect(savedEmails).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "enrichment.gave_up", data: { reason: "verifier_unavailable" } });
  });

  it("stores a valid address and the timezone when the vendor returns one", async () => {
    const verifier = createFakeVerifier(() => ({ status: "valid", raw: { timezone: "Europe/Berlin" } }));
    const { deps, savedEmails, timezones } = createDeps({ lead: makeLead(), verifier });

    const outcome = await enrichLead(CONTACT_ID, deps);

    expect(outcome).toEqual({ status: "verified", email: GUESS_ORDER[0], pattern: "first.last" });
    expect(savedEmails).toEqual([{ email: GUESS_ORDER[0], status: "valid" }]);
    expect(timezones).toEqual(["Europe/Berlin"]);
  });

  it("never stores an invalid timezone", async () => {
    const verifier = createFakeVerifier(() => ({ status: "valid", raw: { timezone: "Mars/Olympus_Mons" } }));
    const { deps, timezones } = createDeps({ lead: makeLead(), verifier });

    await enrichLead(CONTACT_ID, deps);

    expect(timezones).toHaveLength(0);
  });
});

describe("preScore (code, not a model)", () => {
  const icp = {
    titles: ["Head of Customer Support", "COO"],
    industries: ["logistics software"],
    sizeBands: ["51-200"] as SizeBand[],
    geos: ["Germany"],
    disqualifiers: ["intern", "student"],
  };

  it("adds every weight for an exact match", () => {
    const result = preScore({
      title: "Head of Customer Support",
      companyIndustry: "Logistics Software",
      companySizeBand: "51-200",
      companyCountry: "Germany",
      icp,
    });

    expect(result.score).toBe(100);
    expect(result.disqualifiedReason).toBeNull();
  });

  it("weights a partial title match lower than an exact one", () => {
    const partial = preScore({
      title: "Director of Customer Support",
      companyIndustry: null,
      companySizeBand: null,
      companyCountry: null,
      icp,
    });
    const exact = preScore({
      title: "Head of Customer Support",
      companyIndustry: null,
      companySizeBand: null,
      companyCountry: null,
      icp,
    });

    expect(partial.score).toBe(23); // 45 * 0.5, rounded
    expect(exact.score).toBe(45);
    expect(partial.score).toBeLessThan(exact.score);
  });

  it("scores a partial industry match and ignores a size outside the ICP", () => {
    const result = preScore({
      title: null,
      companyIndustry: "Logistics & Supply Chain Software",
      companySizeBand: "1000+",
      companyCountry: null,
      icp,
    });

    expect(result.score).toBe(13); // 25 * 0.5, rounded
  });

  it("treats an empty geo list as anywhere and a listed geo as strict", () => {
    const anywhere = preScore({
      title: null,
      companyIndustry: null,
      companySizeBand: null,
      companyCountry: "Brazil",
      icp: { ...icp, geos: [] },
    });
    const strict = preScore({
      title: null,
      companyIndustry: null,
      companySizeBand: null,
      companyCountry: "Brazil",
      icp,
    });

    expect(anywhere.score).toBe(10);
    expect(strict.score).toBe(0);
  });

  it("disqualifies a title that contains a disqualifier, whatever the score", () => {
    const result = preScore({
      title: "Operations Intern",
      companyIndustry: "Logistics Software",
      companySizeBand: "51-200",
      companyCountry: "Germany",
      icp,
    });

    expect(result.disqualifiedReason).toBe("intern");
    expect(result.reasons.join(" ")).toContain('disqualifier "intern"');
  });
});
