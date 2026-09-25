/**
 * Gate 3 rehearsal (section 11 phase 3): "25 leads get briefs with at least one cited signal,
 * a tier, and a draft that passes the critic."
 *
 * This script runs the REAL pipeline over the fictional golden set, with fixed briefs (no live
 * research), and prints one row per lead plus a summary:
 *
 *   score (real scorer prompt + code rules) -> tier
 *   draft + critic (real evaluator–optimizer loop, up to two revisions)
 *
 * It is owner-triggered and DRY_RUN by nature: it never calls `sendMessage`, never touches the
 * database or a mailbox, and has no send path to reach. It refuses politely without
 * `AI_GATEWAY_API_KEY` + `MODEL_COPY` (see `evals/lib/env.ts`).
 *
 * Usage:
 *   pnpm tsx scripts/gate3-run.ts
 *   pnpm tsx scripts/gate3-run.ts --limit 5
 *   pnpm tsx scripts/gate3-run.ts --only clear-fit-support-saas,disqualifier-crypto
 *
 * Output logs ids, counts, verdicts and costs only — never an address or a message body
 * (section 10 rule 11).
 */

import { parseArgs } from "node:util";

import { draftMessage } from "@/src/ai/agents/copy";
import { scoreLead } from "@/src/ai/agents/score";

import { prepareEvalEnv } from "../evals/lib/env";
import {
  GOLDEN_ANGLES,
  GOLDEN_ICP,
  GOLDEN_LEADS,
  GOLDEN_OFFER,
  GOLDEN_SIGNATURE,
  emailFirstTouchStep,
  findAngle,
  icpForScore,
  leadById,
  leadFactsFor,
  type GoldenLead,
} from "../evals/golden/leads";

const COLUMNS = { lead: 30, signals: 7, tier: 4, critic: 22 } as const;

interface Row {
  leadId: string;
  signals: number;
  tier: string;
  critic: string;
  note: string;
  pass: boolean;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}

function printTable(rows: Row[]): void {
  const header = [
    pad("lead", COLUMNS.lead),
    pad("signals", COLUMNS.signals),
    pad("tier", COLUMNS.tier),
    pad("critic", COLUMNS.critic),
    "note",
  ].join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    console.log(
      [
        pad(row.leadId, COLUMNS.lead),
        pad(String(row.signals), COLUMNS.signals),
        pad(row.tier, COLUMNS.tier),
        pad(row.critic, COLUMNS.critic),
        row.note,
      ].join(" | "),
    );
  }
}

