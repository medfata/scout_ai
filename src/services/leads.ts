import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { getDb, type Transaction } from "@/src/db/client";
import {
  activityEvents,
  companies,
  contacts,
  leadScores,
  researchBriefs,
  suppressions,
  type Company,
  type Contact,
} from "@/src/db/schema";
import {
  advanceStage,
  isSuppressed,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
  normalizeSuppressionValue,
  type SuppressionEntry,
} from "@/src/domain";
import type { ContactStage, EmailStatus, LeadContext, SizeBand, SuppressionKind } from "@/src/domain/types";
import { hashValue } from "@/src/lib/crypto";
import { recordActivity } from "./activity";

/**
 * Companies and contacts enter Scout through here and nowhere else, so dedupe and the
 * do-not-contact list cannot be bypassed (phase 2: "a re-run adds no duplicates;
 * suppressed people never appear").
 */

export interface UpsertCompanyInput {
  domain: string;
  name?: string | null;
  linkedinUrl?: string | null;
  industry?: string | null;
  sizeBand?: SizeBand | null;
  country?: string | null;
  source: string;
  raw?: Record<string, unknown>;
}

export async function upsertCompany(input: UpsertCompanyInput, tx?: Transaction): Promise<{ id: string; created: boolean }> {
  const db = tx ?? getDb();
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new Error("upsertCompany requires a domain");

  const [existing] = await db.select({ id: companies.id }).from(companies).where(eq(companies.domain, domain)).limit(1);
  if (existing) {
    await db
      .update(companies)
      .set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.linkedinUrl ? { linkedinUrl: input.linkedinUrl } : {}),
        ...(input.industry ? { industry: input.industry } : {}),
        ...(input.sizeBand ? { sizeBand: input.sizeBand } : {}),
        ...(input.country ? { country: input.country } : {}),
        updatedAt: new Date(),
      })
      .where(eq(companies.id, existing.id));
    return { id: existing.id, created: false };
  }

  const [created] = await db
    .insert(companies)
    .values({
      domain,
      name: input.name ?? null,
      linkedinUrl: input.linkedinUrl ?? null,
      industry: input.industry ?? null,
      sizeBand: input.sizeBand ?? null,
      country: input.country ?? null,
      source: input.source,
      raw: input.raw ?? {},
    })
    .onConflictDoNothing({ target: companies.domain })
    .returning({ id: companies.id });

  if (created) return { id: created.id, created: true };

  const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.domain, domain)).limit(1);
  if (!row) throw new Error(`Company ${domain} could not be inserted or read.`);
  return { id: row.id, created: false };
}

export interface UpsertContactInput {
  companyId: string | null;
  fullName: string;
  title?: string | null;
  email?: string | null;
  emailStatus?: EmailStatus;
  linkedinUrl?: string | null;
  linkedinProviderId?: string | null;
  timezone?: string | null;
  language?: string | null;
  source: string;
}

export interface UpsertContactResult {
  id: string;
  created: boolean;
  dedupedBy: "email" | "linkedin" | "name_company" | null;
}

export async function upsertContact(input: UpsertContactInput, tx?: Transaction): Promise<UpsertContactResult> {
  const db = tx ?? getDb();
  const email = input.email ? normalizeEmail(input.email) : null;
  const linkedinSlug = input.linkedinUrl ? normalizeLinkedin(input.linkedinUrl) : null;

  // Dedupe order: email, then LinkedIn slug, then name inside the same company.
  if (email) {
    const [row] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, email)).limit(1);
    if (row) {
      await recordActivity({ actor: "system", entityType: "contact", entityId: row.id, type: "lead.deduped", data: { by: "email" } }, tx);
      return { id: row.id, created: false, dedupedBy: "email" };
    }
  }
  if (linkedinSlug) {
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(sql`${contacts.linkedinUrl} is not null and lower(${contacts.linkedinUrl}) like ${`%${linkedinSlug}%`}`)
      .limit(1);
    if (row) {
      await recordActivity({ actor: "system", entityType: "contact", entityId: row.id, type: "lead.deduped", data: { by: "linkedin" } }, tx);
      return { id: row.id, created: false, dedupedBy: "linkedin" };
    }
  }
  if (input.companyId) {
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.companyId, input.companyId), sql`lower(${contacts.fullName}) = ${input.fullName.toLowerCase()}`))
      .limit(1);
    if (row) {
      await recordActivity(
        { actor: "system", entityType: "contact", entityId: row.id, type: "lead.deduped", data: { by: "name_company" } },
        tx,
      );
      return { id: row.id, created: false, dedupedBy: "name_company" };
    }
  }

  const [created] = await db
    .insert(contacts)
    .values({
      companyId: input.companyId,
      fullName: input.fullName,
      title: input.title ?? null,
      email,
      emailStatus: input.emailStatus ?? "unknown",
      linkedinUrl: input.linkedinUrl ?? null,
      linkedinProviderId: input.linkedinProviderId ?? null,
      timezone: input.timezone ?? null,
      language: input.language ?? null,
      source: input.source,
      stage: "new",
    })
    .returning({ id: contacts.id });

  if (!created) {
    if (email) {
      const [row] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, email)).limit(1);
      if (row) return { id: row.id, created: false, dedupedBy: "email" };
    }
    throw new Error(`Contact ${input.fullName} could not be inserted.`);
  }

  await recordActivity(
    { actor: "system", entityType: "contact", entityId: created.id, type: "lead.created", data: { source: input.source } },
    tx,
  );

  return { id: created.id, created: true, dedupedBy: null };
}

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

