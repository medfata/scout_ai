import { count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/src/db/client";
import { icps, offers, type Offer } from "@/src/db/schema";
import { recordActivity } from "./activity";

/**
 * Section 11 phase 1: "Offers CRUD". An offer is the owner's service plus the proof the
 * copywriter may cite (section 6: "proof comes only from the offer record"). Every
 * mutation writes an `activity_events` row (section 3).
 */

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().trim().url("Proof links must be full URLs (https://…).").max(500).optional(),
);

const proofItemInput = z.object({
  label: z.string().trim().min(1, "Every proof item needs a label.").max(120),
  detail: z.string().trim().min(1, "Every proof item needs a detail.").max(600),
  url: optionalUrl,
});

export const offerInputSchema = z.object({
  title: z.string().trim().min(1, "Give the offer a title.").max(160),
  description: z.string().trim().min(1, "Describe the offer in a sentence or two.").max(4000),
  priceHint: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
  proof: z.array(proofItemInput).max(12, "Keep proof to 12 items or fewer.").default([]),
});

export type OfferInput = z.infer<typeof offerInputSchema>;

export const offerPatchSchema = offerInputSchema.partial();
export type OfferPatch = z.infer<typeof offerPatchSchema>;

export interface OfferListItem {
  offer: Offer;
  proofCount: number;
  icpCount: number;
  approvedIcpCount: number;
}

export async function createOffer(input: OfferInput): Promise<Offer> {
  const parsed = offerInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(firstIssue(parsed.error));

  const db = getDb();
  const [created] = await db
    .insert(offers)
    .values({
      title: parsed.data.title,
      description: parsed.data.description,
      proof: parsed.data.proof,
      priceHint: parsed.data.priceHint ?? null,
      status: "active",
    })
    .returning();

  if (!created) throw new Error("Offer could not be saved.");

  await recordActivity({
    actor: "owner",
    entityType: "offer",
    entityId: created.id,
    type: "offer.created",
    data: { title: created.title, proofCount: created.proof.length },
  });

  return created;
}

export async function updateOffer(id: string, patch: OfferPatch): Promise<Offer> {
  const parsed = offerPatchSchema.safeParse(patch);
  if (!parsed.success) throw new Error(firstIssue(parsed.error));
  const data = parsed.data;

  const db = getDb();
  const [updated] = await db
    .update(offers)
    .set({
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.proof !== undefined ? { proof: data.proof } : {}),
      ...(data.priceHint !== undefined ? { priceHint: data.priceHint ?? null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(offers.id, id))
    .returning();

  if (!updated) throw new Error(`Offer ${id} not found.`);

  await recordActivity({
    actor: "owner",
    entityType: "offer",
    entityId: id,
    type: "offer.updated",
    data: { changed: Object.keys(data) },
  });

  return updated;
}

export async function archiveOffer(id: string): Promise<Offer> {
  const db = getDb();
  const [updated] = await db
    .update(offers)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(offers.id, id))
    .returning();

  if (!updated) throw new Error(`Offer ${id} not found.`);

  await recordActivity({
    actor: "owner",
    entityType: "offer",
    entityId: id,
    type: "offer.archived",
    data: { title: updated.title },
  });

  return updated;
}

export async function getOffer(id: string): Promise<Offer | null> {
  const db = getDb();
  const [row] = await db.select().from(offers).where(eq(offers.id, id)).limit(1);
  return row ?? null;
}

export async function listOffers(): Promise<OfferListItem[]> {
  const db = getDb();
  const rows = await db
    .select({
      offer: offers,
      icpCount: count(icps.id),
      approvedIcpCount: sql<number>`count(*) filter (where ${icps.status} = 'approved')`.mapWith(Number),
    })
    .from(offers)
    .leftJoin(icps, eq(icps.offerId, offers.id))
    .groupBy(offers.id)
    .orderBy(desc(offers.updatedAt));

  return rows.map((row) => ({
    offer: row.offer,
    proofCount: row.offer.proof.length,
    icpCount: Number(row.icpCount),
    approvedIcpCount: row.approvedIcpCount,
  }));
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Input is invalid.";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
