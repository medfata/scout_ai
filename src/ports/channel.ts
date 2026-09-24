import type { ChannelKind } from "@/src/domain/types";

/**
 * Port: how a message actually leaves Scout. Adapters: `gmail` (v1), `manual-linkedin`
 * (assisted tasks), `unipile` and `instantly` later. Section 12: "Each swap is
 * reversible. The Gmail and Unipile adapters implement the same Channel port, so
 * upgrading means adding one adapter and changing config."
 */

export interface OutboundMessage {
  /** Recipient address (email) or profile URL (linkedin). */
  to: string;
  subject: string | null;
  body: string;
  /** Continue an existing thread, when the step says `thread: "same"`. */
  threadId: string | null;
  /** RFC 5322 Message-ID of the message being replied to. */
  inReplyTo: string | null;
  references: string[];
  /** Display name for the From header. */
  fromName?: string;
  /** Section 7: with DRY_RUN, every send is rewritten to this address and tagged as a test. */
  dryRunRedirect?: string | null;
  /** Set by the caller when this is a test send, so the UI can mark it. */
  isTest?: boolean;
}

export interface SendResult {
  providerMessageId: string;
  threadId: string | null;
  rfcMessageId: string | null;
  sentAt: Date;
  /** True when the adapter rewrote the message for DRY_RUN. */
  redirected: boolean;
}

export interface Channel {
  readonly kind: ChannelKind;
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/** Assisted-mode channels produce a task for the owner instead of sending (section 0). */
export interface AssistedTask {
  kind: "linkedin_invite" | "linkedin_message";
  profileUrl: string;
  copy: string;
  contactId: string;
  enrollmentId: string;
  step: number;
}
