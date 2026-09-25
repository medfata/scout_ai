import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import {
  activityEvents,
  companies,
  contacts,
  icps,
  leadScores,
  offers,
  researchBriefs,
} from "@/src/db/schema";
import { buildSignature, evaluateCopyRules, type Violation } from "@/src/domain/copy-rules";
import { isLive } from "@/src/domain/enrollment";
import { charLimitForStep, getSequence, getStep, wordLimitForStep } from "@/src/domain/sequence";
import { listApprovalQueue } from "@/src/services/messages";
import { getSettings } from "@/src/services/settings";
import type { InboxRow, InboxSignal, InboxViolation } from "@/components/inbox/types";

/**
 * The approval queue's read model. One query per table for the whole page (no N+1), then
 * the section 6 code checks are re-run in memory so the owner always sees the current
 * verdict for the stored body.
 */

export async function loadInboxRows(limit = 100): Promise<InboxRow[]> {
  const queue = await listApprovalQueue(limit);
  // Review item 3: the enrollment row is the authority on whether a draft is still in
  // play. A message left behind by a replied, stopped, completed or skipped enrollment
  // must never look approvable in the inbox.
  const liveQueue = queue.filter((row) => isLive(row.enrollment.status));
  if (liveQueue.length === 0) return [];

  const db = getDb();
  const messageIds = liveQueue.map((row) => row.message.id);
  const contactIds = unique(liveQueue.map((row) => row.message.contactId));
  const icpIds = unique(liveQueue.map((row) => row.enrollment.icpId));

  const [companiesByContact, briefs, scores, icpRows, verdicts, settings] = await Promise.all([
    loadCompaniesForContacts(contactIds),
    db.select().from(researchBriefs).where(inArray(researchBriefs.contactId, contactIds)),
    db.select().from(leadScores).where(inArray(leadScores.contactId, contactIds)),
    db.select().from(icps).where(inArray(icps.id, icpIds)),
    loadVerdicts(messageIds),
    getSettings(),
  ]);

  const offerIds = unique(icpRows.map((icp) => icp.offerId));
  const offerRows =
    offerIds.length > 0 ? await db.select().from(offers).where(inArray(offers.id, offerIds)) : [];
  const offersById = new Map(offerRows.map((offer) => [offer.id, offer]));
  const icpsById = new Map(icpRows.map((icp) => [icp.id, icp]));
  const briefsByContact = new Map(briefs.map((brief) => [brief.contactId, brief]));
  const signature = buildSignature(settings.signature, settings.postalAddress);

  return liveQueue.map((row) => {
    const { message, enrollment } = row;
    const icp = icpsById.get(enrollment.icpId) ?? null;
    const offer = icp ? offersById.get(icp.offerId) ?? null : null;
    const brief = briefsByContact.get(message.contactId) ?? null;
    const score = scores.find((candidate) => candidate.contactId === message.contactId && candidate.icpId === enrollment.icpId) ?? null;
    const verdictEvent = verdicts.get(message.id) ?? null;
    const claims = readClaims(verdictEvent?.data);
    const angle = typeof verdictEvent?.data.angle === "string" ? verdictEvent.data.angle : enrollment.angle;
    const step = getStep(getSequence(enrollment.sequenceKey), message.step);
    const company = companiesByContact.get(message.contactId) ?? null;

    const codeViolations = step
      ? toViolations(
          evaluateCopyRules({
            step,
            channel: message.channel,
            body: message.body,
            subject: message.subject,
            claims,
            signalCount: brief?.signals.length ?? 0,
            angleKeys: icp?.angles.map((candidate) => candidate.key) ?? [],
            angle: angle ?? "",
            proofCount: offer?.proof.length ?? 0,
            hasSignature: signature.length > 0 && message.body.includes(firstLineOf(signature)),
          }),
        )
      : [];

    return {
      messageId: message.id,
      enrollmentId: enrollment.id,
      enrollmentStatus: enrollment.status,
      contactId: message.contactId,
      contactName: row.contactName,
      contactTitle: row.contactTitle,
      contactEmail: row.contactEmail,
      companyName: company?.name ?? null,
      companyDomain: company?.domain ?? null,
      linkedinUrl: company?.linkedinUrl ?? null,
      channel: message.channel,
      step: message.step,
      stepKey: message.stepKey,
      isFirstTouch: step?.kind === "first_touch",
      subject: message.subject,
      body: message.body,
      needsOwner: message.needsOwner,
      angle: angle ?? null,
      angleKeys: icp?.angles.map((candidate) => candidate.key) ?? [],
      icpName: icp?.name ?? null,
      tier: score?.tier ?? null,
      score: score?.score ?? null,
      scoreReasons: score?.reasons ?? [],
      briefSummary: brief?.summary ?? null,
      signals: (brief?.signals ?? []) as InboxSignal[],
      likelyPains: brief?.likelyPains ?? [],
      aiOpportunity: brief?.aiOpportunity ?? null,
      confidence: brief?.confidence ?? null,
      claims,
      verdict: verdictEvent
        ? {
            passed: Boolean(verdictEvent.data.passed),
            criticPassed: Boolean(verdictEvent.data.criticPassed),
            fix: typeof verdictEvent.data.fix === "string" ? verdictEvent.data.fix : null,
          }
        : null,
      violations: readViolations(verdictEvent?.data),
      codeViolations,
      proofCount: offer?.proof.length ?? 0,
      wordLimit: step ? wordLimitForStep(step) : null,
      charLimit: step ? charLimitForStep(step) : null,
      signature: settings.signature,
      postalAddress: settings.postalAddress,
    };
  });
}

