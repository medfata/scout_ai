import { and, desc, eq, isNull, lt, or } from "drizzle-orm";

import { generateStructured } from "@/src/ai/client";
import { classifyReply } from "@/src/ai/agents/reply-classifier";
import { SUGGESTED_REPLY_PROMPT_VERSION, SUGGESTED_REPLY_SYSTEM, buildSuggestedReplyPrompt } from "@/src/ai/prompts/suggested-reply";
import { SuggestedReplySchema } from "@/src/ai/schemas";
import { getDb } from "@/src/db/client";
import { contacts, enrollments, icps, messages, offers } from "@/src/db/schema";
import { notNowDateOnly, routeIntent } from "@/src/domain";
import type { ReplyIntent, SuppressionKind } from "@/src/domain/types";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { recordActivity } from "./activity";
import { suppressContact } from "./leads";
import { setMessageIntent } from "./messages";
import { notifyOwner } from "./notifications";
import { recordAiCall } from "./quota";
import { createEnrollment, markReplied, stopEnrollment } from "./enrollment";

/**
 * Section 7's reply handling, minus the scheduling: classify, then let code route.
 *
 *   classify → suppress / stop / reschedule / alert / suggest a reply
 *
 * This module is called from the reply workflow's steps and from the replies page's
 * "reclassify" action, so it is safe to run twice: every side effect is keyed on state
 * that is already stored (`messages.intent`, `suppressions`, the enrollment status).
 */

export interface HandleReplyResult {
  ok: boolean;
  reason?: string;
  intent?: ReplyIntent;
  stopped: boolean;
  rescheduled: boolean;
  suppressed: boolean;
  alerted: boolean;
  suggestedReply: string | null;
}

/** How long a claim is honoured before a later run may pick the message up again. */
const REPLY_CLAIM_STALE_MS = 15 * 60 * 1000;

/**
 * Review item 16: a workflow step may retry, so `start(replyWorkflow, …)` can run twice for
 * the same message (double model call, double alert). `reply_handled_at` is an atomic claim:
 * the conditional UPDATE only matches while the column is null or stale, so exactly one run
 * wins.
 *
 * The stale window lets a run that died mid-classification be retried instead of blocking
 * the message forever. `intent IS NULL` keeps an already-classified message — from an
 * earlier run or from the replies page's "reclassify" — out of the claim, so nothing alerts
 * twice.
 */
export async function claimReplyHandling(messageId: string): Promise<boolean> {
  const db = getDb();
  const staleBefore = new Date(Date.now() - REPLY_CLAIM_STALE_MS);
  const [claimed] = await db
    .update(messages)
    .set({ replyHandledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.direction, "inbound"),
        isNull(messages.intent),
        or(isNull(messages.replyHandledAt), lt(messages.replyHandledAt, staleBefore)),
      ),
    )
    .returning({ id: messages.id });
  return Boolean(claimed);
}

export async function handleInboundReply(input: { messageId: string }): Promise<HandleReplyResult> {
  const db = getDb();
  const [row] = await db
    .select({
      message: messages,
      contact: contacts,
    })
    .from(messages)
    .innerJoin(contacts, eq(messages.contactId, contacts.id))
    .where(and(eq(messages.id, input.messageId), eq(messages.direction, "inbound")))
    .limit(1);

  if (!row) {
    return { ok: false, reason: "missing_message", stopped: false, rescheduled: false, suppressed: false, alerted: false, suggestedReply: null };
  }

  // Already classified: a retried step must not pay for a second model call or double-alert.
  let intent = row.message.intent;
  let intentData = row.message.intentData ?? {};
  if (!intent) {
    const classified = await classifyReply({ messageId: input.messageId });
    if (!classified.ok) {
      await recordActivity({
        actor: "system",
        entityType: "contact",
        entityId: row.contact.id,
        type: "reply.classification_failed",
        data: { messageId: input.messageId, reason: classified.reason },
      });
      return {
        ok: false,
        reason: classified.reason,
        stopped: false,
        rescheduled: false,
        suppressed: false,
        alerted: false,
        suggestedReply: null,
      };
    }
    intent = classified.label.intent;
    intentData = {
      returnDate: classified.label.returnDate,
      followUpAfter: classified.label.followUpAfter,
      referral: classified.label.referral,
    };
    await setMessageIntent(input.messageId, intent, {
      summary: classified.label.summary,
      ...intentData,
    });
  }

  const routing = routeIntent(intent);
  const enrollment = await findEnrollmentForContact(row.contact.id);

  let suppressed = false;
  if (routing.suppressKinds.length > 0) {
    const kinds: SuppressionKind[] = [];
    if (routing.suppressKinds.includes("email") && row.contact.email) kinds.push("email");
    if (routing.suppressKinds.includes("linkedin") && row.contact.linkedinUrl) kinds.push("linkedin");
    await suppressContact(row.contact, intent, kinds);

    // Review item 20: a hard bounce suppresses the email address only. The company-domain
    // suppression this block used to write was invented — it blocked every colleague of a
    // person whose mailbox had moved, and `addSuppression` now refuses such writes outright.
    suppressed = kinds.length > 0;
  }

  let stopped = false;
  if (routing.stopSequence && enrollment) {
    if (intent === "unsubscribe" || intent === "not_interested" || intent === "bounce") {
      await stopEnrollment(enrollment.id, `reply:${intent}`);
    } else {
      await markReplied(enrollment.id, `reply:${intent}`);
    }
    stopped = true;
  }

  if (routing.stage) {
    const { setContactStage } = await import("./leads");
    await setContactStage(row.contact.id, routing.stage);
  }

  if (routing.createReEnrollment && enrollment) {
    const today = new Date().toISOString().slice(0, 10);
    const notBefore = notNowDateOnly(intentData.followUpAfter, today);
    const reEnrollment = await createEnrollment({
      contactId: row.contact.id,
      icpId: enrollment.icpId,
      sequenceKey: enrollment.sequenceKey,
      angle: enrollment.angle,
      needsApproval: true,
    });
    const { getDb: db2 } = await import("@/src/db/client");
    const { enrollments: enrollmentsTable } = await import("@/src/db/schema");
    await db2()
      .update(enrollmentsTable)
      .set({ nextActionAt: new Date(`${notBefore}T09:00:00Z`), updatedAt: new Date() })
      .where(eq(enrollmentsTable.id, reEnrollment.id));
    await recordActivity({
      actor: "system",
      entityType: "enrollment",
      entityId: reEnrollment.id,
      type: "enrollment.reenrolled",
      data: { from: enrollment.id, notBefore, reason: "not_now" },
    });
  }

  const suggestedReply = routing.suggestReply ? await suggestReply({ messageId: input.messageId, intent }) : null;

  let alerted = false;
  if (routing.alert !== "none") {
    await notifyOwner({
      kind: routing.alert === "hot" ? "reply_hot" : "reply_normal",
      title: alertTitle(intent, row.contact.fullName, null),
      body: summarize(row.message.body),
      url: `/replies?contact=${row.contact.id}`,
      contactId: row.contact.id,
      data: { intent, messageId: input.messageId },
    });
    alerted = true;
    await recordActivity({
      actor: "system",
      entityType: "contact",
      entityId: row.contact.id,
      type: "reply.alerted",
      data: { intent, channel: routing.alert },
    });
  }

  return {
    ok: true,
    intent,
    stopped,
    rescheduled: routing.reschedule,
    suppressed,
    alerted,
    suggestedReply,
  };
}

