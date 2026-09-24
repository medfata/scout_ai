import { reconnectAccount } from "@/app/(app)/settings/connected-accounts/actions";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ConnectedAccount } from "@/src/db/schema";
import { isWarmupComplete, warmupWeekFor } from "@/src/domain";
import { AccountKindBadge, AccountStatusBadge, isAccountPaused } from "./account-badges";

/**
 * Section 8: one row per sending identity with its health, warmup progress and today's
 * usage. Section 7's caps are shown next to the counters so the owner can see why a send
 * is blocked before it is.
 */

export interface ConnectedAccountRow {
  account: ConnectedAccount;
  /** Today's counters from `send_counters`, or null for a channel without caps. */
  usage: { new: number; total: number } | null;
  /** Today's caps after the warmup ramp, or null for a channel without caps. */
  caps: { newConversations: number; totalSends: number } | null;
}

export function ConnectedAccountsTable({ rows }: { rows: ConnectedAccountRow[] }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Warmup</TableHead>
            <TableHead className="text-right">Sent today</TableHead>
            <TableHead className="text-right">Today&apos;s cap</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ account, usage, caps }) => {
            const paused = isAccountPaused(account.status);
            return (
              <TableRow key={account.id} className={paused ? "opacity-60" : undefined}>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <AccountKindBadge kind={account.kind} />
                    <span className="font-medium">{account.handle}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{providerLabel(account.provider)}</p>
                  {paused && account.statusDetail ? (
                    <p className="mt-1 text-xs text-destructive">{account.statusDetail}</p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <AccountStatusBadge status={account.status} />
                </TableCell>
                <TableCell>
                  <WarmupCell account={account} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usage ? `${usage.new} new · ${usage.total} total` : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {caps ? `${caps.newConversations} new · ${caps.totalSends} total` : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {paused ? (
                    <form action={reconnectAccount}>
                      <input type="hidden" name="accountId" value={account.id} />
                      <Button type="submit" size="sm">
                        Reconnect
                      </Button>
                    </form>
                  ) : (
                    <span className="text-xs text-muted-foreground">Healthy</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function WarmupCell({ account }: { account: ConnectedAccount }) {
  if (account.kind !== "email") {
    return <span className="text-xs text-muted-foreground">Not applicable</span>;
  }
  if (account.warmupStage === 0) {
    return <span className="text-xs text-muted-foreground">Not started</span>;
  }
  const complete = isWarmupComplete(account.warmupStage);
  return (
    <div className="text-xs">
      <p>
        {complete ? "Complete" : `Week ${warmupWeekFor(account.warmupStage)} of 4`}
      </p>
      <p className="text-muted-foreground">
        {account.warmupStartedAt ? `Started ${formatDate(account.warmupStartedAt)}` : "Start date missing"}
      </p>
    </div>
  );
}

function providerLabel(provider: string): string {
  if (provider === "google") return "Google Workspace / Gmail";
  return provider.length > 0 ? `${provider[0]?.toUpperCase() ?? ""}${provider.slice(1)}` : "Unknown provider";
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}
