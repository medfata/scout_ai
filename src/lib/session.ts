import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth, OWNER_ONLY_ERROR_CODE } from "./auth";
import { getEnv } from "./env";
import { logger } from "./logger";

/**
 * Section 8: "Middleware protects every route except `/api/webhooks/*` and auth
 * routes. Server Actions re-check the session." Every Server Action and every
 * protected layout calls `requireOwner()`; `proxy.ts` only checks that a session
 * cookie exists, which is cheap but not authoritative.
 *
 * A signed-in user whose email is not `ADMIN_EMAIL` is refused and signed out
 * here as well, so a stale row from before the allowlist existed cannot be used.
 */

export interface Owner {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

/** The signed-in owner, or `null`. Never redirects; use for optional UI. */
export async function getOwnerSession(): Promise<Owner | null> {
  const current = await auth.api.getSession({ headers: await headers() });
  if (!current) return null;
  return {
    id: current.user.id,
    email: current.user.email,
    name: current.user.name,
    image: current.user.image ?? null,
  };
}

/**
 * Returns the signed-in owner or redirects to `/sign-in`. Refuses (and signs out)
 * any session whose email is not `ADMIN_EMAIL`. Call this at the top of every
 * Server Action — the proxy can be bypassed by a matcher change (Next 16 docs).
 */
export async function requireOwner(): Promise<Owner> {
  const ownerEmail = getEnv().ADMIN_EMAIL.trim().toLowerCase();
  const current = await auth.api.getSession({ headers: await headers() });

  if (!current) redirect("/sign-in");

  if (current.user.email.trim().toLowerCase() !== ownerEmail) {
    logger.warn("auth.session_rejected", { reason: "email_not_allowlisted", userId: current.user.id });
    try {
      await auth.api.signOut({ headers: await headers() });
    } catch (error) {
      logger.error("auth.sign_out_failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    redirect(`/sign-in?error=${OWNER_ONLY_ERROR_CODE}`);
  }

  return {
    id: current.user.id,
    email: current.user.email,
    name: current.user.name,
    image: current.user.image ?? null,
  };
}
