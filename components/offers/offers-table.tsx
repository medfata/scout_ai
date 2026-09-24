import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OfferListItem } from "@/src/services/offers";
import { formatWhen } from "./format";
import { OfferStatusBadge } from "./status-badge";

export function OffersTable({ items }: { items: OfferListItem[] }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Offer</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Proof</TableHead>
            <TableHead className="text-right">ICPs</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="text-right">Open</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map(({ offer, proofCount, icpCount, approvedIcpCount }) => (
            <TableRow key={offer.id}>
              <TableCell className="max-w-md">
                <Link href={`/offers/${offer.id}`} className="font-medium hover:underline">
                  {offer.title}
                </Link>
                <p className="line-clamp-1 text-xs text-muted-foreground">{offer.description}</p>
              </TableCell>
              <TableCell>
                <OfferStatusBadge status={offer.status} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{proofCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {icpCount}
                {approvedIcpCount > 0 ? <Badge variant="secondary" className="ml-2">{approvedIcpCount} approved</Badge> : null}
              </TableCell>
              <TableCell className="text-muted-foreground">{formatWhen(offer.updatedAt)}</TableCell>
              <TableCell className="text-right">
                <Link href={`/offers/${offer.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Open
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
