import { getNotifiers } from "@/src/adapters/notify";
import type { ConnectedAccount } from "@/src/db/schema";
import { humanQuotaName, type QuotaResource } from "@/src/domain";
import { logger } from "@/src/lib/logger";
import type { Alert, Digest } from "@/src/ports/notifier";

/**
 * Section 3: the daily heartbeat ends with "the owner a morning digest"; section 8:
 * a paused account "alerts the owner with a Reconnect button"; section 9: circuit
 * breakers and quota exhaustion alert.
 *
 * One rule holds this file together: **an alert failure must never break a workflow**.
 * `notifyOwner` resolves the configured notifiers, catches everything and returns.
 * Notifiers only see `Alert` data — never a message body, an address or a token.
 */

export async function notifyOwner(alert: Alert): Promise<void> {
  let notifiers: ReturnType<typeof getNotifiers> = [];
  try {
    notifiers = getNotifiers();
  } catch (error) {
    logger.error("notify.config_failed", { kind: alert.kind, reason: reasonOf(error) });
    return;
  }

  if (notifiers.length === 0) {
    logger.warn("notify.no_channel", { kind: alert.kind });
    return;
  }

  await Promise.all(
    notifiers.map(async (notifier) => {
      try {
        await notifier.send(alert);
      } catch (error) {
        logger.error("notify.failed", { kind: alert.kind, notifier: notifier.name, reason: reasonOf(error) });
      }
    }),
  );
}

/**
 * Section 0: "When a quota runs out, that stage pauses until the quota resets and the
 * owner gets an alert." Called at the warning threshold and at exhaustion.
 */
export async function notifyQuota(
  resource: QuotaResource,
  used: number,
  limit: number,
  period: "day" | "month" = "day",
): Promise<void> {
  const name = humanQuotaName(resource);
  const exhausted = used >= limit;
  await notifyOwner({
    kind: "quota",
    title: exhausted ? `Quota reached: ${name}` : `Quota warning: ${name}`,
    body: exhausted
      ? `Scout used ${formatNumber(used)} of ${formatNumber(limit)} ${name} this ${period} and paused the stage until it resets. Scout never buys credits or upgrades a plan on its own.`
      : `Scout has used ${formatNumber(used)} of ${formatNumber(limit)} ${name} this ${period}.`,
    url: "/dashboard",
    data: { resource, used, limit, period },
  });
}

/**
 * Section 8, account health. The account handle is deliberately not included: the owner
 * has one mailbox in v1, and addresses are not written to notification logs or chats
 * (section 10 rule 11).
 */
export async function notifyAccountStatus(account: ConnectedAccount, detail: string): Promise<void> {
  const paused = account.status === "credentials" || account.status === "error" || account.status === "stopped";
  await notifyOwner({
    kind: "account_status",
    title: paused
      ? `${capitalize(account.provider)} ${account.kind} account paused`
      : `${capitalize(account.provider)} ${account.kind} account reconnected`,
    body: detail,
    // Section 8: "alerts the owner with a Reconnect button" — the page renders one.
    url: "/settings/connected-accounts",
    data: { accountId: account.id, provider: account.provider, kind: account.kind, status: account.status },
  });
}

/**
 * Section 3: one daily heartbeat. The email half of the digest waits for phase 5; for v1
 * the digest goes to the configured notifier (Telegram). Missing config is not an error:
 * it logs a warning and returns so the daily planner can finish.
 */
export async function sendDigest(digest: Digest): Promise<void> {
  const lines: string[] = [];
  for (const section of digest.sections) {
    lines.push(section.heading);
    lines.push(...section.lines.map((line) => `• ${line}`));
    lines.push("");
  }

  await notifyOwner({
    kind: "digest",
    title: `Scout daily digest — ${digest.date}`,
    body: lines.join("\n").trimEnd(),
    url: "/dashboard",
    data: { date: digest.date },
  });
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