async function loadCompaniesForContacts(contactIds: string[]) {
  const db = getDb();
  const map = new Map<string, { name: string | null; domain: string | null; linkedinUrl: string | null }>();
  if (contactIds.length === 0) return map;

  const rows = await db
    .select({
      contactId: contacts.id,
      name: companies.name,
      domain: companies.domain,
      linkedinUrl: contacts.linkedinUrl,
    })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(inArray(contacts.id, contactIds));

  for (const row of rows) {
    map.set(row.contactId, { name: row.name, domain: row.domain, linkedinUrl: row.linkedinUrl });
  }
  return map;
}

interface VerdictEvent {
  entityId: string | null;
  data: Record<string, unknown>;
}

/** Latest review event per message; createDraft's own `draft.created` has no `verdict` fields. */
async function loadVerdicts(messageIds: string[]): Promise<Map<string, VerdictEvent>> {
  const db = getDb();
  const map = new Map<string, VerdictEvent>();
  if (messageIds.length === 0) return map;

  const rows = await db
    .select({ entityId: activityEvents.entityId, type: activityEvents.type, data: activityEvents.data, at: activityEvents.at })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityType, "message"), inArray(activityEvents.entityId, messageIds)))
    .orderBy(desc(activityEvents.at));

  for (const row of rows) {
    if (!row.entityId || map.has(row.entityId)) continue;
    if (row.type !== "draft.created" && row.type !== "draft.needs_owner") continue;
    if (row.data.attempts === undefined) continue; // the row-creation event, not the review
    map.set(row.entityId, { entityId: row.entityId, data: row.data });
  }
  return map;
}

function readClaims(data: Record<string, unknown> | undefined): { text: string; signalIndex: number }[] {
  if (!data || !Array.isArray(data.claims)) return [];
  return data.claims.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const claim = entry as { text?: unknown; signalIndex?: unknown };
    if (typeof claim.text !== "string" || typeof claim.signalIndex !== "number") return [];
    return [{ text: claim.text, signalIndex: claim.signalIndex }];
  });
}

function readViolations(data: Record<string, unknown> | undefined): InboxViolation[] {
  if (!data || !Array.isArray(data.violations)) return [];
  return data.violations.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const violation = entry as { code?: unknown; message?: unknown; severity?: unknown };
    if (typeof violation.code !== "string" || typeof violation.message !== "string") return [];
    return [
      {
        code: violation.code,
        message: violation.message,
        severity: violation.severity === "warning" ? ("warning" as const) : ("error" as const),
      },
    ];
  });
}

function toViolations(violations: Violation[]): InboxViolation[] {
  return violations.map((violation) => ({
    code: violation.code,
    message: violation.message,
    severity: violation.severity,
  }));
}

function firstLineOf(value: string): string {
  return value.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
