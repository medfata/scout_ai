"use client";

import { Plus } from "lucide-react";
import { useActionState, useState } from "react";

import { createOfferAction } from "@/app/(app)/offers/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IDLE_ACTION_STATE } from "./action-state";
import { ProofRowsEditor } from "./proof-rows-editor";

export function CreateOfferDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createOfferAction, IDLE_ACTION_STATE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New offer
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New offer</DialogTitle>
          <DialogDescription>
            What you sell and the proof behind it. Scout uses this to generate ICPs; nothing is sent anywhere yet.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="create-offer-title">Title</Label>
            <Input id="create-offer-title" name="title" required maxLength={160} placeholder="AI support triage pilot" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="create-offer-description">Description</Label>
            <Textarea
              id="create-offer-description"
              name="description"
              required
              rows={4}
              maxLength={4000}
              placeholder="What you do, for whom, and what changes for them."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="create-offer-price">Price hint (optional)</Label>
            <Input id="create-offer-price" name="priceHint" maxLength={200} placeholder="$6k pilot" />
          </div>

          <div className="space-y-2">
            <Label>Proof</Label>
            <ProofRowsEditor />
          </div>

          {state.status === "error" ? (
            <Alert variant="destructive">
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create offer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
