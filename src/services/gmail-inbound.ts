import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { google, type Auth } from "googleapis";

import { getDb } from "@/src/db/client";
import { connectedAccounts, messages as messagesTable } from "@/src/db/schema";

import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { markWebhookProcessed, storeWebhookEvent } from "@/src/lib/webhooks";
import { readAccountCredentials } from "./accounts";
import { createGmailOAuthClient } from "./oauth-gmail";
import { findEnrollmentForInbound, recordInboundMessage } from "./messages";
import { getLeadByEmail } from "./leads";
import { notifyOwner } from "./notifications";
import { recordActivity } from "./activity";

/**
 * Section 4: "Replies arrive via Gmail push notifications." The Pub/Sub push only carries
 * a `historyId`; this module turns that into stored inbound messages.
 *
 * Review items 13–14 add rules that keep the path from silently losing mail:
 *  - the history cursor (`connected_accounts.last_history_id`) is the source of truth, so
 *    overlapping pushes cannot skip each other's messages;
 *  - a 404 (cursor too old) is recovered with a bounded full sync of the threads we
 *    recently sent in, never with silence;
 *  - a message is matched by thread first and sender second, so a bounce from
 *    mailer-daemon reaches the classifier, and an unmatched sender is stored and alerted
 *    instead of throwing.
 *
 * Review item B5 adds the other direction: a message that fails permanently is recorded in
 * `webhook_events` with its error, the owner is alerted, and the cursor advances past it.
 * `syncGmailBackstop()` re-drains the cursor from the daily cron for a lost push.
 *
 * The mailbox credential handling mirrors `src/adapters/channels/gmail.ts` on purpose: one
 * adapter sends, one service reads, and both go through `readAccountCredentials` so a
 * rotated `ENCRYPTION_KEY` marks the account for reconnect instead of failing silently.
 */

/** History pages are capped so a runaway mailbox cannot exhaust the workflow budget. */
const HISTORY_MAX_PAGES = 10;
/** Full sync bound: the newest threads we sent in during the last three weeks (section 7's sequence runs 14 days). */
const FULL_SYNC_WINDOW_DAYS = 21;
const FULL_SYNC_MAX_THREADS = 50;
const FULL_SYNC_MAX_MESSAGES = 200;

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
  /** Sender matched no thread and no contact; kept as a raw `webhook_events` row (review item 14). */
  unmatched: number;
  /**
   * Review item B5: messages that failed permanently, were recorded in `webhook_events`
   * with their error and skipped past, so one poison message cannot pin the cursor.
   */
  failed: number;
  errors: string[];
  /** Stored inbound message ids, so the caller can start a reply workflow for each. */
  messageIds: string[];
  /** True when the stored history id was too old and a bounded full sync ran (review item 13). */
  fullSync: boolean;
}

/** Review item B5: the daily cron's backstop result; `ran: false` is a no-op, not an error. */
export interface GmailBackstopResult extends GmailIngestResult {
  ran: boolean;
}

export async function ingestGmailHistory(historyId: string): Promise<GmailIngestResult> {
  const mailbox = await loadMailboxClient();
  if (!mailbox) {
    return {
      ...emptyIngestResult(),
      errors: ["No connected mailbox; the push notification was stored unprocessed."],
    };
  }
  return ingestFromMailbox(historyId, mailbox);
}

/**
 * Review item B5: "Add a cursor-based sync to the daily cron as a backstop for lost
 * pushes." Gmail Pub/Sub can drop a notification (subscription expiry, a deploy between
 * pushes); the cursor is the source of truth, so the daily heartbeat drains everything
 * since `connected_accounts.last_history_id` even when no push ever arrived. A mailbox
 * that is not connected is a no-op: the digest reports `ran: false`.
 */
export async function syncGmailBackstop(): Promise<GmailBackstopResult> {
  const mailbox = await loadMailboxClient();
  if (!mailbox) return { ran: false, ...emptyIngestResult() };
  return { ran: true, ...(await ingestFromMailbox("backstop", mailbox)) };
}

