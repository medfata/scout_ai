import { requireOwner } from "@/src/lib/session";

import { ApprovalQueue } from "@/components/inbox/approval-queue";
import { loadInboxRows } from "./queries";

/**
 * Section 5: the approval inbox. The page is a server component; every mutation goes
 * through the server actions in `./actions.ts`, each of which re-checks the owner session.
 */

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  await requireOwner();
  const rows = await loadInboxRows();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approval inbox</h1>
        <p className="text-sm text-muted-foreground">
          Nothing sends until you approve it. Section 9&apos;s autonomy level decides what can skip this queue.
        </p>
      </header>
      <ApprovalQueue rows={rows} />
    </div>
  );
}
