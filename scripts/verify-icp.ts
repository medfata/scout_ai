/**
 * Phase 1 spike (section 10 rule 2, section 11 phase 1): run the ICP generator and its
 * critic once against the real AI Gateway, then print exactly what came back and what it
 * cost. Read-only for ICP data — nothing is persisted except the `ai.call` metering rows.
 *
 * Usage:
 *   pnpm spike scripts/verify-icp.ts            # uses the sample offer below
 *   pnpm spike scripts/verify-icp.ts <offerId>  # loads a real offer and its learnings
 *
 * Refuses politely when `AI_GATEWAY_API_KEY` is missing.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { critiqueIcps, generateIcps, rankIcpCandidates } from "@/src/ai/agents/icp";
import { ICP_PROMPT_VERSION, type IcpPromptOffer } from "@/src/ai/prompts/icp";
import { loadLearningsForIcpGeneration } from "@/src/services/icps";
import { getOffer } from "@/src/services/offers";

const SAMPLE_OFFER: IcpPromptOffer = {
  title: "AI support triage pilot",
  description:
    "A three-week pilot that adds AI triage and suggested replies to a B2B company's help desk, so small support teams stop losing tickets in the queue.",
  proof: [
    {
      label: "Sample case study (replace with real proof)",
      detail: "First-response time fell from 6 hours to 40 minutes for a 12-agent support team during a four-week pilot.",
      url: "https://example.com/case-study",
    },
  ],
  priceHint: "$6k pilot, $2k/month after",
};

function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key.length === 0 || process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();

  if (!process.env.AI_GATEWAY_API_KEY) {
    console.log(
      [
        "verify-icp: AI_GATEWAY_API_KEY is not set, so there is nothing to verify.",
        "Add it to .env.local (see .env.example) and run this again. No model call was made.",
      ].join("\n"),
    );
    return;
  }

  const offerId = process.argv[2];
  const offer = offerId ? await getOffer(offerId) : null;
  if (offerId && !offer) {
    throw new Error(`No offer with id "${offerId}". Nothing was called.`);
  }

  const promptOffer: IcpPromptOffer = offer
    ? { title: offer.title, description: offer.description, proof: offer.proof, priceHint: offer.priceHint }
    : SAMPLE_OFFER;
  const learnings = offer ? await loadLearningsForIcpGeneration() : [];

  console.log(`verify-icp: prompt ${ICP_PROMPT_VERSION}, offer "${promptOffer.title}"`);
  console.log(`verify-icp: model ${process.env.MODEL_COPY ?? "(MODEL_COPY is not set; see .env.example)"}\n`);

  const generated = await generateIcps({ offer: promptOffer, learnings });
  console.log(`generated ${generated.icps.length} ICPs`);

  const critique = await critiqueIcps({ offer: promptOffer, icps: generated.icps });
  console.log(`critic ranked ${critique.critique.rankings.length} and dropped ${critique.critique.drop.length}\n`);

  const ranked = rankIcpCandidates({ icps: generated.icps }, critique.critique);
  const costUsd = generated.usage.costUsd + critique.usage.costUsd;

  console.log("Ranked result:");
  for (const icp of ranked) {
    const total = icp.scores.pain + icp.scores.budget + icp.scores.reach + icp.scores.proofFit + icp.scores.speed;
    console.log(
      `  ${icp.rank}. ${icp.name} — total ${total}/25 (pain ${icp.scores.pain}, budget ${icp.scores.budget}, reach ${icp.scores.reach}, proofFit ${icp.scores.proofFit}, speed ${icp.scores.speed})`,
    );
    if (icp.critiqueNote) console.log(`     critic: ${icp.critiqueNote}`);
  }
  for (const dropped of critique.critique.drop) {
    console.log(`  dropped: ${dropped.name} — ${dropped.reason}`);
  }

  const usage = {
    model: generated.usage.model,
    promptVersion: generated.usage.promptVersion,
    inputTokens: generated.usage.inputTokens + critique.usage.inputTokens,
    outputTokens: generated.usage.outputTokens + critique.usage.outputTokens,
    costUsd: Number(costUsd.toFixed(6)),
  };
  console.log(`\nusage: ${JSON.stringify(usage)}`);
  console.log(`total: $${costUsd.toFixed(4)}, ${usage.model}`);

  console.log("\nParsed JSON:");
  console.log(JSON.stringify({ ranked, dropped: critique.critique.drop, usage }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(`verify-icp failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
