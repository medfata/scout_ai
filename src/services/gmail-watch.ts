import { eq } from "drizzle-orm";
import { Auth, google } from "googleapis";

import { getDb } from "@/src/db/client";
import { connectedAccounts } from "@/src/db/schema";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { recordActivity } from "./activity";
import { getAccount, getPrimaryEmailAccount, readAccountCredentials } from "./accounts";
import { notifyOwner } from "./notifications";

/**
 * Section 4: "Replies arrive via Gmail push notifications." Section 8: the only connected
 * account in v1 is one Google Workspace mailbox linked through Scout's own Internal OAuth
 * app.
 *
 * A Gmail watch stops delivering when it expires — Google fixes the lifetime at seven days
 * and `users.watch` has no TTL parameter (`WatchResponse.expiration` is epoch millis) — so
 * the watch is registered on connect and renewed by the daily planner (review item 13).
 *
 * This function never throws. The OAuth callback must still succeed when Pub/Sub is not
 * configured yet, and a daily cron must not fail because Google is briefly unavailable.
 */

export type GmailWatchFailureReason =
  | "no_pubsub_topic"
  | "oauth_not_configured"
  | "no_account"
  | "not_gmail"
  | "no_credentials"
  | "watch_failed";

export interface GmailWatchResult {
  renewed: boolean;
  reason?: GmailWatchFailureReason;
  /** The mailbox's history id at the moment the watch was (re)created. */
  historyId?: string;
  /** Google's expiry for the watch, epoch millis as a string. Informational only. */
  expiration?: string | null;
}

export interface RenewGmailWatchInput {
  /** The account the OAuth callback just saved; the daily planner omits it. */
  accountId?: string;
}

/**
 * Registers (or renews) the Pub/Sub watch for the sending mailbox.
 *
 * Called twice: from `saveGmailAccount` after the OAuth callback, and once a day from the
 * daily planner. Renewing is the same call as creating, so a mailbox connected before this
 * code existed is repaired by the next cron run.
 */
export async function renewGmailWatch(input: RenewGmailWatchInput = {}): Promise<GmailWatchResult> {
  try {
    const env = getEnv();
    if (!env.GMAIL_PUBSUB_TOPIC) {
      // Section 0's free-first setup has the owner create the topic by hand; until then
      // there is nothing to watch with, and that is not an error.
      return { renewed: false, reason: "no_pubsub_topic" };
    }
    if (!env.GMAIL_OAUTH_CLIENT_ID || !env.GMAIL_OAUTH_CLIENT_SECRET) {
      return { renewed: false, reason: "oauth_not_configured" };
    }

    const account = input.accountId ? await getAccount(input.accountId) : await getPrimaryEmailAccount();
    if (!account) return { renewed: false, reason: "no_account" };
    if (account.kind !== "email" || account.provider !== "google") {
      return { renewed: false, reason: "not_gmail" };
    }

    const credentials = await readAccountCredentials<{
      refreshToken?: string | null;
      accessToken?: string | null;
    }>(account);
    if (!credentials?.refreshToken && !credentials?.accessToken) {
      return { renewed: false, reason: "no_credentials" };
    }

    // Only the app credentials are needed to mint an access token from the stored refresh
    // token; no redirect URI is involved in a refresh. A fresh client per call keeps this
    // module free of module-level auth state.
    const client = new Auth.OAuth2Client({
      clientId: env.GMAIL_OAUTH_CLIENT_ID,
      clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET,
    });
    client.setCredentials({
      refresh_token: credentials.refreshToken ?? undefined,
      access_token: credentials.accessToken ?? undefined,
    });

    const gmail = google.gmail({ version: "v1", auth: client });
    const response = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: env.GMAIL_PUBSUB_TOPIC,
        // Replies land in the inbox. Label filtering keeps the rest of the mailbox's
        // activity out of the push stream, which protects the workflow-event quota.
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    });

    const historyId = response.data.historyId ?? null;
    const expiration = response.data.expiration ?? null;
    if (!historyId) {
      logger.warn("gmail.watch_no_history_id", { accountId: account.id });
      return { renewed: false, reason: "watch_failed" };
    }

    // The response carries the mailbox's *current* history id. It seeds the ingest cursor
    // on first connect only: overwriting an existing cursor here would jump past mail that
    // no notification has delivered yet, and the ingest advances the cursor itself
    // (review item 13). A reconnect therefore never resets the cursor.
    if (!account.lastHistoryId) {
      const db = getDb();
      await db
        .update(connectedAccounts)
        .set({ lastHistoryId: historyId, updatedAt: new Date() })
        .where(eq(connectedAccounts.id, account.id));
    }

    // `account.connected` is the closest existing activity type for a connected account's
    // state; `data.action` carries the exact meaning ("gmail_watch_renewed").
    await recordActivity({
      actor: "system",
      entityType: "connected_account",
      entityId: account.id,
      type: "account.connected",
      data: { action: "gmail_watch_renewed", historyId, expiration },
    });

    return { renewed: true, historyId, expiration };
  } catch (error) {
    logger.warn("gmail.watch_failed", { reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    // A mailbox with no watch silently stops receiving replies. The alert includes no
    // address (section 10 rule 11) and the daily planner retries tomorrow.
    await notifyOwner({
      kind: "error",
      title: "Gmail push notifications could not be registered",
      body: "Scout could not renew the mailbox watch, so replies will not arrive until it succeeds. Check the Pub/Sub topic and reconnect the mailbox if its credentials changed.",
      url: "/settings/connected-accounts",
    });
    return { renewed: false, reason: "watch_failed" };
  }
}
