import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import { contacts, enrollments, messages, type Message } from "@/src/db/schema";
import { isHumanIntent } from "@/src/domain";
import type { ChannelKind, MessageStatus, ReplyIntent } from "@/src/domain/types";
import { idempotencyKey } from "@/src/lib/ids";
import { recordActivity } from "./activity";

/**
 * Every draft, sent and received message lives in `messages` (section 5). The
 * idempotency key is written at draft time and never changes, which is what makes a
 * retried send safe: the second insert with the same key fails.
 */

export interface CreateDraftInput {
  enrollmentId: string;
  contactId: string;
  channel: ChannelKind;
  step: number;
  stepKey: string;
  subject?: string | null;
  body: string;
  status: Extract<MessageStatus, "drafted" | "pending_approval" | "approved">;
  model?: string | null;
  promptVersion?: string | null;
  costUsd?: number;
  needsOwner?: boolean;
}

export async function createDraft(input: CreateDraftInput): Promise<Message> {
  const db = getDb();
  const key = idempotencyKey(input.enrollmentId, input.step, input.channel);

  const [created] = await db
    .insert(messages)
    .values({
      enrollmentId: input.enrollmentId,
      contactId: input.contactId,
      channel: input.channel,
      direction: "outbound",
      step: input.step,
      stepKey: input.stepKey,
      subject: input.subject ?? null,
      body: input.body,
      status: input.status,
      idempotencyKey: key,
      model: input.model ?? null,
      promptVersion: input.promptVersion ?? null,
      costUsd: (input.costUsd ?? 0).toFixed(6),
      needsOwner: input.needsOwner ?? false,
    })
    .onConflictDoNothing({ target: messages.idempotencyKey })
    .returning();

  if (created) {
    await recordActivity({
      actor: "ai",
      entityType: "message",
      entityId: created.id,
      type: "draft.created",
      data: { enrollmentId: input.enrollmentId, step: input.step, channel: input.channel },
    });
    return created;
  }

  // The draft already existed: a retried step. Return the stored row untouched.
  const existing = await getMessageByIdempotencyKey(key);
  if (!existing) throw new Error(`Draft ${key} conflicted but could not be read back.`);
  return existing;
}

export async function getMessageByIdempotencyKey(key: string): Promise<Message | null> {
  const db = getDb();
  const [row] = await db.select().from(messages).where(eq(messages.idempotencyKey, key)).limit(1);
  return row ?? null;
}

export async function getMessage(messageId: string): Promise<Message | null> {
  const db = getDb();
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  return row ?? null;
}

export async function getStepMessage(enrollmentId: string, step: number, channel: ChannelKind): Promise<Message | null> {
  return getMessageByIdempotencyKey(idempotencyKey(enrollmentId, step, channel));
}

/** The owner's edit before approving; claims and grounding are re-checked by the critic. */
export async function updateDraft(messageId: string, patch: { subject?: string | null; body?: string }): Promise<Message> {
  const db = getDb();
  const [updated] = await db
    .update(messages)
    .set({
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      updatedAt: new Date(),
    })
    .where(eq(messages.id, messageId))
    .returning();
  if (!updated) throw new Error(`Message ${messageId} not found`);
  return updated;
}

export async function approveMessage(messageId: string, actor: "owner" | "system" = "owner"): Promise<Message> {
  const db = getDb();
  const [updated] = await db
    .update(messages)
    .set({ status: "approved", updatedAt: new Date() })
    .where(and(eq(messages.id, messageId), inArray(messages.status, ["drafted", "pending_approval"])))
    .returning();
  if (updated) {
    await recordActivity({ actor, entityType: "message", entityId: messageId, type: "message.approved" });
    return updated;
  }
  const existing = await getMessage(messageId);
  if (!existing) throw new Error(`Message ${messageId} not found`);
  return existing;
}

export async function skipMessage(messageId: string, reason: string): Promise<Message> {
  const db = getDb();
  const [updated] = await db
    .update(messages)
    .set({ status: "skipped", updatedAt: new Date() })
    .where(and(eq(messages.id, messageId), inArray(messages.status, ["drafted", "pending_approval", "approved"])))
    .returning();
  if (!updated) {
    const existing = await getMessage(messageId);
    if (!existing) throw new Error(`Message ${messageId} not found`);
    return existing;
  }
  await recordActivity({ actor: "owner", entityType: "message", entityId: messageId, type: "message.skipped", data: { reason } });
  return updated;
}

