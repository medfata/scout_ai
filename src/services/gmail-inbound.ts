import { google, type Auth } from "googleapis";

import { getDb } from "@/src/db/client";
import { connectedAccounts } from "@/src/db/schema";
import { eq } from "drizzle-orm";

import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { readAccountCredentials } from "./accounts";
import { createGmailOAuthClient } from "./oauth-gmail";
import { recordInboundMessage } from "./messages";
import { getLeadByEmail } from "./leads";
import { findEnrollmentForContact } from "./reply-handling";
import { recordActivity } from "./activity";

/**
 * Section 4: "Replies arrive via Gmail push notifications." The Pub/Sub push only carries
 * a `historyId`; this module turns that into stored inbound messages.
 *
 * The mailbox credential handling mirrors `src/adapters/channels/gmail.ts` on purpose: one
 * adapter sends, one service reads, and both go through `readAccountCredentials` so a
 * rotated `ENCRYPTION_KEY` marks the account for reconnect instead of failing silently.
 */

export interface InboundMessage {
  providerMessageId: string;
  threadId: string | null;
  rfcMessageId: string | null;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  body: string;
  receivedAt: Date;
}

export interface GmailIngestResult {
  mailbox: string | null;
  fetched: number;
  stored: number;
  skipped: number;
  errors: string[];
  /** Stored inbound message ids, so the caller can start a reply workflow for each. */
  messageIds: string[];
}

export async function ingestGmailHistory(historyId: string): Promise<GmailIngestResult> {
  const result: GmailIngestResult = { mailbox: null, fetched: 0, stored: 0, skipped: 0, errors: [], messageIds: [] };

  const client = await loadMailboxClient();
  if (!client) {
    result.errors.push("No connected mailbox; the push notification was stored unprocessed.");
    return result;
  }
  result.mailbox = client.handle;

  const gmail = google.gmail({ version: "v1", auth: client.auth });

  let messageIds: string[] = [];
  try {
    const history = await gmail.users.history.list({
      userId: "me",
      startHistoryId: historyId,
      historyTypes: ["messageAdded"],
    });
    const entries = history.data.history ?? [];
    messageIds = entries
      .flatMap((entry) => entry.messages ?? [])
      .map((message) => message.id)
      .filter((id): id is string => typeof id === "string");
  } catch (error) {
    // A history id that is too old makes Gmail answer 404; the owner is alerted through
    // the unprocessed webhook event rather than a silent gap in the thread.
    result.errors.push(error instanceof Error ? error.message : "history_list_failed");
    return result;
  }

  for (const id of dedupe(messageIds)) {
    try {
      const message = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const parsed = parseGmailMessage(message.data);
      if (!parsed) {
        result.skipped += 1;
        continue;
      }
      result.fetched += 1;

      const lead = await getLeadByEmail(parsed.fromEmail);
      const enrollment = lead ? await findEnrollmentForContact(lead.contact.id) : null;

      const stored = await recordInboundMessage({
        contactId: lead?.contact.id ?? null,
        enrollmentId: enrollment?.id ?? null,
        channel: "email",
        providerMessageId: parsed.providerMessageId,
        threadId: parsed.threadId,
        rfcMessageId: parsed.rfcMessageId,
        subject: parsed.subject,
        body: parsed.body,
        receivedAt: parsed.receivedAt,
        fromEmail: parsed.fromEmail,
      });
      result.stored += 1;
      result.messageIds.push(stored.id);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : "message_get_failed");
    }
  }

  await recordActivity({
    actor: "system",
    entityType: "gmail",
    entityId: result.mailbox,
    type: "reply.received",
    data: { historyId, fetched: result.fetched, stored: result.stored, skipped: result.skipped },
  });

  return result;
}

interface MailboxClient {
  handle: string;
  auth: Auth.OAuth2Client;
}

async function loadMailboxClient(): Promise<MailboxClient | null> {
  const db = getDb();
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.kind, "email"))
    .limit(1);
  if (!account) return null;

  const credentials = await readAccountCredentials<{
    refreshToken?: string | null;
    accessToken?: string | null;
    accessTokenExpiresAt?: string | null;
  }>(account);
  if (!credentials?.refreshToken && !credentials?.accessToken) return null;

  const env = getEnv();
  const client = createGmailOAuthClient(`${env.APP_URL}/api/oauth/gmail/callback`);
  client.setCredentials({
    refresh_token: credentials.refreshToken ?? undefined,
    access_token: credentials.accessToken ?? undefined,
  });

  try {
    const token = await client.getAccessToken();
    if (!token.token) {
      logger.warn("gmail.inbound_no_token", { accountId: account.id });
      return null;
    }
    client.setCredentials({ access_token: token.token });
  } catch (error) {
    logger.warn("gmail.inbound_token_failed", { accountId: account.id, reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }

  return { handle: account.handle, auth: client };
}

interface GmailPart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

interface GmailMessageLike {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  internalDate?: string | null;
  payload?: {
    mimeType?: string | null;
    headers?: Array<{ name?: string | null; value?: string | null }> | null;
    body?: { data?: string | null } | null;
    parts?: GmailPart[] | null;
  } | null;
}

/** Exported for tests: a Gmail message becomes an `InboundMessage`, or null when it is not mail we want. */
export function parseGmailMessage(message: GmailMessageLike): (InboundMessage & { fromEmail: string }) | null {
  const id = message.id;
  if (!id) return null;
  if (message.labelIds && !message.labelIds.includes("INBOX")) return null;

  const headers = message.payload?.headers ?? [];
  const header = (name: string): string | null => {
    const found = headers.find((entry) => entry.name?.toLowerCase() === name.toLowerCase());
    return found?.value ?? null;
  };

  const from = header("From");
  if (!from) return null;

  // `List-Unsubscribe` and `Precedence: bulk` mark bulk mail we should not treat as a reply.
  const precedence = header("Precedence")?.toLowerCase() ?? "";
  if (precedence === "bulk" || precedence === "list") return null;

  const fromEmail = extractEmail(from);
  if (!fromEmail) return null;

  const body = extractPlainText(message.payload ?? null) || header("Snippet") || "";
  const internalDate = message.internalDate ? Number(message.internalDate) : Date.now();

  return {
    providerMessageId: id,
    threadId: message.threadId ?? null,
    rfcMessageId: header("Message-ID"),
    fromEmail,
    fromName: extractDisplayName(from),
    subject: header("Subject"),
    body,
    receivedAt: new Date(Number.isFinite(internalDate) ? internalDate : Date.now()),
  };
}

function extractPlainText(payload: GmailMessageLike["payload"]): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return decodeBase64Url(part.body.data);
    }
  }
  for (const part of payload.parts ?? []) {
    const nested = extractPlainText(part as GmailMessageLike["payload"]);
    if (nested) return nested;
  }
  return "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function extractEmail(from: string): string | null {
  const angled = /<([^>]+)>/.exec(from);
  const candidate = (angled?.[1] ?? from).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

export function extractDisplayName(from: string): string | null {
  const match = /^([^<]+)</.exec(from);
  const name = match?.[1]?.trim().replace(/^"|"$/g, "");
  return name && name.length > 0 ? name : null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
