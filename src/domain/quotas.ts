import type { Caps } from "@/src/domain/types";

/**
 * Section 0's free-tier quotas and section 7's pacing table, as pure functions.
 * The service layer supplies the counters; this file only decides what the numbers
 * mean, so every quota rule is testable without a database.
 */

/** Section 7: "5 → 10 → 20 → 30 over 4 weeks". Index 0 is warmup week 1. */
export const WARMUP_RAMP = [5, 10, 20, 30] as const;

/** After the ramp, a mailbox may start 30 new conversations and send 50 emails a day. */
export const STEADY_STATE_NEW_CAP = 30;
export const STEADY_STATE_TOTAL_CAP = 50;

export interface EmailCaps {
  newConversations: number;
  totalSends: number;
}

/**
 * Caps for a mailbox on a given warmup week (1-based).
 * Week 1: 5/5, week 2: 10/10, week 3: 20/20, week 4: 30/30, week 5+: 30/50.
 * `caps` comes from settings so the owner can lower (never silently raise) them.
 */
export function emailCapsForWarmup(week: number, caps: Caps): EmailCaps {
  const ramped = WARMUP_RAMP[Math.min(Math.max(week, 1), WARMUP_RAMP.length) - 1] ?? STEADY_STATE_NEW_CAP;
  const isSteadyState = week > WARMUP_RAMP.length;
  return {
    newConversations: Math.min(ramped, caps.emailNew),
    totalSends: isSteadyState ? Math.min(caps.emailTotal, caps.emailTotal) : Math.min(ramped, caps.emailTotal),
  };
}

export function warmupWeekFor(stage: number): number {
  return Math.max(1, Math.min(stage, WARMUP_RAMP.length + 1));
}

export function isWarmupComplete(stage: number): boolean {
  return stage > WARMUP_RAMP.length;
}

/** Section 0: "5 (quality mode), never above 12". */
export function dailyNewProspectQuota(configured: number, hardMax: number): number {
  return Math.max(0, Math.min(configured, hardMax));
}

// ---------------------------------------------------------------------------
// Monthly allowances (section 0)
// ---------------------------------------------------------------------------

export const MONTHLY_ALLOWANCES = {
  newProspects: 100,
  emailsSent: 1050,
  linkedinInvites: 200,
  exaSearches: 1400,
  emailVerifications: 700,
  aiSpendUsd: 5,
  workflowEvents: 50_000,
} as const;

/** Section 0: "alert at 80%" for workflow events and database storage. */
export const QUOTA_ALERT_THRESHOLD = 0.8;

export type QuotaResource =
  | "exa_searches"
  | "email_verifications"
  | "ai_spend_usd"
  | "new_prospects"
  | "emails_sent"
  | "linkedin_invites"
  /** Section 0: 50,000 Workflow events a month, "alert at 80%" (review item B4). */
  | "workflow_events"
  /** Section 0: 0.5 GB Neon database, "alert at 80%" (review item B4). */
  | "database_storage";

export interface QuotaUsage {
  resource: QuotaResource;
  used: number;
  limit: number;
  /** Daily limits reset at midnight; monthly ones at the start of the month. */
  period: "day" | "month";
}

export function quotaRemaining(usage: QuotaUsage): number {
  return Math.max(0, usage.limit - usage.used);
}

export function isQuotaExhausted(usage: QuotaUsage): boolean {
  return usage.used >= usage.limit;
}

export function shouldAlertOnQuota(usage: QuotaUsage): boolean {
  if (usage.limit === 0) return false;
  return usage.used / usage.limit >= QUOTA_ALERT_THRESHOLD;
}

/**
 * Section 0: "When a quota runs out, that stage pauses until the quota resets and the
 * owner gets an alert. Scout never buys credits, upgrades a plan, or switches provider
 * on its own." The stage is named so the pause is visible in the UI and the digest.
 */
export type Stage = "sourcing" | "research" | "drafting" | "sending" | "linkedin_tasks" | "verification";

export function stageForResource(resource: QuotaResource): Stage {
  switch (resource) {
    case "exa_searches":
      return "sourcing";
    case "email_verifications":
      return "verification";
    case "ai_spend_usd":
      return "research";
    case "new_prospects":
      return "sourcing";
    case "emails_sent":
      return "sending";
    case "linkedin_invites":
      return "linkedin_tasks";
    case "workflow_events":
      // The durable sequencer is the main consumer of workflow events, so sending is the
      // stage that stalls when the monthly allowance is gone.
      return "sending";
    case "database_storage":
      // Storage fills up with sourced raw payloads, which section 0 prunes when the
      // warning threshold is crossed.
      return "sourcing";
  }
}

export function humanQuotaName(resource: QuotaResource): string {
  switch (resource) {
    case "exa_searches":
      return "Exa searches";
    case "email_verifications":
      return "email verifications";
    case "ai_spend_usd":
      return "AI spend";
    case "new_prospects":
      return "new prospects today";
    case "emails_sent":
      return "emails sent today";
    case "linkedin_invites":
      return "LinkedIn invites";
    case "workflow_events":
      return "workflow events";
    case "database_storage":
      return "database storage";
  }
}