/**
 * Section 7, guard rule 8: "The idempotency key is unused; mark `sending`, call the
 * provider, store the provider id, mark `sent`."
 *
 * Returns false when another worker already claimed the message, so the provider is
 * called exactly once even if the step is retried.
 *
 * Review item 8: `rfcMessageId` is written *before* the provider call (same UPDATE, so
 * there is no window where a claimed message has no Message-ID to reconcile with). A
 * message that stays `sending` after a crash or an ambiguous provider error is looked up
 * by this id on the next attempt.
 */
export async function claimMessageForSend(messageId: string, rfcMessageId?: string): Promise<Message | null> {
  const db = getDb();
  const [claimed] = await db
    .update(messages)
    .set({
      status: "sending",
      ...(rfcMessageId ? { rfcMessageId } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(messages.id, messageId), eq(messages.status, "approved")))
    .returning();
  return claimed ?? null;
}

export interface MarkSentInput {
  providerMessageId: string;
  threadId: string | null;
  rfcMessageId: string | null;
  sentAt: Date;
}

/**
 * Review item B2: stores the mailbox send slot reserved for this message on the message
 * itself (`messages.scheduled_for`, section 5), and returns whichever slot the message
 * owns. The conditional update makes the first writer win: a retried or racing attempt on
 * the same message waits for the stored slot instead of consuming a second one from the
 * mailbox's queue.
 *
 * Review item 1: the same update overwrites a slot that has expired (`scheduled_for`
 * earlier than `expiredBefore`), so a message that missed its place in the queue while it
 * was blocked takes a fresh one instead of keeping a slot nobody can honour.
 */
export async function storeMessageSendSlot(messageId: string, slotAt: Date, expiredBefore: Date): Promise<Date> {
  const db = getDb();
  const [stored] = await db
    .update(messages)
    .set({ scheduledFor: slotAt, updatedAt: new Date() })
    .where(
      and(
        eq(messages.id, messageId),
        or(isNull(messages.scheduledFor), lt(messages.scheduledFor, expiredBefore)),
      ),
    )
    .returning({ scheduledFor: messages.scheduledFor });

  if (stored?.scheduledFor) return stored.scheduledFor;

  const existing = await getMessage(messageId);
  if (!existing) throw new Error(`Message ${messageId} not found while storing its send slot.`);
  if (!existing.scheduledFor) throw new Error(`Message ${messageId} was not given a send slot.`);
  return existing.scheduledFor;
}

/**
 * Review item 1: a message blocked by the sending window, the daily cap or a park keeps a
 * slot that has already passed; at the next window start it would skip pacing and send at
 * once alongside every other blocked message. Clearing the slot here makes the next attempt
 * reserve a fresh place in the mailbox queue.
 */
export async function clearMessageSendSlot(messageId: string): Promise<void> {
  const db = getDb();
  await db
    .update(messages)
    .set({ scheduledFor: null, updatedAt: new Date() })
    .where(and(eq(messages.id, messageId), isNotNull(messages.scheduledFor)));
}

/**
 * The by-key variant for a block that happens before the guard has read the message row
 * (a kill switch, a missing signature or a DRY_RUN with nowhere to send). The key is unique,
 * so this clears exactly the message the step would have sent.
 */
export async function clearMessageSendSlotByKey(key: string): Promise<void> {
  const db = getDb();
  await db
    .update(messages)
    .set({ scheduledFor: null, updatedAt: new Date() })
    .where(and(eq(messages.idempotencyKey, key), isNotNull(messages.scheduledFor)));
}

export async function markMessageSent(messageId: string, input: MarkSentInput): Promise<Message> {
  const db = getDb();
  const [updated] = await db
    .update(messages)
    .set({
      status: "sent",
      providerMessageId: input.providerMessageId,
      threadId: input.threadId ?? undefined,
      rfcMessageId: input.rfcMessageId,
      sentAt: input.sentAt,
      updatedAt: new Date(),
    })
    .where(eq(messages.id, messageId))
    .returning();
  if (!updated) throw new Error(`Message ${messageId} not found`);
  await recordActivity({
    actor: "system",
    entityType: "message",
    entityId: messageId,
    type: "message.sent",
    data: { channel: updated.channel, step: updated.step, providerMessageId: input.providerMessageId },
  });
  return updated;
}

export async function markMessageFailed(messageId: string, error: string): Promise<Message> {
  const db = getDb();
  const [updated] = await db
    .update(messages)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();
  if (!updated) throw new Error(`Message ${messageId} not found`);
  await recordActivity({ actor: "system", entityType: "message", entityId: messageId, type: "message.failed", data: { error } });
  return updated;
}

/** Puts a claimed message back to `approved` so the next run can retry it. */
export async function releaseMessage(messageId: string): Promise<void> {
  const db = getDb();
  await db
    .update(messages)
    .set({ status: "approved", updatedAt: new Date() })
    .where(and(eq(messages.id, messageId), eq(messages.status, "sending")));
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export interface RecordInboundInput {
  contactId: string | null;
  enrollmentId: string | null;
  channel: ChannelKind;
  providerMessageId: string;
  threadId: string | null;
  rfcMessageId: string | null;
  subject: string | null;
  body: string;
  receivedAt: Date;
  fromEmail?: string | null;
}

export async function recordInboundMessage(input: RecordInboundInput): Promise<Message> {
  const db = getDb();

  const [existing] = await db.select().from(messages).where(eq(messages.providerMessageId, input.providerMessageId)).limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(messages)
    .values({
      enrollmentId: input.enrollmentId,
      contactId: input.contactId ?? (await resolveContactId(input.enrollmentId, input.fromEmail)),
      channel: input.channel,
      direction: "inbound",
      step: -1,
      stepKey: null,
      subject: input.subject,
      body: input.body,
      status: "received",
      providerMessageId: input.providerMessageId,
      threadId: input.threadId,
      rfcMessageId: input.rfcMessageId,
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing()
    .returning();

  if (!created) {
    const [row] = await db.select().from(messages).where(eq(messages.providerMessageId, input.providerMessageId)).limit(1);
    if (!row) throw new Error("Inbound message insert conflicted but could not be read back.");
    return row;
  }

  await recordActivity({
    actor: "system",
    entityType: "message",
    entityId: created.id,
    type: "message.received",
    data: { channel: input.channel, contactId: created.contactId },
  });
  await recordActivity({
    actor: "system",
    entityType: "contact",
    entityId: created.contactId,
    type: "reply.received",
    data: { channel: input.channel },
  });
  return created;
}

async function resolveContactId(enrollmentId: string | null, fromEmail: string | null | undefined): Promise<string> {
  const db = getDb();
  if (enrollmentId) {
    const [row] = await db.select({ contactId: enrollments.contactId }).from(enrollments).where(eq(enrollments.id, enrollmentId)).limit(1);
    if (row) return row.contactId;
  }
  if (fromEmail) {
    const [row] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, fromEmail.toLowerCase())).limit(1);
    if (row) return row.id;
  }
  throw new Error("Inbound message has no matching contact; it was stored without a lead.");
}

export async function setMessageIntent(
  messageId: string,
  intent: ReplyIntent,
  intentData: Record<string, unknown> = {},
): Promise<void> {
  const db = getDb();
  await db
    .update(messages)
    .set({ intent, intentData: intentData as Message["intentData"], updatedAt: new Date() })
    .where(eq(messages.id, messageId));
  await recordActivity({
    actor: "ai",
    entityType: "message",
    entityId: messageId,
    type: "reply.classified",
    data: { intent, ...intentData },
  });
}

/**
 * Section 7, guard rule 4: "No unclassified or human inbound message from this lead
 * since enrollment started." Until classification finishes, further sends are blocked.
 */
export async function hasUnresolvedInbound(contactId: string, since: Date | null): Promise<boolean> {
  const db = getDb();
  const conditions = [eq(messages.contactId, contactId), eq(messages.direction, "inbound")];
  if (since) conditions.push(gte(messages.receivedAt, since));

  const rows = await db
    .select({ intent: messages.intent })
    .from(messages)
    .where(and(...conditions));

  return rows.some((row) => row.intent === null || isHumanIntent(row.intent));
}

export async function hasAnyInbound(contactId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.contactId, contactId), eq(messages.direction, "inbound")))
    .limit(1);
  return Boolean(row);
}

