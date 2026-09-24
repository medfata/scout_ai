import { Badge } from "@/components/ui/badge";
import type { AccountKind, AccountStatus } from "@/src/domain/types";

/**
 * Section 8, account health: `credentials`, `error` and `stopped` pause the account and
 * put a Reconnect button in front of the owner. The badge is the only place those four
 * states are turned into words.
 */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const STATUS_VARIANTS: Record<AccountStatus, BadgeVariant> = {
  ok: "default",
  credentials: "destructive",
  error: "destructive",
  stopped: "destructive",
  paused: "outline",
};

const STATUS_LABELS: Record<AccountStatus, string> = {
  ok: "Connected",
  credentials: "Needs reconnect",
  error: "Error",
  stopped: "Stopped",
  paused: "Paused",
};

const KIND_LABELS: Record<AccountKind, string> = {
  email: "Mailbox",
  linkedin: "LinkedIn",
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function AccountKindBadge({ kind }: { kind: AccountKind }) {
  return (
    <Badge variant="secondary" className="font-normal">
      {KIND_LABELS[kind]}
    </Badge>
  );
}

export function isAccountPaused(status: AccountStatus): boolean {
  return status === "credentials" || status === "error" || status === "stopped";
}
