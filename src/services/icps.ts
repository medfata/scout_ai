import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { critiqueIcps, generateIcps, rankIcpCandidates } from "@/src/ai/agents/icp";
import type { IcpPromptOffer } from "@/src/ai/prompts/icp";
import { getDb, withTransaction } from "@/src/db/client";
import { activityEvents, icps, learnings, type Icp, type NewIcp, type Offer } from "@/src/db/schema";
import { SIZE_BANDS, type IcpSearchFilters, type IcpStatus } from "@/src/domain/types";
import { recordActivity, type ActivityType } from "./activity";
import { getOffer } from "./offers";

/**
 * Section 11 phase 1: the ICP studio. Generation runs the two model calls, merges the
 * critic's scores over the generated ones, ranks in code and replaces the offer's
 * `proposed` ICPs. Approved, paused and archived ICPs are never touched by a re-run.
 *
 * Section 6: "Apollo filters are built by the Apollo adapter from titles, industries,
 * sizeBands and geos, not by the model." That is why only `searchFilters.exa` is
 * written here; the Apollo adapter derives its own filters from the structured columns.
 */

const angleInput = z.object({
  key: z.string().trim().min(1, "Every angle needs a key.").max(40),
  hook: z.string().trim().min(1, "Every angle needs a hook.").max(240),
});

export const icpEditSchema = z.object({
  name: z.string().trim().min(1, "Give the ICP a name.").max(120),
  rationale: z.string().trim().min(1, "Keep a short rationale.").max(600),
  pains: z.array(z.string().trim().min(1).max(240)).min(2, "Keep at least two pains.").max(12),
  titles: z.array(z.string().trim().min(1).max(120)).min(1, "Keep at least one title.").max(20),
  industries: z.array(z.string().trim().min(1).max(120)).min(1, "Keep at least one industry.").max(20),
  sizeBands: z.array(z.enum(SIZE_BANDS)).max(SIZE_BANDS.length),
  geos: z.array(z.string().trim().min(1).max(80)).max(20),
  disqualifiers: z.array(z.string().trim().min(1).max(240)).max(20),
  angles: z.array(angleInput).min(2, "Keep at least two angles.").max(3, "Keep at most three angles."),
});

export const icpEditPatchSchema = icpEditSchema.partial();

export type IcpEditInput = z.infer<typeof icpEditSchema>;
export type IcpEditPatch = z.infer<typeof icpEditPatchSchema>;

export async function listIcpsForOffer(offerId: string): Promise<Icp[]> {
  const db = getDb();
  return db
    .select()
    .from(icps)
    .where(eq(icps.offerId, offerId))
    .orderBy(sql`${icps.rank} asc nulls last`, asc(icps.createdAt));
}

export async function getIcp(id: string): Promise<Icp | null> {
  const db = getDb();
  const [row] = await db.select().from(icps).where(eq(icps.id, id)).limit(1);
  return row ?? null;
}

export async function updateIcp(id: string, patch: IcpEditPatch): Promise<Icp> {
  const parsed = icpEditPatchSchema.safeParse(patch);
  if (!parsed.success) throw new Error(firstIssue(parsed.error));
  const data = parsed.data;

  const db = getDb();
  const [updated] = await db
    .update(icps)
    .set({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.rationale !== undefined ? { rationale: data.rationale } : {}),
      ...(data.pains !== undefined ? { pains: data.pains } : {}),
      ...(data.titles !== undefined ? { titles: data.titles } : {}),
      ...(data.industries !== undefined ? { industries: data.industries } : {}),
      ...(data.sizeBands !== undefined ? { sizeBands: data.sizeBands } : {}),
      ...(data.geos !== undefined ? { geos: data.geos } : {}),
      ...(data.disqualifiers !== undefined ? { disqualifiers: data.disqualifiers } : {}),
      ...(data.angles !== undefined ? { angles: data.angles } : {}),
      updatedAt: new Date(),
    })
    .where(eq(icps.id, id))
    .returning();

  if (!updated) throw new Error(`ICP ${id} not found.`);

  await recordActivity({
    actor: "owner",
    entityType: "icp",
    entityId: id,
    type: "icp.updated",
    data: { offerId: updated.offerId, changed: Object.keys(data) },
  });

  return updated;
}

export async function approveIcp(id: string): Promise<Icp> {
  return setIcpStatus(id, "approved", "icp.approved");
}

export async function pauseIcp(id: string): Promise<Icp> {
  return setIcpStatus(id, "paused", "icp.paused");
}

export async function archiveIcp(id: string): Promise<Icp> {
  return setIcpStatus(id, "archived", "icp.archived");
}

