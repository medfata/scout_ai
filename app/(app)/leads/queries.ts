import { and, asc, desc, eq, inArray, max, ne } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import {
  activityEvents,
  companies,
  contacts,
  enrollments,
  icps,
  leadScores,
  messages,
  researchBriefs,
  type Company,
  type Contact,
  type Enrollment,
  type LeadScore,
  type Message,
  type ResearchBrief,
} from "@/src/db/schema";
import { CONTACT_STAGES, type ContactStage, type EmailStatus, type Tier } from "@/src/domain/types";
import { listLeads, type LeadFilters } from "@/src/services/leads";

/**
 * Read models for the leads table and the lead detail page. Kept next to the routes they
 * serve so the pages stay thin and every query is owned by this phase.
 */

export interface LeadRow {
  contactId: string;
  fullName: string;
  title: string | null;
  companyName: string | null;
  stage: ContactStage;
  emailStatus: EmailStatus;
  tier: Tier | null;
  score: number | null;
  icpId: string | null;
  icpName: string | null;
  lastActivityAt: string | null;
}

export interface LeadFilterOption {
  id: string;
  name: string;
}

export interface LeadFilterOptions {
  icps: LeadFilterOption[];
  stages: readonly ContactStage[];
}

export async function loadLeadRows(filters: LeadFilters): Promise<LeadRow[]> {
  const leads = await listLeads(filters);
  if (leads.length === 0) return [];

  const db = getDb();
  const contactIds = leads.map((lead) => lead.contact.id);

  const [scoreRows, lastActivityRows, icpRows] = await Promise.all([
    db.select().from(leadScores).where(inArray(leadScores.contactId, contactIds)),
    db
      .select({ contactId: activityEvents.entityId, lastAt: max(activityEvents.at) })
      .from(activityEvents)
      .where(and(eq(activityEvents.entityType, "contact"), inArray(activityEvents.entityId, contactIds)))
      .groupBy(activityEvents.entityId),
    db.select({ id: icps.id, name: icps.name }).from(icps),
  ]);

  const icpNames = new Map(icpRows.map((icp) => [icp.id, icp.name]));
  const lastActivity = new Map(lastActivityRows.map((row) => [row.contactId, row.lastAt]));

  return leads.map((lead) => {
    const score = pickScore(scoreRows.filter((row) => row.contactId === lead.contact.id), filters.icpId);
    return {
      contactId: lead.contact.id,
      fullName: lead.contact.fullName,
      title: lead.contact.title,
      companyName: lead.company?.name ?? null,
      stage: lead.contact.stage,
      emailStatus: lead.contact.emailStatus,
      tier: score?.tier ?? null,
      score: score?.score ?? null,
      icpId: score?.icpId ?? null,
      icpName: score ? icpNames.get(score.icpId) ?? null : null,
      lastActivityAt: toIso(lastActivity.get(lead.contact.id) ?? null),
    };
  });
}

/** The best fit wins the column; when a single ICP is filtered, that ICP's score wins. */
function pickScore(scores: LeadScore[], icpId?: string): LeadScore | null {
  if (scores.length === 0) return null;
  if (icpId) return scores.find((score) => score.icpId === icpId) ?? null;
  return [...scores].sort((a, b) => b.score - a.score)[0] ?? null;
}

export async function loadLeadFilterOptions(): Promise<LeadFilterOptions> {
  const db = getDb();
  const rows = await db
    .select({ id: icps.id, name: icps.name })
    .from(icps)
    .where(ne(icps.status, "archived"))
    .orderBy(asc(icps.rank), asc(icps.name));
  return { icps: rows, stages: CONTACT_STAGES };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface LeadDetail {
  contact: Contact;
  company: Company | null;
  brief: ResearchBrief | null;
  scores: Array<{ score: LeadScore; icpName: string | null }>;
  enrollments: Enrollment[];
  messages: Message[];
  activity: Array<{ id: number; at: string; type: string; actor: string }>;
}

export async function loadLeadDetail(contactId: string): Promise<LeadDetail | null> {
  const db = getDb();
  const [row] = await db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!row) return null;

  const [briefRows, scoreRows, enrollmentRows, messageRows, activityRows, icpRows] = await Promise.all([
    db.select().from(researchBriefs).where(eq(researchBriefs.contactId, contactId)).limit(1),
    db.select().from(leadScores).where(eq(leadScores.contactId, contactId)),
    db.select().from(enrollments).where(eq(enrollments.contactId, contactId)).orderBy(desc(enrollments.createdAt)),
    db.select().from(messages).where(eq(messages.contactId, contactId)).orderBy(desc(messages.createdAt)),
    db
      .select({ id: activityEvents.id, at: activityEvents.at, type: activityEvents.type, actor: activityEvents.actor })
      .from(activityEvents)
      .where(and(eq(activityEvents.entityType, "contact"), eq(activityEvents.entityId, contactId)))
      .orderBy(desc(activityEvents.at))
      .limit(25),
    db.select({ id: icps.id, name: icps.name }).from(icps),
  ]);

  const icpNames = new Map(icpRows.map((icp) => [icp.id, icp.name]));

  return {
    contact: row.contact,
    company: row.company,
    brief: briefRows[0] ?? null,
    scores: scoreRows.map((score) => ({ score, icpName: icpNames.get(score.icpId) ?? null })),
    enrollments: enrollmentRows,
    messages: messageRows,
    activity: activityRows.map((event) => ({
      id: event.id,
      at: event.at.toISOString(),
      type: event.type,
      actor: event.actor,
    })),
  };
}

/** Section 9: the Export button returns everything Scout holds about the contact. */
export async function loadContactExport(contactId: string) {
  const detail = await loadLeadDetail(contactId);
  if (!detail) return null;
  return {
    exportedAt: new Date().toISOString(),
    contact: {
      id: detail.contact.id,
      fullName: detail.contact.fullName,
      title: detail.contact.title,
      email: detail.contact.email,
      emailStatus: detail.contact.emailStatus,
      linkedinUrl: detail.contact.linkedinUrl,
      source: detail.contact.source,
      collectedAt: detail.contact.collectedAt.toISOString(),
      stage: detail.contact.stage,
      timezone: detail.contact.timezone,
      language: detail.contact.language,
    },
    company: detail.company
      ? {
          id: detail.company.id,
          domain: detail.company.domain,
          name: detail.company.name,
          industry: detail.company.industry,
          sizeBand: detail.company.sizeBand,
          country: detail.company.country,
        }
      : null,
    researchBrief: detail.brief
      ? {
          summary: detail.brief.summary,
          signals: detail.brief.signals,
          likelyPains: detail.brief.likelyPains,
          aiOpportunity: detail.brief.aiOpportunity,
          confidence: detail.brief.confidence,
          model: detail.brief.model,
          promptVersion: detail.brief.promptVersion,
          createdAt: detail.brief.createdAt.toISOString(),
        }
      : null,
    scores: detail.scores.map(({ score, icpName }) => ({
      icp: icpName,
      score: score.score,
      tier: score.tier,
      reasons: score.reasons,
      disqualifiedReason: score.disqualifiedReason,
    })),
    messages: detail.messages.map((message) => ({
      channel: message.channel,
      direction: message.direction,
      step: message.step,
      subject: message.subject,
      body: message.body,
      status: message.status,
      sentAt: message.sentAt?.toISOString() ?? null,
      receivedAt: message.receivedAt?.toISOString() ?? null,
      intent: message.intent,
    })),
  };
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
