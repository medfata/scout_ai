import { generateText, isStepCount, tool, type StopCondition, type ToolSet } from "ai";
import { z } from "zod";

import { generateStructured, modelForRole } from "@/src/ai/client";
import { costOfUsage } from "@/src/ai/pricing";
import {
  RESEARCH_PROMPT_VERSION,
  researchRepairHint,
  researchSynthesisSystemPrompt,
  researchSynthesisUserPrompt,
  researchSystemPrompt,
  researchUserPrompt,
  type ResearchPromptInput,
} from "@/src/ai/prompts/research";
import { ResearchBriefSchema, type ResearchBriefOutput } from "@/src/ai/schemas";
import { endTrace, startTrace } from "@/src/ai/telemetry";
import type { LinkedinMode } from "@/src/domain/types";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import type { WebsiteReader } from "@/src/ports/website-reader";

/**
 * Section 6: "Research agent | Smart, fast for extraction | Contact, company, ICP |
 * ResearchBrief | Bounded tool loop, max 6 tool calls."
 *
 * Two phases keep the bound honest:
 *  1. a tool loop whose stop condition counts tool calls in code, with a second counter
 *     inside every tool's `execute` so a burst of parallel calls cannot exceed the budget;
 *  2. a synthesis call that turns the collected evidence into the Zod-validated brief.
 *
 * Everything the agent touches is injected: website reader, web search and (only in
 * automated mode) LinkedIn profile lookup. The agent never imports an adapter and never
 * writes to the database, so evals and tests can drive it with fakes.
 */

export const RESEARCH_MAX_TOOL_CALLS = 6;

/** One web-search hit. Matches the shape the Exa adapter returns. */
export interface ResearchSearchHit {
  url: string;
  title: string | null;
  text: string;
}

export type ResearchSearchFn = (query: string) => Promise<ResearchSearchHit[]>;

export interface ResearchLinkedinProfile {
  url: string;
  headline: string | null;
  text: string;
}

export type ResearchLinkedinProfileFn = (id: string) => Promise<ResearchLinkedinProfile>;

export interface ResearchLeadInput {
  contactId: string;
  icpId: string;
  /** Built by the service from the contact, company, ICP and offer rows. */
  prompt: ResearchPromptInput;
}

export interface ResearchLeadDeps {
  readWebsite: WebsiteReader;
  search: ResearchSearchFn;
  /** Registered only when `linkedinMode` is "automated" (v1 is assisted). */
  linkedinProfile?: ResearchLinkedinProfileFn;
  /** Defaults to `LINKEDIN_MODE` from env; tests pass it explicitly. */
  linkedinMode?: LinkedinMode;
  /** Injected clock so the evidence digest's news query uses a deterministic year. */
  now?: () => Date;
}