export interface AddSuppressionInput {
  kind: SuppressionKind;
  value: string;
  reason: string;
  source?: string;
}

export async function loadSuppressionEntries(): Promise<SuppressionEntry[]> {
  const db = getDb();
  return db
    .select({ kind: suppressions.kind, value: suppressions.value, valueHash: suppressions.valueHash })
    .from(suppressions);
}

export async function isContactSuppressed(target: {
  email: string | null;
  companyDomain: string | null;
  linkedinUrl: string | null;
}): Promise<boolean> {
  const entries = await loadSuppressionEntries();
  return isSuppressed(target, entries);
}

export async function addSuppression(input: AddSuppressionInput, tx?: Transaction): Promise<{ created: boolean }> {
  const db = tx ?? getDb();
  const value = normalizeSuppressionValue(input.kind, input.value);
  const valueHash = hashValue(input.kind, value);

  const [row] = await db
    .insert(suppressions)
    .values({ kind: input.kind, value, valueHash, reason: input.reason, source: input.source ?? "scout" })
    .onConflictDoNothing()
    .returning({ id: suppressions.id });

  await recordActivity(
    {
      actor: "system",
      entityType: "suppression",
      entityId: row?.id ?? null,
      type: "suppression.added",
      data: { kind: input.kind, reason: input.reason },
    },
    tx,
  );

  return { created: Boolean(row) };
}

/** Suppress every channel this lead has, for opt-outs and hard bounces (section 9). */
export async function suppressContact(
  contact: Pick<Contact, "id" | "email" | "linkedinUrl">,
  reason: string,
  kinds: SuppressionKind[] = ["email", "linkedin"],
  tx?: Transaction,
): Promise<void> {
  for (const kind of kinds) {
    if (kind === "email" && contact.email) {
      await addSuppression({ kind: "email", value: contact.email, reason }, tx);
    }
    if (kind === "linkedin" && contact.linkedinUrl) {
      await addSuppression({ kind: "linkedin", value: contact.linkedinUrl, reason }, tx);
    }
  }
}

export async function listSuppressions(limit = 200) {
  const db = getDb();
  return db.select().from(suppressions).orderBy(desc(suppressions.createdAt)).limit(limit);
}

export async function removeSuppression(id: string): Promise<void> {
  const db = getDb();
  await db.delete(suppressions).where(eq(suppressions.id, id));
  await recordActivity({ actor: "owner", entityType: "suppression", entityId: id, type: "suppression.added", data: { removed: true } });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface LeadWithCompany {
  contact: Contact;
  company: Company | null;
}

export interface LeadFilters {
  stage?: ContactStage;
  icpId?: string;
  search?: string;
  limit?: number;
}

export async function listLeads(filters: LeadFilters = {}): Promise<LeadWithCompany[]> {
  const db = getDb();
  const conditions = [isNull(contacts.deletedAt)];
  if (filters.stage) conditions.push(eq(contacts.stage, filters.stage));

  if (filters.icpId) {
    const scored = db.select({ contactId: leadScores.contactId }).from(leadScores).where(eq(leadScores.icpId, filters.icpId));
    conditions.push(inArray(contacts.id, scored));
  }
  if (filters.search && filters.search.trim().length > 0) {
    const needle = `%${filters.search.trim().toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(${contacts.fullName}) like ${needle}`,
        sql`lower(coalesce(${contacts.title}, '')) like ${needle}`,
        sql`lower(coalesce(${companies.name}, '')) like ${needle}`,
      )!,
    );
  }

  return db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(and(...conditions))
    .orderBy(desc(contacts.createdAt))
    .limit(filters.limit ?? 100);
}

export async function getLead(contactId: string): Promise<LeadWithCompany | null> {
  const db = getDb();
  const [row] = await db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(eq(contacts.id, contactId))
    .limit(1);
  return row ?? null;
}

export async function getLeadByEmail(email: string): Promise<LeadWithCompany | null> {
  const db = getDb();
  const [row] = await db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(eq(contacts.email, normalizeEmail(email)))
    .limit(1);
  return row ?? null;
}

