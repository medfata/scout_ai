import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { QUOTA_ALERT_THRESHOLD } from "@/src/domain";
import type { DatabaseSizeUsage, WorkflowEventUsage } from "@/src/services/quota";

/**
 * Review item B4: section 0's two platform limits — 50,000 Workflow events a month and
 * 0.5 GB of database storage — against what Scout can actually measure.
 *
 * The Workflow SDK exposes no usage counter, so `workflowEventUsage()` models the figure
 * from recorded runs and steps; the row says "estimate" because that number must never be
 * read as a measurement. The database row uses the real `pg_database_size()`.
 */

export function MeteringTable({
  workflowEvents,
  database,
}: {
  workflowEvents: WorkflowEventUsage;
  database: DatabaseSizeUsage;
}) {
  const eventsState = stateFor(workflowEvents.used, workflowEvents.limit);
  const databaseState = stateFor(database.usedBytes, database.limitBytes);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform metering</CardTitle>
        <CardDescription>
          Section 0&apos;s platform limits. Scout alerts at {QUOTA_ALERT_THRESHOLD * 100}% and never buys credits or
          upgrades a plan on its own.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resource</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead className="text-right">Limit</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    Workflow events
                    {workflowEvents.estimated ? (
                      <Badge
                        variant="outline"
                        title="The Workflow SDK exposes no usage counter. This figure is modelled from recorded runs and steps, not measured."
                      >
                        estimate
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground block text-xs font-normal">this month</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(workflowEvents.used)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(workflowEvents.limit)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(workflowEvents.used, workflowEvents.limit)}</TableCell>
                <TableCell>
                  <Badge variant={eventsState.variant}>{eventsState.label}</Badge>
                </TableCell>
              </TableRow>

              <TableRow>
                <TableCell className="font-medium">
                  Database storage
                  <span className="text-muted-foreground block text-xs font-normal">Neon free plan</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatBytes(database.usedBytes)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBytes(database.limitBytes)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(database.usedBytes, database.limitBytes)}</TableCell>
                <TableCell>
                  <Badge variant={databaseState.variant}>{databaseState.label}</Badge>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function stateFor(used: number, limit: number): { label: string; variant: "secondary" | "outline" | "destructive" } {
  if (limit <= 0) return { label: "ok", variant: "secondary" };
  if (used >= limit) return { label: "at limit", variant: "destructive" };
  if (used / limit >= QUOTA_ALERT_THRESHOLD) return { label: "80% used", variant: "outline" };
  return { label: "ok", variant: "secondary" };
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-GB").format(Math.round(value));
}

function formatPercent(used: number, limit: number): string {
  if (limit <= 0) return "—";
  return `${Math.round((used / limit) * 100)}%`;
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}
