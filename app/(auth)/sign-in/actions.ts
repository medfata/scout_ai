"use server";

import { redirect } from "next/navigation";
import { APIError } from "better-auth/api";

import { auth, OWNER_ONLY_ERROR_CODE, OWNER_ONLY_ERROR_MESSAGE } from "@/src/lib/auth";
import { logger } from "@/src/lib/logger";

/**
 * Server Action for the dev-only email + password form (DECISIONS.md D2).
 * Google sign-in stays on the client because it is a redirect handshake.
 *
 * The form posts here instead of calling the API directly so the action can map
 * Better Auth's error codes to messages a person can read — in particular the
 * allowlist rejection, which must be explicit (section 8).
 */

export interface SignInState {
  error: string | null;
}

const DASHBOARD = "/dashboard";

/** Only same-site absolute paths; blocks `//evil.example` and absolute URLs. */
function safeNextPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return DASHBOARD;
  return value;
}

export async function signInWithDevCredentials(
  _previousState: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const nextPath = safeNextPath(String(formData.get("next") ?? ""));

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  try {
    await auth.api.signInEmail({ body: { email, password } });
  } catch (error) {
    if (error instanceof APIError) {
      const code = error.body?.code;
      if (code === OWNER_ONLY_ERROR_CODE) return { error: OWNER_ONLY_ERROR_MESSAGE };
      if (code === "INVALID_EMAIL_OR_PASSWORD") return { error: "Wrong email or password." };
      logger.warn("auth.dev_sign_in_failed", { code: code ?? "unknown", status: error.status });
      return { error: "Sign-in failed. Check the email and password and try again." };
    }
    logger.error("auth.dev_sign_in_failed", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { error: "Sign-in failed. Check the server logs." };
  }

  redirect(nextPath);
}
