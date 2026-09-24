import { guessEmailCandidatesWithPatterns, type EmailPatternCandidate } from "@/src/adapters/enrich/patterns";
import { createEmailVerifier } from "@/src/adapters/verify";
import { domainFromEmail, normalizeEmail } from "@/src/domain/suppression";
import type { EmailStatus } from "@/src/domain/types";
import { ConfigurationError, QuotaExceededError, VendorError } from "@/src/lib/errors";
import { isValidTimeZone } from "@/src/lib/time-windows";
import { logger, type Logger } from "@/src/lib/logger";
import type { EmailVerifier } from "@/src/ports/email-verifier";
import type { ActivityType } from "./activity";
import { recordActivity } from "./activity";
import { getLead, setContactEmail, setContactTimezone, type LeadWithCompany } from "./leads";

/**
 * Enrichment service (phase 2). Turns a contact into an addressable lead:
 *
 *  1. a `valid` address needs no work (section 9: "send only to valid");
 *  2. an address the source already provided is verified first (section 9 rule 6);
 *  3. otherwise, pattern guesses run in order and the first `valid` one wins;
 *  4. a `catch_all` address is stored as `catch_all` and never as `valid` — those go
 *     LinkedIn-first (section 9).
 *
 * Every check goes through the verifier chain's quota hooks; this service never calls a
 * verifier directly, and it never sends anything (section 3: "AI decides content, code
 * decides actions" — and this file has no AI at all).
 *
 * `enrichment.email_verified` is written by `services/quota.ts#recordVerification` for
 * every vendor check; writing a second event of the same type here would double-count the
 * daily verification quota, so this service records the *outcomes* instead:
 * `enrichment.patterns_generated`, `enrichment.email_rejected` and `enrichment.gave_up`.
 */

export type EnrichmentGiveUpReason =
  | "no_company_domain"
  | "no_candidates"
  | "all_rejected"
  | "quota_exhausted"
  | "verifier_unavailable";

export type EnrichmentOutcome =
  | { status: "not_found" }
  | { status: "already_valid"; email: string }
  | { status: "verified"; email: string; pattern: string }
  | { status: "catch_all"; email: string; pattern: string }
  | { status: "gave_up"; reason: EnrichmentGiveUpReason };

/** Injectable seam: `enrichment.test.ts` runs this with in-memory fakes and no database. */
export interface EnrichmentDeps {
  loadLead: (contactId: string) => Promise<LeadWithCompany | null>;
  verifier: EmailVerifier;
  setEmail: (contactId: string, email: string, status: EmailStatus) => Promise<void>;
  setTimezone: (contactId: string, timezone: string) => Promise<void>;
  record: (input: {
    contactId: string;
    type: ActivityType;
    data?: Record<string, unknown>;
    /** Defaults to `contact`; `quota.exhausted` uses `quota`. */
    entityType?: string;
  }) => Promise<void>;
  logger: Logger;
}

