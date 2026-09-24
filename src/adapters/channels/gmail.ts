import { randomUUID } from "node:crypto";

import { Auth, google } from "googleapis";

import { ConfigurationError, VendorError } from "@/src/lib/errors";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import type { Channel, OutboundMessage, SendResult } from "@/src/ports/channel";
import {
  getAccount,
  getPrimaryEmailAccount,
  readAccountCredentials,
  setAccountStatus,
  upsertAccount,
} from "@/src/services/accounts";
import { notifyAccountStatus } from "@/src/services/notifications";

/**
 * Section 4/8: Gmail is the v1 sending channel, through Scout's own Internal OAuth app.
 * Section 9: plain text only — no tracking pixels, no HTML part, no link shorteners —
 * and section 6: an email is at most 110 words with a real signal behind every claim.
 *
 * Section 10 rule 6: nothing sends except `sendMessage` and its guard. This adapter is
 * called only by the guard, which has already applied DRY_RUN and the daily caps.
 *
 * Design notes:
 *  - `createGmailChannel()` runs synchronously inside the channel registry. It returns
 *    `null` (never throws) when the Internal OAuth app is not configured, so the guard
 *    reports "no account" instead of crashing a workflow.
 *  - Credentials are loaded lazily in `send()`, decrypted from `connected_accounts` with
 *    AES-256-GCM (`readAccountCredentials`). Tokens are refreshed at most once per send,
 *    always through `google.auth.OAuth2`, and persisted back with `upsertAccount`.
 *  - Nothing here logs an address, a subject or a body (section 10 rule 11): log lines
 *    carry the account id and a status code only.
 */

const GMAIL_API_VERSION = "v1";
/** Google's `Credentials.expiry_date` is epoch ms; refresh this long before expiry. */
const REFRESH_SKEW_MS = 60_000;
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export type GmailCredentials = {
  /** Long-lived token from the Internal OAuth app. Never logged. */
  refreshToken?: string | null;
  /** Short-lived token; refreshed when missing or within `REFRESH_SKEW_MS` of expiry. */
  accessToken?: string | null;
  /** Epoch milliseconds, as Google's `Credentials.expiry_date`. */
  accessTokenExpiresAt?: number | null;
  scope?: string | null;
};

export interface GmailMailbox {
  id: string;
  /** The connected address, also the `From` header. */
  handle: string;
  credentials: GmailCredentials | null;
}

/**
 * Everything the adapter touches outside its own process: the mailbox row, the OAuth
 * client and the "pause and alert" path. Tests inject all four, so no Google call and
 * no database access happens in a test.
 */
export interface GmailChannelDeps {
  loadMailbox: () => Promise<GmailMailbox | null>;
  createOAuthClient: () => Auth.OAuth2Client;
  saveCredentials: (mailboxId: string, credentials: GmailCredentials) => Promise<void>;
  markCredentialsBad: (mailboxId: string, detail: string) => Promise<void>;
  /** Test seam for `Date` headers and expiry checks. */
  now?: () => Date;
}

export type GmailChannelOptions = Partial<GmailChannelDeps>;

type ResolvedDeps = GmailChannelDeps & { now: () => Date };

