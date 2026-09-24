import { eq } from "drizzle-orm";

import { getLeadSources, getSignalSources } from "@/src/adapters/sources";
import { getDb } from "@/src/db/client";
import { companies, icps, offers, type Icp, type Offer } from "@/src/db/schema";
import { dailyNewProspectQuota } from "@/src/domain/quotas";
import { preScore } from "@/src/domain/scoring";
import { isSuppressed, normalizeDomain } from "@/src/domain/suppression";
import { getEnv } from "@/src/lib/env";
import { ConfigurationError, isScoutError, ScoutError } from "@/src/lib/errors";
import { logger } from "@/src/lib/logger";
import type { IcpSearchInput, LeadCandidate, LeadSource, SignalCandidate, SignalSource } from "@/src/ports/lead-source";
import { recordActivity } from "./activity";
import { loadSuppressionEntries, upsertCompany, upsertContact } from "./leads";
import { assertNewProspectQuota, dailyNewProspectCount } from "./quota";
import { getSettings } from "./settings";

/**
 * Sourcing service (phase 2). `sourceLeadsForIcp` is the only way candidates become
 * companies and contacts, so pre-scoring, quota and the do-not-contact list cannot be
 * bypassed (section 6, two-pass cost control; section 9, guardrails).
 *
 * Order matters for two reasons the phase plan spells out:
 *  - the new-prospect quota is checked *before* any Exa search is spent, so an exhausted
 *    day pauses the stage instead of burning credits;
 *  - the suppression list is loaded once per batch and applied *before* any row is
 *    written, so "suppressed people never appear" (a re-run must write zero rows).
 */

export interface SourcingSummary {
  icpId: string;
  requested: number;
  effectiveLimit: number;
  /** Raw candidates returned by every source, before any filtering. */
  candidates: number;
  created: number;
  deduped: number;
  suppressed: number;
  disqualified: number;
  sources: string[];
  /** Contacts this run created, so a caller can start the research pipeline for them. */
  createdContacts: Array<{ contactId: string; companyId: string | null }>;
}

export interface SourceLeadsInput {
  icpId: string;
  limit: number;
  /** Test/UI seam; defaults to the configured registry (`APOLLO_API_KEY`, `EXA_API_KEY`). */
  sources?: LeadSource[];
}

export async function sourceLeadsForIcp(input: SourceLeadsInput): Promise<SourcingSummary> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new ScoutError(`limit must be a positive integer, received ${input.limit}.`, { code: "validation" });
  }

  const row = await loadIcpWithOffer(input.icpId);
  if (!row) throw new ScoutError(`ICP ${input.icpId} was not found.`, { code: "not_found" });

  const sources = input.sources ?? getLeadSources();
  if (sources.length === 0) {
    throw new ConfigurationError(
      "No lead source is configured. Add APOLLO_API_KEY or EXA_API_KEY to .env.local, or import a CSV export.",
      { icpId: input.icpId },
    );
  }

  try {
    return await runSourcing(row, sources, input.limit);
  } catch (error) {
    await recordActivity({
      actor: "system",
      entityType: "icp",
      entityId: input.icpId,
      type: "sourcing.failed",
      data: {
        code: isScoutError(error) ? error.code : "unexpected",
        reason: error instanceof Error ? error.message.slice(0, 300) : "unknown error",
      },
    });
    throw error;
  }
}

