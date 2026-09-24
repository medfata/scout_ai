import { Archive, Check, Pause } from "lucide-react";

import { approveIcpAction, archiveIcpAction, pauseIcpAction } from "@/app/(app)/offers/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Icp } from "@/src/db/schema";
import { icpScoreTotal } from "@/src/domain/scoring";
import { IcpEditForm } from "./icp-edit-form";
import { IcpStatusBadge } from "./status-badge";

const SCORE_FIELDS = [
  { key: "pain", label: "Pain" },
  { key: "budget", label: "Budget" },
  { key: "reach", label: "Reach" },
  { key: "proofFit", label: "Proof fit" },
  { key: "speed", label: "Speed" },
] as const;

export function IcpCard({ icp }: { icp: Icp }) {
  const exa = icp.searchFilters.exa;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
              <span className="text-muted-foreground">#{icp.rank ?? "–"}</span>
              {icp.name}
              <IcpStatusBadge status={icp.status} />
            </CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">{icp.rationale}</p>
          </div>
          <IcpStatusActions icp={icp} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <ScoreCell label="Total" value={icp.scores ? `${icpScoreTotal(icp.scores)}/25` : "–"} strong />
          {SCORE_FIELDS.map((field) => (
            <ScoreCell key={field.key} label={field.label} value={icp.scores ? String(icp.scores[field.key]) : "–"} />
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pains</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
              {icp.pains.map((pain) => (
                <li key={pain}>{pain}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Angles</p>
            <ul className="mt-1 space-y-2 text-sm">
              {icp.angles.map((angle) => (
                <li key={angle.key}>
                  <span className="font-mono text-xs text-muted-foreground">{angle.key}</span>
                  <p>{angle.hook}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="rounded-md bg-muted/50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Exa search</p>
          <p className="mt-1 font-mono text-xs">{exa?.query ?? "–"}</p>
          {exa && exa.criteria.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">{exa.criteria.join(" · ")}</p>
          ) : null}
        </div>

        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <DetailRow label="Titles" values={icp.titles} />
          <DetailRow label="Industries" values={icp.industries} />
          <DetailRow label="Size bands" values={icp.sizeBands} />
          <DetailRow label="Geos" values={icp.geos} />
          <DetailRow label="Triggers" values={icp.triggers} />
          <DetailRow label="Disqualifiers" values={icp.disqualifiers} />
        </dl>

        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">Edit ICP</summary>
          <div className="mt-3">
            <IcpEditForm icp={icp} />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function IcpStatusActions({ icp }: { icp: Icp }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {icp.status !== "approved" ? (
        <form action={approveIcpAction}>
          <input type="hidden" name="icpId" value={icp.id} />
          <Button type="submit" size="sm">
            <Check /> Approve
          </Button>
        </form>
      ) : null}
      {icp.status !== "paused" ? (
        <form action={pauseIcpAction}>
          <input type="hidden" name="icpId" value={icp.id} />
          <Button type="submit" size="sm" variant="outline">
            <Pause /> Pause
          </Button>
        </form>
      ) : null}
      {icp.status !== "archived" ? (
        <form action={archiveIcpAction}>
          <input type="hidden" name="icpId" value={icp.id} />
          <Button type="submit" size="sm" variant="ghost">
            <Archive /> Archive
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function ScoreCell({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={strong ? "text-lg font-semibold" : "text-base font-medium"}>{value}</p>
    </div>
  );
}

function DetailRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd>{values.length > 0 ? values.join(", ") : "–"}</dd>
    </div>
  );
}
