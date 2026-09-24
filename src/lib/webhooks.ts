import { and, eq } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import { webhookEvents } from "@/src/db/schema";
import { secureCompare } from "@/src/lib/crypto";
import { logger } from "@/src/lib/logger";

/**
 * Section 8: "Each webhook route verifies a shared secret with a constant-time compare,
 * then stores the raw event before doing anything else."
 *
 * Storing first is what makes a redelivery safe: the unique index on
 * `(provider, external_id)` turns a duplicate push into a no-op, and an event that fails
 * downstream stays in the table with its error for the owner to inspect.
 */

export interface VerifyOptions {
  /** Header carrying the secret, e.g. `authorization` for `Bearer …`. */
  headerName?: string;
  /** Query parameter carrying the secret, when the provider only supports a URL. */
  queryParam?: string;
  /** Exact expected value. Never logged. */
  expected: string | undefined;
  /** When the provider prefixes the secret (`Bearer `), strip it before comparing. */
  stripBearer?: boolean;
}

export function verifySharedSecret(request: Request, options: VerifyOptions): { ok: boolean; reason?: string } {
  if (!options.expected) {
    return { ok: false, reason: "secret_not_configured" };
  }

  const url = new URL(request.url);
  const fromQuery = options.queryParam ? url.searchParams.get(options.queryParam) : null;
  const fromHeader = options.headerName ? request.headers.get(options.headerName) : null;

  const provided = fromQuery ?? (options.stripBearer && fromHeader?.startsWith("Bearer ") ? fromHeader.slice(7) : fromHeader);

  if (!provided) return { ok: false, reason: "missing_secret" };
  return secureCompare(provided, options.expected) ? { ok: true } : { ok: false, reason: "bad_secret" };
}

export interface StoreWebhookInput {
  provider: string;
  externalId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface StoreWebhookResult {
  id: string;
  duplicate: boolean;
}

export async function storeWebhookEvent(input: StoreWebhookInput): Promise<StoreWebhookResult> {
  const db = getDb();
  const [created] = await db
    .insert(webhookEvents)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      eventType: input.eventType,
      payload: input.payload,
    })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.externalId] })
    .returning({ id: webhookEvents.id });

  if (created) return { id: created.id, duplicate: false };

  const [existing] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, input.provider), eq(webhookEvents.externalId, input.externalId)))
    .limit(1);

  return { id: existing?.id ?? "unknown", duplicate: true };
}

export async function markWebhookProcessed(id: string, error?: string): Promise<void> {
  if (id === "unknown") return;
  const db = getDb();
  await db
    .update(webhookEvents)
    .set({ processedAt: new Date(), error: error ?? null })
    .where(eq(webhookEvents.id, id));
}

/** Section 0: alert at 80% of the workflow-event allowance, and pause when it is gone. */
export function logWebhookRejection(provider: string, reason: string, request: Request): void {
  logger.warn("webhook.rejected", { provider, reason, path: new URL(request.url).pathname });
}