function emptyIngestResult(): GmailIngestResult {
  return {
    mailbox: null,
    fetched: 0,
    stored: 0,
    skipped: 0,
    unmatched: 0,
    failed: 0,
    errors: [],
    messageIds: [],
    fullSync: false,
  };
}

async function ingestFromMailbox(historyId: string, mailbox: MailboxClient): Promise<GmailIngestResult> {
  const result: GmailIngestResult = { ...emptyIngestResult(), mailbox: mailbox.handle };

  const gmail = google.gmail({ version: "v1", auth: mailbox.auth });

  let candidateIds: string[] = [];
  let advancedTo: string | null = null;
  let unmatchedNew = 0;

  // Review item 13: the stored cursor is the source of truth, so a push that arrives while
  // an earlier one is still being processed cannot skip its messages. The push's own
  // `historyId` is deliberately not used as a start point: it marks the *end* of the change
  // it announces and `startHistoryId` is exclusive, so starting there could skip the very
  // message that triggered the push. Without a cursor (a mailbox connected before the watch
  // existed), a bounded full sync is the safe first run.
  if (!mailbox.lastHistoryId) {
    result.fullSync = true;
    const sync = await fullSyncWithCursor(gmail, result);
    candidateIds = sync.messageIds;
    advancedTo = sync.advancedTo;
  } else {
    try {
      const listing = await listHistoryMessages(gmail, mailbox.lastHistoryId);
      candidateIds = listing.messageIds;
      advancedTo = listing.historyId;
    } catch (error) {
      if (!isNotFound(error)) {
        result.errors.push(reasonOf(error));
        return result;
      }
      // Gmail answers 404 when the cursor is too old to resume from. The documented recovery
      // is a full sync; Scout bounds it to the threads we recently sent in (review item 13).
      result.fullSync = true;
      const sync = await fullSyncWithCursor(gmail, result);
      candidateIds = sync.messageIds;
      advancedTo = sync.advancedTo;
    }
  }

  let failedNew = 0;
  for (const id of dedupe(candidateIds)) {
    try {
      if (await ingestMessage(gmail, id, mailbox, result)) {
        unmatchedNew += 1;
      }
    } catch (error) {
      // Review item B5: a message that fails permanently is recorded in `webhook_events`
      // with its error and skipped past. Only a listing-level failure (above) keeps the
      // cursor; otherwise one poison message would block every later reply forever.
      const reason = reasonOf(error);
      result.failed += 1;
      if (await recordFailedMessage(mailbox, id, reason)) failedNew += 1;
    }
  }

  // Advance after a clean *listing* pass. The cursor is the source of truth for pushes
  // (review item 13), and message-level failures no longer pin it (review item B5).
  if (result.errors.length === 0 && advancedTo) {
    await setLastHistoryId(mailbox.id, advancedTo);
  }

  // One alert per ingest, not one per message: a first run over a large history must not
  // put hundreds of messages into the owner's chat.
  if (unmatchedNew > 0) {
    await alertUnmatchedInbound(unmatchedNew);
  }
  if (failedNew > 0) {
    await alertIngestFailures(failedNew);
  }

  await recordActivity({
    actor: "system",
    entityType: "gmail",
    entityId: mailbox.id,
    type: "reply.received",
    data: {
      historyId,
      cursor: mailbox.lastHistoryId,
      fullSync: result.fullSync,
      fetched: result.fetched,
      stored: result.stored,
      skipped: result.skipped,
      unmatched: result.unmatched,
      failed: result.failed,
    },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Gmail reads
// ---------------------------------------------------------------------------

type GmailApi = ReturnType<typeof google.gmail>;

interface HistoryListing {
  messageIds: string[];
  /** The mailbox's current history id from the last page, to store as the new cursor. */
  historyId: string | null;
}

/** `users.history.list`, all pages, `messageAdded` only. Throws on a 404 for the caller to recover. */
async function listHistoryMessages(gmail: GmailApi, startHistoryId: string): Promise<HistoryListing> {
  const messageIds: string[] = [];
  let historyId: string | null = null;
  let pageToken: string | undefined;

  for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
    const response = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
      maxResults: 500,
      ...(pageToken ? { pageToken } : {}),
    });

    for (const entry of response.data.history ?? []) {
      // The specific change-type field is authoritative; `entry.messages` is a duplicate of
      // it when present, and may also carry label changes we do not want.
      const added = (entry.messagesAdded ?? []).map((item) => item.message?.id);
      const fallback = entry.messagesAdded ? [] : (entry.messages ?? []).map((message) => message.id);
      for (const id of [...added, ...fallback]) {
        if (id) messageIds.push(id);
      }
    }

    historyId = response.data.historyId ?? historyId;
    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  return { messageIds, historyId };
}

/**
 * Review item 13's 404 recovery. Only threads Scout sent in during the window are read, and
 * the message count is capped, so a mailbox with years of history still costs a bounded
 * number of API calls. Errors are returned rather than thrown so partial results survive.
 */
async function fullSyncRecentThreads(gmail: GmailApi): Promise<{ messageIds: string[]; errors: string[] }> {
  const db = getDb();
  const since = new Date(Date.now() - FULL_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const anchors = await db
    .select({ threadId: messagesTable.threadId })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.direction, "outbound"),
        eq(messagesTable.status, "sent"),
        isNotNull(messagesTable.threadId),
        gte(messagesTable.sentAt, since),
      ),
    )
    .orderBy(desc(messagesTable.sentAt))
    .limit(FULL_SYNC_MAX_THREADS);

  const threadIds = dedupe(
    anchors.map((anchor) => anchor.threadId).filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const messageIds: string[] = [];
  const errors: string[] = [];

  for (const threadId of threadIds) {
    if (messageIds.length >= FULL_SYNC_MAX_MESSAGES) break;
    try {
      const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
      for (const message of thread.data.messages ?? []) {
        if (messageIds.length >= FULL_SYNC_MAX_MESSAGES) break;
        if (message.id) messageIds.push(message.id);
      }
    } catch (error) {
      // A thread deleted from the mailbox is nothing to read, not a failure.
      if (isNotFound(error)) continue;
      errors.push(reasonOf(error));
    }
  }

  return { messageIds, errors };
}

