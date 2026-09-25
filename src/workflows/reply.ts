import { getDb } from "@/src/db/client";
import { enrollments, messages } from "@/src/db/schema";
import { and, eq, inArray } from "drizzle-orm";

import type { LeadEvent, ReplyIntent } from "@/src/domain/types";
import { claimReplyHandling, handleInboundReply } from "@/src/services/reply-handling";
import { leadEventHook } from "./sequence";

/**
 * Section 7: "That workflow classifies the reply, acts on it, and then calls
 * `resumeHook("lead:<enrollmentId>", event)` so the sequence stops or reschedules."
 *
 * The workflow itself only orchestrates: classification, suppression, alerts and the
 * suggested reply all happen in `handleInboundReply`, which is idempotent because every
 * decision it makes is keyed on stored state. `reply_handled_at` is the claim that makes
 * the *runs themselves* idempotent (review item 16).
 *
 * `resumeHook` must be called from outside a workflow function, so the resume happens in
 * a step — a step is a normal function at runtime, which is exactly the boundary the SDK
 * documents.
 */

export type ReplyWorkflowResult =
  | { status: "handled"; intent: string; resumed: boolean }
  | { status: "needs_owner"; reason: string }
  | { status: "no_enrollment" }
  | { status: "already_handled" };

export async function replyWorkflow(messageId: string): Promise<ReplyWorkflowResult> {
  "use workflow";

  // Review item 16: the step that starts reply runs can retry, so two runs may exist for
  // the same message. The claim is atomic and the loser is a no-op.
  const claimed = await claimStep(messageId);
  if (!claimed) return { status: "already_handled" };

  const handled = await classifyStep(messageId);
  if (!handled.ok) {
    await alertNeedsOwnerStep(messageId, handled.reason);
    return { status: "needs_owner", reason: handled.reason };
  }

  const resumed = await resumeSequenceStep(messageId);
  return { status: "handled", intent: handled.intent ?? "other", resumed };
}

async function claimStep(messageId: string): Promise<boolean> {
  "use step";
  return claimReplyHandling(messageId);
}

interface ClassifyStepResult {
  ok: boolean;
  reason: string;
  intent: string | null;
}

async function classifyStep(messageId: string): Promise<ClassifyStepResult> {
  "use step";

  const result = await handleInboundReply({ messageId });
  if (!result.ok) return { ok: false, reason: result.reason ?? "unknown", intent: null };
  return { ok: true, reason: "", intent: result.intent ?? null };
}

/**
 * Wakes the sleeping sequence with the right lead event. Returns false when the sequence
 * already finished (a reply that arrives after the last step is still classified and
 * still alerts the owner — it just has nothing to interrupt).
 */
async function resumeSequenceStep(messageId: string): Promise<boolean> {
  "use step";

  const db = getDb();
  const [row] = await db
    .select({
      enrollmentId: messages.enrollmentId,
      intent: messages.intent,
      intentData: messages.intentData,
      contactId: messages.contactId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!row?.enrollmentId) return false;

  // Only wake a run that is still in play; a finished enrollment has no hook, and the
  // status already says what happened.
  const [enrollment] = await db
    .select({ id: enrollments.id, status: enrollments.status })
    .from(enrollments)
    .where(and(eq(enrollments.id, row.enrollmentId), inArray(enrollments.status, ["active", "waiting"])))
    .limit(1);

  if (!enrollment) return false;

  const event = toLeadEvent(row.intent, row.intentData?.returnDate ?? undefined);
  const { resumeLeadEvent } = await import("@/src/services/hooks");
  const result = await resumeLeadEvent(enrollment.id, event);
  return result.resumed;
}

async function alertNeedsOwnerStep(messageId: string, reason: string): Promise<void> {
  "use step";

  const { notifyOwner } = await import("@/src/services/notifications");
  const { recordActivity } = await import("@/src/services/activity");
  const db = getDb();
  const [row] = await db.select({ contactId: messages.contactId }).from(messages).where(eq(messages.id, messageId)).limit(1);

  await notifyOwner({
    kind: "error",
    title: "A reply could not be classified",
    body: "Open Scout and read the thread; the lead's sequence is paused until this is resolved.",
    url: "/replies",
    contactId: row?.contactId ?? undefined,
    data: { messageId, reason },
  });
  await recordActivity({
    actor: "system",
    entityType: "message",
    entityId: messageId,
    type: "reply.classification_failed",
    data: { reason },
  });
}

export function toLeadEvent(intent: string | null, returnDate?: string): LeadEvent {
  switch (intent) {
    case "out_of_office":
      return { type: "ooo", returnDate };
    case "bounce":
      return { type: "bounce", kind: "hard" };
    case "unsubscribe":
      return { type: "optout" };
    case "auto_reply":
      return { type: "reply", intent: "auto_reply" };
    default:
      return { type: "reply", intent: (intent ?? "other") as ReplyIntent };
  }
}

export { leadEventHook };
