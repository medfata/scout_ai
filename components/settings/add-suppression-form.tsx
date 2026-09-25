"use client";

import { useActionState, useState } from "react";

import { addSuppressionAction } from "@/app/(app)/settings/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SUPPRESSION_KINDS, type SuppressionKind } from "@/src/domain/types";
import { IDLE_SETTINGS_STATE } from "./action-state";

/**
 * Section 9: "Opt-outs go to `suppressions` instantly and permanently." The owner can add
 * entries by hand for people who ask to be left alone outside a reply (a call, a
 * conference, an introduction). The server action normalises and hashes the value.
 */

const PLACEHOLDERS: Record<SuppressionKind, string> = {
  email: "person@acme.com",
  domain: "acme.com",
  linkedin: "linkedin.com/in/person",
};

export function AddSuppressionForm() {
  const [state, formAction, pending] = useActionState(addSuppressionAction, IDLE_SETTINGS_STATE);
  const [kind, setKind] = useState<SuppressionKind>("email");

  return (
    <form action={formAction} className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">Add to the do-not-contact list</p>
      <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="suppression-kind">Kind</Label>
          <Select
            value={kind}
            onValueChange={(value) => {
              const candidate = SUPPRESSION_KINDS.find((option) => option === value);
              if (candidate) setKind(candidate);
            }}
            disabled={pending}
          >
            <SelectTrigger id="suppression-kind" aria-label="Suppression kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPRESSION_KINDS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="suppression-value">Value</Label>
          <Input
            id="suppression-value"
            name="value"
            placeholder={PLACEHOLDERS[kind]}
            maxLength={320}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="suppression-reason">Reason (optional)</Label>
          <Input id="suppression-reason" name="reason" placeholder="owner_manual" maxLength={200} />
        </div>

        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>

      {/* The kind Select is not a form control, so the chosen value travels as a hidden field. */}
      <input type="hidden" name="kind" value={kind} />

      {state.status !== "idle" ? (
        <Alert variant={state.status === "error" ? "destructive" : "default"}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
