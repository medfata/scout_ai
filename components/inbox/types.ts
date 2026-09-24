import type { ChannelKind, EnrollmentStatus, Tier } from "@/src/domain/types";

/**
 * Serializable shape the inbox page passes to the client component. Nothing here is a
 * model or database handle, so the approval queue can be edited with keyboard shortcuts
 * without a round trip until the owner acts.
 */

export interface InboxViolation {
  code: string;
  message: string;
  severity: "error" | "warning";
}

/** Result shape shared by the approval server actions and the client queue. */
export interface InboxActionResult {
  ok: boolean;
  error?: string;
}

export interface InboxSignal {
  fact: string;
  url: string;
  date?: string;
}

export interface InboxRow {
  messageId: string;
  enrollmentId: string;
  enrollmentStatus: EnrollmentStatus;
  contactId: string;
  contactName: string;
  contactTitle: string | null;
  contactEmail: string | null;
  companyName: string | null;
  companyDomain: string | null;
  linkedinUrl: string | null;
  channel: ChannelKind;
  step: number;
  stepKey: string | null;
  /** Drives the first-touch word limit and the "no links" rule in the live code checks. */
  isFirstTouch: boolean;
  subject: string | null;
  body: string;
  needsOwner: boolean;
  angle: string | null;
  angleKeys: string[];
  icpName: string | null;
  tier: Tier | null;
  score: number | null;
  scoreReasons: string[];
  briefSummary: string | null;
  signals: InboxSignal[];
  likelyPains: string[];
  aiOpportunity: string | null;
  confidence: "low" | "medium" | "high" | null;
  claims: { text: string; signalIndex: number }[];
  /** The verdict recorded when the draft was written; null for pre-phase-3 rows. */
  verdict: { passed: boolean; criticPassed: boolean; fix: string | null } | null;
  /** Critic + code violations merged at draft time, deduped by code. */
  violations: InboxViolation[];
  /** Code checks re-run against the exact stored body (deterministic, no model call). */
  codeViolations: InboxViolation[];
  proofCount: number;
  wordLimit: number | null;
  charLimit: number | null;
  signature: string;
  postalAddress: string;
}
