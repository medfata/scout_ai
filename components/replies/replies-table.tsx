import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { POSITIVE_INTENTS, type ReplyIntent } from "@/src/domain/types";
import type { ReplyRow } from "./types";

/**
 * Section 7's reply surface: who replied, how the classifier read it, and the summary it
 * wrote. Nothing here sends — suggested replies are drafts from `activity_events`, shown
 * collapsed so they cannot be mistaken for an editor.
 */

const POSITIVE = new Set<string>(POSITIVE_INTENTS);
const NEGATIVE = new Set<string>(["unsubscribe", "not_interested", "bounce"]);

export function RepliesTable({ rows }: { rows: ReplyRow[] }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Contact</TableHead>
            <TableHead>Intent</TableHead>
            <TableHead>Received</TableHead>
            <TableHead>Summary</TableHead>
            <TableHead className="text-right">Lead</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.messageId}>
              <TableCell className="font-medium">{row.contactName}</TableCell>
              <TableCell>
                <IntentBadge intent={row.intent} />
              </TableCell>
              <TableCell className="text-muted-foreground">{formatInstant(row.receivedAt)}</TableCell>
              <TableCell className="max-w-[34rem] whitespace-normal">
                {row.summary ? (
                  <p>{row.summary}</p>
                ) : (
                  <p className="text-muted-foreground">
                    {row.intent ? "No summary stored." : "Not classified yet — Scout is blocking further sends."}
                  </p>
                )}
                {row.suggestedReply ? (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Suggested reply (draft only, never sent)
                    </summary>
                    <pre className="mt-1 font-sans text-xs whitespace-pre-wrap text-muted-foreground">
                      {row.suggestedReply}
                    </pre>
                  </details>
                ) : null}
              </TableCell>
              <TableCell className="text-right">
                <Link className="text-sm underline underline-offset-2" href={`/leads/${row.contactId}`}>
                  Open lead
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function IntentBadge({ intent }: { intent: ReplyIntent | null }) {
  if (!intent) return <Badge variant="outline">unclassified</Badge>;
  const variant = POSITIVE.has(intent) ? "default" : NEGATIVE.has(intent) ? "destructive" : "secondary";
  return <Badge variant={variant}>{intent.replace(/_/g, " ")}</Badge>;
}

function formatInstant(value: string | null): string {
  if (!value) return "—";
  return `${value.slice(0, 16).replace("T", " ")} UTC`;
}