export interface ReplyEnrollment {
  id: string;
  icpId: string;
  sequenceKey: string;
  angle: string | null;
  status: string;
  contactId: string;
}

/** The most recent live-or-replied enrollment for a contact, which a reply belongs to. */
export async function findEnrollmentForContact(contactId: string): Promise<ReplyEnrollment | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: enrollments.id,
      icpId: enrollments.icpId,
      sequenceKey: enrollments.sequenceKey,
      angle: enrollments.angle,
      status: enrollments.status,
      contactId: enrollments.contactId,
    })
    .from(enrollments)
    .where(eq(enrollments.contactId, contactId))
    .orderBy(desc(enrollments.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Section 7: "alert the owner, suggest a response". Stored as an activity event rather
 * than a `messages` row, because every row in `messages` is a potential send and a
 * suggestion must never become one by accident.
 */
async function suggestReply(input: { messageId: string; intent: ReplyIntent }): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({
      message: messages,
      contact: contacts,
      icp: icps,
      offer: offers,
    })
    .from(messages)
    .innerJoin(contacts, eq(messages.contactId, contacts.id))
    .innerJoin(enrollments, eq(messages.enrollmentId, enrollments.id))
    .innerJoin(icps, eq(enrollments.icpId, icps.id))
    .innerJoin(offers, eq(icps.offerId, offers.id))
    .where(eq(messages.id, input.messageId))
    .limit(1);

  if (!row) return null;

  const env = getEnv();
  try {
    const result = await generateStructured({
      component: "suggested-reply",
      promptVersion: SUGGESTED_REPLY_PROMPT_VERSION,
      role: "copy",
      schema: SuggestedReplySchema,
      system: SUGGESTED_REPLY_SYSTEM,
      prompt: buildSuggestedReplyPrompt({
        intent: input.intent,
        summary: String(row.message.intentData?.summary ?? ""),
        inboundBody: row.message.body,
        contactName: row.contact.fullName,
        companyName: null,
        offerTitle: row.offer.title,
        offerDescription: row.offer.description,
        bookingUrl: env.CALCOM_BOOKING_URL || null,
      }),
      contactId: row.contact.id,
      maxOutputTokens: 500,
    });

    await recordAiCall({
      component: "suggested-reply",
      model: result.model,
      promptVersion: result.promptVersion,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      contactId: row.contact.id,
    });

    await recordActivity({
      actor: "ai",
      entityType: "contact",
      entityId: row.contact.id,
      type: "reply.suggested",
      data: { messageId: input.messageId, subject: result.object.subject ?? null, body: result.object.body },
    });

    return result.object.body;
  } catch (error) {
    logger.warn("reply.suggest_failed", { messageId: input.messageId, reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

function alertTitle(intent: ReplyIntent, contactName: string, companyName: string | null): string {
  const who = companyName ? `${contactName} (${companyName})` : contactName;
  switch (intent) {
    case "interested":
      return `${who} is interested`;
    case "meeting_request":
      return `${who} wants a meeting`;
    case "question":
      return `${who} asked a question`;
    case "referral":
      return `${who} referred you to someone`;
    case "not_now":
      return `${who} said not now`;
    case "not_interested":
      return `${who} said no`;
    case "unsubscribe":
      return `${who} asked to opt out`;
    case "bounce":
      return `Bounce from ${who}`;
    case "other":
      return `Reply from ${who}`;
    default:
      return `Reply from ${who}`;
  }
}

function summarize(body: string): string {
  const firstLine = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)[0] ?? "";
  return firstLine.length > 280 ? `${firstLine.slice(0, 277)}…` : firstLine;
}
