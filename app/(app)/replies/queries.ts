import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import { activityEvents, contacts, messages } from "@/src/db/schema";
import type { ReplyRow } from "@/components/replies/types";

/**
 * The replies page's read model. Section 7: the webhook stores every inbound message and
 * starts the reply workflow, which classifies it and stores a summary on the row. This
 * query joins the contact in and adds the latest suggested reply from `activity_events`
 * (never from `messages`, because a suggestion must not look like a sendable message).
 *
 * `src/services/messages.ts#listReplies` is the service-level equivalent; this file exists
 * because the page also needs contact names and suggestions in one pass.
 */

export async function loadReplyRows(limit = 100): Promise<ReplyRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      messageId: messages.id,
      contactId: messages.contactId,
      contactName: contacts.fullName,
      intent: messages.intent,
      intentData: messages.intentData,
      receivedAt: messages.receivedAt,
    })
    .from(messages)
    .innerJoin(contacts, eq(messages.contactId, contacts.id))
    .where(and(eq(messages.direction, "inbound"), isNotNull(messages.receivedAt)))
    .orderBy(desc(messages.receivedAt))
    .limit(limit);

  const contactIds = [...new Set(rows.map((row) => row.contactId))];
  const suggestions = await loadSuggestedReplies(contactIds);

  return rows.map((row) => ({
    messageId: row.messageId,
    contactId: row.contactId,
    contactName: row.contactName,
    intent: row.intent,
    summary: row.intentData?.summary ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    suggestedReply: suggestions.get(row.contactId) ?? null,
  }));
}

/** Latest suggestion per contact. The event stores the body in `data.body`. */
async function loadSuggestedReplies(contactIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (contactIds.length === 0) return map;

  const db = getDb();
  const rows = await db
    .select({ entityId: activityEvents.entityId, data: activityEvents.data })
    .from(activityEvents)
    .where(and(eq(activityEvents.type, "reply.suggested"), inArray(activityEvents.entityId, contactIds)))
    .orderBy(desc(activityEvents.at));

  for (const row of rows) {
    if (!row.entityId || map.has(row.entityId)) continue;
    const body = row.data.body;
    if (typeof body === "string" && body.trim().length > 0) map.set(row.entityId, body);
  }
  return map;
}
