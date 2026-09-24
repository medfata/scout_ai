/**
 * Shared domain vocabulary. Pure data — no vendor, framework or database imports
 * (section 10 rule 3). Everything here is serialisable and testable in isolation.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Company headcount bands. The exact set is fixed by the plan's Icp schema. */
export const SIZE_BANDS = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;
export type SizeBand = (typeof SIZE_BANDS)[number];

export const CHANNELS = ["email", "linkedin"] as const;
export type ChannelKind = (typeof CHANNELS)[number];

export const DIRECTIONS = ["outbound", "inbound"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * `unknown`  — never checked.
 * `valid`    — safe to cold-email (section 9: "send only to valid").
 * `catch_all`— domain accepts anything; goes LinkedIn-first (section 9).
 * `invalid`  — hard fail; never send, suppress the address.
 */
export const EMAIL_STATUSES = ["unknown", "valid", "catch_all", "invalid", "risky", "disposable"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const TIERS = ["A", "B", "C"] as const;
export type Tier = (typeof TIERS)[number];

/** Enrollment lifecycle (section 5). Transitions live in `enrollment.ts`. */
export const ENROLLMENT_STATUSES = [
  "drafted",
  "pending_approval",
  "active",
  "waiting",
  "replied",
  "stopped",
  "completed",
  "skipped",
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/** Contact stage, moved separately from enrollment status (section 5). */
export const CONTACT_STAGES = [
  "new",
  "researched",
  "qualified",
  "disqualified",
  "contacted",
  "replied",
  "interested",
  "meeting",
  "won",
  "lost",
] as const;
export type ContactStage = (typeof CONTACT_STAGES)[number];

export const MESSAGE_STATUSES = [
  "drafted",
  "pending_approval",
  "approved",
  "sending",
  "sent",
  "failed",
  "skipped",
  "received",
  "cancelled",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Reply classification labels (section 6). */
export const REPLY_INTENTS = [
  "interested",
  "meeting_request",
  "question",
  "referral",
  "not_now",
  "not_interested",
  "unsubscribe",
  "out_of_office",
  "bounce",
  "auto_reply",
  "other",
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

/** Intents that count as a positive signal for the learning loop (section 11). */
export const POSITIVE_INTENTS = ["interested", "meeting_request", "question", "referral"] as const satisfies readonly ReplyIntent[];

/** Intents that are not written by a human and must not stop a sequence by themselves. */
export const NON_HUMAN_INTENTS = [
  "out_of_office",
  "bounce",
  "auto_reply",
] as const satisfies readonly ReplyIntent[];

export const AUTONOMY_LEVELS = ["L0", "L1", "L2"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const ACTORS = ["system", "owner", "ai"] as const;
export type Actor = (typeof ACTORS)[number];

export const OFFER_STATUSES = ["draft", "active", "archived"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const ICP_STATUSES = ["proposed", "approved", "paused", "archived"] as const;
export type IcpStatus = (typeof ICP_STATUSES)[number];

export const LINKEDIN_MODES = ["assisted", "automated"] as const;
export type LinkedinMode = (typeof LINKEDIN_MODES)[number];

export const ACCOUNT_KINDS = ["email", "linkedin"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/**
 * Account health (section 8). `credentials`, `error` and `stopped` pause the account
 * and alert the owner with a Reconnect button.
 */
export const ACCOUNT_STATUSES = ["ok", "credentials", "error", "stopped", "paused"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const SUPPRESSION_KINDS = ["email", "domain", "linkedin"] as const;
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number];

export const LEARNING_SCOPES = ["global", "icp"] as const;
export type LearningScope = (typeof LEARNING_SCOPES)[number];

/** Buckets in `send_counters`: first-touch sends vs. everything sent that day. */
export const SEND_BUCKETS = ["new", "total"] as const;
export type SendBucket = (typeof SEND_BUCKETS)[number];

// ---------------------------------------------------------------------------
// Structured payloads
// ---------------------------------------------------------------------------

export interface Angle {
  key: string;
  hook: string;
}

export interface IcpScores {
  /** 1–5 each, per the ICP ranking criteria in section 6. */
  pain: number;
  budget: number;
  reach: number;
  proofFit: number;
  speed: number;
}

export interface ApollloSearchFilters {
  person_titles: string[];
  person_locations: string[];
  organization_industries: string[];
  organization_num_employees_ranges: string[];
  person_not_titles?: string[];
}

export interface ExaSearchFilters {
  query: string;
  criteria: string[];
}

/** Provider-specific filters, built by adapters — never by the model (section 6). */
export interface IcpSearchFilters {
  apollo?: ApollloSearchFilters;
  exa?: ExaSearchFilters;
}

export interface ProofItem {
  label: string;
  detail: string;
  url?: string;
}

export interface ResearchSignal {
  fact: string;
  url: string;
  date?: string;
}

export interface ResearchHook {
  text: string;
  signalIndex: number;
}

export interface DraftClaim {
  text: string;
  signalIndex: number;
}

export interface SendingWindow {
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  /** Local time in the recipient's (or owner's) timezone, "HH:MM". */
  start: string;
  end: string;
}

export interface SendingWindows {
  email: SendingWindow;
  linkedin: SendingWindow;
}

export interface Caps {
  /** First-touch emails per mailbox per day, after warmup. */
  emailNew: number;
  /** All email sends per mailbox per day, after warmup. */
  emailTotal: number;
  /** LinkedIn invites per day in automated mode. */
  linkedinInvites: number;
  /** LinkedIn messages per day in automated mode. */
  linkedinMessages: number;
  linkedinProfileLookups: number;
}

export interface ReferralDetails {
  name: string;
  email?: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// Lead events — the only thing that may interrupt a sleeping sequence
// ---------------------------------------------------------------------------

export type LeadEvent =
  | { type: "reply"; intent: ReplyIntent; messageId?: string; returnDate?: string }
  | { type: "accepted"; at: string }
  | { type: "ooo"; returnDate?: string }
  | { type: "bounce"; kind: "hard" | "soft" }
  | { type: "optout" };

export type LeadEventType = LeadEvent["type"];

/** What the sequence workflow does after an event. */
export type EventDecision =
  | { action: "stop"; reason: string }
  /** `notBefore` is a date-only string ("YYYY-MM-DD"); the caller turns it into an instant. */
  | { action: "reschedule"; notBefore: string; reason: string }
  | { action: "continue"; reason: string };

/** Reasons a step is skipped, recorded on the message row and in `activity_events`. */
export type SkipReason =
  | "no_valid_email"
  | "no_linkedin_url"
  | "suppressed"
  | "invite_not_accepted"
  | "step_abandoned"
  | "linkedin_not_available"
  | "lead_replied"
  | "quota_exhausted";

export interface LeadContext {
  contactId: string;
  email: string | null;
  emailStatus: EmailStatus;
  linkedinUrl: string | null;
  inviteAccepted: boolean;
  inviteSentAt: string | null;
  enrollmentStartedAt: string;
}
