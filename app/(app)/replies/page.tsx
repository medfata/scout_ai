import Link from "next/link";

import { RepliesTable } from "@/components/replies/replies-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOwner } from "@/src/lib/session";
import { loadReplyRows } from "./queries";

/**
 * Section 10: `(app)/replies`. Honest stub: it shows the classified replies that exist
 * today, or explains what has to be connected before any can. No suggested-reply editor —
 * section 7 says the owner answers humans, and a suggestion is a draft, not a send.
 */

export const dynamic = "force-dynamic";

export default async function RepliesPage() {
  await requireOwner();
  const rows = await loadReplyRows();

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Replies</h1>
        <p className="text-sm text-muted-foreground">
          Section 7: any human reply stops that lead&apos;s enrollment on every channel. Scout classifies the reply and
          alerts you; it never answers a person on its own.
        </p>
      </header>

      {rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No replies yet</CardTitle>
            <CardDescription>
              Replies appear here once the Gmail push path is connected: Scout registers <code className="text-xs">users.watch</code>{" "}
              on the sending mailbox, stores each inbound message and classifies its intent. Nothing has arrived so far.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              If you expected a reply, check the mailbox connection first — an account with a broken status is paused
              and alerts you.
            </p>
            <Link className="underline underline-offset-2" href="/settings/connected-accounts">
              Open connected accounts
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {rows.length} inbound message{rows.length === 1 ? "" : "s"}, newest first. Bounces, auto-replies and
            out-of-office notices are labelled; they do not stop a sequence by themselves.
          </p>
          <RepliesTable rows={rows} />
        </>
      )}
    </div>
  );
}
