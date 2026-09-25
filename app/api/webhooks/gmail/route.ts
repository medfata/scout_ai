import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { start } from "workflow/api";

import { getDb } from "@/src/db/client";
import { webhookEvents } from "@/src/db/schema";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { logWebhookRejection, markWebhookProcessed, storeWebhookEvent, verifySharedSecret } from "@/src/lib/webhooks";
import { gmailIngestWorkflow } from "@/src/workflows/gmail-ingest";

/**
 * Section 4: "Replies arrive via Gmail push notifications." Section 8: "Each webhook route
 * verifies a shared secret with a constant-time compare, then stores the raw event before
 * doing anything else."
 *
 * The Pub/Sub push envelope is `{ message: { data: base64, messageId, publishTime },
 * subscription }`; the decoded payload is `{ emailAddress, historyId }`. The push carries
 * no mail itself, so the route hands the history id to a workflow.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface PubSubEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

interface GmailPushPayload {
  emailAddress?: string;
  historyId?: string | number;
}

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();

  // Pub/Sub can only send the secret in the URL or as a bearer token; both are accepted,
  // both compared in constant time.
  const verified = verifySharedSecret(request, {
    headerName: "authorization",
    queryParam: "token",
    expected: env.GMAIL_PUSH_SECRET,
    stripBearer: true,
  });
  if (!verified.ok) {
    logWebhookRejection("gmail", verified.reason ?? "unauthorized", request);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let envelope: PubSubEnvelope;
  try {
    envelope = (await request.json()) as PubSubEnvelope;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data = envelope.message?.data;
  if (!data) {
    return NextResponse.json({ error: "Missing Pub/Sub message data" }, { status: 400 });
  }

  let payload: GmailPushPayload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as GmailPushPayload;
  } catch {
    return NextResponse.json({ error: "Pub/Sub payload was not base64 JSON" }, { status: 400 });
  }

  const historyId = payload.historyId === undefined ? null : String(payload.historyId);
  if (!payload.emailAddress || !historyId) {
    return NextResponse.json({ error: "Payload had no emailAddress or historyId" }, { status: 400 });
  }

  // Store before acting: a redelivery of the same push is then a no-op.
  const stored = await storeWebhookEvent({
    provider: "gmail",
    externalId: `${payload.emailAddress}:${historyId}`,
    eventType: "gmail.push",
    payload: payload as Record<string, unknown>,
  });

  // Review item 15: a duplicate only counts as handled when the first attempt finished
  // cleanly. One whose first attempt errored or was interrupted is retried — the ingest is
  // idempotent (`messages.provider_message_id` is unique), so a retry cannot double-store
  // mail or double-classify a reply.
  if (stored.duplicate) {
    const prior = await loadWebhookOutcome(stored.id);
    if (prior?.processedAt && !prior.error) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    logger.warn("webhook.gmail_duplicate_retry", {
      reason: prior?.error ? "previous_error" : "not_processed",
    });
  }

  try {
    const run = await start(gmailIngestWorkflow, [historyId]);
    await markWebhookProcessed(stored.id);
    return NextResponse.json({ ok: true, runId: run.runId, duplicate: stored.duplicate });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ingest_start_failed";
    logger.error("webhook.gmail_ingest_failed", { reason: message });
    // The event stays in `webhook_events` with its error, so a redelivery retries it.
    await markWebhookProcessed(stored.id, message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

interface WebhookOutcome {
  processedAt: Date | null;
  error: string | null;
}

/** The stored event's outcome; `null` means it could not be read, which is retried. */
async function loadWebhookOutcome(id: string): Promise<WebhookOutcome | null> {
  if (id === "unknown") return null;
  const db = getDb();
  const [row] = await db
    .select({ processedAt: webhookEvents.processedAt, error: webhookEvents.error })
    .from(webhookEvents)
    .where(eq(webhookEvents.id, id))
    .limit(1);
  return row ?? null;
}
