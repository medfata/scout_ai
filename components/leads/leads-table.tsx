"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";

import type { LeadRow } from "@/app/(app)/leads/queries";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Section 4: "Dense tables and keyboard shortcuts for the approval inbox" — the leads
 * table is the dense read-only companion. TanStack Table v9 with the core features only:
 * the page filters server-side, so no client row models are needed.
 */

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, LeadRow>();

const columns = helper.columns([
  helper.accessor("fullName", {
    header: "Name",
    cell: (info) => (
      <Link className="font-medium underline-offset-2 hover:underline" href={`/leads/${info.row.original.contactId}`}>
        {info.getValue()}
      </Link>
    ),
  }),
  helper.accessor("title", { header: "Title", cell: (info) => info.getValue() ?? "—" }),
  helper.accessor("companyName", { header: "Company", cell: (info) => info.getValue() ?? "—" }),
  helper.accessor("stage", {
    header: "Stage",
    cell: (info) => <Badge variant={info.getValue() === "disqualified" ? "destructive" : "secondary"}>{info.getValue()}</Badge>,
  }),
  helper.accessor("emailStatus", {
    header: "Email",
    cell: (info) => {
      const status = info.getValue();
      return (
        <span className={status === "valid" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
          {status}
        </span>
      );
    },
  }),
  helper.accessor("tier", { header: "Tier", cell: (info) => (info.getValue() ? <Badge variant="outline">{info.getValue()}</Badge> : "—") }),
  helper.accessor("icpName", { header: "ICP", cell: (info) => info.getValue() ?? "—" }),
  helper.accessor("lastActivityAt", {
    header: "Last activity",
    cell: (info) => <span className="text-muted-foreground">{formatWhen(info.getValue())}</span>,
  }),
]);

export function LeadsTable({ rows }: { rows: LeadRow[] }) {
  const router = useRouter();
  const table = useTable({ features, columns, data: rows });

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No leads match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className="cursor-pointer"
              onClick={() => {
                router.push(`/leads/${row.original.contactId}`);
              }}
            >
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return date.toISOString().slice(0, 10);
}
