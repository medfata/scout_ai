/**
 * Port: how the owner hears about something. v1 uses Telegram; the daily digest goes by
 * email through the sending mailbox (section 4).
 */

export type AlertKind =
  | "reply_hot"
  | "reply_normal"
  | "account_status"
  | "quota"
  | "circuit_breaker"
  | "error"
  | "digest";

export interface Alert {
  kind: AlertKind;
  title: string;
  body: string;
  /** Deep link into Scout, e.g. `/replies?contact=<id>`. */
  url?: string;
  contactId?: string;
  /** Machine-readable extras, kept small. Never includes message bodies. */
  data?: Record<string, unknown>;
}

export interface Notifier {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

/** The digest aggregates a day of work into one message (section 3, daily heartbeat). */
export interface DigestSection {
  heading: string;
  lines: string[];
}

export interface Digest {
  date: string;
  sections: DigestSection[];
}