export async function enrichLead(contactId: string, overrides: Partial<EnrichmentDeps> = {}): Promise<EnrichmentOutcome> {
  let deps: EnrichmentDeps;
  try {
    deps = resolveDeps(overrides);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    // No verifier key is configured. Skip this stage; the caller keeps the lead for a
    // later run instead of crashing the batch (section 0 rule 2).
    await recordActivity({
      actor: "system",
      entityType: "contact",
      entityId: contactId,
      type: "enrichment.gave_up",
      data: { reason: "verifier_unavailable" },
    });
    logger.warn("enrichment.verifier_unavailable", { contactId });
    return { status: "gave_up", reason: "verifier_unavailable" };
  }

  const lead = await deps.loadLead(contactId);
  if (!lead) return { status: "not_found" };

  const contact = lead.contact;
  if (contact.email && contact.emailStatus === "valid") {
    return { status: "already_valid", email: contact.email };
  }

  const domain = lead.company?.domain ? lead.company.domain.trim().toLowerCase() : contact.email ? domainFromEmail(contact.email) : null;
  if (!domain) {
    await deps.record({ contactId, type: "enrichment.gave_up", data: { reason: "no_company_domain" } });
    return { status: "gave_up", reason: "no_company_domain" };
  }

  const candidates = buildCandidates({ fullName: contact.fullName, domain, providedEmail: contact.email });
  if (candidates.length === 0) {
    await deps.record({ contactId, type: "enrichment.gave_up", data: { reason: "no_candidates" } });
    return { status: "gave_up", reason: "no_candidates" };
  }

  await deps.record({
    contactId,
    type: "enrichment.patterns_generated",
    data: {
      count: candidates.filter((candidate) => candidate.origin === "guessed").length,
      provided: candidates.some((candidate) => candidate.origin === "provided"),
    },
  });

  let catchAll: EmailPatternCandidate | null = null;

  for (const candidate of candidates) {
    let result;
    try {
      result = await deps.verifier.verify(candidate.email);
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        await deps.record({
          contactId,
          type: "enrichment.gave_up",
          data: { reason: "quota_exhausted", checked: candidates.length },
        });
        // Section 0: the stage pauses until the quota resets; the owner is alerted by
        // the caller (quota snapshots and alerts read `quota.exhausted`).
        await deps.record({
          contactId,
          type: "quota.exhausted",
          entityType: "quota",
          data: { resource: error.resource, used: error.used, limit: error.limit, period: error.period, stage: "verification" },
        });
        return { status: "gave_up", reason: "quota_exhausted" };
      }
      if (error instanceof VendorError || error instanceof ConfigurationError) {
        await deps.record({
          contactId,
          type: "enrichment.gave_up",
          data: { reason: "verifier_unavailable", code: error.code },
        });
        deps.logger.warn("enrichment.verifier_failed", { contactId, code: error.code });
        return { status: "gave_up", reason: "verifier_unavailable" };
      }
      throw error;
    }

    if (result.status === "valid") {
      await deps.setEmail(contactId, candidate.email, "valid");
      await storeTimezone(deps, contactId, result.raw);
      return { status: "verified", email: candidate.email, pattern: candidate.pattern };
    }

    if (result.status === "catch_all" && !catchAll) catchAll = candidate;

    await deps.record({
      contactId,
      type: "enrichment.email_rejected",
      data: { status: result.status, provider: result.provider, pattern: candidate.pattern },
    });
  }

  if (catchAll) {
    // Stored, never stamped `valid` (section 9: catch-all addresses go LinkedIn-first).
    await deps.setEmail(contactId, catchAll.email, "catch_all");
    return { status: "catch_all", email: catchAll.email, pattern: catchAll.pattern };
  }

  await deps.record({ contactId, type: "enrichment.gave_up", data: { reason: "all_rejected", checked: candidates.length } });
  return { status: "gave_up", reason: "all_rejected" };
}

interface CandidateWithOrigin extends EmailPatternCandidate {
  origin: "provided" | "guessed";
}

/**
 * Order: the address the source already gave us first, then the pattern guesses in
 * `COMMON_EMAIL_PATTERNS` order (`first.last`, `first`, `firstlast`, …).
 */
export function buildCandidates(input: {
  fullName: string;
  domain: string;
  providedEmail?: string | null;
}): CandidateWithOrigin[] {
  const candidates: CandidateWithOrigin[] = [];

  if (input.providedEmail) {
    candidates.push({ email: normalizeEmail(input.providedEmail), pattern: "provided", origin: "provided" });
  }

  const seen = new Set(candidates.map((candidate) => candidate.email));
  for (const guessed of guessEmailCandidatesWithPatterns({ fullName: input.fullName, domain: input.domain })) {
    if (seen.has(guessed.email)) continue;
    seen.add(guessed.email);
    candidates.push({ ...guessed, origin: "guessed" });
  }

  return candidates;
}

async function storeTimezone(deps: EnrichmentDeps, contactId: string, raw?: Record<string, unknown>): Promise<void> {
  const timezone = raw?.["timezone"];
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) return;
  await deps.setTimezone(contactId, timezone);
}

function resolveDeps(overrides: Partial<EnrichmentDeps>): EnrichmentDeps {
  return {
    loadLead: overrides.loadLead ?? getLead,
    verifier: overrides.verifier ?? createEmailVerifier(),
    setEmail: overrides.setEmail ?? setContactEmail,
    setTimezone: overrides.setTimezone ?? setContactTimezone,
    record:
      overrides.record ??
      ((input) =>
        recordActivity({
          actor: "system",
          entityType: input.entityType ?? "contact",
          entityId: input.contactId,
          type: input.type,
          data: input.data,
        })),
    logger: overrides.logger ?? logger,
  };
}
