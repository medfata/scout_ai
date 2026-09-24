"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState, type ChangeEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ProofItem } from "@/src/domain/types";

/**
 * Case studies, demos and numbers. Section 6: copy may only claim proof that lives on
 * the offer record, so this is the one place proof is entered. Empty rows are dropped
 * by the server action; a row needs at least a label and a detail.
 */
export function ProofRowsEditor({ defaultProof = [] }: { defaultProof?: ProofItem[] }) {
  const [rows, setRows] = useState<ProofItem[]>(
    defaultProof.length > 0 ? defaultProof : [{ label: "", detail: "", url: "" }],
  );

  const update = (index: number, patch: Partial<ProofItem>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const remove = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      {rows.map((row, index) => (
        <div key={index} className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1.6fr_1fr_auto] sm:items-start">
          <div className="space-y-1.5">
            <Label htmlFor={`proof-label-${index}`}>Label</Label>
            <Input
              id={`proof-label-${index}`}
              name="proofLabel"
              value={row.label}
              onChange={(event: ChangeEvent<HTMLInputElement>) => update(index, { label: event.target.value })}
              placeholder="Support triage pilot"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`proof-detail-${index}`}>Detail</Label>
            <Textarea
              id={`proof-detail-${index}`}
              name="proofDetail"
              value={row.detail}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => update(index, { detail: event.target.value })}
              placeholder="Cut first-response time from 6h to 40min for a 12-agent team."
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`proof-url-${index}`}>Link (optional)</Label>
            <Input
              id={`proof-url-${index}`}
              name="proofUrl"
              type="url"
              value={row.url ?? ""}
              onChange={(event: ChangeEvent<HTMLInputElement>) => update(index, { url: event.target.value })}
              placeholder="https://"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mt-6"
            onClick={() => remove(index)}
            disabled={rows.length === 1}
            aria-label={`Remove proof item ${index + 1}`}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setRows((current) => [...current, { label: "", detail: "", url: "" }])}
      >
        <Plus /> Add proof item
      </Button>
      <p className="text-xs text-muted-foreground">
        Proof is the only evidence the copywriter may cite. Never enter results you cannot back up.
      </p>
    </div>
  );
}
