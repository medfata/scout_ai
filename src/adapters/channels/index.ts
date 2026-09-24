import type { ChannelKind } from "@/src/domain/types";
import type { Channel } from "@/src/ports/channel";
import { logger } from "@/src/lib/logger";
import { createGmailChannel } from "./gmail";
import { createManualLinkedinChannel } from "./manual-linkedin";

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

/** Test seam: forgets constructed channels so a test can swap in a fake. */
export function resetChannelCache(): void {
  cache.clear();
}