export function createGmailChannel(options: GmailChannelOptions = {}): Channel | null {
  const deps = resolveDeps(options);
  if (!deps) return null;
  return new GmailChannel(deps);
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

class GmailChannel implements Channel {
  readonly kind = "email" as const;
  readonly name = "gmail";

  constructor(private readonly deps: ResolvedDeps) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const mailbox = await this.deps.loadMailbox();
    if (!mailbox) {
      throw new ConfigurationError(
        "No sending mailbox is connected. Connect one under Settings → Connected accounts before sending.",
      );
    }

    const client = this.deps.createOAuthClient();
    const accessToken = await this.ensureAccessToken(mailbox, client);
    client.setCredentials({ access_token: accessToken });

    const now = this.deps.now();
    const rfcMessageId = buildMessageId(mailbox.handle);
    const raw = buildRfc5322Message({
      from: mailbox.handle,
      fromName: message.fromName ?? null,
      to: message.to,
      subject: message.subject,
      body: message.body,
      rfcMessageId,
      date: now,
      inReplyTo: message.inReplyTo,
      references: message.references,
      isTest: message.isTest === true,
    });

    const gmail = google.gmail({ version: GMAIL_API_VERSION, auth: client });

    try {
      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: toBase64Url(raw),
          // Section 7: the day-3 follow-up lands in the same thread as email 1.
          ...(message.threadId ? { threadId: message.threadId } : {}),
        },
      });

      const providerMessageId = response.data.id;
      if (!providerMessageId) {
        throw new VendorError("gmail", "Gmail accepted the send but returned no message id.", {
          code: "vendor_unavailable",
          retryable: true,
        });
      }

      return {
        providerMessageId,
        threadId: response.data.threadId ?? message.threadId ?? null,
        rfcMessageId,
        sentAt: now,
        // The guard already swapped `to` for the DRY_RUN address; we only report it.
        redirected: Boolean(message.dryRunRedirect && message.to === message.dryRunRedirect),
      };
    } catch (error) {
      throw await this.classifySendFailure(mailbox, error);
    }
  }

  /**
   * Section 8: "A status of `credentials`, `error` or `stopped` pauses that account and
   * alerts the owner with a Reconnect button." Failures to authenticate are failures of
   * the stored credentials, so the mailbox is paused here before the error propagates.
   */
  private async classifySendFailure(mailbox: GmailMailbox, error: unknown): Promise<VendorError> {
    if (error instanceof VendorError) return error;

    const status = httpStatusOf(error);
    logger.warn("gmail.send_failed", { accountId: mailbox.id, status });

    if (status === 401 || status === 403) {
      const detail = "Google rejected the mailbox credentials. Reconnect the mailbox.";
      await this.deps.markCredentialsBad(mailbox.id, detail);
      return new VendorError("gmail", detail, { code: "vendor_auth", status, cause: error });
    }
    if (status === 429) {
      return new VendorError("gmail", "Gmail rate limited the send.", {
        code: "vendor_rate_limited",
        status,
        retryable: true,
        cause: error,
      });
    }
    if (status !== null && status >= 500) {
      return new VendorError("gmail", `Gmail returned ${status}.`, {
        code: "vendor_unavailable",
        status,
        retryable: true,
        cause: error,
      });
    }
    if (status !== null) {
      return new VendorError("gmail", `Gmail rejected the message (${status}).`, {
        code: "vendor_bad_request",
        status,
        cause: error,
      });
    }
    return new VendorError("gmail", "Gmail could not be reached.", {
      code: "vendor_unavailable",
      retryable: true,
      cause: error,
    });
  }

  private async ensureAccessToken(mailbox: GmailMailbox, client: Auth.OAuth2Client): Promise<string> {
    const credentials = mailbox.credentials;
    const accessToken = credentials?.accessToken ?? null;
    const expiresAt = credentials?.accessTokenExpiresAt ?? null;

    if (
      typeof accessToken === "string" &&
      accessToken.length > 0 &&
      typeof expiresAt === "number" &&
      expiresAt - this.deps.now().getTime() > REFRESH_SKEW_MS
    ) {
      return accessToken;
    }

    const refreshToken = credentials?.refreshToken ?? null;
    if (!refreshToken) {
      const detail = "The mailbox has no refresh token. Reconnect the mailbox.";
      await this.deps.markCredentialsBad(mailbox.id, detail);
      throw new VendorError("gmail", detail, { code: "vendor_auth" });
    }

    client.setCredentials({ refresh_token: refreshToken });

    let refreshed: Auth.Credentials;
    try {
      refreshed = (await client.refreshAccessToken()).credentials;
    } catch (error) {
      const reason = oauthErrorCode(error);
      logger.warn("gmail.refresh_failed", { accountId: mailbox.id, reason: reason ?? "unknown" });
      const detail = reason
        ? `Google rejected the mailbox credentials (${reason}). Reconnect the mailbox.`
        : "Google rejected the mailbox credentials. Reconnect the mailbox.";
      await this.deps.markCredentialsBad(mailbox.id, detail);
      throw new VendorError("gmail", detail, { code: "vendor_auth", cause: error });
    }

    const next: GmailCredentials = {
      refreshToken: refreshed.refresh_token ?? refreshToken,
      accessToken: refreshed.access_token ?? null,
      accessTokenExpiresAt: refreshed.expiry_date ?? null,
      scope: refreshed.scope ?? credentials?.scope ?? GMAIL_SEND_SCOPE,
    };

    // Persist first: a lost token here means a second refresh call on the next send.
    await this.deps.saveCredentials(mailbox.id, next);

    if (!next.accessToken) {
      const detail = "Google returned no access token. Reconnect the mailbox.";
      await this.deps.markCredentialsBad(mailbox.id, detail);
      throw new VendorError("gmail", detail, { code: "vendor_auth" });
    }

    client.setCredentials({
      access_token: next.accessToken,
      refresh_token: next.refreshToken ?? undefined,
      expiry_date: next.accessTokenExpiresAt ?? undefined,
    });
    return next.accessToken;
  }
}