async function runSourcing(row: { icp: Icp; offer: Offer }, sources: LeadSource[], limit: number): Promise<SourcingSummary> {
  const { icp, offer } = row;
  const env = getEnv();

  // Quota first: a paused day must not spend an Exa search (section 0).
  await assertNewProspectQuota();
  const settings = await getSettings();
  const dailyTarget = dailyNewProspectQuota(settings.dailyNewProspectTarget, env.MAX_DAILY_NEW_PROSPECTS);
  const usedToday = await dailyNewProspectCount();
  const effectiveLimit = Math.max(0, Math.min(limit, dailyTarget - usedToday, env.MAX_DAILY_NEW_PROSPECTS));

  await recordActivity({
    actor: "system",
    entityType: "icp",
    entityId: icp.id,
    type: "sourcing.started",
    data: { limit, effectiveLimit, offerId: offer.id, sources: sources.map((source) => source.name) },
  });

  const searchInput: IcpSearchInput = {
    id: icp.id,
    name: icp.name,
    titles: icp.titles,
    industries: icp.industries,
    sizeBands: icp.sizeBands,
    geos: icp.geos,
    pains: icp.pains,
    triggers: icp.triggers,
    disqualifiers: icp.disqualifiers,
    searchFilters: icp.searchFilters,
  };

  const [suppressionEntries, existingDomains] = await Promise.all([loadSuppressionEntries(), loadExistingCompanyDomains()]);

  const settled = await Promise.allSettled(
    sources.map((source) => source.search({ icp: searchInput, limit, excludeDomains: existingDomains })),
  );

  const candidates: LeadCandidate[] = [];
  const usedSources = new Set<string>();
  let lastFailure: unknown = null;

  for (const [index, result] of settled.entries()) {
    const source = sources[index];
    if (!source) continue;
    if (result.status === "fulfilled") {
      candidates.push(...result.value);
      usedSources.add(source.name);
      continue;
    }
    lastFailure = result.reason;
    logger.warn("sourcing.source_failed", {
      source: source.name,
      code: isScoutError(result.reason) ? result.reason.code : "unexpected",
      reason: result.reason instanceof Error ? result.reason.message.slice(0, 200) : "unknown",
    });
    await recordActivity({
      actor: "system",
      entityType: "icp",
      entityId: icp.id,
      type: "sourcing.failed",
      data: { source: source.name, code: isScoutError(result.reason) ? result.reason.code : "unexpected" },
    });
  }

  if (usedSources.size === 0) {
    // Every source failed: rethrow the first typed failure so the workflow can pause or
    // alert instead of pretending the run succeeded with zero leads.
    throw lastFailure instanceof Error ? lastFailure : new Error("Every lead source failed.");
  }

  // Pass one: code pre-scoring over every candidate, before any AI or verification spend.
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: preScore({
        title: candidate.title,
        companyIndustry: candidate.companyIndustry,
        companySizeBand: candidate.companySizeBand,
        companyCountry: candidate.companyCountry,
        icp: {
          titles: icp.titles,
          industries: icp.industries,
          sizeBands: icp.sizeBands,
          geos: icp.geos,
          disqualifiers: icp.disqualifiers,
        },
      }),
    }))
    .sort((a, b) => b.score.score - a.score.score);

  let disqualified = 0;
  let suppressed = 0;
  const eligible: LeadCandidate[] = [];

  for (const { candidate, score } of scored) {
    if (score.disqualifiedReason) {
      disqualified += 1;
      await recordActivity({
        actor: "system",
        entityType: "icp",
        entityId: icp.id,
        type: "lead.prescore_failed",
        data: { score: score.score, reason: score.disqualifiedReason, source: candidate.source },
      });
      continue;
    }

    if (
      isSuppressed(
        { email: candidate.email, companyDomain: candidate.companyDomain, linkedinUrl: candidate.linkedinUrl },
        suppressionEntries,
      )
    ) {
      suppressed += 1;
      await recordActivity({
        actor: "system",
        entityType: "icp",
        entityId: icp.id,
        type: "suppression.matched",
        data: { stage: "sourcing", source: candidate.source, companyDomain: candidate.companyDomain },
      });
      continue;
    }

    eligible.push(candidate);
  }

  // Pass two: write in score order until the day's allowance is used. Every write goes
  // through `upsertCompany` / `upsertContact`, so a re-run adds zero rows.
  let created = 0;
  let deduped = 0;
  const createdContacts: Array<{ contactId: string; companyId: string | null }> = [];

  for (const candidate of eligible) {
    if (created >= effectiveLimit) break;

    const companyId = await upsertCandidateCompany(candidate);
    const contact = await upsertContact({
      companyId,
      fullName: candidate.fullName,
      title: candidate.title,
      email: candidate.email,
      linkedinUrl: candidate.linkedinUrl,
      source: candidate.source,
    });

    if (contact.created) {
      created += 1;
      // The daily planner needs the new contact ids to start research and drafting for
      // exactly the leads this run created (section 3: "source, research, draft").
      createdContacts.push({ contactId: contact.id, companyId });
    } else {
      deduped += 1;
    }
  }

  const summary: SourcingSummary = {
    icpId: icp.id,
    requested: limit,
    effectiveLimit,
    candidates: candidates.length,
    created,
    deduped,
    suppressed,
    disqualified,
    sources: [...usedSources],
    createdContacts,
  };

  await recordActivity({
    actor: "system",
    entityType: "icp",
    entityId: icp.id,
    type: "sourcing.finished",
    data: { ...summary },
  });

  return summary;
}

