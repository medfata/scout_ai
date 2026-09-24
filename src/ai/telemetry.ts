import { Langfuse, type LangfuseTraceClient } from "langfuse";

import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";

/**
 * Section 4: "LLM tracing and evals | Langfuse + promptfoo". Section 6: "Every call logs
 * prompt version, model, tokens and cost to Langfuse and to the row it produced."
 *
 * Tracing is best-effort: a Langfuse outage must never fail a research or drafting step,
 * so every call is wrapped and swallowed.
 */

export interface TraceHandle {
  id: string;
  client: Langfuse | null;
  trace: LangfuseTraceClient | null;
  startedAt: Date;
}

let client: Langfuse | null = null;
let initialised = false;

function langfuse(): Langfuse | null {
  if (initialised) return client;
  initialised = true;
  const env = getEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    logger.info("langfuse.disabled", { reason: "missing keys" });
    client = null;
    return null;
  }
  client = new Langfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_HOST || "https://cloud.langfuse.com",
    flushAt: 10,
    requestTimeout: 10_000,
  });
  return client;
}

export interface StartTraceInput {
  name: string;
  model: string;
  promptVersion: string;
  contactId?: string | null;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export function startTrace(input: StartTraceInput): TraceHandle {
  const instance = langfuse();
  const startedAt = new Date();
  if (!instance) return { id: `${input.name}:${startedAt.getTime()}`, client: null, trace: null, startedAt };

  try {
    const trace = instance.trace({
      name: input.name,
      metadata: {
        model: input.model,
        promptVersion: input.promptVersion,
        contactId: input.contactId ?? "none",
      },
      input: input.input,
      timestamp: startedAt,
    });
    return { id: trace.id, client: instance, trace, startedAt };
  } catch (error) {
    logger.warn("langfuse.trace_failed", { name: input.name, reason: error instanceof Error ? error.message : "unknown" });
    return { id: `${input.name}:${startedAt.getTime()}`, client: null, trace: null, startedAt };
  }
}

export interface EndTraceInput {
  output?: unknown;
  model?: string;
  modelParameters?: Record<string, string | number | boolean | string[] | null>;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  promptVersion?: string;
  error?: boolean;
}

export function endTrace(handle: TraceHandle, input: EndTraceInput): void {
  if (!handle.client || !handle.trace) return;
  try {
    if (input.error) {
      handle.trace.update({ output: { error: true } });
    } else {
      handle.trace.generation({
        name: "completion",
        model: input.model ?? "unknown",
        modelParameters: input.modelParameters ?? {},
        input: undefined,
        output: input.output,
        usage: {
          input: input.inputTokens ?? 0,
          output: input.outputTokens ?? 0,
          unit: "TOKENS",
        },
        metadata: {
          promptVersion: input.promptVersion ?? "unknown",
          costUsd: input.costUsd ?? 0,
        },
        startTime: handle.startedAt,
        endTime: new Date(),
      });
    }
  } catch (error) {
    logger.warn("langfuse.generation_failed", { reason: error instanceof Error ? error.message : "unknown" });
  }
}

/** Called by the daily planner so a serverless instance does not drop its last events. */
export async function flushTraces(): Promise<void> {
  const instance = langfuse();
  if (!instance) return;
  try {
    await instance.flushAsync();
  } catch (error) {
    logger.warn("langfuse.flush_failed", { reason: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * Section 6: "cost is logged". The caller passes the same numbers here and to the row it
 * produced, so the dashboard, the quota guard and the trace agree.
 */
export function langfuseId(handle: TraceHandle): string {
  return handle.id;
}
