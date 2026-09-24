"use client";

import * as React from "react";
import { useActionState } from "react";
import { Loader2Icon } from "lucide-react";

import { signInWithDevCredentials, type SignInState } from "@/app/(auth)/sign-in/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/src/lib/auth-client";

/**
 * The two sign-in paths.
 *
 * Google is a client-side redirect handshake (`authClient.signIn.social`); the
 * dev credentials form posts to a Server Action so the allowlist error can be
 * rendered verbatim (see `../app/(auth)/sign-in/actions.ts`).
 */

const INITIAL_STATE: SignInState = { error: null };

export function GoogleSignInButton({ nextPath }: { nextPath: string }) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        className="w-full"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError(null);
          void authClient.signIn.social({
            provider: "google",
            callbackURL: nextPath,
            errorCallbackURL: "/sign-in",
            fetchOptions: {
              onError: (context) => {
                setPending(false);
                setError(context.error.message || "Google sign-in failed.");
              },
            },
          });
        }}
      >
        {pending ? <Loader2Icon className="animate-spin" /> : null}
        Continue with Google
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function DevCredentialsForm({ nextPath }: { nextPath: string }) {
  const [state, formAction, pending] = useActionState(signInWithDevCredentials, INITIAL_STATE);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="next" value={nextPath} />
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required placeholder="owner@example.com" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={12}
          placeholder="12+ characters"
        />
      </div>
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="secondary" className="w-full" disabled={pending}>
        {pending ? <Loader2Icon className="animate-spin" /> : null}
        Sign in with password
      </Button>
    </form>
  );
}
