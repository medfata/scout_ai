"use client";

import { useActionState } from "react";

import { updateOfferAction } from "@/app/(app)/offers/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Offer } from "@/src/db/schema";
import { IDLE_ACTION_STATE } from "./action-state";
import { ProofRowsEditor } from "./proof-rows-editor";

export function OfferEditForm({ offer }: { offer: Offer }) {
  const [state, formAction, pending] = useActionState(updateOfferAction, IDLE_ACTION_STATE);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="offerId" value={offer.id} />

      <div className="space-y-1.5">
        <Label htmlFor="offer-title">Title</Label>
        <Input id="offer-title" name="title" defaultValue={offer.title} required maxLength={160} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="offer-description">Description</Label>
        <Textarea id="offer-description" name="description" defaultValue={offer.description} required rows={4} maxLength={4000} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="offer-price">Price hint (optional)</Label>
        <Input id="offer-price" name="priceHint" defaultValue={offer.priceHint ?? ""} maxLength={200} />
      </div>

      <div className="space-y-2">
        <Label>Proof</Label>
        <ProofRowsEditor defaultProof={offer.proof} />
      </div>

      {state.status !== "idle" ? (
        <Alert variant={state.status === "error" ? "destructive" : "default"}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save offer"}
      </Button>
    </form>
  );
}
