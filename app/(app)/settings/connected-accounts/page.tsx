import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectedAccountsTable, type ConnectedAccountRow } from "@/components/settings/connected-accounts-table";
import { DryRunBanner } from "@/components/settings/dry-run-banner";
import { emailCapsForWarmup } from "@/src/domain";
import { getEnv } from "@/src/lib/env";
import { dateOnlyInZone } from "@/src/lib/time-windows";
import { listAccounts } from "@/src/services/accounts";
import { getSendCounters } from "@/src/services/quota";
import { getSettings } from "@/src/services/settings";

/**
 * Section 8: the connected-accounts page. Shows the one mailbox v1 sends from, its
 * health, warmup progress and today's usage against the caps the send guard enforces.
 * Disconnect is deliberately absent: the plan has no disconnect flow, and removing the
 * only sending identity would be a one-way door.
 */

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ConnectedAccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const env = getEnv();
  const [accounts, settings] = await Promise.all([listAccounts(), getSettings()]);
  const today = dateOnlyInZone(new Date(), settings.timezone);

  const rows: ConnectedAccountRow[] = await Promise.all(
    accounts.map(async (account) => {
      if (account.kind !== "email") {
        return { account, usage: null, caps: null };
      }
      const usage = await getSendCounters(account.id, today);
      return { account, usage, caps: emailCapsForWarmup(account.warmupStage, settings.caps) };
    }),
  );

  const hasMailbox = rows.some((row) => row.account.kind === "email");
  const errorCode = typeof params.error === "string" ? params.error : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Connected accounts</h1>
          <p className="text-sm text-muted-foreground">
            One mailbox sends every email through Scout&apos;s own Internal OAuth app. Scout stores an encrypted refresh
            token, never a password, and replies arrive on the same account.
          </p>
        </div>
        {hasMailbox ? null : (
          <a href="/api/oauth/gmail" className={buttonVariants()}>
            Connect mailbox
          </a>
        )}
      </div>

      {env.DRY_RUN ? <DryRunBanner redirectEmail={env.DRY_RUN_REDIRECT_EMAIL || null} /> : null}

      {params.connected === "1" ? (
        <Alert>
          <AlertTitle>Mailbox connected</AlertTitle>
          <AlertDescription>
            Warmup starts now: Scout ramps from 5 to 30 new conversations a day over four weeks before it sends at full
            pace. You can watch the counters on this page.
          </AlertDescription>
        </Alert>
      ) : null}

      {errorCode ? (
        <Alert variant="destructive">
          <AlertTitle>Mailbox not connected</AlertTitle>
          <AlertDescription>{errorMessage(errorCode)}</AlertDescription>
        </Alert>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No accounts connected yet</CardTitle>
            <CardDescription>
              Connect the sending mailbox on your secondary domain. Nothing is sent until a message is approved in the
              inbox, and nothing leaves at all while <code className="text-xs">DRY_RUN</code> is on.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a href="/api/oauth/gmail" className={buttonVariants({ variant: "outline" })}>
              Connect mailbox
            </a>
          </CardContent>
        </Card>
      ) : (
        <ConnectedAccountsTable rows={rows} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>How sending stays safe</CardTitle>
          <CardDescription>Section 7 and section 9 of the plan, enforced in code rather than in prompts.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Emails go out as plain text, one at a time, only inside the recipient&apos;s sending window and under the
            mailbox&apos;s daily cap. There are no tracking pixels and no HTML.
          </p>
          <p>
            Any reply stops the sequence on every channel immediately. A hard bounce or an opt-out suppresses the address
            forever.
          </p>
          <p>
            If Google rejects the credentials, the mailbox is paused and you get an alert with a Reconnect button. Nobody
            else can sign in to Scout.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** Whitelist: an error code from the URL is never echoed back into the page. */
function errorMessage(code: string): string {
  switch (code) {
    case "not_configured":
      return "The Gmail OAuth app is not configured yet. Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET, then try again.";
    case "access_denied":
      return "Google did not grant access, so nothing was connected. Start again and accept every permission.";
    case "missing_code":
      return "Google returned no authorization code. Start the connection again.";
    case "state_mismatch":
      return "That connection attempt expired or came from a different browser. Start again from this page.";
    case "exchange_failed":
      return "Google accepted the request but the tokens could not be read. Check the server logs, then try again.";
    case "start_failed":
      return "Scout could not start the Google consent flow. Try again in a moment.";
    default:
      return "The mailbox could not be connected. Try again and check the server logs.";
  }
}