/** Finds the enrollment a reply belongs to, by thread first, then by contact. */
export async function findEnrollmentForInbound(input: {
  threadId: string | null;
  contactId: string | null;
}): Promise<{ enrollmentId: string; contactId: string } | null> {
  const db = getDb();

  if (input.threadId) {
    const [row] = await db
      .select({ enrollmentId: messages.enrollmentId, contactId: messages.contactId })
      .from(messages)
      .where(and(eq(messages.threadId, input.threadId), sql`${messages.enrollmentId} is not null`))
      .orderBy(desc(messages.sentAt))
      .limit(1);
    if (row?.enrollmentId) return { enrollmentId: row.enrollmentId, contactId: row.contactId };
  }

  if (input.contactId) {
    const [row] = await db
      .select({ id: enrollments.id, contactId: enrollments.contactId })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.contactId, input.contactId),
          inArray(enrollments.status, ["drafted", "pending_approval", "active", "waiting", "replied"]),
        ),
      )
      .orderBy(desc(enrollments.createdAt))
      .limit(1);
    if (row) return { enrollmentId: row.id, contactId: row.contactId };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reads for the approval inbox, replies page and lead detail
// ---------------------------------------------------------------------------

export async function listApprovalQueue(limit = 100) {
  const db = getDb();
  return db
    .select({
      message: messages,
      enrollment: enrollments,
      contactName: contacts.fullName,
      contactTitle: contacts.title,
      contactEmail: contacts.email,
    })
    .from(messages)
    .innerJoin(enrollments, eq(messages.enrollmentId, enrollments.id))
    .innerJoin(contacts, eq(messages.contactId, contacts.id))
    .where(and(inArray(messages.status, ["drafted", "pending_approval"]), eq(messages.direction, "outbound")))
    .orderBy(desc(messages.updatedAt))
    .limit(limit);
}

