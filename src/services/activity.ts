import { desc, eq, and, gte, lte, sql, count } from "drizzle-orm";

import { getDb, type Transaction } from "@/src/db/client";
import { activityEvents } from "@/src/db/schema";
import type { Actor } from "@/src/domain/types";
import { logger } from "@/src/lib/logger";

/**
 * Section 3: "Append-only event log. Every state change writes to `activity_events`.
 * Dashboards and the learning loop read from it."
 *
 * Two jobs share this table:
 *  1. audit — every transition, send, guard failure and AI call;
 *  2. metering — daily Exa searches, verifications and AI spend are *counted* here
 *     rather than in their own tables, which keeps the schema at the sixteen tables
 *     section 5 specifies and makes every quota auditable after the fact.
 *
 * Nothing here updates or deletes a row.
 */

export type ActivityType =
  // Offer & ICP studio
  | "offer.created"
  | "offer.updated"
  | "offer.archived"
  | "icp.generated"
  | "icp.ranked"
  | "icp.updated"
  | "icp.approved"
  | "icp.paused"
  | "icp.archived"
  // Sourcing
  | "sourcing.started"
  | "sourcing.finished"
  | "sourcing.failed"
  | "lead.created"
  | "lead.updated"
  | "lead.deduped"
  | "lead.prescore_failed"
  | "lead.suppressed"
  | "exa.search"
  // Enrichment
  | "enrichment.patterns_generated"
  | "enrichment.email_verified"
  | "enrichment.email_rejected"
  | "enrichment.gave_up"
  | "website.read"
  // Research & scoring
  | "research.started"
  | "research.finished"
  | "research.failed"
  | "score.computed"
  // Drafting
  | "draft.created"
  | "draft.critic_failed"
  | "draft.revised"
  | "draft.blocked"
  | "draft.needs_owner"
  // Messages & sending
  | "message.approved"
  | "message.skipped"
  | "message.sending"
  | "message.sent"
  | "message.failed"
  | "message.received"
  | "message.bounced"
  | "guard.blocked"
  // Enrollments
  | "enrollment.created"
  | "enrollment.transition"
  | "enrollment.approved"
  | "enrollment.skipped"
  | "enrollment.completed"
  | "enrollment.stopped"
  | "enrollment.replied"
  | "enrollment.reenrolled"
  | "enrollment.invite_sent"
  | "enrollment.invite_accepted"
  // Replies
  | "reply.received"
  | "reply.classified"
  | "reply.alerted"
  | "reply.suggested"
  | "reply.classification_failed"
  // Compliance & safety
  | "suppression.added"
  | "suppression.matched"
  | "quota.warning"
  | "quota.exhausted"
  | "account.connected"
  | "account.status_changed"
  // AI metering
  | "ai.call"
  | "ai.failed"
  // System
  | "settings.updated"
  | "cron.daily_started"
  | "cron.daily_finished"
  | "workflow.failed"
  | "system.error"
  | "retention.pruned";

export interface ActivityInput {
  actor: Actor;
  entityType: string;
  entityId?: string | null;
  type: ActivityType;
  data?: Record<string, unknown>;
}

export async function recordActivity(input: ActivityInput, tx?: Transaction): Promise<void> {
  const db = tx ?? getDb();
  try {
    await db.insert(activityEvents).values({
      actor: input.actor,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      type: input.type,
      data: input.data ?? {},
    });
  } catch (error) {
    // The audit log must never take down the action it is describing. Log and continue;
    // section 3's append-only guarantee is about never updating, not about blocking.
    logger.error("activity.record_failed", {
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

export interface ActivityQuery {
  entityType?: string;
  entityId?: string;
  type?: ActivityType;
  since?: Date;
  until?: Date;
  limit?: number;
}

export async function listActivity(query: ActivityQuery = {}) {
  const conditions = [];
  if (query.entityType) conditions.push(eq(activityEvents.entityType, query.entityType));
  if (query.entityId) conditions.push(eq(activityEvents.entityId, query.entityId));
  if (query.type) conditions.push(eq(activityEvents.type, query.type));
  if (query.since) conditions.push(gte(activityEvents.at, query.since));
  if (query.until) conditions.push(lte(activityEvents.at, query.until));

  const db = getDb();
  const base = db.select().from(activityEvents).orderBy(desc(activityEvents.at)).limit(query.limit ?? 50);
  return conditions.length > 0 ? base.where(and(...conditions)) : base;
}

/** Counts events of a type in a window. Metering is a count, not a sum of rows. */
export async function countActivity(input: { type: ActivityType; since: Date; until?: Date }): Promise<number> {
  const db = getDb();
  const conditions = [eq(activityEvents.type, input.type), gte(activityEvents.at, input.since)];
  if (input.until) conditions.push(lte(activityEvents.at, input.until));
  const [row] = await db.select({ value: count() }).from(activityEvents).where(and(...conditions));
  return Number(row?.value ?? 0);
}

/** Sums a numeric field out of `data` for a type in a window (used for AI spend). */
export async function sumActivityNumeric(input: {
  type: ActivityType;
  field: string;
  since: Date;
  until?: Date;
}): Promise<number> {
  const db = getDb();
  const conditions = [eq(activityEvents.type, input.type), gte(activityEvents.at, input.since)];
  if (input.until) conditions.push(lte(activityEvents.at, input.until));
  const [row] = await db
    .select({ value: sql<number>`coalesce(sum((${activityEvents.data} ->> ${input.field})::numeric), 0)` })
    .from(activityEvents)
    .where(and(...conditions));
  return Number(row?.value ?? 0);
}