export async function getResearchBrief(contactId: string) {
  const db = getDb();
  const [row] = await db.select().from(researchBriefs).where(eq(researchBriefs.contactId, contactId)).limit(1);
  return row ?? null;
}

export async function getLeadScores(contactId: string) {
  const db = getDb();
  return db.select().from(leadScores).where(eq(leadScores.contactId, contactId));
}

/** Latest AI score for a lead, used by the approval inbox and the tier check. */
export async function getLatestLeadScore(contactId: string, icpId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(leadScores)
    .where(and(eq(leadScores.contactId, contactId), eq(leadScores.icpId, icpId)))
    .limit(1);
  return row ?? null;
}

export async function upsertLeadScore(input: {
  contactId: string;
  icpId: string;
  score: number;
  tier: "A" | "B" | "C" | null;
  reasons: string[];
  disqualifiedReason?: string | null;
}): Promise<void> {
  const db = getDb();
  await db
    .insert(leadScores)
    .values({
      contactId: input.contactId,
      icpId: input.icpId,
      score: input.score,
      tier: input.tier,
      reasons: input.reasons,
      disqualifiedReason: input.disqualifiedReason ?? null,
    })
    .onConflictDoUpdate({
      target: [leadScores.contactId, leadScores.icpId],
      set: {
        score: input.score,
        tier: input.tier,
        reasons: input.reasons,
        disqualifiedReason: input.disqualifiedReason ?? null,
      },
    });
  await recordActivity({
    actor: "ai",
    entityType: "contact",
    entityId: input.contactId,
    type: "score.computed",
    data: { icpId: input.icpId, score: input.score, tier: input.tier },
  });
}

/**
 * Everything the sequencer needs to decide about a step, in one read.
 *
 * LinkedIn acceptance is recorded as an `enrollment.transition` activity event with
 * reason `invite_accepted` (the webhook does this), so it survives workflow restarts
 * without a new column.
 */
export async function loadLeadContext(
  contactId: string,
  enrollmentId: string,
): Promise<(LeadContext & { contact: Contact; company: Company | null }) | null> {
  const lead = await getLead(contactId);
  if (!lead) return null;

  const db = getDb();
  const events = await db
    .select({ data: activityEvents.data, at: activityEvents.at, type: activityEvents.type })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityType, "enrollment"), eq(activityEvents.entityId, enrollmentId)))
    .orderBy(desc(activityEvents.at))
    .limit(50);

  const accepted = events.find((event) => event.type === "enrollment.invite_accepted");
  const inviteSent = events.find((event) => event.type === "enrollment.invite_sent");

  return {
    contactId,
    email: lead.contact.email,
    emailStatus: lead.contact.emailStatus,
    linkedinUrl: lead.contact.linkedinUrl,
    inviteAccepted: Boolean(accepted),
    inviteSentAt: inviteSent?.at.toISOString() ?? null,
    enrollmentStartedAt: lead.contact.collectedAt.toISOString(),
    contact: lead.contact,
    company: lead.company,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function setContactStage(contactId: string, stage: ContactStage): Promise<ContactStage> {
  const db = getDb();
  const [current] = await db.select({ stage: contacts.stage }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!current) throw new Error(`Contact ${contactId} not found`);
  const next = advanceStage(current.stage, stage);
  if (next !== current.stage) {
    await db.update(contacts).set({ stage: next, updatedAt: new Date() }).where(eq(contacts.id, contactId));
    await recordActivity({
      actor: "system",
      entityType: "contact",
      entityId: contactId,
      type: "lead.updated",
      data: { from: current.stage, to: next },
    });
  }
  return next;
}

export async function setContactEmail(contactId: string, email: string, status: EmailStatus): Promise<void> {
  const db = getDb();
  await db
    .update(contacts)
    .set({ email: normalizeEmail(email), emailStatus: status, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

export async function setContactTimezone(contactId: string, timezone: string): Promise<void> {
  const db = getDb();
  await db.update(contacts).set({ timezone, updatedAt: new Date() }).where(eq(contacts.id, contactId));
}

/** Section 9: each contact page has Export and Delete buttons for data requests. */
export async function exportContact(contactId: string): Promise<LeadWithCompany> {
  const lead = await getLead(contactId);
  if (!lead) throw new Error(`Contact ${contactId} not found`);
  return lead;
}

export async function deleteContact(contactId: string): Promise<void> {
  const db = getDb();
  const lead = await getLead(contactId);
  if (!lead) return;
  // Soft delete: keeps the suppression list and the audit trail intact (section 9).
  await suppressContact(lead.contact, "deleted_on_request", ["email", "linkedin"]);
  await db
    .update(contacts)
    .set({ deletedAt: new Date(), email: null, linkedinUrl: null, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
  await recordActivity({
    actor: "owner",
    entityType: "contact",
    entityId: contactId,
    type: "lead.updated",
    data: { deleted: true },
  });
}
