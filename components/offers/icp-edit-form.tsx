"use client";

import { useActionState } from "react";

import { updateIcpAction } from "@/app/(app)/offers/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Icp } from "@/src/db/schema";
import { SIZE_BANDS } from "@/src/domain/types";
import { IDLE_ACTION_STATE } from "./action-state";

/**
 * The owner's edit surface for one ICP (section 11 phase 1: "ICP edit and approve").
 * List fields are one entry per line; angles are up to three key/hook rows.
 */
export function IcpEditForm({ icp }: { icp: Icp }) {
  const [state, formAction, pending] = useActionState(updateIcpAction, IDLE_ACTION_STATE);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="icpId" value={icp.id} />
      <input type="hidden" name="offerId" value={icp.offerId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`icp-name-${icp.id}`}>Name</Label>
          <Input id={`icp-name-${icp.id}`} name="name" defaultValue={icp.name} required maxLength={120} />
        </div>
        <div className="space-y-1.5">
          <Label>Status</Label>
          <p className="text-sm text-muted-foreground">
            {icp.status}
            {icp.rank ? ` · rank ${icp.rank}` : ""}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`icp-rationale-${icp.id}`}>Rationale</Label>
        <Textarea id={`icp-rationale-${icp.id}`} name="rationale" defaultValue={icp.rationale} required rows={3} maxLength={600} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <LinesField id={`icp-pains-${icp.id}`} name="pains" label="Pains (one per line, at least 2)" defaultValue={icp.pains} />
        <LinesField id={`icp-titles-${icp.id}`} name="titles" label="Titles (one per line)" defaultValue={icp.titles} />
        <LinesField id={`icp-industries-${icp.id}`} name="industries" label="Industries (one per line)" defaultValue={icp.industries} />
        <LinesField id={`icp-geos-${icp.id}`} name="geos" label="Geos (one per line)" defaultValue={icp.geos} />
        <LinesField
          id={`icp-disqualifiers-${icp.id}`}
          name="disqualifiers"
          label="Disqualifiers (one per line)"
          defaultValue={icp.disqualifiers}
        />
      </div>

      <div className="space-y-2">
        <Label>Company size</Label>
        <div className="flex flex-wrap gap-4">
          {SIZE_BANDS.map((band) => (
            <Label key={band} className="flex items-center gap-2 text-sm font-normal">
              <input
                type="checkbox"
                name="sizeBands"
                value={band}
                defaultChecked={icp.sizeBands.includes(band)}
                className="size-4 rounded border"
              />
              {band}
            </Label>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Angles (2-3, key + opening hook)</Label>
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[200px_1fr]">
              <Input name="angleKey" defaultValue={icp.angles[index]?.key ?? ""} placeholder="angle-key" maxLength={40} />
              <Input name="angleHook" defaultValue={icp.angles[index]?.hook ?? ""} placeholder="Opening hook…" maxLength={240} />
            </div>
          ))}
        </div>
      </div>

      {state.status !== "idle" ? (
        <Alert variant={state.status === "error" ? "destructive" : "default"}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save ICP"}
      </Button>
    </form>
  );
}

function LinesField({
  id,
  name,
  label,
  defaultValue,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: string[];
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} name={name} defaultValue={defaultValue.join("\n")} rows={4} className="font-mono text-xs" />
    </div>
  );
}
