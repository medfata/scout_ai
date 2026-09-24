import { start } from "workflow/api";

import { getDb } from "@/src/db/client";
import { icps, leadScores } from "@/src/db/schema";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import type { Digest } from "@/src/ports/notifier";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { recordActivity } from "@/src/services/activity";
import { sourceLeadsForIcp } from "@/src/services/sourcing";
import { sendDigest } from "@/src/services/notifications";
import { dailyNewProspectCount, quotaSnapshot } from "@/src/services/quota";
import { getSettings } from "@/src/services/settings";
import { listEnrollmentsForApproval } from "@/src/services/enrollment";
import { researchAndDraftWorkflow } from "./research";

/**
 * Section 3: "One daily heartbeat. A Vercel cron starts the daily planner workflow:
 * allocate budget, source, research, draft, then send the owner a morning digest."
 *
 * Phase 7 replaces the allocation step with the Thompson-sampling allocator. Until there
 * is reply data to learn from, the budget is split evenly across approved ICPs, which is
 * the honest starting point rather than a fake optimiser.
 */

export interface DailyPlanResult {
  date: string;
  budget: number;
  icps: Array<{ icpId: string; name: string; allocated: number; created: number; deduped: number; suppressed: number }>;
  researchRuns: string[];
  errors: string[];
}

export async function dailyPlannerWorkflow(): Promise<DailyPlanResult> {
  "use workflow";

  const plan = await planDayStep();
  const sourced = await sourceStep(plan.allocations);
  const researchRuns = await researchStep(sourced.created);
  await digestStep({ plan: { ...plan, allocations: sourced.allocations }, researchRuns });
  return {
    date: plan.date,
    budget: plan.budget,
    icps: sourced.allocations,
    researchRuns,
    errors: [...plan.errors, ...sourced.errors],
  };
}

interface Allocation {
  icpId: string;
  name: string;
  allocated: number;
  created: number;
  deduped: number;
  suppressed: number;
}

interface DayPlan {
  date: string;
  budget: number;
  allocations: Allocation[];
  errors: string[];
}

async function planDayStep(): Promise<DayPlan> {
  "use step";

  const env = getEnv();
  const settings = await getSettings();
  const date = new Date().toISOString().slice(0, 10);
  const errors: string[] = [];

  const alreadyCreated = await dailyNewProspectCount();
  const budget = Math.max(0, Math.min(settings.dailyNewProspectTarget, env.MAX_DAILY_NEW_PROSPECTS) - alreadyCreated);

  await recordActivity({
    actor: "system",
    entityType: "cron",
    entityId: date,
    type: "cron.daily_started",
    data: { budget, alreadyCreated },
  });

  const db = getDb();
  const approved = await db
    .select({ id: icps.id, name: icps.name, offerId: icps.offerId, rank: icps.rank })
    .from(icps)
    .where(eq(icps.status, "approved"))
    .orderBy(desc(icps.rank));

  if (approved.length === 0) {
    errors.push("No approved ICPs. Approve at least one in Offers & ICPs before the planner can source.");
    return { date, budget: 0, allocations: [], errors };
  }

  if (budget === 0) {
    return { date, budget: 0, allocations: [], errors };
  }

  // Even split, remainder to the highest-ranked ICPs. Phase 7 swaps this for the allocator.
  const per = Math.floor(budget / approved.length);
  let remainder = budget - per * approved.length;
  const allocations: Allocation[] = approved.map((icp) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { icpId: icp.id, name: icp.name, allocated: per + extra, created: 0, deduped: 0, suppressed: 0 };
  });

  return { date, budget, allocations, errors };
}

async function sourceStep(allocations: Allocation[]): Promise<{ allocations: Allocation[]; created: Array<{ contactId: string; icpId: string }>; errors: string[] }> {
  "use step";

  const created: Array<{ contactId: string; icpId: string }> = [];
  const errors: string[] = [];

  for (const allocation of allocations) {
    if (allocation.allocated <= 0) continue;
    try {
      const summary = await sourceLeadsForIcp({ icpId: allocation.icpId, limit: allocation.allocated });
      allocation.created = summary.created;
      allocation.deduped = summary.deduped;
      allocation.suppressed = summary.suppressed;
      created.push(...summary.createdContacts.map((contact) => ({ contactId: contact.contactId, icpId: allocation.icpId })));
    } catch (error) {
      const message = error instanceof Error ? error.message : "sourcing_failed";
      logger.warn("planner.source_failed", { icpId: allocation.icpId, reason: message });
      errors.push(`${allocation.name}: ${message}`);
    }
  }

  return { allocations, created, errors };
}

async function researchStep(created: Array<{ contactId: string; icpId: string }>): Promise<string[]> {
  "use step";

  const runs: string[] = [];
  for (const item of created) {
    const run = await start(researchAndDraftWorkflow, [item.contactId, item.icpId]);
    runs.push(run.runId);
  }
  return runs;
}

async function digestStep(input: {
  plan: { date: string; budget: number; allocations: Allocation[] };
  researchRuns: string[];
}): Promise<void> {
  "use step";

  const settings = await getSettings();
  const [quotas, pending, tierCounts] = await Promise.all([
    quotaSnapshot(),
    listEnrollmentsForApproval(200),
    tierCountsToday(),
  ]);

  const sections: Digest["sections"] = [];

  sections.push({
    heading: "Today",
    lines: [
      `New prospects planned: ${input.plan.budget}`,
      ...input.plan.allocations
        .filter((allocation) => allocation.allocated > 0)
        .map((allocation) => `  ${allocation.name}: ${allocation.created} new, ${allocation.deduped} duplicates, ${allocation.suppressed} suppressed`),
      `Research and drafting runs started: ${input.researchRuns.length}`,
      `Tier A/B/C today: ${tierCounts.A}/${tierCounts.B}/${tierCounts.C}`,
    ],
  });

  sections.push({
    heading: "Waiting for you",
    lines: pending.length === 0 ? ["Nothing needs approval."] : [`${pending.length} message(s) in the inbox.`],
  });

  sections.push({
    heading: "Quota",
    lines: quotas.map((quota) => `${quota.resource} (${quota.period}): ${format(quota.used)}/${format(quota.limit)}`),
  });

  await sendDigest({ date: input.plan.date, sections });

  await recordActivity({
    actor: "system",
    entityType: "cron",
    entityId: input.plan.date,
    type: "cron.daily_finished",
    data: { budget: input.plan.budget, pending: pending.length, timezone: settings.timezone },
  });
}

async function tierCountsToday(): Promise<{ A: number; B: number; C: number }> {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ tier: leadScores.tier, value: sql<number>`count(*)::int` })
    .from(leadScores)
    .where(and(gte(leadScores.createdAt, since), inArray(leadScores.tier, ["A", "B", "C"])))
    .groupBy(leadScores.tier);
  return {
    A: Number(rows.find((row) => row.tier === "A")?.value ?? 0),
    B: Number(rows.find((row) => row.tier === "B")?.value ?? 0),
    C: Number(rows.find((row) => row.tier === "C")?.value ?? 0),
  };
}

function format(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toFixed(4);
}
