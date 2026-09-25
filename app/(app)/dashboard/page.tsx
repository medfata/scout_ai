import Link from "next/link";

import { QuotaTable } from "@/components/dashboard/quota-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AutonomyLevel } from "@/src/domain/types";
import { requireOwner } from "@/src/lib/session";
import { listEnrollmentsForApproval } from "@/src/services/enrollment";
import { quotaSnapshot } from "@/src/services/quota";
import { getSettings } from "@/src/services/settings";

/**
 * Section 10: `(app)/dashboard`. Deliberately honest: phase 7's metrics do not exist yet,
 * so this page reports only what is already real — section 0's quota counters and the
 * approval queue depth — and says where the numbers come from.
 */

export const dynamic = "force-dynamic";

/** Section 9's autonomy table, phrased for the queue card. */
const AUTONOMY_QUEUE_NOTES: Record<AutonomyLevel, string> = {
  L0: "Every message waits in the inbox until you approve it.",
  L1: "First touches and LinkedIn messages wait; follow-ups that pass the critic can send themselves.",
  L2: "Tier A messages can send themselves within caps; tier B and C wait for approval.",
};

export default async function DashboardPage() {
  await requireOwner();
  const [snapshots, pending, settings] = await Promise.all([
    quotaSnapshot(),
    listEnrollmentsForApproval(),
    getSettings(),
  ]);

  // `listEnrollmentsForApproval` caps at 100 rows; show that it is a floor, not an exact count.
  const pendingLabel = pending.length >= 100 ? "100+" : String(pending.length);
  const queueNote = settings.killSwitch
    ? "The kill switch is on, so nothing sends at all until you turn it off."
    : AUTONOMY_QUEUE_NOTES[settings.autonomyLevel];

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Scout is mid-MVP: sourcing, research, drafting and the approval inbox work end to end. Replies and timed
          follow-ups arrive in phase 5; the learning loop in phase 7.
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <QuotaTable snapshots={snapshots} />

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Awaiting your approval</CardTitle>
              <CardDescription>
                Section 9, level {settings.autonomyLevel}: {queueNote}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-4xl font-semibold tabular-nums">{pendingLabel}</p>
              <p className="text-sm text-muted-foreground">
                {pending.length === 0
                  ? "Nothing waiting right now."
                  : pending.length === 1
                    ? "draft is waiting for a decision."
                    : "drafts are waiting for a decision."}
              </p>
              <Button asChild size="sm">
                <Link href="/inbox">Open the approval inbox</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Metrics arrive in phase 7</CardTitle>
              <CardDescription>Reply rates, ICP × angle performance and the daily budget allocator.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Phase 7 reads the append-only activity log to shift new-lead volume toward the ICPs and angles that
                earn positive replies. Building it before real replies exist would mean guessing at thresholds, so
                this page stays a quota and queue view for now.
              </p>
              <Link className="text-sm underline underline-offset-2" href="/inbox">
                Review the drafts waiting for you →
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
