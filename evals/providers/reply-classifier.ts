/**
 * Reply-classifier eval provider. `src/ai/agents/reply-classifier.ts` reads a message row from
 * the database before classifying, which an eval must not do; this provider makes the same
 * `generateStructured` call with the same real prompt functions
 * (`REPLY_CLASSIFIER_SYSTEM`, `buildReplyClassifierPrompt`) and the same
 * `ReplyLabelSchema` (section 6: one job, one schema, one prompt file).
 *
 * The labels are compared in code by `evals/assertions/classifier-*.ts`; not one byte of the
 * reply body is printed.
 */
import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";

import { generateStructured } from "@/src/ai/client";
import {
  buildReplyClassifierPrompt,
  REPLY_CLASSIFIER_PROMPT_VERSION,
  REPLY_CLASSIFIER_SYSTEM,
} from "@/src/ai/prompts/reply-classifier";
import { ReplyLabelSchema } from "@/src/ai/schemas";

import { requireEvalEnv } from "../lib/env";
import { readVar } from "../lib/grading";
import { replyById } from "../golden/leads";

export default class ReplyClassifierProvider implements ApiProvider {
  id(): string {
    return "scout-eval:reply-classifier";
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    requireEvalEnv();

    const replyId = readVar(context, "replyId");
    if (replyId === null) return { error: "classifier eval: vars.replyId is required" };

    const reply = replyById(replyId);
    const result = await generateStructured({
      component: "eval.reply-classifier",
      promptVersion: REPLY_CLASSIFIER_PROMPT_VERSION,
      role: "copy",
      schema: ReplyLabelSchema,
      system: REPLY_CLASSIFIER_SYSTEM,
      prompt: buildReplyClassifierPrompt({
        subject: reply.subject,
        body: reply.body,
        fromName: reply.fromName,
        companyName: reply.companyName,
        previousMessage: reply.previousMessage ?? null,
      }),
      maxOutputTokens: 400,
      temperature: 0,
      contactId: `eval:${reply.id}`,
    });

    return {
      output: JSON.stringify({ replyId: reply.id, intent: result.object.intent }),
      metadata: {
        scout: {
          replyId: reply.id,
          intent: result.object.intent,
          summary: result.object.summary,
          returnDate: result.object.returnDate ?? null,
          followUpAfter: result.object.followUpAfter ?? null,
          referral: result.object.referral ?? null,
          model: result.model,
          costUsd: result.costUsd,
        },
      },
    };
  }
}
