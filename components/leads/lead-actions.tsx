"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { deleteContactAction, exportContactAction } from "@/app/(app)/leads/actions";
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
 * Section 9's data-request buttons. Export downloads every field Scout holds for the
 * contact; Delete suppresses the contact on every channel and soft-deletes the row.
 */

export function LeadActions({ contactId, contactName }: { contactId: string; contactName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleExport() {
    setBusy(true);
    setError(null);
    const result = await exportContactAction(contactId);
    setBusy(false);

    if (!result.ok || !("json" in result) || !result.json) {
      setError(result.error ?? "Export failed.");
      return;
    }

    const blob = new Blob([result.json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename ?? "scout-contact.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    const result = await deleteContactAction(contactId);
    setBusy(false);

    if (!result.ok) {
      setError(result.error ?? "Delete failed.");
      return;
    }
    setConfirmOpen(false);
    router.push("/leads");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => void handleExport()} disabled={busy}>
        Export
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogTrigger asChild>
          <Button variant="destructive" size="sm" disabled={busy}>
            Delete
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {contactName}?</DialogTitle>
            <DialogDescription>
              This suppresses the contact on email, domain and LinkedIn, then soft-deletes the record. The
              do-not-contact list and the audit log are kept.
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={busy}>
              {busy ? "Deleting…" : "Delete contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error && !confirmOpen ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
