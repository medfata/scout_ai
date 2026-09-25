import { and, count, eq, gte, inArray, sql } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import { activityEvents, sendCounters } from "@/src/db/schema";
import { dateOnlyInZone, instantForDateOnly } from "@/src/lib/time-windows";
import { QuotaExceededError } from "@/src/lib/errors";
import { getEnv } from "@/src/lib/env";
import { getSettings } from "./settings";
import { countActivity, recordActivity, sumActivityNumeric, type ActivityType } from "./activity";
import { notifyQuota } from "./notifications";
import { MONTHLY_ALLOWANCES, QUOTA_ALERT_THRESHOLD, type QuotaResource, quotaRemaining } from "@/src/domain/quotas";
import type { SendBucket } from "@/src/domain/types";

/**
 * Section 0's quotas, enforced in code. "When a quota runs out, that stage pauses until
 * the quota resets and the owner gets an alert. Scout never buys credits, upgrades a
 * plan, or switches provider on its own."
 *
 * Counting lives in `activity_events` (see `services/activity.ts`). The one exception is
 * `send_counters`, which must be updated atomically under a row lock.
 */

function startOfDay(now: Date, timeZone: string): Date {
  const dateOnly = dateOnlyInZone(now, timeZone);
  return new Date(`${dateOnly}T00:00:00Z`);
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Review item 12: when the daily cap blocks a send, the retry belongs at the start of the
 * next counter day in the owner's timezone — not "now plus twelve hours", which could land
 * in the same counter day or in the middle of the night.
 */
export function nextCounterDayStart(now: Date, timeZone: string): Date {
  const today = dateOnlyInZone(now, timeZone);
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return instantForDateOnly(tomorrow.toISOString().slice(0, 10), "00:05", timeZone);
}

// ---------------------------------------------------------------------------
// AI spend (section 9: "Daily AI spend above DAILY_AI_BUDGET_USD: stop research and
// drafting until tomorrow")
// ---------------------------------------------------------------------------

export interface AiCallRecord {
  component: string;
  model: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number;
  contactId?: string;
}

export async function recordAiCall(record: AiCallRecord): Promise<void> {
  await recordActivity({
    actor: "ai",
    entityType: "ai",
    entityId: record.component,
    type: "ai.call",
    data: {
      component: record.component,
      model: record.model,
      promptVersion: record.promptVersion ?? null,
      inputTokens: record.inputTokens ?? 0,
      outputTokens: record.outputTokens ?? 0,
      costUsd: Number(record.costUsd.toFixed(6)),
      contactId: record.contactId ?? null,
    },
  });
}

export async function dailyAiSpendUsd(now: Date = new Date()): Promise<number> {
  const { timezone } = await getSettings();
  return sumActivityNumeric({ type: "ai.call", field: "costUsd", since: startOfDay(now, timezone) });
}

export async function monthlyAiSpendUsd(now: Date = new Date()): Promise<number> {
  return sumActivityNumeric({ type: "ai.call", field: "costUsd", since: startOfMonth(now) });
}

export async function assertAiBudget(now: Date = new Date()): Promise<void> {
  const env = getEnv();
  const spent = await dailyAiSpendUsd(now);
  if (spent >= env.DAILY_AI_BUDGET_USD) {
    await recordActivity({
      actor: "system",
      entityType: "quota",
      type: "quota.exhausted",
      data: { resource: "ai_spend_usd", used: spent, limit: env.DAILY_AI_BUDGET_USD, period: "day" },
    });
    throw new QuotaExceededError("ai_spend_usd", spent, env.DAILY_AI_BUDGET_USD, "day");
  }
}

// ---------------------------------------------------------------------------
// Exa searches (section 0: 45/day, ~1,400/month)
// ---------------------------------------------------------------------------

export async function recordExaSearch(input: { query: string; count?: number; icpId?: string }): Promise<void> {
  await recordActivity({
    actor: "system",
    entityType: "quota",
    entityId: input.icpId ?? null,
    type: "exa.search",
    data: { query: input.query.slice(0, 200), count: input.count ?? 1, icpId: input.icpId ?? null },
  });
}

export async function dailyExaSearchCount(now: Date = new Date()): Promise<number> {
  const { timezone } = await getSettings();
  const rows = await countActivity({ type: "exa.search", since: startOfDay(now, timezone) });
  return rows;
}

export async function assertExaQuota(now: Date = new Date()): Promise<void> {
  const env = getEnv();
  const used = await dailyExaSearchCount(now);
  if (used >= env.DAILY_EXA_SEARCHES) {
    throw new QuotaExceededError("exa_searches", used, env.DAILY_EXA_SEARCHES, "day");
  }
  const monthly = await countActivity({ type: "exa.search", since: startOfMonth(now) });
  if (monthly >= MONTHLY_ALLOWANCES.exaSearches) {
    throw new QuotaExceededError("exa_searches", monthly, MONTHLY_ALLOWANCES.exaSearches, "month");
  }
}

// ---------------------------------------------------------------------------
// Email verifications (section 0: 23/day, 700/month across Reoon + ZeroBounce)
// ---------------------------------------------------------------------------

export async function recordVerification(input: { email: string; provider: string; status: string; contactId?: string }): Promise<void> {
  await recordActivity({
    actor: "system",
    entityType: "contact",
    entityId: input.contactId ?? null,
    type: "enrichment.email_verified",
    data: { provider: input.provider, status: input.status, count: 1 },
  });
}

export async function dailyVerificationCount(now: Date = new Date()): Promise<number> {
  const { timezone } = await getSettings();
  return countActivity({ type: "enrichment.email_verified", since: startOfDay(now, timezone) });
}

export async function assertVerificationQuota(now: Date = new Date()): Promise<void> {
  const env = getEnv();
  const used = await dailyVerificationCount(now);
  if (used >= env.DAILY_VERIFICATIONS) {
    throw new QuotaExceededError("email_verifications", used, env.DAILY_VERIFICATIONS, "day");
  }
  const monthly = await countActivity({ type: "enrichment.email_verified", since: startOfMonth(now) });
  if (monthly >= MONTHLY_ALLOWANCES.emailVerifications) {
    throw new QuotaExceededError("email_verifications", monthly, MONTHLY_ALLOWANCES.emailVerifications, "month");
  }
}

// ---------------------------------------------------------------------------
// New prospects (section 0: 5/day in quality mode, hard ceiling 12)
// ---------------------------------------------------------------------------

export async function dailyNewProspectCount(now: Date = new Date()): Promise<number> {
  const { timezone } = await getSettings();
  const settings = await getSettings();
  const created = await countActivity({ type: "lead.created", since: startOfDay(now, timezone) });
  return Math.min(created, settings.dailyNewProspectTarget * 4);
}

export async function assertNewProspectQuota(now: Date = new Date()): Promise<void> {
  const env = getEnv();
  const settings = await getSettings();
  const limit = Math.min(settings.dailyNewProspectTarget, env.MAX_DAILY_NEW_PROSPECTS);
  const used = await dailyNewProspectCount(now);
  if (used >= limit) {
    throw new QuotaExceededError("new_prospects", used, limit, "day");
  }
}

// ---------------------------------------------------------------------------
// Workflow events (section 0: 50,000/month, alert at 80%) — review item B4
// ---------------------------------------------------------------------------

/** Section 0: the Neon free plan allows 0.5 GB before storage must be pruned. */
export const DATABASE_SIZE_LIMIT_BYTES = Math.round(0.5 * 1024 ** 3);

export interface WorkflowEventUsage {
  used: number;
  limit: number;
  /** Always true today: the Workflow SDK exposes no usage counter (see the model below). */
  estimated: boolean;
}

export interface DatabaseSizeUsage {
  usedBytes: number;
  limitBytes: number;
}

/**
 * Review item B4: the Workflow SDK exposes no usage counter (its observability docs cover
 * inspecting runs, not metering, and Vercel does not hand the app a Workflow-event count),
 * so Scout estimates from the two things it does record in `activity_events`: the durable
 * runs it starts and the steps that wrote an activity row.
 *
 *   estimate = runs × 4 + logged steps × 6
 *
 * The Workflow event log charges per `step_created`/`step_started`/`step_completed` and per
 * wait, and Scout's send loop runs about five steps plus one sleep per send — but only two
 * or three of those steps write an activity row. `6` is that shape, rounded up; `4` covers
 * `run_created`/`run_started`/`run_completed` bookkeeping per run. The figure is a model,
 * not a measurement, which is why the dashboard and the digest label it an estimate.
 */
const WORKFLOW_EVENTS_PER_LOGGED_STEP = 6;
const WORKFLOW_EVENTS_PER_RUN = 4;

/** Activity types recorded once when a durable run starts (or immediately before it does). */
const WORKFLOW_RUN_MARKERS: ActivityType[] = [
  "enrollment.created",
  "research.started",
  "reply.received",
  "cron.daily_started",
];

export async function workflowEventUsage(): Promise<WorkflowEventUsage> {
  const month = startOfMonth(new Date());
  const [loggedSteps, runs] = await Promise.all([countWorkflowLoggedSteps(month), countWorkflowRuns(month)]);

  const used = loggedSteps * WORKFLOW_EVENTS_PER_LOGGED_STEP + runs * WORKFLOW_EVENTS_PER_RUN;
  const limit = MONTHLY_ALLOWANCES.workflowEvents;

  await alertOnApproachingLimit("workflow_events", used, limit);
  return { used, limit, estimated: true };
}

export async function databaseSizeUsage(): Promise<DatabaseSizeUsage> {
  const db = getDb();
  const result = await db.execute(sql`select pg_database_size(current_database()) as bytes`);
  const row = extractRows(result)[0] as { bytes: number | string } | undefined;
  const usedBytes = Number(row?.bytes ?? 0);

  await alertOnApproachingLimit("database_storage", usedBytes, DATABASE_SIZE_LIMIT_BYTES);
  return { usedBytes, limitBytes: DATABASE_SIZE_LIMIT_BYTES };
}

/** Only the two resources above are metered here; the day counters never pass through. */
type MeteredResource = Extract<QuotaResource, "workflow_events" | "database_storage">;

/**
 * Section 0: "alert at 80%", at most once a day per resource. The append-only log is the
 * only state Scout keeps for this: a `quota.warning` row for the same resource since the
 * owner's midnight means the alert already went out. The row is written before the alert,
 * so a crash between the two cannot turn into a duplicate later the same day.
 */
async function alertOnApproachingLimit(resource: MeteredResource, used: number, limit: number): Promise<void> {
  if (limit <= 0 || used / limit < QUOTA_ALERT_THRESHOLD) return;

  const { timezone } = await getSettings();
  const since = startOfDay(new Date(), timezone);
  if (await warnedToday(resource, since)) return;

  await recordActivity({
    actor: "system",
    entityType: "quota",
    type: "quota.warning",
    data: { resource, used, limit, period: "month" },
  });
  await notifyQuota(resource, used, limit, "month");
}

async function warnedToday(resource: MeteredResource, since: Date): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.type, "quota.warning"),
        gte(activityEvents.at, since),
        sql`${activityEvents.data} ->> 'resource' = ${resource}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Every `system`/`ai` row was written from inside a `"use step"` (or by the AI layer such a
 * step calls). Owner server actions record as `owner` and never run in a workflow.
 */
async function countWorkflowLoggedSteps(since: Date): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: count() })
    .from(activityEvents)
    .where(and(gte(activityEvents.at, since), inArray(activityEvents.actor, ["system", "ai"])));
  return Number(row?.value ?? 0);
}

async function countWorkflowRuns(since: Date): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: count() })
    .from(activityEvents)
    .where(and(gte(activityEvents.at, since), inArray(activityEvents.type, WORKFLOW_RUN_MARKERS)));
  return Number(row?.value ?? 0);
}

// ---------------------------------------------------------------------------
// Send counters — the one place that needs an atomic row update
// ---------------------------------------------------------------------------

export interface ConsumeSendInput {
  accountId: string;
  bucket: SendBucket;
  cap: number;
  date: string;
}

export interface ConsumeSendResult {
  ok: boolean;
  count: number;
}

/**
 * Section 7, guard rule 5: "The account's daily cap is not reached (atomic
 * `UPDATE send_counters … WHERE count < cap RETURNING`)".
 *
 * A single statement does the check and the increment, so two concurrent runs can never
 * both believe they sent the 50th email. No row returned means the cap is reached.
 */
export async function consumeSendCounter(input: ConsumeSendInput): Promise<ConsumeSendResult> {
  const db = getDb();
  const result = await db.execute(sql`
    INSERT INTO send_counters (account_id, date, bucket, count)
    VALUES (${input.accountId}, ${input.date}, ${input.bucket}, 1)
    ON CONFLICT (account_id, date, bucket)
    DO UPDATE SET count = send_counters.count + 1, updated_at = now()
    WHERE send_counters.count < ${input.cap}
    RETURNING count
  `);

  const rows = extractRows(result);
  const row = rows[0] as { count: number | string } | undefined;
  if (!row) {
    const current = await getSendCounter(input);
    return { ok: false, count: current };
  }
  return { ok: true, count: Number(row.count) };
}

export async function getSendCounter(input: Omit<ConsumeSendInput, "cap">): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sendCounters.count })
    .from(sendCounters)
    .where(
      and(
        eq(sendCounters.accountId, input.accountId),
        eq(sendCounters.date, input.date),
        eq(sendCounters.bucket, input.bucket),
      ),
    )
    .limit(1);
  return row?.count ?? 0;
}

export async function getSendCounters(accountId: string, date: string): Promise<Record<SendBucket, number>> {
  const db = getDb();
  const rows = await db
    .select({ bucket: sendCounters.bucket, count: sendCounters.count })
    .from(sendCounters)
    .where(and(eq(sendCounters.accountId, accountId), eq(sendCounters.date, date)));
  return {
    new: rows.find((row) => row.bucket === "new")?.count ?? 0,
    total: rows.find((row) => row.bucket === "total")?.count ?? 0,
  };
}

/** Rolls a counter back when a send was claimed but the provider call failed outright. */
export async function releaseSendCounter(input: ConsumeSendInput): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE send_counters
    SET count = greatest(count - 1, 0), updated_at = now()
    WHERE account_id = ${input.accountId} AND date = ${input.date} AND bucket = ${input.bucket}
  `);
}

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

