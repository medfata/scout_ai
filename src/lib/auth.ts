import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import { account, session, user, verification } from "@/src/db/schema";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";

/**
 * Section 8: "Better Auth with Google sign-in. Only `ADMIN_EMAIL` can sign in;
 * everyone else is rejected." Sessions are cookie-based (Better Auth's default),
 * so `src/lib/session.ts` can read them from Server Components and Server Actions.
 *
 * The allowlist is enforced **inside Better Auth**, not in the UI:
 *  - `databaseHooks.user.create.before` stops a non-owner Google account from
 *    ever getting a row, so a rejected person cannot sign in even by retrying;
 *  - `databaseHooks.session.create.before` is defence in depth for a row that
 *    already exists (for example, one created before the allowlist was added).
 * A rejected account gets a `scout_owner_only` error that the sign-in page
 * turns into a readable message.
 *
 * D2 (DECISIONS.md): "Dev-only email+password, off in production." The credentials
 * provider exists only when `NODE_ENV !== "production"` **and** `DRY_RUN=true`,
 * both inlined at build time, so it is never compiled into a production build.
 * Sign-up stays disabled: `scripts/seed-owner.ts` creates the single local account.
 */

/** Error code the sign-in page maps to a readable message. */
export const OWNER_ONLY_ERROR_CODE = "scout_owner_only";

/** Message Better Auth returns to a rejected account, verbatim. */
export const OWNER_ONLY_ERROR_MESSAGE =
  "This account is not allowed. Scout is a private app and only its owner can sign in.";

/** D2: true only in a local/preview build that also has `DRY_RUN=true`. */
export const devCredentialsEnabled =
  process.env.NODE_ENV !== "production" && process.env.DRY_RUN === "true";

const env = getEnv();

/**
 * Google sign-in needs a real GCP client. Locally the owner may not have created
 * one yet (D2 exists for exactly that reason), so the provider is omitted rather
 * than making the whole auth instance fail to boot. Production must set both.
 */
export const googleSignInEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

function assertOwnerEmail(email: string): void {
  const ownerEmail = env.ADMIN_EMAIL.trim().toLowerCase();
  if (email.trim().toLowerCase() === ownerEmail) return;
  logger.warn("auth.rejected", { reason: "email_not_allowlisted" });
  throw new APIError("FORBIDDEN", {
    code: OWNER_ONLY_ERROR_CODE,
    message: OWNER_ONLY_ERROR_MESSAGE,
  });
}

export const auth = betterAuth({
  appName: "Scout",
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(getDb(), {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  ...(googleSignInEnabled
    ? {
        socialProviders: {
          google: {
            clientId: env.GOOGLE_CLIENT_ID ?? "",
            clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
          },
        },
      }
    : {}),
  ...(devCredentialsEnabled
    ? {
        emailAndPassword: {
          enabled: true,
          // D2: the account must already exist (scripts/seed-owner.ts).
          disableSignUp: true,
          minPasswordLength: 12,
        },
      }
    : {}),
  databaseHooks: {
    user: {
      create: {
        before: async (newUser) => {
          assertOwnerEmail(newUser.email);
        },
      },
    },
    session: {
      create: {
        before: async (newSession) => {
          const [owner] = await getDb()
            .select({ email: user.email })
            .from(user)
            .where(eq(user.id, newSession.userId))
            .limit(1);
          if (!owner) return false;
          assertOwnerEmail(owner.email);
        },
      },
    },
  },
  onAPIError: {
    // A failed OAuth callback lands back on the sign-in page with ?error=<code>,
    // which is where the owner sees why the account was rejected.
    errorURL: "/sign-in",
  },
  // Must be the last plugin. Lets `auth.api.*` calls made from Server Actions
  // write their Set-Cookie headers through `next/headers` (section 8).
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
