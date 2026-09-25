import { randomBytes } from "node:crypto";

import { Auth, google } from "googleapis";

import type { GmailCredentials } from "@/src/adapters/channels/gmail";
import type { ConnectedAccount } from "@/src/db/schema";
import { hashValue, secureCompare } from "@/src/lib/crypto";
import { ConfigurationError } from "@/src/lib/errors";
import { getEnv } from "@/src/lib/env";
import { getAccount, markAccountWarmupStart, upsertAccount } from "./accounts";
import { renewGmailWatch } from "./gmail-watch";

/**
 * Section 8: "the only connected account is one Google Workspace mailbox, linked through
 * Scout's own Internal OAuth app with the Gmail send and read scopes."
 *
 * This service owns the whole OAuth dance; the two route handlers in
 * `app/api/oauth/gmail/**` only deal with cookies and redirects.
 *
 * CSRF: the `state` parameter is a random nonce plus an HMAC keyed with `ENCRYPTION_KEY`.
 * It is stored in an http-only cookie and compared (constant time) on the way back, then
 * deleted, so a captured state value cannot be replayed.
 */

export const GMAIL_OAUTH_SCOPES = [
  /** Send the sequence. */
  "https://www.googleapis.com/auth/gmail.send",
  /** Read replies in phase 5; requested now so one consent covers the MVP. */
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export const GMAIL_OAUTH_STATE_COOKIE = "scout_gmail_oauth_state";
export const GMAIL_OAUTH_STATE_MAX_AGE_SECONDS = 600;
export const GMAIL_OAUTH_STATE_PATH = "/api/oauth/gmail";

export interface GmailOAuthResult {
  emailAddress: string;
  credentials: GmailCredentials;
}

export function isGmailOAuthConfigured(): boolean {
  const env = readEnv();
  return Boolean(env?.GMAIL_OAUTH_CLIENT_ID && env?.GMAIL_OAUTH_CLIENT_SECRET);
}

export function gmailRedirectUri(appUrl: string): string {
  return new URL("/api/oauth/gmail/callback", appUrl).toString();
}

export function createGmailOAuthClient(redirectUri: string): Auth.OAuth2Client {
  const env = getEnv();
  const clientId = env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ConfigurationError(
      "GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET must be set before a mailbox can be connected.",
    );
  }
  return new Auth.OAuth2Client({ clientId, clientSecret, redirectUri });
}

/**
 * `access_type: "offline"` + `prompt: "consent"` guarantee a refresh token on every
 * connection, including a reconnect that rotates a revoked one.
 */
export function createGmailAuthUrl(input: { redirectUri: string }): { url: string; state: string } {
  const state = createOAuthState();
  const client = createGmailOAuthClient(input.redirectUri);
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_OAUTH_SCOPES],
    state,
    include_granted_scopes: false,
  });
  return { url, state };
}

export function createOAuthState(): string {
  const nonce = randomBytes(24).toString("base64url");
  return `${nonce}.${hashValue("gmail-oauth-state", nonce)}`;
}

/** Constant-time compare of the signed state and the value from the http-only cookie. */
export function verifyOAuthState(state: string | null, expected: string | null): boolean {
  if (!state || !expected) return false;
  if (!secureCompare(state, expected)) return false;
  const [nonce, signature] = state.split(".");
  if (!nonce || !signature) return false;
  return secureCompare(signature, hashValue("gmail-oauth-state", nonce));
}

export async function completeGmailOAuth(input: { code: string; redirectUri: string }): Promise<GmailOAuthResult> {
  const client = createGmailOAuthClient(input.redirectUri);
  const { tokens } = await client.getToken(input.code);

  if (!tokens.refresh_token) {
    throw new ConfigurationError("Google did not return a refresh token. Connect the mailbox again and accept all permissions.");
  }
  const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  if (!granted.includes("https://www.googleapis.com/auth/gmail.send")) {
    throw new ConfigurationError("The Gmail send permission was not granted. Connect the mailbox again and leave every box checked.");
  }

  client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const emailAddress = profile.data.emailAddress;
  if (!emailAddress) {
    throw new ConfigurationError("Google returned no mailbox address for this account.");
  }

  return {
    emailAddress,
    credentials: {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token ?? null,
      accessTokenExpiresAt: tokens.expiry_date ?? null,
      scope: tokens.scope ?? GMAIL_OAUTH_SCOPES.join(" "),
    },
  };
}

/**
 * Section 5: `connected_accounts` is keyed on `(provider, externalAccountId)`, so a
 * reconnect updates the existing row instead of adding a second mailbox.
 */
export async function saveGmailAccount(result: GmailOAuthResult): Promise<ConnectedAccount> {
  const account = await upsertAccount({
    provider: "google",
    kind: "email",
    externalAccountId: result.emailAddress,
    handle: result.emailAddress,
    credentials: { ...result.credentials },
    status: "ok",
    statusDetail: null,
  });

  // Section 9: "Warm each mailbox for 2–3 weeks before any cold send." Warmup starts at
  // the first connection and is *not* restarted by a reconnect: rotating a token does not
  // reset the mailbox's sending history, and resetting the ramp would drop the caps.
  if (!account.warmupStartedAt) {
    await markAccountWarmupStart(account.id);
  }

  // Review item 13: replies arrive through a Pub/Sub watch registered per mailbox, and
  // Google expires it after seven days. Registering it here means a freshly connected
  // mailbox is watched immediately; the daily planner renews it. `renewGmailWatch` never
  // throws, so a missing topic or a Google hiccup cannot fail the OAuth callback.
  await renewGmailWatch({ accountId: account.id });

  return (await getAccount(account.id)) ?? account;
}

function readEnv(): ReturnType<typeof getEnv> | null {
  try {
    return getEnv();
  } catch {
    return null;
  }
}