// ---------------------------------------------------------------------------
// Default dependencies (production)
// ---------------------------------------------------------------------------

function resolveDeps(options: GmailChannelOptions): ResolvedDeps | null {
  const now = options.now ?? (() => new Date());

  if (options.loadMailbox && options.createOAuthClient && options.saveCredentials && options.markCredentialsBad) {
    return {
      loadMailbox: options.loadMailbox,
      createOAuthClient: options.createOAuthClient,
      saveCredentials: options.saveCredentials,
      markCredentialsBad: options.markCredentialsBad,
      now,
    };
  }

  const env = readEnv();
  const clientId = env?.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = env?.GMAIL_OAUTH_CLIENT_SECRET;
  // Not configured yet: the registry treats this as "no account" and the guard blocks.
  if (!clientId || !clientSecret) return null;

  return {
    loadMailbox: defaultLoadMailbox,
    createOAuthClient: () => new Auth.OAuth2Client({ clientId, clientSecret }),
    saveCredentials: defaultSaveCredentials,
    markCredentialsBad: defaultMarkCredentialsBad,
    now,
  };
}

function readEnv(): ReturnType<typeof getEnv> | null {
  try {
    return getEnv();
  } catch {
    return null;
  }
}

async function defaultLoadMailbox(): Promise<GmailMailbox | null> {
  const account = await getPrimaryEmailAccount();
  if (!account || account.provider !== "google") return null;
  const credentials = await readAccountCredentials<GmailCredentials>(account);
  return { id: account.id, handle: account.handle, credentials };
}

async function defaultSaveCredentials(mailboxId: string, credentials: GmailCredentials): Promise<void> {
  const account = await getAccount(mailboxId);
  if (!account) return;
  await upsertAccount({
    provider: account.provider,
    kind: account.kind,
    externalAccountId: account.externalAccountId ?? account.handle,
    handle: account.handle,
    credentials: { ...credentials },
  });
}

async function defaultMarkCredentialsBad(mailboxId: string, detail: string): Promise<void> {
  await setAccountStatus(mailboxId, "credentials", detail);
  const account = await getAccount(mailboxId);
  if (account) await notifyAccountStatus(account, detail);
}

// ---------------------------------------------------------------------------
// RFC 5322 message
// ---------------------------------------------------------------------------

export interface Rfc5322Input {
  from: string;
  fromName?: string | null;
  to: string;
  subject: string | null;
  body: string;
  /** Full form, including angle brackets. */
  rfcMessageId: string;
  date: Date;
  inReplyTo?: string | null;
  references?: string[];
  /** Section 7: DRY_RUN sends are tagged so they are obvious in the test inbox. */
  isTest?: boolean;
}

/**
 * Builds the raw message Gmail sends. Plain text with a quoted-printable body, so it is
 * 7-bit safe, readable in a transcript, and never contains an HTML alternative.
 */