export interface CollectSignalsInput {
  icpId: string;
  limit?: number;
  /** Defaults to the ICP's triggers, then its pains. */
  query?: string;
  sources?: SignalSource[];
}

/**
 * Hacker News–style signals. They are stored as `sourcing.finished` events with
 * `data.signals` — the schema is fixed at sixteen tables (section 5), so signals get no
 * table of their own.
 */
export async function collectSignalsForIcp(input: CollectSignalsInput): Promise<SignalCandidate[]> {
  const row = await loadIcpWithOffer(input.icpId);
  if (!row) throw new ScoutError(`ICP ${input.icpId} was not found.`, { code: "not_found" });

  const query = (input.query?.trim() || row.icp.triggers.join(" ") || row.icp.pains.join(" ")).trim();
  if (!query) {
    logger.debug("sourcing.signals_skipped", { icpId: input.icpId, reason: "no_query" });
    return [];
  }

  const sources = input.sources ?? getSignalSources();
  if (sources.length === 0) return [];
  const limit = input.limit ?? 10;

  try {
    const settled = await Promise.allSettled(sources.map((source) => source.search({ query, limit })));
    const signals: SignalCandidate[] = [];
    const seenUrls = new Set<string>();
    let lastFailure: unknown = null;

    for (const [index, result] of settled.entries()) {
      const source = sources[index];
      if (!source) continue;
      if (result.status === "fulfilled") {
        for (const signal of result.value) {
          if (seenUrls.has(signal.url)) continue;
          seenUrls.add(signal.url);
          signals.push(signal);
        }
      } else {
        lastFailure = result.reason;
        logger.warn("sourcing.signal_source_failed", {
          source: source.name,
          code: isScoutError(result.reason) ? result.reason.code : "unexpected",
        });
      }
    }

    if (signals.length === 0 && lastFailure instanceof Error) throw lastFailure;

    await recordActivity({
      actor: "system",
      entityType: "icp",
      entityId: input.icpId,
      type: "sourcing.finished",
      data: { kind: "signals", query: query.slice(0, 200), count: signals.length, signals },
    });

    return signals.slice(0, limit * sources.length);
  } catch (error) {
    await recordActivity({
      actor: "system",
      entityType: "icp",
      entityId: input.icpId,
      type: "sourcing.failed",
      data: { kind: "signals", code: isScoutError(error) ? error.code : "unexpected" },
    });
    throw error;
  }
}

async function loadIcpWithOffer(icpId: string): Promise<{ icp: Icp; offer: Offer } | null> {
  const db = getDb();
  const [row] = await db
    .select({ icp: icps, offer: offers })
    .from(icps)
    .innerJoin(offers, eq(icps.offerId, offers.id))
    .where(eq(icps.id, icpId))
    .limit(1);
  return row ?? null;
}

async function loadExistingCompanyDomains(): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ domain: companies.domain }).from(companies);
  return rows.map((row) => row.domain);
}

async function upsertCandidateCompany(candidate: LeadCandidate): Promise<string | null> {
  if (!candidate.companyDomain) return null;
  const domain = normalizeDomain(candidate.companyDomain);
  if (!domain || !domain.includes(".")) return null;

  const company = await upsertCompany({
    domain,
    name: candidate.companyName,
    linkedinUrl: candidate.companyLinkedinUrl,
    industry: candidate.companyIndustry,
    sizeBand: candidate.companySizeBand,
    country: candidate.companyCountry,
    source: candidate.source,
    raw: { source: candidate.source },
  });
  return company.id;
}
