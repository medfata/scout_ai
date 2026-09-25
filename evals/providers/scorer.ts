/**
 * Scorer eval provider. It calls the real `scoreLead` agent, which uses the real
 * `scoreSystemPrompt`/`scoreUserPrompt` from `src/ai/prompts/score.ts` through
 * `generateStructured` and applies the real code rules (`src/ai/agents/score.ts`) on top of the
 * model's number.
 *
 * The printed `output` is deliberately redacted (no reasons, no prose); the raw result travels
 * in `metadata.scout` for the assertions. No send path is reachable from this file.
 */
import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";

import { scoreLead } from "@/src/ai/agents/score";

import { requireEvalEnv } from "../lib/env";
import { readVar } from "../lib/grading";
import { icpForScore, leadById, leadFactsFor } from "../golden/leads";

export default class ScorerProvider implements ApiProvider {
  id(): string {
    return "scout-eval:scorer";
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    requireEvalEnv();

    const leadId = readVar(context, "leadId");
    if (leadId === null) return { error: "scorer eval: vars.leadId is required" };

    const lead = leadById(leadId);
    const result = await scoreLead({
      contactId: `eval:${lead.id}`,
      icpId: `eval:${lead.id}:icp`,
      icp: icpForScore(),
      lead: leadFactsFor(lead),
      brief: lead.brief,
    });

    return {
      output: JSON.stringify({
        leadId: lead.id,
        score: result.score,
        tier: result.tier,
        disqualified: result.disqualified,
        gates: result.gates,
      }),
      metadata: {
        scout: {
          leadId: lead.id,
          score: result.score,
          tier: result.tier,
          disqualified: result.disqualified,
          disqualifiedReason: result.disqualifiedReason,
          reasons: result.reasons,
          gates: result.gates,
          model: result.model,
          costUsd: result.costUsd,
        },
      },
    };
  }
}
