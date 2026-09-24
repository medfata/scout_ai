import { Badge } from "@/components/ui/badge";
import type { IcpStatus, OfferStatus } from "@/src/domain/types";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const OFFER_VARIANTS: Record<OfferStatus, BadgeVariant> = {
  active: "default",
  draft: "secondary",
  archived: "outline",
};

export function OfferStatusBadge({ status }: { status: OfferStatus }) {
  return <Badge variant={OFFER_VARIANTS[status]}>{status}</Badge>;
}

const ICP_VARIANTS: Record<IcpStatus, BadgeVariant> = {
  proposed: "secondary",
  approved: "default",
  paused: "outline",
  archived: "outline",
};

export function IcpStatusBadge({ status }: { status: IcpStatus }) {
  return <Badge variant={ICP_VARIANTS[status]}>{status}</Badge>;
}
