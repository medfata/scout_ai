import { isScoutError, QuotaExceededError } from "@/src/lib/errors";
import type { SignalCandidate } from "@/src/ports/lead-source";
import { recordActivity } from "@/src/services/activity";
import { collectSignalsForIcp, sourceLeadsForIcp, type SourcingSummary } from "@/src/services/sourcing";

/**
 * Phase 2 sourcing workflow. The `"use workflow"` function is deterministic: it only
 * stitches steps together; every database read, vendor call and clock read happens in a
 * `"use step"` function (section 10 rule 8).
 *
 * Steps can be replayed after a crash, so each one is idempotent at the data layer:
 * `sourceLeadsForIcp` writes through the deduplicating upserts, and re-recording an Exa
 * search only ever moves the quota counter in the safe direction (pause early, never
 * exceed — section 0). A quota stop is returned as data (`status: "paused"`) so the run
 * finishes cleanly and the daily planner can alert the owner.
 */

export type SourcingRunStatus = "ok" | "paused" | "failed";

export interface SourcingRunResult {
  status: SourcingRunStatus;
  icpId: string;
  limit: number;
  summary: SourcingSummary | null;
  signals: SignalCandidate[];
  reason: string | null;
}

export async function sourcingWorkflow(icpId: string, limit: number): Promise<SourcingRunResult> {
  "use workflow";

  const sourced = await runSourcingStep(icpId, limit);
  if (sourced.status !== "ok") return { ...sourced, signals: [] };

  const signals = await runSignalStep(icpId, limit);
  return { ...sourced, signals: signals.signals };
}

async function runSourcingStep(icpId: string, limit: number): Promise<Omit<SourcingRunResult, "signals">> {
  "use step";

  try {
    const summary = await sourceLeadsForIcp({ icpId, limit });
    return { status: "ok", icpId, limit, summary, reason: null };
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      // Section 0: "that stage pauses until the quota resets and the owner gets an
      // alert". The pause is data; the planner reads `quota.exhausted` for the alert.
      await recordActivity({
        actor: "system",
        entityType: "quota",
        entityId: icpId,
        type: "quota.exhausted",
        data: {
          resource: error.resource,
          used: error.used,
          limit: error.limit,
          period: error.period,
          stage: "sourcing",
          stop: "paused",
        },
      });
      return { status: "paused", icpId, limit, summary: null, reason: error.message };
    }

    if (isScoutError(error) && !error.retryable) {
      // Bad key, missing ICP, no source configured: a retry cannot fix it.
      return { status: "failed", icpId, limit, summary: null, reason: error.message };
    }

    // Transient (network, vendor 5xx): let the Workflow SDK retry this step.
    throw error;
  }
}

runSourcingStep.maxRetries = 2;

async function runSignalStep(icpId: string, limit: number): Promise<{ signals: SignalCandidate[] }> {
  "use step";

  try {
    return { signals: await collectSignalsForIcp({ icpId, limit: Math.min(limit, 10) }) };
  } catch (_error) {
    // Signals are a nice-to-have: never fail the sourcing run because Hacker News is
    // slow. The failure itself is already recorded by `collectSignalsForIcp`.
    return { signals: [] };
  }
}
