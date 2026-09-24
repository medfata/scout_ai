import { eq } from "drizzle-orm";

import { LlmValidationError } from "@/src/ai/client";
import {
  researchLead,
  type ResearchLeadDeps,
  type ResearchLinkedinProfileFn,
  type ResearchSearchFn,
} from "@/src/ai/agents/research";
import { scoreLead, type ScoreLeadResult } from "@/src/ai/agents/score";
import type { ResearchBriefOutput } from "@/src/ai/schemas";
import { createJinaWebsiteReader } from "@/src/adapters/enrich";
import { EXA_RESPONSE_SCHEMA } from "@/src/adapters/sources/exa";
import { getDb } from "@/src/db/client";
import {
  icps,
  offers,
  researchBriefs,
  type Icp,
  type Offer,
  type ResearchBrief,
} from "@/src/db/schema";
import {
  allowsEmailEnrichment,
  passesResearchGate,
  RESEARCH_SCORE_ENRICHMENT_THRESHOLD,
  PRE_SCORE_RESEARCH_THRESHOLD,
} from "@/src/domain/scoring";
import type { LinkedinMode } from "@/src/domain/types";
import { ConfigurationError, QuotaExceededError, VendorError, isScoutError } from "@/src/lib/errors";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import type { WebsiteReader } from "@/src/ports/website-reader";
import { recordActivity } from "./activity";
import { getLead, getResearchBrief, isContactSuppressed, upsertLeadScore } from "./leads";
import { assertAiBudget, assertExaQuota, recordAiCall, recordExaSearch } from "./quota";

/**
 * Phase 3's use cases: research one lead, score it, and expose the section 6 cost gates
 * so the pipeline can decide what deserves a model call.
 *
 * The agent itself is adapter-free; this file is the call site that injects the website
 * reader and the Exa-backed search function, and it owns persistence, quota accounting
 * and the "needs owner" marker.
 */

// Section 6 cost control, re-exported so another pipeline can gate without importing
// the domain module directly.
export { allowsEmailEnrichment, passesResearchGate };
export { PRE_SCORE_RESEARCH_THRESHOLD, RESEARCH_SCORE_ENRICHMENT_THRESHOLD };

