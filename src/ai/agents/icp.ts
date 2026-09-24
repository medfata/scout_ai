import { generateStructured } from "@/src/ai/client";
import {
  IcpCritiqueSchema,
  IcpSetSchema,
  type IcpCritiqueOutput,
  type IcpOutput,
  type IcpSetOutput,
} from "@/src/ai/schemas";
import {
  ICP_PROMPT_VERSION,
  buildIcpCritiquePrompt,
  buildIcpGenerationPrompt,
  type IcpCritiqueContext,
  type IcpGenerationContext,
} from "@/src/ai/prompts/icp";
import { rankIcps } from "@/src/domain/scoring";
import { assertAiBudget, recordAiCall } from "@/src/services/quota";

/**
 * Section 6: the ICP generator proposes 3-7 profiles; the critic re-scores them on the
 * same five criteria and names the ones to drop; code then validates, merges and ranks.
 * A model never decides what is saved — `src/services/icps.ts` does.
 *
 * v1 runs both calls on `MODEL_COPY` through the AI Gateway (section 0; D7: no
 * `MODEL_SMART` exists until the owner approves Sonnet 5). Every call checks the AI
 * budget first and records its cost with `recordAiCall`.
 */

export const ICP_GENERATOR_COMPONENT = "icp.generator";
export const ICP_CRITIC_COMPONENT = "icp.critic";

export interface IcpUsage {
  component: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  attempts: number;
}

export interface IcpGenerationResult {
  icps: IcpOutput[];
  usage: IcpUsage;
}

export interface IcpCritiqueResult {
  critique: IcpCritiqueOutput;
  usage: IcpUsage;
}

export async function generateIcps(context: IcpGenerationContext): Promise<IcpGenerationResult> {
  await assertAiBudget();

  const parts = buildIcpGenerationPrompt(context);
  const result = await generateStructured({
    component: ICP_GENERATOR_COMPONENT,
    promptVersion: ICP_PROMPT_VERSION,
    role: "copy",
    schema: IcpSetSchema,
    system: parts.system,
    prompt: parts.prompt,
    maxOutputTokens: 6000,
    repairHint:
      'Return 3-7 ICPs. Every ICP needs pains (at least 2), angles (2-3), the exa object, and all five scores as integers from 1 to 5.',
  });

  const usage: IcpUsage = {
    component: ICP_GENERATOR_COMPONENT,
    model: result.model,
    promptVersion: result.promptVersion,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    attempts: result.attempts,
  };
  await recordAiCall(usage);

  return { icps: result.object.icps, usage };
}

export async function critiqueIcps(context: IcpCritiqueContext): Promise<IcpCritiqueResult> {
  await assertAiBudget();

  const parts = buildIcpCritiquePrompt(context);
  const result = await generateStructured({
    component: ICP_CRITIC_COMPONENT,
    promptVersion: ICP_PROMPT_VERSION,
    role: "copy",
    schema: IcpCritiqueSchema,
    system: parts.system,
    prompt: parts.prompt,
    maxOutputTokens: 3000,
    repairHint:
      "Score every candidate you were given in `rankings` (five integers 1-5 each) and list only clearly weak candidates in `drop`.",
  });

  const usage: IcpUsage = {
    component: ICP_CRITIC_COMPONENT,
    model: result.model,
    promptVersion: result.promptVersion,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    attempts: result.attempts,
  };
  await recordAiCall(usage);

  return { critique: result.object, usage };
}

export interface RankedIcp extends IcpOutput {
  /** 1 = best. Ties go to reachability (section 6). */
  rank: number;
  /** The critic's one-line note, when it scored this candidate. */
  critiqueNote: string | null;
}

/**
 * Merges the critic's scores over the generated ones, drops the rejected candidates and
 * ranks the rest with `rankIcps` (sum desc, ties to reach). Names are matched
 * case-insensitively and trimmed, because a model may return "  CTOs " once and "CTOs"
 * once. Candidates the critic did not score keep their generated scores.
 */
export function rankIcpCandidates(set: Pick<IcpSetOutput, "icps">, critique: IcpCritiqueOutput): RankedIcp[] {
  const dropped = new Set(critique.drop.map((entry) => normaliseName(entry.name)));
  const byName = new Map(critique.rankings.map((entry) => [normaliseName(entry.name), entry]));

  const kept = set.icps
    .filter((icp) => !dropped.has(normaliseName(icp.name)))
    .map((icp) => {
      const ranking = byName.get(normaliseName(icp.name));
      return ranking ? { ...icp, scores: ranking.scores } : icp;
    });

  return rankIcps(kept).map((icp, index) => ({
    ...icp,
    rank: index + 1,
    critiqueNote: byName.get(normaliseName(icp.name))?.note ?? null,
  }));
}

function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}
