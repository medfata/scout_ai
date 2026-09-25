import Link from "next/link";

import { QuotaTable } from "@/components/dashboard/quota-table";
import { DryRunBanner } from "@/components/settings/dry-run-banner";
import { ReadOnlySettings } from "@/components/settings/read-only-settings";
import { SettingsForm } from "@/components/settings/settings-form";
import { SuppressionManager } from "@/components/settings/suppression-manager";
import { buttonVariants } from "@/components/ui/button";
import { getEnv } from "@/src/lib/env";
import { requireOwner } from "@/src/lib/session";
import { listSuppressions } from "@/src/services/leads";
import { quotaSnapshot } from "@/src/services/quota";
import { getSettings } from "@/src/services/settings";

/**
 * Section 10: `(app)/settings` — the phase 0 deliverable where section 9's guardrails and
 * section 7's pacing live. The page is a server component; every mutation goes through the
 * server actions in `./actions.ts`, each of which re-checks the owner session (section 8).
 */

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireOwner();
  const env = getEnv();
  const [settings, suppressions, snapshots] = await Promise.all([getSettings(), listSuppressions(), quotaSnapshot()]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Section 9&apos;s guardrails and section 7&apos;s pacing in one place. Code enforces every value here;
            prompts never see them.
          </p>
        </div>
        <Link href="/settings/connected-accounts" className={buttonVariants({ variant: "outline" })}>
          Connected accounts
        </Link>
      </header>

      {env.DRY_RUN ? <DryRunBanner redirectEmail={env.DRY_RUN_REDIRECT_EMAIL || null} /> : null}

      <SettingsForm
        values={{
          timezone: settings.timezone,
          sendingWindows: settings.sendingWindows,
          caps: settings.caps,
          autonomyLevel: settings.autonomyLevel,
          signature: settings.signature,
          postalAddress: settings.postalAddress,
          killSwitch: settings.killSwitch,
          dailyNewProspectTarget: settings.dailyNewProspectTarget,
        }}
        maxDailyNewProspects={env.MAX_DAILY_NEW_PROSPECTS}
      />

      <SuppressionManager rows={suppressions} />

      <QuotaTable snapshots={snapshots} />

      <ReadOnlySettings
        linkedinMode={env.LINKEDIN_MODE}
        modelCopy={env.MODEL_COPY}
        modelResearch={env.MODEL_RESEARCH}
        dryRun={env.DRY_RUN}
        requiresConsentGeos={settings.requiresConsentGeos}
      />
    </div>
  );
}