export async function listMessagesForEnrollment(enrollmentId: string): Promise<Message[]> {
  const db = getDb();
  return db
    .select()
    .from(messages)
    .where(eq(messages.enrollmentId, enrollmentId))
    .orderBy(asc(messages.step), asc(messages.createdAt));
}

export async function listMessagesForContact(contactId: string): Promise<Message[]> {
  const db = getDb();
  return db
    .select()
    .from(messages)
    .where(eq(messages.contactId, contactId))
    .orderBy(desc(messages.createdAt));
}

export async function listReplies(limit = 100) {
  const db = getDb();
  return db
    .select({
      message: messages,
      contactName: contacts.fullName,
      contactId: contacts.id,
      companyName: sql<string | null>`null`,
    })
    .from(messages)
    .innerJoin(contacts, eq(messages.contactId, contacts.id))
    .where(and(eq(messages.direction, "inbound"), sql`${messages.intent} is not null`))
    .orderBy(desc(messages.receivedAt))
    .limit(limit);
}

export async function countMessagesByStatus(status: MessageStatus): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ value: sql<number>`count(*)::int` }).from(messages).where(eq(messages.status, status));
  return Number(row?.value ?? 0);
}

/** A sent message's thread + RFC id, needed to reply in-thread (section 7, day-3 follow-up). */
export async function getThreadAnchor(enrollmentId: string): Promise<{ threadId: string | null; rfcMessageId: string | null }> {
  const db = getDb();
  const [row] = await db
    .select({ threadId: messages.threadId, rfcMessageId: messages.rfcMessageId })
    .from(messages)
    .where(and(eq(messages.enrollmentId, enrollmentId), eq(messages.status, "sent")))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return { threadId: row?.threadId ?? null, rfcMessageId: row?.rfcMessageId ?? null };
}

/**
 * Review item 10: every Message-ID already sent on this enrollment, oldest first, so the
 * send guard can set `References` to the whole chain and `In-Reply-To` to its last entry.
 */
export async function listSentRfcMessageIds(enrollmentId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ rfcMessageId: messages.rfcMessageId })
    .from(messages)
    .where(
      and(
        eq(messages.enrollmentId, enrollmentId),
        eq(messages.status, "sent"),
        sql`${messages.rfcMessageId} is not null`,
      ),
    )
    .orderBy(asc(messages.sentAt), asc(messages.createdAt));
  return rows.map((row) => row.rfcMessageId).filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Section 7: "Not now" creates a new, approval-gated enrollment. */
export async function listEnrollmentsAwaitingStep(enrollmentId: string): Promise<Message | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.enrollmentId, enrollmentId), isNull(messages.sentAt), inArray(messages.status, ["drafted", "pending_approval", "approved"])))
    .orderBy(asc(messages.step))
    .limit(1);
  return row ?? null;
}

export async function markThreadRead(contactId: string): Promise<void> {
  const db = getDb();
  await db
    .update(messages)
    .set({ updatedAt: new Date() })
    .where(and(eq(messages.contactId, contactId), or(isNull(messages.intent), eq(messages.intent, "other"))));
}