export interface ResearchLeadResult {
  brief: ResearchBriefOutput;
  model: string;
  promptVersion: string;
  costUsd: number;
  attempts: number;
  /** Actual tool executions, including the calls that hit the budget wall. */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

const MAX_WEBSITE_CHARS = 6_000;
const MAX_SEARCH_HITS = 5;
const MAX_HIT_CHARS = 1_200;
const MAX_EVIDENCE_CHARS = 24_000;

export async function researchLead(
  input: ResearchLeadInput,
  deps: ResearchLeadDeps,
): Promise<ResearchLeadResult> {
  const budget = createToolBudget(RESEARCH_MAX_TOOL_CALLS);
  const tools = buildTools(deps, budget);
  const promptVersion = RESEARCH_PROMPT_VERSION;

  // --- phase 1: bounded tool loop -----------------------------------------
  const { model: toolModel, id: modelId } = modelForRole("research");
  const trace = startTrace({
    name: "research.tools",
    model: modelId,
    promptVersion,
    contactId: input.contactId,
    input: input.prompt.company.companyName,
  });

  const loop = await generateText({
    model: toolModel,
    system: researchSystemPrompt({ maxToolCalls: RESEARCH_MAX_TOOL_CALLS }),
    prompt: researchUserPrompt(input.prompt),
    tools,
    // Code, not prompt: stop as soon as the budget is spent. The +1 leaves room for the
    // model's final text generation after the sixth tool result.
    stopWhen: [toolBudgetSpent, isStepCount(RESEARCH_MAX_TOOL_CALLS + 1)],
    temperature: 0.2,
    maxRetries: 1,
  });

  const toolCalls = countToolCalls(loop.steps);
  const loopCost = costOfUsage(modelId, {
    inputTokens: loop.totalUsage.inputTokens,
    outputTokens: loop.totalUsage.outputTokens,
    inputTokenDetails: loop.totalUsage.inputTokenDetails,
  });
  endTrace(trace, {
    output: { toolCalls, steps: loop.steps.length },
    model: modelId,
    promptVersion,
    inputTokens: loop.totalUsage.inputTokens ?? 0,
    outputTokens: loop.totalUsage.outputTokens ?? 0,
    costUsd: loopCost.costUsd,
  });

  if (toolCalls === 0) {
    logger.warn("research.no_tool_calls", { contactId: input.contactId });
  }

  // --- phase 2: synthesis (Zod-validated, one retry, then needs owner) ------
  const evidence = formatEvidence(loop.steps);
  const synthesis = await generateStructured({
    component: "research",
    promptVersion,
    role: "research",
    schema: ResearchBriefSchema,
    system: researchSynthesisSystemPrompt(),
    prompt: researchSynthesisUserPrompt({ input: input.prompt, evidence }),
    temperature: 0.2,
    contactId: input.contactId,
    repairHint: researchRepairHint(),
  });

  return {
    brief: synthesis.object,
    model: synthesis.model,
    promptVersion,
    costUsd: roundUsd(loopCost.costUsd + synthesis.costUsd),
    attempts: synthesis.attempts,
    toolCalls,
    inputTokens: (loop.totalUsage.inputTokens ?? 0) + synthesis.inputTokens,
    outputTokens: (loop.totalUsage.outputTokens ?? 0) + synthesis.outputTokens,
  };
}

/**
 * `stopWhen` that counts tool calls across all steps. Exported so the bound can be
 * asserted directly in tests and evals.
 */
export const toolBudgetSpent: StopCondition<ToolSet> = ({ steps }) =>
  countToolCalls(steps) >= RESEARCH_MAX_TOOL_CALLS;

interface StepLike {
  toolCalls?: Array<{ toolName: string; toolCallId: string; input?: unknown }>;
  toolResults?: Array<{ toolName: string; toolCallId: string; output?: unknown }>;
}

export function countToolCalls(steps: readonly StepLike[]): number {
  return steps.reduce((total, step) => total + (step.toolCalls?.length ?? 0), 0);
}

/**
 * A shared counter behind every tool. The `stopWhen` condition bounds steps; this bounds
 * executions, including several calls inside one step. Over-budget calls return a tool
 * error so the model switches to synthesis instead of failing the whole run.
 */
function createToolBudget(max: number) {
  let used = 0;
  return {
    use(toolName: string): void {
      used += 1;
      if (used > max) {
        throw new Error(
          `Tool budget exhausted after ${max} calls (blocked ${toolName}). Synthesise the brief from the evidence already collected.`,
        );
      }
    },
    get used(): number {
      return used;
    },
  };
}

function buildTools(deps: ResearchLeadDeps, budget: ReturnType<typeof createToolBudget>): ToolSet {
  const mode = deps.linkedinMode ?? getEnv().LINKEDIN_MODE;
  const now = deps.now ?? (() => new Date());
  const year = now().getFullYear();

  const tools: ToolSet = {
    readWebsite: tool({
      description:
        "Read a company web page as markdown. Use the company's own site first (home, about, product, blog). Returns the page text; long pages are truncated.",
      inputSchema: z.object({ url: z.string().url().describe("Full URL, https://…") }),
      execute: async ({ url }) => {
        budget.use("readWebsite");
        const page = await deps.readWebsite.read(url);
        return {
          url: page.url,
          title: page.title,
          cached: page.cached,
          markdown: truncate(page.markdown, MAX_WEBSITE_CHARS),
        };
      },
    }),
    webSearch: tool({
      description:
        "Search the public web for a company, product or market fact. Returns up to five results with the text of each page. Use precise queries.",
      inputSchema: z.object({ query: z.string().min(3).max(200) }),
      execute: async ({ query }) => {
        budget.use("webSearch");
        const hits = await deps.search(query);
        return { query, results: hits.slice(0, MAX_SEARCH_HITS).map(trimHit) };
      },
    }),
    recentNews: tool({
      description:
        "Search recent news and announcements about a company (funding, launches, hiring, leadership, expansions). Returns up to five dated results when available.",
      inputSchema: z.object({ company: z.string().min(1).max(120) }),
      execute: async ({ company }) => {
        budget.use("recentNews");
        const hits = await deps.search(`${company} news announcement ${year}`);
        return { company, results: hits.slice(0, MAX_SEARCH_HITS).map(trimHit) };
      },
    }),
  };

  // Section 0 locks v1 to assisted mode, so this tool is not registered. It exists only
  // for a future automated deployment (phase 6) and still needs an injected reader.
  if (mode === "automated" && deps.linkedinProfile) {
    const linkedinProfile = deps.linkedinProfile;
    tools.linkedinProfile = tool({
      description: "Read a LinkedIn profile when LinkedIn automation is enabled.",
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        budget.use("linkedinProfile");
        const profile = await linkedinProfile(id);
        return { ...profile, text: truncate(profile.text, MAX_HIT_CHARS) };
      },
    });
  }

  return tools;
}

function trimHit(hit: ResearchSearchHit) {
  return { url: hit.url, title: hit.title, text: truncate(hit.text, MAX_HIT_CHARS) };
}

/** Renders the tool transcript the synthesis call reasons over. */
export function formatEvidence(steps: readonly StepLike[]): string {
  const lines: string[] = [];
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      const result = step.toolResults?.find((candidate) => candidate.toolCallId === call.toolCallId);
      lines.push(`### ${call.toolName}(${JSON.stringify(call.input ?? {})})`);
      if (!result) {
        lines.push("(no result — the tool failed or the budget blocked it)");
      } else {
        lines.push(truncate(safeStringify(result.output), MAX_HIT_CHARS * 2));
      }
      lines.push("");
      if (lines.join("\n").length > MAX_EVIDENCE_CHARS) {
        lines.push("(evidence truncated to fit the budget)");
        return lines.join("\n");
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no tool results were collected)";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}