export interface QuotaSnapshot {
  resource: QuotaResource;
  used: number;
  limit: number;
  period: "day" | "month";
  remaining: number;
}

export async function quotaSnapshot(now: Date = new Date()): Promise<QuotaSnapshot[]> {
  const env = getEnv();
  const settings = await getSettings();
  const day = startOfDay(now, settings.timezone);
  const month = startOfMonth(now);

  const [aiDay, exaDay, verificationsDay, exaMonth, verificationsMonth] = await Promise.all([
    sumActivityNumeric({ type: "ai.call", field: "costUsd", since: day }),
    countActivity({ type: "exa.search", since: day }),
    countActivity({ type: "enrichment.email_verified", since: day }),
    countActivity({ type: "exa.search", since: month }),
    countActivity({ type: "enrichment.email_verified", since: month }),
  ]);

  const snapshots: Array<Omit<QuotaSnapshot, "remaining">> = [
    { resource: "new_prospects", used: await dailyNewProspectCount(now), limit: Math.min(settings.dailyNewProspectTarget, env.MAX_DAILY_NEW_PROSPECTS), period: "day" },
    { resource: "ai_spend_usd", used: aiDay, limit: env.DAILY_AI_BUDGET_USD, period: "day" },
    { resource: "exa_searches", used: exaDay, limit: env.DAILY_EXA_SEARCHES, period: "day" },
    { resource: "email_verifications", used: verificationsDay, limit: env.DAILY_VERIFICATIONS, period: "day" },
    { resource: "exa_searches", used: exaMonth, limit: MONTHLY_ALLOWANCES.exaSearches, period: "month" },
    { resource: "email_verifications", used: verificationsMonth, limit: MONTHLY_ALLOWANCES.emailVerifications, period: "month" },
  ];

  return snapshots.map((snapshot) => ({ ...snapshot, remaining: quotaRemaining(snapshot) }));
}

function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown[] }).rows;
    if (Array.isArray(rows)) return rows;
  }
  return [];
}
