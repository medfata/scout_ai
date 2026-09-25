import type { ChannelKind } from "@/src/domain/types";
import type { Channel } from "@/src/ports/channel";
import { logger } from "@/src/lib/logger";
import { createGmailChannel, type ReconcilableChannel } from "./gmail";
import { createManualLinkedinChannel } from "./manual-linkedin";

export type { ReconciledSend, ReconcilableChannel } from "./gmail";
export { senderDomainFrom } from "./gmail";

/**
 * The channel registry. `sendMessage` resolves a channel through here and never imports a
 * vendor directly (section 3, ports and adapters).
 *
 * Section 12: "The Gmail and Unipile adapters implement the same Channel port, so
 * upgrading means adding one adapter and changing config." Adding one is a one-line edit
 * to `REGISTRY` below.
 */

type ChannelFactory = () => Channel | null;

const REGISTRY: Record<ChannelKind, ChannelFactory> = {
  email: createGmailChannel,
  linkedin: createManualLinkedinChannel,
};

const cache = new Map<ChannelKind, Channel>();

export function getChannel(kind: ChannelKind): Channel | null {
  const cached = cache.get(kind);
  if (cached) return cached;

  const factory = REGISTRY[kind];
  if (!factory) return null;

  try {
    const channel = factory();
    if (channel) cache.set(kind, channel);
    return channel;
  } catch (error) {
    // A missing key or an unconnected account is a configuration state, not a crash:
    // the inbox shows the account as disconnected and the send guard blocks.
    logger.warn("channel.unavailable", { kind, reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

/**
 * Review item 8: only channels that can look a send up by RFC 5322 Message-ID may take
 * part in reconciliation. The guard uses this narrowing instead of guessing, so a
 * message stuck in `sending` on a channel that cannot be searched is never blind-retried.
 */
export function getReconcilableChannel(kind: ChannelKind): ReconcilableChannel | null {
  const channel = getChannel(kind);
  if (!channel) return null;
  const candidate = channel as Partial<ReconcilableChannel>;
  return typeof candidate.findSentByRfcMessageId === "function" ? (channel as ReconcilableChannel) : null;
}

/** Test seam: forgets constructed channels so a test can swap in a fake. */
export function resetChannelCache(): void {
  cache.clear();
}
