import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { humanQuotaName, isQuotaExhausted, shouldAlertOnQuota, stageForResource } from "@/src/domain";
import type { QuotaSnapshot } from "@/src/services/quota";

/**
 * Section 0's quotas against their counters. Section 3: "Dashboards and the learning loop
 * read from" the append-only log, which is what `quotaSnapshot()` summarises. Used by the
 * dashboard and by `/settings`, so both pages agree on what is paused.
 */

export function QuotaTable({ snapshots }: { snapshots: QuotaSnapshot[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quota snapshot</CardTitle>
        <CardDescription>
          When a quota runs out its stage pauses until the quota resets. Scout never buys credits, upgrades a plan or
          switches provider on its own.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resource</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead className="text-right">Limit</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshots.map((snapshot) => {
                const state = stateFor(snapshot);
                return (
                  <TableRow key={`${snapshot.resource}-${snapshot.period}`}>
                    <TableCell className="font-medium">
                      {capitalize(humanQuotaName(snapshot.resource))}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{snapshot.period === "day" ? "Daily" : "Monthly"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatValue(snapshot.resource, snapshot.used)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatValue(snapshot.resource, snapshot.limit)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatValue(snapshot.resource, snapshot.remaining)}
                    </TableCell>
                    <TableCell>
                      <span title={`${stageForResource(snapshot.resource)} pauses while this is exhausted`}>
                        <Badge variant={state.variant}>{state.label}</Badge>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function stateFor(snapshot: QuotaSnapshot): { label: string; variant: "secondary" | "outline" | "destructive" } {
  if (isQuotaExhausted(snapshot)) {
    return {
      label: snapshot.period === "day" ? "paused until tomorrow" : "paused until next month",
      variant: "destructive",
    };
  }
  if (shouldAlertOnQuota(snapshot)) return { label: "80% used", variant: "outline" };
  return { label: "ok", variant: "secondary" };
}

function formatValue(resource: QuotaSnapshot["resource"], value: number): string {
  if (resource === "ai_spend_usd") return `$${value.toFixed(2)}`;
  return new Intl.NumberFormat("en-GB").format(Math.round(value));
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}