/** The mailbox's current history id, used to re-seed the cursor after a full sync. */
async function profileHistoryId(gmail: GmailApi, result: GmailIngestResult): Promise<string | null> {
  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    if (!profile.data.historyId) {
      result.errors.push("Gmail returned no history id after the full sync.");
      return null;
    }
    return profile.data.historyId;
  } catch (error) {
    result.errors.push(reasonOf(error));
    return null;
  }
}

/**
 * The bounded full sync plus the cursor re-seed. The cursor is re-seeded only when the
 * thread scan was clean; otherwise the old cursor stays so the next push runs it again.
 */
async function fullSyncWithCursor(gmail: GmailApi, result: GmailIngestResult): Promise<{ messageIds: string[]; advancedTo: string | null }> {
  const sync = await fullSyncRecentThreads(gmail);
  result.errors.push(...sync.errors);
  if (sync.errors.length > 0) return { messageIds: sync.messageIds, advancedTo: null };
  return { messageIds: sync.messageIds, advancedTo: await profileHistoryId(gmail, result) };
}

async function ingestMessage(
  gmail: GmailApi,
  messageId: string,
  mailbox: MailboxClient,
  result: GmailIngestResult,
): Promise<boolean> {
  let parsed: (InboundMessage & { inInbox: boolean }) | null;
  try {
    const response = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    parsed = parseGmailMessage(response.data);
  } catch (error) {
    // A message deleted between `history.list` and `messages.get` has nothing to read.
    if (isNotFound(error)) {
      result.skipped += 1;
      return false;
    }
    result.errors.push(reasonOf(error));
    return false;
  }

  if (!parsed) {
    result.skipped += 1;
    return false;
  }

  // Our own sent messages and follow-ups share the thread; they are not replies.
  if (parsed.fromEmail === mailbox.handle.toLowerCase()) {
    result.skipped += 1;
    return false;
  }

  result.fetched += 1;

  const lead = await getLeadByEmail(parsed.fromEmail);

  // Review item 14: thread first, then From. A bounce from mailer-daemon has no lead of its
  // own, but it carries the thread of the message we sent, and that thread names the
  // contact — so the bounce reaches the classifier and stops the sequence.
  const matched = await findEnrollmentForInbound({
    threadId: parsed.threadId,
    contactId: lead?.contact.id ?? null,
  });
  const contactId = matched?.contactId ?? lead?.contact.id ?? null;

  if (!contactId) {
    // Anything outside the inbox that matches no thread is mailbox noise, not a reply.
    if (!parsed.inInbox) {
      result.skipped += 1;
      return false;
    }
    const stored = await storeUnmatchedInbound(mailbox, parsed);
    result.unmatched += 1;
    return stored;
  }

  const stored = await recordInboundMessage({
    contactId,
    enrollmentId: matched?.enrollmentId ?? null,
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
  return false;
}

// ---------------------------------------------------------------------------
// Unmatched senders (review item 14)
// ---------------------------------------------------------------------------

/**
 * "Never throw on an unknown sender: store it unmatched and alert."
 *
 * `messages.contact_id` is NOT NULL, so a message whose sender matches no contact cannot
 * live in `messages`. The raw event table is section 8's designated store for inbound
 * events; the raw payload is pruned on the phase 8 retention schedule, and the owner is
 * alerted from the caller so one ingest can never fire hundreds of chat messages. Callers
 * must not log the payload (section 10 rule 11).
 *
 * Returns false when the message was already stored by an earlier attempt, so a retry does
 * not alert twice.
 */
async function storeUnmatchedInbound(mailbox: MailboxClient, parsed: InboundMessage): Promise<boolean> {
  const stored = await storeWebhookEvent({
    provider: "gmail",
    externalId: `unmatched:${parsed.providerMessageId}`,
    eventType: "gmail.unmatched",
    payload: {
      providerMessageId: parsed.providerMessageId,
      threadId: parsed.threadId,
      fromEmail: parsed.fromEmail,
      subject: parsed.subject,
      receivedAt: parsed.receivedAt.toISOString(),
    },
  });

  if (stored.duplicate) return false;
  await markWebhookProcessed(stored.id);

  await recordActivity({
    actor: "system",
    entityType: "gmail",
    entityId: mailbox.id,
    type: "reply.received",
    data: { unmatched: true, providerMessageId: parsed.providerMessageId, threadId: parsed.threadId },
  });
  return true;
}

async function alertUnmatchedInbound(count: number): Promise<void> {
  await notifyOwner({
    kind: "error",
    title: count === 1 ? "An inbound email could not be matched to a lead" : `${count} inbound emails could not be matched to a lead`,
    body: "They arrived in the sending mailbox and matched no thread and no contact. They are stored as unmatched events; open the mailbox if any looks like a reply.",
    url: "/replies",
    data: { count },
  });
}

// ---------------------------------------------------------------------------
// Permanently failed messages (review item B5)
// ---------------------------------------------------------------------------

/**
 * Review item B5: a message that fails permanently must not pin the ingest cursor. The
 * raw event table is section 8's store for inbound events with an error column, so the
 * failure is recorded there (`processed_at` set, `error` filled) and the cursor advances
 * past it. The provider message id is safe to store; the error is truncated and must
 * never contain a body or an address (section 10 rule 11).
 *
 * Returns false when the row already existed, so a replay does not alert twice.
 */
async function recordFailedMessage(mailbox: MailboxClient, messageId: string, error: string): Promise<boolean> {
  const stored = await storeWebhookEvent({
    provider: "gmail",
    externalId: `failed:${messageId}`,
    eventType: "gmail.ingest_failed",
    payload: { providerMessageId: messageId, error },
  });

  if (stored.duplicate) return false;
  await markWebhookProcessed(stored.id, error);

  await recordActivity({
    actor: "system",
    entityType: "gmail",
    entityId: mailbox.id,
    type: "system.error",
    data: { providerMessageId: messageId, reason: error },
  });
  return true;
}

async function alertIngestFailures(count: number): Promise<void> {
  await notifyOwner({
    kind: "error",
    title: count === 1 ? "An inbound email could not be processed" : `${count} inbound emails could not be processed`,
    body: "Scout recorded them in the webhook log with their errors and moved past them, so later replies are still ingested. Open the mailbox if one of them looks important.",
    url: "/replies",
    data: { count },
  });
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

interface MailboxClient {
  id: string;
  handle: string;
  lastHistoryId: string | null;
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
    logger.warn("gmail.inbound_token_failed", {
      accountId: account.id,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return null;
  }

  return { id: account.id, handle: account.handle, lastHistoryId: account.lastHistoryId, auth: client };
}

async function setLastHistoryId(accountId: string, historyId: string): Promise<void> {
  const db = getDb();
  await db
    .update(connectedAccounts)
    .set({ lastHistoryId: historyId, updatedAt: new Date() })
    .where(eq(connectedAccounts.id, accountId));
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

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

/**
 * Exported for tests: a Gmail message becomes an `InboundMessage`, or null when it is not
 * mail we want at all.
 *
 * `inInbox` is returned rather than filtered on: a reply the owner already archived still
 * belongs to a thread we sent in, so it must reach the classifier, while an archived
 * message with no thread match is mailbox noise.
 */
export function parseGmailMessage(message: GmailMessageLike): (InboundMessage & { inInbox: boolean }) | null {
  const id = message.id;
  if (!id) return null;

  const headers = message.payload?.headers ?? [];
  const header = (name: string): string | null => {
    const found = headers.find((entry) => entry.name?.toLowerCase() === name.toLowerCase());
    return found?.value ?? null;
  };

  const from = header("From");
  if (!from) return null;

  // `Precedence: bulk|list` marks mail we should not treat as a reply — except for the two
  // machine messages that matter most: a bounce and an out-of-office reply (review item 14:
  // "a bounce from mailer-daemon in our thread must reach the classifier"). Both are
  // recognised structurally, never by sender address.
  const precedence = header("Precedence")?.toLowerCase() ?? "";
  if (!isAutomaticMail(header) && (precedence === "bulk" || precedence === "list")) return null;

  const fromEmail = extractEmail(from);
  if (!fromEmail) return null;

  const body = extractPlainText(message.payload ?? null) || header("Snippet") || "";
  const internalDate = message.internalDate ? Number(message.internalDate) : Date.now();
  const inInbox = message.labelIds ? message.labelIds.includes("INBOX") : true;

  return {
    providerMessageId: id,
    threadId: message.threadId ?? null,
    rfcMessageId: header("Message-ID"),
    fromEmail,
    fromName: extractDisplayName(from),
    subject: header("Subject"),
    body,
    receivedAt: new Date(Number.isFinite(internalDate) ? internalDate : Date.now()),
    inInbox,
  };
}

/** Delivery-status notifications and automatic replies, by their machine headers. */
function isAutomaticMail(header: (name: string) => string | null): boolean {
  if (header("X-Failed-Recipients")) return true;
  const autoSubmitted = header("Auto-Submitted")?.toLowerCase() ?? "";
  if (autoSubmitted === "auto-replied" || autoSubmitted === "auto-generated") return true;
  const contentType = header("Content-Type")?.toLowerCase() ?? "";
  return contentType.includes("multipart/report") && contentType.includes("delivery-status");
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Gaxios reports the HTTP status on `response.status`, `code` or `status`, depending on the path. */
function isNotFound(error: unknown): boolean {
  return httpStatusOf(error) === 404;
}

function httpStatusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const status = candidate.response?.status ?? candidate.status ?? candidate.code;
  if (typeof status === "number") return status;
  if (typeof status === "string" && /^\d{3}$/.test(status)) return Number(status);
  return null;
}

/** Fixed-width reason so a vendor message can never smuggle a body or address into a log line. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown";
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
