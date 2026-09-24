import { createGateway, type GatewayProvider } from "@ai-sdk/gateway";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText, type LanguageModel } from "ai";
import type { z } from "zod";

import { getEnv, requireVendorVar } from "@/src/lib/env";
import { ConfigurationError, ScoutError } from "@/src/lib/errors";
import { logger } from "@/src/lib/logger";
import { costOfUsage } from "./pricing";
import { endTrace, startTrace } from "./telemetry";

/**
 * Section 6: "Seven model calls, each with one job, one Zod output schema and one prompt
 * file. None of them can send anything; they only return data that code validates and
 * acts on."
 *
 * This module is the only place a model is constructed, so the routing rules from
 * section 0 live in one file: copy goes through the AI Gateway, company research goes to
 * the Gemini free tier.
 */

let gatewayInstance: GatewayProvider | null = null;

function gatewayProvider(): GatewayProvider {
  if (!gatewayInstance) {
    gatewayInstance = createGateway({ apiKey: requireVendorVar("AI_GATEWAY_API_KEY") });
  }
  return gatewayInstance;
}

/** Claude Haiku 4.5 by default (section 0). The id comes from env, never hard-coded. */
export function copyModel(): LanguageModel {
  const { MODEL_COPY } = getEnv();
  return gatewayProvider()(MODEL_COPY);
}

/**
 * Gemini free tier for company research (section 0: "public company data only, never
 * personal data").
 */
export function researchModel(): LanguageModel {
  const { MODEL_RESEARCH, GEMINI_API_KEY } = getEnv();
  const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY || undefined });
  return google(MODEL_RESEARCH);
}

/**
 * Section 4 defines `MODEL_SMART` (Claude Sonnet 5) as an upgrade the owner must approve
 * before it exists (section 0). Calling this without `MODEL_SMART` set fails loudly
 * rather than silently downgrading.
 */
export function smartModel(): LanguageModel {
  const model = process.env.MODEL_SMART;
  if (!model) {
    throw new ConfigurationError(
      "MODEL_SMART is not configured. v1 runs on Claude Haiku 4.5 (MODEL_COPY) and Gemini (MODEL_RESEARCH); Sonnet 5 is an upgrade the owner must approve.",
    );
  }
  return gatewayProvider()(model);
}

export type ModelRole = "copy" | "research" | "smart";

export function modelForRole(role: ModelRole): { model: LanguageModel; id: string } {
  const env = getEnv();
  switch (role) {
    case "copy":
      return { model: copyModel(), id: env.MODEL_COPY };
    case "research":
      return { model: researchModel(), id: env.MODEL_RESEARCH };
    case "smart": {
      const id = process.env.MODEL_SMART ?? "unknown";
      return { model: smartModel(), id };
    }
  }
}

export class LlmValidationError extends ScoutError {
  constructor(
    readonly component: string,
    readonly attempts: number,
    cause?: unknown,
  ) {
    super(`LLM output failed schema validation twice for ${component}; the item is marked "needs owner".`, {
      code: "validation",
      context: { component, attempts },
      cause,
    });
  }
}

export interface StructuredCallInput<TSchema extends z.ZodType> {
  component: string;
  promptVersion: string;
  role: ModelRole;
  schema: TSchema;
  /** Static context first, so provider prompt caching applies (section 6). */
  system: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  contactId?: string | null;
  /** Appended on the single retry after a schema failure (section 10 rule 5). */
  repairHint?: string;
}

export interface StructuredCallResult<T> {
  object: T;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  attempts: number;
}

/**
 * Calls a model and parses the result with its Zod schema. On failure, retries once with
 * a repair hint; if that also fails, throws `LlmValidationError` so the caller can mark
 * the item "needs owner" (section 10 rule 5).
 */
export async function generateStructured<TSchema extends z.ZodType>(
  input: StructuredCallInput<TSchema>,
): Promise<StructuredCallResult<z.infer<TSchema>>> {
  const { model, id } = modelForRole(input.role);
  const trace = startTrace({
    name: input.component,
    model: id,
    promptVersion: input.promptVersion,
    contactId: input.contactId ?? null,
    input: input.prompt,
  });

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = attempt === 1 ? input.prompt : `${input.prompt}\n\n${repairInstruction(input.repairHint, lastError)}`;
    try {
      const result = await generateObject({
        model,
        schema: input.schema,
        system: input.system,
        prompt,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      });

      const usage = result.usage;
      const { costUsd, known } = costOfUsage(id, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        inputTokenDetails: usage.inputTokenDetails,
      });
      if (!known) {
        logger.warn("ai.unknown_model_price", { model: id, component: input.component });
      }

      const totals = {
        model: id,
        promptVersion: input.promptVersion,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        costUsd,
        attempts: attempt,
      };
      endTrace(trace, { output: result.object, ...totals, costUsd });

      return { object: result.object as z.infer<TSchema>, ...totals };
    } catch (error) {
      lastError = error;
      logger.warn("ai.structured_call_failed", { component: input.component, attempt, model: id });
    }
  }

  endTrace(trace, { error: true });
  throw new LlmValidationError(input.component, 2, lastError);
}

export interface TextCallInput {
  component: string;
  promptVersion: string;
  role: ModelRole;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  contactId?: string | null;
}

export async function generatePlainText(input: TextCallInput): Promise<StructuredCallResult<string>> {
  const { model, id } = modelForRole(input.role);
  const trace = startTrace({
    name: input.component,
    model: id,
    promptVersion: input.promptVersion,
    contactId: input.contactId ?? null,
    input: input.prompt,
  });

  const result = await generateText({
    model,
    system: input.system,
    prompt: input.prompt,
    maxRetries: 1,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
  });

  const usage = result.usage;
  const { costUsd, known } = costOfUsage(id, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    inputTokenDetails: usage.inputTokenDetails,
  });
  if (!known) logger.warn("ai.unknown_model_price", { model: id, component: input.component });

  const totals = {
    model: id,
    promptVersion: input.promptVersion,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    costUsd,
    attempts: 1,
  };
  endTrace(trace, { output: result.text, ...totals, costUsd });

  return { object: result.text, ...totals };
}

function repairInstruction(hint: string | undefined, error: unknown): string {
  const detail = error instanceof Error ? error.message.slice(0, 400) : "unknown error";
  return [
    "Your previous response could not be parsed.",
    hint ?? "Return only the JSON object that matches the schema exactly. Use every required field.",
    `Parser said: ${detail}`,
  ].join("\n");
}

/** The AI SDK's error type for "model returned something that is not the schema". */
export function isSchemaFailure(error: unknown): boolean {
  return error instanceof ScoutError || (error instanceof Error && /schema|object|JSON/i.test(error.message));
}
