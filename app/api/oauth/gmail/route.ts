import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { requireOwner } from "@/src/lib/session";
import {
  GMAIL_OAUTH_STATE_COOKIE,
  GMAIL_OAUTH_STATE_MAX_AGE_SECONDS,
  GMAIL_OAUTH_STATE_PATH,
  createGmailAuthUrl,
  gmailRedirectUri,
  isGmailOAuthConfigured,
} from "@/src/services/oauth-gmail";

/**
 * Section 8: starts the Google hosted consent flow for the one sending mailbox. The
 * owner is the only person who can reach this route (session required), and the signed
 * `state` is stored in an http-only cookie that the callback consumes exactly once.
 *
 * `?reconnect=<accountId>` is accepted for parity with the Unipile flow; Google has no
 * such parameter, so the same flow runs and `saveGmailAccount` updates the existing row
 * by `externalAccountId` (section 8: "simply run the normal flow again").
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  await requireOwner();

  const requestUrl = new URL(request.url);
  const failure = (error: string) => {
    const back = new URL("/settings/connected-accounts", requestUrl.origin);
    back.searchParams.set("error", error);
    return NextResponse.redirect(back);
  };

  if (!isGmailOAuthConfigured()) {
    logger.warn("gmail.oauth_not_configured", {});
    return failure("not_configured");
  }

  try {
    const { url, state } = createGmailAuthUrl({ redirectUri: gmailRedirectUri(getEnv().APP_URL) });
    const cookieStore = await cookies();
    cookieStore.set(GMAIL_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: GMAIL_OAUTH_STATE_PATH,
      maxAge: GMAIL_OAUTH_STATE_MAX_AGE_SECONDS,
    });
    return NextResponse.redirect(url);
  } catch (error) {
    logger.error("gmail.oauth_start_failed", { reason: error instanceof Error ? error.name : "unknown" });
    return failure("start_failed");
  }
}
