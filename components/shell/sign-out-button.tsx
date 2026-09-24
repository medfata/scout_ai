"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOutIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/src/lib/auth-client";

/**
 * Ends the cookie session through Better Auth and returns to the sign-in page.
 * Client-side on purpose: the sign-out endpoint owns cookie clearing, and the
 * sidebar is a client component anyway.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Sign out"
      title="Sign out"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await authClient.signOut();
          router.push("/sign-in");
          router.refresh();
        });
      }}
    >
      <LogOutIcon />
    </Button>
  );
}
