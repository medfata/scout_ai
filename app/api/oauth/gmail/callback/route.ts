import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { requireOwner } from "@/src/lib/session";
import {
  GMAIL_OAUTH_STATE_COOKIE,
  GMAIL_OAUTH_STATE_PATH,
  completeGmailOAuth,
  gmailRedirectUri,
  saveGmailAccount,
  verifyOAuthState,
} from "@/src/services/oauth-gmail";

/**
 * Section 8: Google redirects here after the owner consents. This route is not in the
 * middleware allow-list, so `requireOwner()` is the gate; the state cookie is read once
 * and deleted, which is what makes the round trip single-use.
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

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(GMAIL_OAUTH_STATE_COOKIE)?.value ?? null;
  cookieStore.delete({ name: GMAIL_OAUTH_STATE_COOKIE, path: GMAIL_OAUTH_STATE_PATH });

  // Google reports a refusal through `error`; nothing was granted, so this is not a 500.
  if (requestUrl.searchParams.get("error")) return failure("access_denied");

  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  if (!code) return failure("missing_code");
  if (!verifyOAuthState(state, expectedState)) return failure("state_mismatch");

  try {
    const result = await completeGmailOAuth({ code, redirectUri: gmailRedirectUri(getEnv().APP_URL) });
    await saveGmailAccount(result);
  } catch (error) {
    logger.error("gmail.oauth_exchange_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return failure("exchange_failed");
  }

  const done = new URL("/settings/connected-accounts", requestUrl.origin);
  done.searchParams.set("connected", "1");
  return NextResponse.redirect(done);
}
