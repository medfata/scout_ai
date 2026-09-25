import { vi } from "vitest";

import type { ReconcilableChannel, ReconciledSend } from "@/src/adapters/channels";
import type * as GmailModule from "@/src/adapters/channels/gmail";
import type { ChannelKind } from "@/src/domain/types";
import { ScoutError, VendorError } from "@/src/lib/errors";
import type { OutboundMessage } from "@/src/ports/channel";

/**
 * Section 10 rule 4: "Every port has a fake." This is the in-memory `Channel`: it
 * records every `send()` and every reconciliation lookup, and it can be scripted to
 * behave like each real failure mode:
 *
 *  - `ok`        — the provider accepted the message;
 *  - `retryable` — a typed retryable failure (429, 5xx);
 *  - `ambiguous` — a plain error with no HTTP status (timeout, reset): the provider may
 *                  have accepted, so the send guard must reconcile before resending;
 *  - `rejected`  — a definite 4xx rejection: the send must be marked `failed`;
 *  - `auth`      — rejected credentials: the message returns to `approved` and the
 *                  guard blocks with `config_incomplete`.
 *
 * Installation goes through the registry's existing seam: the registry builds a channel
 * from `createGmailChannel`, and `resetChannelCache()` forgets what it built. The mock
 * below replaces that one factory (keeping every other export, including
 * `senderDomainFrom`) so `getChannel("email")` returns the installed fake. No production
 * code is touched.
 */

export type FakeChannelBehaviour =
  | { type: "ok"; providerMessageId?: string; threadId?: string | null; sentAt?: Date }
  | { type: "retryable"; message?: string }
  | { type: "ambiguous"; message?: string }
  | { type: "rejected"; status?: number; message?: string }
  | { type: "auth"; message?: string };

export type FakeReconciliation = "found" | "not_found" | ReconciledSend;

export interface FakeChannel extends ReconcilableChannel {
  /** Every outbound message the guard handed to this channel, in order. */
  readonly sendCalls: OutboundMessage[];
  /** Every `rfc822msgid:` lookup the guard made, in order. */
  readonly lookupCalls: string[];
  setBehaviour(behaviour: FakeChannelBehaviour): void;
  setReconciliation(reconciliation: FakeReconciliation): void;
}

export interface FakeChannelOptions {
  kind?: ChannelKind;
  name?: string;
  behaviour?: FakeChannelBehaviour;
  reconciliation?: FakeReconciliation;
}

export function createFakeChannel(options: FakeChannelOptions = {}): FakeChannel {
  let behaviour: FakeChannelBehaviour = options.behaviour ?? { type: "ok" };
  let reconciliation: FakeReconciliation = options.reconciliation ?? "not_found";
  const sendCalls: OutboundMessage[] = [];
  const lookupCalls: string[] = [];
  let sentCount = 0;

  return {
    kind: options.kind ?? "email",
    name: options.name ?? "fake-channel",
    sendCalls,
    lookupCalls,
    setBehaviour(next) {
      behaviour = next;
    },
    setReconciliation(next) {
      reconciliation = next;
    },
    async send(message) {
      // Copy so a later mutation of the guard's object cannot rewrite the recording.
      sendCalls.push({ ...message, references: [...message.references] });

      switch (behaviour.type) {
        case "ok": {
          sentCount += 1;
          return {
            providerMessageId: behaviour.providerMessageId ?? `provider-${sentCount}`,
            threadId: behaviour.threadId !== undefined ? behaviour.threadId : (message.threadId ?? `thread-${sentCount}`),
            rfcMessageId: message.rfcMessageId ?? `<fake-${sentCount}@scoutmail.example>`,
            sentAt: behaviour.sentAt ?? new Date(),
            redirected: Boolean(message.dryRunRedirect && message.to === message.dryRunRedirect),
          };
        }
        case "retryable":
          throw new ScoutError(behaviour.message ?? "fake rate limit", {
            code: "vendor_rate_limited",
            retryable: true,
          });
        case "ambiguous":
          // Deliberately a plain Error with no `status`/`code`: the guard must treat it
          // as "the provider may have accepted" and never resend blindly.
          throw new Error(behaviour.message ?? "socket hang up");
        case "rejected":
          throw new VendorError("gmail", behaviour.message ?? `fake rejection (${behaviour.status ?? 400})`, {
            code: "vendor_bad_request",
            status: behaviour.status ?? 400,
          });
        case "auth":
          throw new VendorError("gmail", behaviour.message ?? "credentials rejected", {
            code: "vendor_auth",
            status: 401,
          });
      }
    },
    async findSentByRfcMessageId(rfcMessageId): Promise<ReconciledSend | null> {
      lookupCalls.push(rfcMessageId);
      if (reconciliation === "found") {
        return { providerMessageId: "reconciled-1", threadId: "thread-reconciled", sentAt: new Date() };
      }
      if (reconciliation === "not_found") return null;
      return reconciliation;
    },
  };
}

const holder = vi.hoisted(() => ({ channel: null as FakeChannel | null }));

vi.mock("@/src/adapters/channels/gmail", async (importOriginal) => {
  const actual = await importOriginal<typeof GmailModule>();
  return {
    ...actual,
    createGmailChannel: () => holder.channel,
  };
});

/**
 * Points the `email` channel at `channel` and forgets the registry's cached build, so
 * the next `getChannel("email")` returns the fake. Pass `null` to remove it again.
 *
 * Other test files get the same seam by importing this module: the `vi.mock` above is
 * registered when this file is evaluated, which must happen before `sendMessage` (and
 * therefore the registry) is imported. Import order in the test file is what guarantees
 * that — keep this import above the service imports.
 */
export async function installFakeChannel(channel: FakeChannel | null): Promise<void> {
  holder.channel = channel;
  const { getChannel, resetChannelCache } = await import("@/src/adapters/channels");
  resetChannelCache();

  // Loudly refuse a late install instead of silently letting the guard talk to the real
  // adapter registry: the module mock only works when this file is evaluated before the
  // service that builds the registry.
  if (channel && getChannel(channel.kind) !== channel) {
    throw new Error(
      "tests/fakes/channel.ts was imported after the channel registry was built; move its import above the service imports in the test file.",
    );
  }
}
