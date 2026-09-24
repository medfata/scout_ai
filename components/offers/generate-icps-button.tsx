"use client";

import { Sparkles } from "lucide-react";
import { useActionState } from "react";

import { generateIcpAction } from "@/app/(app)/offers/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IDLE_ACTION_STATE } from "./action-state";

export function GenerateIcpsButton({ offerId, hasExisting }: { offerId: string; hasExisting: boolean }) {
  const [state, formAction, pending] = useActionState(generateIcpAction, IDLE_ACTION_STATE);

  return (
    <div className="flex max-w-sm flex-col items-end gap-2">
      <form action={formAction}>
        <input type="hidden" name="offerId" value={offerId} />
        <Button type="submit" disabled={pending}>
          <Sparkles /> {pending ? "Generating…" : hasExisting ? "Re-generate ICPs" : "Generate ICPs"}
        </Button>
      </form>
      {state.status !== "idle" ? (
        <Alert variant={state.status === "error" ? "destructive" : "default"}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