async function setIcpStatus(id: string, status: IcpStatus, type: ActivityType): Promise<Icp> {
  const db = getDb();
  const [updated] = await db
    .update(icps)
    .set({ status, updatedAt: new Date() })
    .where(eq(icps.id, id))
    .returning();

  if (!updated) throw new Error(`ICP ${id} not found.`);

  await recordActivity({
    actor: "owner",
    entityType: "icp",
    entityId: id,
    type,
    data: { offerId: updated.offerId, status },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface IcpRunUsage {
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface IcpGenerationRun {
  icps: Icp[];
  usage: IcpRunUsage;
  dropped: Array<{ name: string; reason: string }>;
}

/**
 * Sections 11 phase 1 and 6: one offer yields 3-7 ranked ICPs that pass Zod, can be
 * edited and saved, and log their cost. The AI calls happen outside the transaction;
 * only the validated rows and the audit events are written atomically.
 *
 * A `QuotaExceededError` from `assertAiBudget` propagates untouched so the UI can show
 * "AI budget for today is used up" (section 9).
 */
export async function generateIcpsForOffer(offerId: string): Promise<IcpGenerationRun> {
  const offer = await getOffer(offerId);
  if (!offer) throw new Error(`Offer ${offerId} not found.`);

  const promptOffer = toPromptOffer(offer);
  const learningTexts = await loadLearningsForIcpGeneration();

  const generated = await generateIcps({ offer: promptOffer, learnings: learningTexts });
  const critique = await critiqueIcps({ offer: promptOffer, icps: generated.icps });
  const ranked = rankIcpCandidates({ icps: generated.icps }, critique.critique);

  const usage: IcpRunUsage = {
    model: generated.usage.model,
    promptVersion: generated.usage.promptVersion,
    inputTokens: generated.usage.inputTokens + critique.usage.inputTokens,
    outputTokens: generated.usage.outputTokens + critique.usage.outputTokens,
    costUsd: generated.usage.costUsd + critique.usage.costUsd,
  };

  const saved = await withTransaction(async (tx) => {
    await tx.delete(icps).where(and(eq(icps.offerId, offerId), eq(icps.status, "proposed")));

    const rows: NewIcp[] = ranked.map((icp) => ({
      offerId,
      name: icp.name,
      rationale: icp.rationale,
      industries: icp.industries,
      sizeBands: icp.sizeBands,
      geos: icp.geos,
      titles: icp.titles,
      pains: icp.pains,
      triggers: icp.triggers,
      disqualifiers: icp.disqualifiers,
      // Section 6: only the Exa search comes from the model; Apollo filters are
      // derived from the structured columns by the Apollo adapter.
      searchFilters: {
        exa: { query: icp.exa.query, criteria: icp.exa.criteria },
      } satisfies IcpSearchFilters,
      angles: icp.angles,
      scores: icp.scores,
      rank: icp.rank,
      status: "proposed",
    }));

    const inserted = rows.length > 0 ? await tx.insert(icps).values(rows).returning() : [];

    await recordActivity(
      {
        actor: "ai",
        entityType: "offer",
        entityId: offerId,
        type: "icp.generated",
        data: {
          offerId,
          count: inserted.length,
          dropped: critique.critique.drop.length,
          model: usage.model,
          promptVersion: usage.promptVersion,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: Number(usage.costUsd.toFixed(6)),
        },
      },
      tx,
    );

    await recordActivity(
      {
        actor: "ai",
        entityType: "offer",
        entityId: offerId,
        type: "icp.ranked",
        data: {
          offerId,
          model: usage.model,
          costUsd: Number(usage.costUsd.toFixed(6)),
          ranks: inserted.map((icp) => ({ icpId: icp.id, name: icp.name, rank: icp.rank })),
        },
      },
      tx,
    );

    return inserted;
  });

  return { icps: saved, usage, dropped: critique.critique.drop };
}

/** Active global learnings, fed into the generator prompt (section 6). Empty in phase 1. */
export async function loadLearningsForIcpGeneration(limit = 20): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ text: learnings.text })
    .from(learnings)
    .where(and(eq(learnings.active, true), isNull(learnings.icpId)))
    .orderBy(desc(learnings.updatedAt))
    .limit(limit);
  return rows.map((row) => row.text);
}

export interface IcpGenerationSummary {
  at: Date;
  count: number;
  costUsd: number;
  model: string;
  promptVersion: string;
}

/** The last generation run for an offer, read back from `activity_events` for the UI. */
export async function lastIcpGeneration(offerId: string): Promise<IcpGenerationSummary | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.entityType, "offer"),
        eq(activityEvents.entityId, offerId),
        eq(activityEvents.type, "icp.generated"),
      ),
    )
    .orderBy(desc(activityEvents.at))
    .limit(1);

  if (!row) return null;
  return {
    at: row.at,
    count: numberFrom(row.data.count),
    costUsd: numberFrom(row.data.costUsd),
    model: stringFrom(row.data.model) ?? "unknown",
    promptVersion: stringFrom(row.data.promptVersion) ?? "unknown",
  };
}

function toPromptOffer(offer: Offer): IcpPromptOffer {
  return {
    title: offer.title,
    description: offer.description,
    proof: offer.proof,
    priceHint: offer.priceHint,
  };
}

function numberFrom(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Input is invalid.";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
