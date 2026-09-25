import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Suppression } from "@/src/db/schema";
import { AddSuppressionForm } from "./add-suppression-form";
import { RemoveSuppressionButton } from "./remove-suppression-button";

/**
 * Section 9's do-not-contact list. Read-only rows plus two owner actions: add and remove.
 * The list is checked by sourcing (phase 2), by `suppressContact` on opt-outs and bounces,
 * and by the send guard's rule 3, so what the owner sees here is what blocks a send.
 */

export function SuppressionManager({ rows }: { rows: Suppression[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Do-not-contact list</CardTitle>
        <CardDescription>
          Opt-outs and hard bounces land here instantly and stay until you remove them. Matching is normalised and
          hashed, so a domain entry blocks every address on it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AddSuppressionForm />

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing suppressed yet. Opt-outs and hard bounces add themselves here.
          </p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Badge variant="outline">{row.kind}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[24rem] truncate font-mono text-xs" title={row.value ?? undefined}>
                      {row.value ?? "hash only (retention)"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.reason ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(row.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <RemoveSuppressionButton id={row.id} value={row.value} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Showing the {rows.length} most recent {rows.length === 1 ? "entry" : "entries"}.
        </p>
      </CardContent>
    </Card>
  );
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(
    value,
  );
}
