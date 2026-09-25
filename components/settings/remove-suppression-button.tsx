"use client";

import { useState } from "react";

import { removeSuppressionAction } from "@/app/(app)/settings/actions";
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

/**
 * Removing an entry from the do-not-contact list re-opens a channel to that person, so it
 * asks for confirmation first (same pattern as the lead Delete button). The server action
 * re-checks the owner session and validates the id before deleting.
 */

export function RemoveSuppressionButton({ id, value }: { id: string; value: string | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove() {
    setBusy(true);
    setError(null);
    const result = await removeSuppressionAction({ id });
    setBusy(false);

    if (!result.ok) {
      setError(result.error ?? "The entry could not be removed.");
      return;
    }
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          aria-label={value ? `Remove suppression for ${value}` : "Remove suppression"}
        >
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove this suppression?</DialogTitle>
          <DialogDescription>
            Scout may contact{" "}
            <span className="font-mono text-xs">{value ?? "this hashed value"}</span> again on this channel. Opt-outs
            should stay on the list; only remove an entry you added by mistake.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void handleRemove()} disabled={busy}>
            {busy ? "Removing…" : "Remove entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
