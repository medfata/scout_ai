import type { Metadata } from "next";
import { RadarIcon } from "lucide-react";

import { DevCredentialsForm, GoogleSignInButton } from "@/components/shell/sign-in-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  devCredentialsEnabled,
  googleSignInEnabled,
  OWNER_ONLY_ERROR_CODE,
  OWNER_ONLY_ERROR_MESSAGE,
} from "@/src/lib/auth";

/**
 * Section 8: the only public page. Google sign-in for production, the D2
 * email+password form when the dev provider is compiled in. A rejected Google
 * account lands back here with `?error=scout_owner_only` and sees exactly why.
 */

export const metadata: Metadata = { title: "Sign in" };

const DASHBOARD = "/dashboard";

function safeNextPath(value: string | string[] | undefined): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return DASHBOARD;
  return raw;
}

function describeError(value: string | string[] | undefined): string | null {
  const code = typeof value === "string" ? value : undefined;
  if (!code) return null;

  // Only codes Scout knows are rendered. Never echo an arbitrary
  // `error_description` from the URL back into the page.
  if (code === OWNER_ONLY_ERROR_CODE) return OWNER_ONLY_ERROR_MESSAGE;
  if (code === "state_not_found" || code === "invalid_callback_request") {
    return "That sign-in attempt expired or was tampered with. Try again.";
  }
  if (code === "account_not_linked" || code === "email_does_not_match") {
    return "That Google account is not linked to the owner's. Sign in with the owner's Google account.";
  }
  return `Sign-in failed (${code}).`;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const nextPath = safeNextPath(params.next);
  const errorMessage = describeError(params.error);

  return (
    <main className="surface-grid relative flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <div className="flex items-center gap-2">
        <RadarIcon className="text-primary size-5" />
        <span className="font-mono text-sm font-medium tracking-[0.28em] uppercase">Scout</span>
      </div>

      <div className="bg-card w-full max-w-sm rounded-lg border p-6 shadow-lg">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
          <p className="text-muted-foreground text-sm">
            Private console. Only the owner&apos;s account can get past this screen.
          </p>
        </div>

        {errorMessage ? (
          <Alert variant="destructive" className="mt-4">
            <AlertTitle>Access denied</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-5 space-y-4">
          {googleSignInEnabled ? (
            <GoogleSignInButton nextPath={nextPath} />
          ) : (
            <Alert>
              <AlertTitle>Google sign-in is not configured</AlertTitle>
              <AlertDescription>
                Set <code className="font-mono text-xs">GOOGLE_CLIENT_ID</code> and{" "}
                <code className="font-mono text-xs">GOOGLE_CLIENT_SECRET</code> to enable it.
              </AlertDescription>
            </Alert>
          )}

          {devCredentialsEnabled ? (
            <>
              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="micro-label text-muted-foreground">Local dev</span>
                <Separator className="flex-1" />
              </div>
              <DevCredentialsForm nextPath={nextPath} />
              <p className="text-muted-foreground text-xs">
                Dev-only password sign-in (DECISIONS.md D2). Run{" "}
                <code className="font-mono">pnpm db:seed:owner</code> once to create the account.
              </p>
            </>
          ) : null}
        </div>
      </div>

      <p className="text-muted-foreground font-mono text-[11px] tracking-wide">
        Single-user · no index · dry run by default
      </p>
    </main>
  );
}
