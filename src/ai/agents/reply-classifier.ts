import { getDb } from "@/src/db/client";
import { contacts, messages } from "@/src/db/schema";
import { eq } from "drizzle-orm";

import { generateStructured } from "@/src/ai/client";
import { REPLY_CLASSIFIER_PROMPT_VERSION, REPLY_CLASSIFIER_SYSTEM, buildReplyClassifierPrompt } from "@/src/ai/prompts/reply-classifier";
import { ReplyLabelSchema, type ReplyLabelOutput } from "@/src/ai/schemas";
import { recordAiCall } from "@/src/services/quota";
import { logger } from "@/src/lib/logger";

/**
 * Section 6: "Reply classifier | Fast | Inbound message + thread | `ReplyLabel` |
 * Classify, then code routes."
 *
 * This module only labels. Everything that happens next is decided by
 * `routeIntent` in `src/domain/reply.ts`.
 */

export interface ClassifyReplyInput {
  messageId: string;
}

export interface ClassifyReplyResult {
  ok: true;
  label: ReplyLabelOutput;
  costUsd: number;
}

export interface ClassifyReplyFailure {
  ok: false;
  reason: "missing_message" | "validation";
  message?: string;
}

export async function classifyReply(input: ClassifyReplyInput): Promise<ClassifyReplyResult | ClassifyReplyFailure> {
  const db = getDb();
  const [row] = await db
    .select({
      message: messages,
      contactName: contacts.fullName,
      companyName: contacts.source,
    })
    .from(messages)
    .leftJoin(contacts, eq(messages.contactId, contacts.id))
    .where(eq(messages.id, input.messageId))
    .limit(1);

  if (!row) return { ok: false, reason: "missing_message" };

  const previous = row.message.enrollmentId ? await loadPreviousOutbound(row.message.enrollmentId) : null;

  try {
    const result = await generateStructured({
      component: "reply-classifier",
      promptVersion: REPLY_CLASSIFIER_PROMPT_VERSION,
      role: "copy",
      schema: ReplyLabelSchema,
      system: REPLY_CLASSIFIER_SYSTEM,
      prompt: buildReplyClassifierPrompt({
        subject: row.message.subject,
        body: row.message.body,
        fromName: row.contactName,
        companyName: row.companyName ?? null,
        previousMessage: previous,
      }),
      contactId: row.message.contactId,
      maxOutputTokens: 400,
      temperature: 0,
    });

    await recordAiCall({
      component: "reply-classifier",
      model: result.model,
      promptVersion: result.promptVersion,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      contactId: row.message.contactId,
    });

    return { ok: true, label: result.object, costUsd: result.costUsd };
  } catch (error) {
    logger.warn("reply.classify_failed", { messageId: input.messageId, reason: error instanceof Error ? error.message : "unknown" });
    return { ok: false, reason: "validation", message: "The classifier could not label this reply; it needs the owner." };
  }
}

async function loadPreviousOutbound(enrollmentId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ subject: messages.subject, body: messages.body })
    .from(messages)
    .where(eq(messages.enrollmentId, enrollmentId))
    .orderBy(messages.sentAt)
    .limit(1);
  if (!row) return null;
  return [row.subject ? `Subject: ${row.subject}` : null, row.body].filter(Boolean).join("\n");
}
