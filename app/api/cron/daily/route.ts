import { NextResponse } from "next/server";
import { start } from "workflow/api";

import { getEnv } from "@/src/lib/env";
import { secureCompare } from "@/src/lib/crypto";
import { logger } from "@/src/lib/logger";
import { dailyPlannerWorkflow } from "@/src/workflows/daily-planner";

/**
 * Section 3: "One daily heartbeat. A Vercel cron starts the daily planner workflow."
 * Section 0: Vercel Hobby allows exactly one cron a day, declared in `vercel.json`.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` for a cron with a secret set. Without
 * the secret configured the route refuses to run: an unauthenticated endpoint that starts
 * outreach workflows must never be reachable.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  const env = getEnv();
  const authorization = request.headers.get("authorization") ?? "";

  if (!env.CRON_SECRET) {
    logger.error("cron.daily_unconfigured", { reason: "CRON_SECRET is not set" });
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (!secureCompare(authorization, `Bearer ${env.CRON_SECRET}`)) {
    logger.warn("cron.daily_unauthorized", {});
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const run = await start(dailyPlannerWorkflow, []);
  return NextResponse.json({ runId: run.runId });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

/** Vercel only calls GET; POST exists so a manual run is possible with the same secret. */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
