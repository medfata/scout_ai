import type { ReplyIntent } from "@/src/domain/types";

/**
 * Serializable shape the replies page passes to its table. The summary is the classifier's
 * own field (section 6's `ReplyLabel`), never the message body — section 10 rule 11 keeps
 * full bodies out of places that do not need them.
 */

export interface ReplyRow {
  messageId: string;
  contactId: string;
  contactName: string;
  /** Null until the reply workflow classifies it; guard rule 4 blocks sends meanwhile. */
  intent: ReplyIntent | null;
  summary: string | null;
  /** ISO instant, or null when the provider gave no date. */
  receivedAt: string | null;
  /** Latest `reply.suggested` event body, read from `activity_events` if one exists. */
  suggestedReply: string | null;
}