export function buildRfc5322Message(input: Rfc5322Input): string {
  const headers: string[] = [
    `From: ${formatAddress(input.from, input.fromName)}`,
    `To: ${sanitizeHeaderValue(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject ?? "")}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: ${sanitizeHeaderValue(input.rfcMessageId)}`,
  ];

  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${sanitizeHeaderValue(input.inReplyTo)}`);
  }
  const references = (input.references ?? []).map(sanitizeHeaderValue).filter((value) => value.length > 0);
  if (references.length > 0) {
    headers.push(`References: ${references.join(" ")}`);
  }

  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: quoted-printable");
  if (input.isTest) headers.push("X-Scout-Test: 1");

  const body = encodeQuotedPrintable(input.body);
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export function buildMessageId(handle: string): string {
  const domain = handle.includes("@") ? handle.slice(handle.lastIndexOf("@") + 1) : "";
  const safeDomain = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domain) ? domain : "scout.local";
  return `<${randomUUID()}@${safeDomain}>`;
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}

/**
 * Quoted-printable (RFC 2045). Non-ASCII and "=" are escaped, lines are folded below 77
 * characters, and a folded line never ends in raw whitespace because transport strips it.
 */
export function encodeQuotedPrintable(text: string): string {
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalised
    .split("\n")
    .map((line) => encodeQuotedPrintableLine(Buffer.from(line, "utf8")))
    .join("\r\n");
}

/** Content lines may hold at most 75 characters; the 76th is the soft break "=". */
const QP_CONTENT_LIMIT = 75;

function encodeQuotedPrintableLine(bytes: Uint8Array): string {
  const tokens: string[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const isLast = index === bytes.length - 1;
    if (byte === 0x20) {
      tokens.push(isLast ? "=20" : " ");
      continue;
    }
    if (byte === 0x09) {
      tokens.push(isLast ? "=09" : "\t");
      continue;
    }
    if (byte === 0x3d) {
      tokens.push("=3D");
      continue;
    }
    if (byte < 0x20 || byte > 0x7e) {
      tokens.push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`);
      continue;
    }
    tokens.push(String.fromCharCode(byte));
  }

  const lines: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const token of tokens) {
    if (length + token.length > QP_CONTENT_LIMIT && current.length > 0) {
      // Carry trailing whitespace onto the next line so the fold never leaves it at
      // the end of a line, where a mail server is allowed to strip it.
      const carry: string[] = [];
      while (current.length > 0) {
        const last = current[current.length - 1];
        if (last !== " " && last !== "\t") break;
        carry.unshift(current.pop() ?? "");
        length -= 1;
      }
      lines.push(current.join(""));
      current = carry;
      length = carry.length;
    }
    current.push(token);
    length += token.length;
  }
  lines.push(current.join(""));

  return lines.join("=\r\n");
}

/** RFC 2047 encoded word(s); long values are split so no word exceeds 75 characters. */
export function encodeHeaderValue(value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;

  const words: string[] = [];
  let chunk = "";
  for (const char of clean) {
    const candidate = chunk + char;
    if (chunk.length > 0 && encodedWord(candidate).length > 75) {
      words.push(encodedWord(chunk));
      chunk = char;
    } else {
      chunk = candidate;
    }
  }
  if (chunk.length > 0) words.push(encodedWord(chunk));
  return words.join("\r\n ");
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatAddress(address: string, name?: string | null): string {
  const cleanAddress = sanitizeHeaderValue(address).trim();
  const cleanName = sanitizeHeaderValue(name ?? "").trim();
  if (cleanName.length === 0) return cleanAddress;
  const display = /^[\x20-\x7e]*$/.test(cleanName)
    ? `"${cleanName.replace(/(["\\])/g, "\\$1")}"`
    : encodeHeaderValue(cleanName);
  return `${display} <${cleanAddress}>`;
}

/** Header injection guard: no header value may carry a line break. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Error narrowing (no vendor types leak out of the adapter)
// ---------------------------------------------------------------------------

function httpStatusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const status = candidate.response?.status ?? candidate.status ?? candidate.code;
  if (typeof status === "number") return status;
  if (typeof status === "string" && /^\d{3}$/.test(status)) return Number(status);
  return null;
}

/** Extracts only a short machine code (`invalid_grant`) — never a body or an address. */
function oauthErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { response?: { data?: unknown } }).response?.data;
  if (!data || typeof data !== "object" || !("error" in data)) return null;
  const code = (data as { error?: unknown }).error;
  return typeof code === "string" && /^[a-z_]{1,40}$/i.test(code) ? code : null;
}