async function runLead(lead: GoldenLead): Promise<{ row: Row; costUsd: number; eligible: boolean; passed: boolean }> {
  const signals = lead.brief.signals.length;
  const score = await scoreLead({
    contactId: `gate3:${lead.id}`,
    icpId: `gate3:${lead.id}:icp`,
    icp: icpForScore(),
    lead: leadFactsFor(lead),
    brief: lead.brief,
  });
  let costUsd = score.costUsd;

  if (score.disqualified) {
    const expected = lead.expect.disqualified !== false;
    return {
      row: {
        leadId: lead.id,
        signals,
        tier: "—",
        critic: "skipped (disqualified)",
        note: expected ? `expected: ${score.disqualifiedReason ?? "no reason"}` : `UNEXPECTED: ${score.disqualifiedReason ?? "no reason"}`,
        pass: expected,
      },
      costUsd,
      eligible: false,
      passed: expected,
    };
  }

  if (score.tier === null) {
    return {
      row: {
        leadId: lead.id,
        signals,
        tier: "—",
        critic: "not drafted (no tier)",
        note: "UNEXPECTED: non-disqualified lead without a tier",
        pass: false,
      },
      costUsd,
      eligible: true,
      passed: false,
    };
  }

  const step = emailFirstTouchStep();
  const draft = await draftMessage({
    enrollmentId: `gate3:${lead.id}:${step.key}`,
    contactId: `gate3:${lead.id}`,
    step,
    channel: step.channel,
    threadContext: null,
    offer: GOLDEN_OFFER,
    icp: { name: GOLDEN_ICP.name, angles: [...GOLDEN_ANGLES] },
    angle: findAngle("support_triage"),
    brief: lead.brief,
    recipient: { companyName: lead.company.name, contactTitle: lead.contactTitle },
    settings: {
      signature: GOLDEN_SIGNATURE.signature,
      postalAddress: GOLDEN_SIGNATURE.postalAddress,
      autonomyLevel: "L0",
    },
    tier: score.tier,
    language: lead.language,
  });
  costUsd += draft.costUsd;

  const critic = draft.verdict
    ? draft.verdict.passed
      ? `pass (${draft.attempts} attempt${draft.attempts === 1 ? "" : "s"})`
      : "FAIL"
    : "no verdict";
  const citedClaims = draft.draft?.claims.length ?? 0;
  const problems: string[] = [];
  if (signals < 1) problems.push("no cited signal");
  if (!draft.verdict?.passed) {
    const codes = (draft.verdict?.violations ?? []).map((violation) => violation.code).join(",");
    problems.push(`critic: ${codes || "needs owner"}`);
  }
  if (citedClaims < 1) problems.push("draft cites no signal");

  return {
    row: {
      leadId: lead.id,
      signals,
      tier: score.tier,
      critic,
      note: problems.length > 0 ? problems.join("; ") : `${citedClaims} claim(s), ${draft.attempts} attempt(s)`,
      pass: problems.length === 0,
    },
    costUsd,
    eligible: true,
    passed: problems.length === 0,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    console.log("Usage: pnpm tsx scripts/gate3-run.ts [--only id1,id2] [--limit N]");
    return;
  }

  const env = prepareEvalEnv();
  if (!env.ok) {
    console.error("Gate 3 needs real keys, so it did not run:");
    console.error(`  ${env.message}`);
    console.error("Nothing was sent and nothing was written.");
    process.exitCode = 1;
    return;
  }

  const requestedIds = values.only
    ?.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const limit = values.limit !== undefined ? Number.parseInt(values.limit, 10) : undefined;

  let leads = requestedIds && requestedIds.length > 0 ? requestedIds.map((id) => leadById(id)) : [...GOLDEN_LEADS];
  if (limit !== undefined && Number.isFinite(limit) && limit > 0 && limit < leads.length) {
    leads = leads.slice(0, limit);
  }

  console.log("Scout gate 3 — golden-set rehearsal (DRY_RUN: no send path is reachable from here)");
  console.log(`Leads: ${leads.length} | first-touch step: ${emailFirstTouchStep().key} | model: ${process.env.MODEL_COPY ?? "(unset)"}`);
  console.log("");

  const rows: Row[] = [];
  let costUsd = 0;
  let drafted = 0;
  let draftedPassed = 0;
  let expectedDisqualified = 0;
  let failures = 0;

  for (const lead of leads) {
    try {
      const result = await runLead(lead);
      rows.push(result.row);
      costUsd += result.costUsd;
      if (result.row.critic.startsWith("skipped")) {
        if (result.passed) expectedDisqualified += 1;
        else failures += 1;
      } else {
        drafted += 1;
        if (result.passed) draftedPassed += 1;
        else failures += 1;
      }
    } catch (error) {
      rows.push({
        leadId: lead.id,
        signals: lead.brief.signals.length,
        tier: "—",
        critic: "ERROR",
        note: error instanceof Error ? error.message.slice(0, 80) : "unknown error",
        pass: false,
      });
      failures += 1;
    }
  }

  printTable(rows);
  console.log("");
  console.log(
    `Summary: ${leads.length} golden leads | ${drafted} drafted | ${draftedPassed} passed the critic | ${expectedDisqualified} expected disqualifications | ${failures} failure(s) | est. AI cost $${costUsd.toFixed(4)}`,
  );
  const gate3Passed = failures === 0;
  console.log(
    gate3Passed
      ? "Gate 3 rehearsal: PASS on the golden set (every eligible lead had a cited signal, a tier and a critic-passing draft)."
      : "Gate 3 rehearsal: FAIL — see the notes column.",
  );
  console.log(`DRY_RUN=${process.env.DRY_RUN ?? "true"} — nothing was sent.`);

  if (!gate3Passed) process.exitCode = 1;
}

void main();
