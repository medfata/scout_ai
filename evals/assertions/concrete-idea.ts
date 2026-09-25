/**
 * The one model-graded check stage 1b asks for: "one concrete idea tied to a signal".
 *
 * Everything mechanical is in `copy-rules.ts` (code). Whether the idea is *concrete* and
 * *tied to a real signal* is the judgement a model can help with, so this assertion sends the
 * draft and the numbered signals to the fast model through the real `generateStructured`
 * client and requires a pass plus the signal index it used.
 *
 * It is intentionally narrow: no style, no tone, no length.
 */
import { z } from "zod";

import { generateStructured } from "@/src/ai/client";

import { asString, grade, isRecord, readScoutPayload, type GradingResult } from "../lib/grading";
import { leadById } from "../golden/leads";
import { requireEvalEnv } from "../lib/env";

const IdeaVerdictSchema = z.object({
  pass: z.boolean(),
  reason: z.string().max(400),
  /** Index of the signal the idea is tied to; -1 when there is none. */
  signalIndex: z.number().int().min(-1),
});

const IDEA_GRADER_VERSION = "eval.copy.concrete-idea/v1";

export default async function checkConcreteIdea(_output: unknown, context: unknown): Promise<GradingResult> {
  requireEvalEnv();

  const payload = readScoutPayload(context);
  if (payload === null) return grade(false, "concrete-idea: no provider metadata reached the assertion");

  const leadId = asString(payload.leadId);
  if (leadId === null) return grade(false, "concrete-idea: provider metadata has no leadId");
  const lead = leadById(leadId);

  const draft = payload.draft;
  if (!isRecord(draft) || typeof draft.body !== "string") {
    return grade(false, "concrete-idea: the provider returned no draft body to grade");
  }
  const verdict = isRecord(payload.verdict) ? payload.verdict : null;
  if (verdict !== null && verdict.passed !== true) {
    return grade(false, "concrete-idea: the draft did not pass the critic, so the idea check is moot");
  }

  const signals = lead.brief.signals
    .map((signal, index) => `[${index}] ${signal.fact} (${signal.url})`)
    .join("\n");

  const result = await generateStructured({
    component: "eval.copy.concrete-idea",
    promptVersion: IDEA_GRADER_VERSION,
    role: "copy",
    schema: IdeaVerdictSchema,
    system: [
      "You grade ONE requirement of a cold outreach draft: it must contain exactly one concrete",
      "idea that is tied to a numbered signal in the brief.",
      "Pass only when all three are true:",
      "  1. there is exactly one idea (zero ideas, or several competing ideas, fail),",
      "  2. the idea is specific and actionable for this company (generic advice that fits any",
      "     company fails),",
      "  3. the idea follows from at least one signal in the brief.",
      "Return JSON: pass (boolean), reason (one sentence), signalIndex (the index it uses, or -1).",
    ].join("\n"),
    prompt: [
      "## Brief signals",
      signals,
      "",
      "## Draft body",
      draft.body,
      "",
      "Grade it now.",
    ].join("\n"),
    temperature: 0,
  });

  const object = result.object;
  const reason = `${object.reason} (signal ${object.signalIndex})`;
  return grade(object.pass, object.pass ? `concrete idea: ${reason}` : `concrete idea failed: ${reason}`);
}