export interface ResearchAdapterDeps {
  readWebsite: WebsiteReader;
  /** Exa-backed web search. Counted against the daily quota by this service. */
  search: ResearchSearchFn;
  linkedinProfile?: ResearchLinkedinProfileFn;
  linkedinMode?: LinkedinMode;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Brief persistence
// ---------------------------------------------------------------------------

export interface UpsertBriefInput {
  contactId: string;
  brief: ResearchBriefOutput;
  model: string;
  promptVersion: string;
  costUsd: number;
}

export async function upsertBrief(input: UpsertBriefInput): Promise<ResearchBrief> {
  const db = getDb();
  const [row] = await db
    .insert(researchBriefs)
    .values({
      contactId: input.contactId,
      summary: input.brief.summary,
      signals: input.brief.signals,
      likelyPains: input.brief.likelyPains,
      hooks: input.brief.hooks,
      aiOpportunity: input.brief.aiOpportunity,
      confidence: input.brief.confidence,
      model: input.model,
      promptVersion: input.promptVersion,
      costUsd: input.costUsd.toFixed(6),
    })
    .onConflictDoUpdate({
      target: researchBriefs.contactId,
      set: {
        summary: input.brief.summary,
        signals: input.brief.signals,
        likelyPains: input.brief.likelyPains,
        hooks: input.brief.hooks,
        aiOpportunity: input.brief.aiOpportunity,
        confidence: input.brief.confidence,
        model: input.model,
        promptVersion: input.promptVersion,
        costUsd: input.costUsd.toFixed(6),
      },
    })
    .returning();

  if (!row) throw new Error(`Research brief for contact ${input.contactId} could not be saved.`);
  return row;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export type ResearchOutcome =
  | {
      ok: true;
      brief: ResearchBrief;
      /** True when an existing brief answered and no model call was made (retry-safe). */
      skipped: boolean;
      toolCalls: number;
      costUsd: number;
      model: string;
    }
  | {
      ok: false;
      reason: "suppressed" | "missing_lead" | "missing_icp" | "validation" | "quota" | "unavailable";
      message?: string;
    };

interface IcpWithOffer {
  icp: Icp;
  offer: Offer;
}

async function loadIcpWithOffer(icpId: string): Promise<IcpWithOffer | null> {
  const db = getDb();
  const [row] = await db
    .select({ icp: icps, offer: offers })
    .from(icps)
    .innerJoin(offers, eq(icps.offerId, offers.id))
    .where(eq(icps.id, icpId))
    .limit(1);
  return row ?? null;
}

export interface ResearchLeadForContactInput {
  contactId: string;
  icpId: string;
  /** Re-run even when a brief already exists. Default false so retried steps are free. */
  force?: boolean;
}

export async function researchLeadForContact(
  input: ResearchLeadForContactInput,
  deps: ResearchAdapterDeps,
): Promise<ResearchOutcome> {
  const lead = await getLead(input.contactId);
  if (!lead) return { ok: false, reason: "missing_lead" };

  // A suppressed lead never costs a model call or an Exa search.
  if (await isContactSuppressed({
    email: lead.contact.email,
    companyDomain: lead.company?.domain ?? null,
    linkedinUrl: lead.contact.linkedinUrl,
  })) {
    await recordActivity({
      actor: "system",
      entityType: "contact",
      entityId: input.contactId,
      type: "suppression.matched",
      data: { stage: "research" },
    });
    return { ok: false, reason: "suppressed" };
  }

  if (!input.force) {
    const existing = await getResearchBrief(input.contactId);
    if (existing) {
      return {
        ok: true,
        brief: existing,
        skipped: true,
        toolCalls: 0,
        costUsd: Number(existing.costUsd),
        model: existing.model ?? "unknown",
      };
    }
  }

  const icpWithOffer = await loadIcpWithOffer(input.icpId);
  if (!icpWithOffer) return { ok: false, reason: "missing_icp" };

  try {
    // Section 9: "Daily AI spend above DAILY_AI_BUDGET_USD: stop research and drafting
    // until tomorrow", and section 0's Exa daily search quota.
    await assertAiBudget();
    await assertExaQuota();

    await recordActivity({
      actor: "system",
      entityType: "contact",
      entityId: input.contactId,
      type: "research.started",
      data: { icpId: input.icpId },
    });

    const result = await researchLead(
      {
        contactId: input.contactId,
        icpId: input.icpId,
        prompt: {
          company: {
            companyName: lead.company?.name ?? lead.company?.domain ?? "Unknown company",
            companyDomain: lead.company?.domain ?? null,
            websiteUrl: lead.company?.domain ? `https://${lead.company.domain}` : null,
            industry: lead.company?.industry ?? null,
            sizeBand: lead.company?.sizeBand ?? null,
            country: lead.company?.country ?? null,
            contactTitle: lead.contact.title,
          },
          icp: {
            name: icpWithOffer.icp.name,
            pains: icpWithOffer.icp.pains,
            triggers: icpWithOffer.icp.triggers,
            disqualifiers: icpWithOffer.icp.disqualifiers,
          },
          offer: {
            title: icpWithOffer.offer.title,
            description: icpWithOffer.offer.description,
          },
          language: lead.contact.language,
          today: new Date().toISOString().slice(0, 10),
          maxToolCalls: 6,
        },
      },
      toAgentDeps(deps, input.icpId),
    );

    const brief = await upsertBrief({
      contactId: input.contactId,
      brief: result.brief,
      model: result.model,
      promptVersion: result.promptVersion,
      costUsd: result.costUsd,
    });

    await recordAiCall({
      component: "research",
      model: result.model,
      promptVersion: result.promptVersion,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      contactId: input.contactId,
    });

    await recordActivity({
      actor: "system",
      entityType: "contact",
      entityId: input.contactId,
      type: "research.finished",
      data: { icpId: input.icpId, signals: result.brief.signals.length, toolCalls: result.toolCalls },
    });

    return {
      ok: true,
      brief,
      skipped: false,
      toolCalls: result.toolCalls,
      costUsd: result.costUsd,
      model: result.model,
    };
  } catch (error) {
    if (error instanceof LlmValidationError) {
      // Section 10 rule 5: nothing is persisted; the contact is marked for the owner.
      await recordActivity({
        actor: "system",
        entityType: "contact",
        entityId: input.contactId,
        type: "research.failed",
        data: { reason: "validation", component: error.component, attempts: error.attempts },
      });
      return { ok: false, reason: "validation", message: error.message };
    }
    if (error instanceof QuotaExceededError) {
      return { ok: false, reason: "quota", message: error.message };
    }
    if (error instanceof ConfigurationError) {
      // A missing key or an unwired adapter is a configuration state, not a lead failure.
      logger.warn("research.unavailable", { contactId: input.contactId, reason: error.message });
      return { ok: false, reason: "unavailable", message: error.message };
    }
    logger.error("research.failed", {
      contactId: input.contactId,
      icpId: input.icpId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    await recordActivity({
      actor: "system",
      entityType: "contact",
      entityId: input.contactId,
      type: "research.failed",
      data: { reason: "error" },
    });
    throw error;
  }
}

/** Translates the service's adapter deps into the agent's port-shaped deps. */
function toAgentDeps(deps: ResearchAdapterDeps, icpId: string): ResearchLeadDeps {
  return {
    readWebsite: deps.readWebsite,
    // Every Exa search the agent makes passes the quota guard (section 0).
    search: quotaGuardedSearch(deps.search, icpId),
    ...(deps.linkedinProfile ? { linkedinProfile: deps.linkedinProfile } : {}),
    ...(deps.linkedinMode ? { linkedinMode: deps.linkedinMode } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ScoreOutcome =
  | { ok: true; result: ScoreLeadResult }
  | {
      ok: false;
      reason: "missing_lead" | "missing_icp" | "missing_brief" | "validation" | "quota";
      message?: string;
    };

export async function scoreLeadForContact(input: {
  contactId: string;
  icpId: string;
}): Promise<ScoreOutcome> {
  const lead = await getLead(input.contactId);
  if (!lead) return { ok: false, reason: "missing_lead" };

  const brief = await getResearchBrief(input.contactId);
  if (!brief) return { ok: false, reason: "missing_brief" };

  const icpWithOffer = await loadIcpWithOffer(input.icpId);
  if (!icpWithOffer) return { ok: false, reason: "missing_icp" };

  const suppressed = await isContactSuppressed({
    email: lead.contact.email,
    companyDomain: lead.company?.domain ?? null,
    linkedinUrl: lead.contact.linkedinUrl,
  });

  try {
    await assertAiBudget();

    const result = await scoreLead({
      contactId: input.contactId,
      icpId: input.icpId,
      lead: {
        title: lead.contact.title,
        companyName: lead.company?.name ?? null,
        companyDomain: lead.company?.domain ?? null,
        industry: lead.company?.industry ?? null,
        sizeBand: lead.company?.sizeBand ?? null,
        country: lead.company?.country ?? null,
        emailStatus: lead.contact.emailStatus,
        suppressed,
      },
      icp: {
        name: icpWithOffer.icp.name,
        rationale: icpWithOffer.icp.rationale,
        pains: icpWithOffer.icp.pains,
        triggers: icpWithOffer.icp.triggers,
        titles: icpWithOffer.icp.titles,
        industries: icpWithOffer.icp.industries,
        sizeBands: icpWithOffer.icp.sizeBands,
        geos: icpWithOffer.icp.geos,
        disqualifiers: icpWithOffer.icp.disqualifiers,
      },
      brief: {
        summary: brief.summary,
        signals: brief.signals,
        likelyPains: brief.likelyPains,
        aiOpportunity: brief.aiOpportunity,
        hooks: brief.hooks,
        confidence: brief.confidence,
      },
    });

    await upsertLeadScore({
      contactId: input.contactId,
      icpId: input.icpId,
      score: result.score,
      tier: result.tier,
      reasons: result.reasons,
      disqualifiedReason: result.disqualifiedReason,
    });

    await recordAiCall({
      component: "score",
      model: result.model,
      promptVersion: result.promptVersion,
      costUsd: result.costUsd,
      contactId: input.contactId,
    });

    return { ok: true, result };
  } catch (error) {
    if (error instanceof LlmValidationError) {
      await recordActivity({
        actor: "system",
        entityType: "contact",
        entityId: input.contactId,
        type: "ai.failed",
        data: { component: "score", reason: "validation", attempts: error.attempts },
      });
      return { ok: false, reason: "validation", message: error.message };
    }
    if (isScoutError(error) && error.code === "quota_exceeded") {
      return { ok: false, reason: "quota", message: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Adapter wiring
// ---------------------------------------------------------------------------

/**
 * The call site that plugs real adapters into the research tools. `researchLeadForContact`
 * wraps the search function in the Exa quota guard, so every search an agent makes is
 * counted against the daily and monthly allowance (section 0).
 */
export function resolveResearchAdapterDeps(): ResearchAdapterDeps {
  return {
    readWebsite: createJinaWebsiteReader(),
    search: createExaTextSearch(),
    linkedinMode: getEnv().LINKEDIN_MODE,
  };
}

/**
 * Exa text search for the `webSearch` / `recentNews` tools. The sourcing adapter
 * (`src/adapters/sources/exa.ts`) is a people-search `LeadSource` and does not expose a
 * page-text search, so the research call lives here, reusing its exported response schema.
 *
 * Raw on purpose: `researchLeadForContact` wraps it with `quotaGuardedSearch`, which is
 * the only path allowed to call Exa for research.
 */
export function createExaTextSearch(options: { apiKey?: string; fetchImpl?: typeof fetch } = {}): ResearchSearchFn {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (query: string) => {
    const apiKey = options.apiKey ?? requireExaKey();

    let response: Response;
    try {
      response = await fetchImpl(EXA_SEARCH_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          query,
          numResults: EXA_RESEARCH_RESULTS,
          type: "auto",
          contents: { text: { maxCharacters: EXA_RESEARCH_TEXT_CHARS } },
        }),
        signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
      });
    } catch (error) {
      throw new VendorError("exa", `Research search failed: ${error instanceof Error ? error.message : "network error"}`, {
        code: "vendor_unavailable",
        retryable: true,
        cause: error,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw VendorError.fromStatus("exa", response.status, text);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      throw new VendorError("exa", "Research search returned invalid JSON.", {
        code: "vendor_unavailable",
        retryable: true,
        cause: error,
      });
    }

    const parsed = EXA_RESPONSE_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      throw new VendorError("exa", "Research search returned an unexpected shape.", {
        code: "vendor_unavailable",
        context: { issues: parsed.error.issues.length },
      });
    }

    return parsed.data.results
      .filter((result): result is typeof result & { url: string } => typeof result.url === "string")
      .map((result) => ({
        url: result.url,
        title: result.title ?? null,
        text: result.text ?? "",
      }));
  };
}

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_TIMEOUT_MS = 20_000;
const EXA_RESEARCH_RESULTS = 5;
const EXA_RESEARCH_TEXT_CHARS = 1_500;

function requireExaKey(): string {
  const value = getEnv().EXA_API_KEY;
  if (!value) {
    throw new ConfigurationError("EXA_API_KEY is not set, so research cannot search the web. Add it to .env.local.", {
      vendor: "exa",
    });
  }
  return value;
}

/** Wraps a search function with the Exa quota guard; used by the adapter wiring above. */
export function quotaGuardedSearch(search: ResearchSearchFn, icpId?: string): ResearchSearchFn {
  return async (query: string) => {
    await assertExaQuota();
    const hits = await search(query);
    await recordExaSearch({ query, count: 1, icpId });
    return hits;
  };
}
