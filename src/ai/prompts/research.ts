import type { ResearchBriefOutput } from "@/src/ai/schemas";

/**
 * Section 6: "Seven model calls, each with one job, one Zod output schema and one prompt
 * file." This is the research agent's prompt.
 *
 * Prompts are versioned pure functions: they take plain data and return strings, so
 * `evals/` (promptfoo) can import them and the workflow can log the version with every
 * row they produced (section 6, "Prompt hygiene").
 *
 * Section 0: company research runs on the Gemini free tier and must never receive
 * personal data. The input therefore carries company facts and the contact's *role*
 * only — never a name, email or profile.
 */

export const RESEARCH_PROMPT_VERSION = "research.v1";

export interface ResearchCompanyContext {
  companyName: string;
  companyDomain: string | null;
  websiteUrl: string | null;
  industry: string | null;
  sizeBand: string | null;
  country: string | null;
  /** Role only, for tailoring the brief. Never the person's name, email or profile. */
  contactTitle: string | null;
}

export interface ResearchIcpContext {
  name: string;
  pains: string[];
  triggers: string[];
  disqualifiers: string[];
}

export interface ResearchOfferContext {
  title: string;
  description: string;
}

export interface ResearchPromptInput {
  company: ResearchCompanyContext;
  icp: ResearchIcpContext;
  offer: ResearchOfferContext;
  /** The lead's language, so the brief's prose is useful to the copywriter. */
  language: string | null;
  /** Injected so the prompt is deterministic and eval-friendly. */
  today: string;
  maxToolCalls: number;
}

/** Static context goes first so provider prompt caching applies (section 6). */
export function researchSystemPrompt(input: Pick<ResearchPromptInput, "maxToolCalls">): string {
  return [
    "You are Scout's research agent. You research ONE company and return an evidence-backed",
    "brief that a human copywriter uses for a first cold outreach email.",
    "",
    "## Hard rules",
    `1. You may call tools at most ${input.maxToolCalls} times in total. The code enforces this; once the`,
    "   budget is spent you must synthesise the brief from the tool results you already have.",
    "2. Company-level, public facts only. Never look for or record personal data about a person",
    "   (no private emails, phone numbers, home addresses, personal social profiles or personal life).",
    "3. Every signal must come from a tool result and carry the exact URL it came from.",
    "   Never invent a fact, number, client, date or quote.",
    "4. Prefer the company's own website first, then a targeted web search, then recent news.",
    "5. If evidence is thin, say so: use few signals and confidence \"low\". Fewer honest signals",
    "   are always better than a confident invention.",
    "6. `aiOpportunity` is ONE concrete idea for how the sender's offer could help this company.",
    "   It must follow from the signals you collected, not from generic industry talk.",
    "7. `hooks` are candidate opening observations for the writer; each `signalIndex` must point at",
    "   one of the signals you returned (0-based).",
    "8. Write the prose fields in English unless the recipient's language is known and different,",
    "   in which case write them in that language.",
    "",
    "Return only the JSON object that matches the required schema: summary, signals, likelyPains,",
    "aiOpportunity, hooks, confidence.",
  ].join("\n");
}

export function researchUserPrompt(input: ResearchPromptInput): string {
  const { company, icp, offer } = input;
  return [
    "## Company to research",
    `Name: ${company.companyName}`,
    `Website: ${company.websiteUrl ?? "unknown"}`,
    `Domain: ${company.companyDomain ?? "unknown"}`,
    `Industry: ${company.industry ?? "unknown"}`,
    `Headcount band: ${company.sizeBand ?? "unknown"}`,
    `Country: ${company.country ?? "unknown"}`,
    `Contact's role: ${company.contactTitle ?? "unknown"}`,
    "",
    "## The ICP this lead was sourced for",
    `Name: ${icp.name}`,
    `Pains we look for: ${listOrNone(icp.pains)}`,
    `Buying triggers: ${listOrNone(icp.triggers)}`,
    `Disqualifiers: ${listOrNone(icp.disqualifiers)}`,
    "",
    "## What the sender sells (for the aiOpportunity field)",
    `Offer: ${offer.title}`,
    `Description: ${offer.description}`,
    "",
    `Today is ${input.today}. Prefer evidence from the last 18 months and include dates when the`,
    "source states them.",
    "",
    "## What to return",
    "- summary: 2–4 sentences on what this company does today and what is changing for them.",
    "- signals: up to 8 company facts, each with the exact source URL. Only facts you actually saw.",
    "- likelyPains: at most 3, each traceable to a signal above.",
    "- aiOpportunity: one concrete idea tied to the offer, 1–3 sentences.",
    "- hooks: up to 3 candidate opening observations, each pointing at a signal index.",
    "- confidence: \"low\", \"medium\" or \"high\" — how much the evidence supports the brief.",
  ].join("\n");
}

/** Appended to the single retry after a schema failure (section 10 rule 5). */
export function researchRepairHint(): string {
  return [
    "Return ONLY the JSON object. Required fields: summary (string), signals (array of",
    '{ fact, url, date? }), likelyPains (array of strings, max 3), aiOpportunity (string),',
    "hooks (array of { text, signalIndex }), confidence (\"low\"|\"medium\"|\"high\").",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Phase 2: synthesis
// ---------------------------------------------------------------------------

/**
 * The synthesis call is the second half of the research agent: the tool loop collects
 * raw evidence, then this prompt turns it into the `ResearchBrief` object. It is a pure
 * function of the original research input plus the tool transcript, which is what the
 * promptfoo evals exercise.
 */
export function researchSynthesisSystemPrompt(): string {
  return [
    "You are Scout's research agent, writing the final brief after the investigation is",
    "over. You receive the company context and a transcript of every tool call made.",
    "",
    "## Hard rules",
    "1. Use only facts that appear in the transcript. Never invent a fact, number, client,",
    "   date or quote.",
    "2. Every signal needs the exact URL it came from.",
    "3. Company-level public facts only; no personal data about any individual.",
    "4. Fewer, honest signals beat many weak ones. If the transcript is thin, use \"low\"",
    "   confidence and fewer signals.",
    "5. `aiOpportunity` is ONE concrete idea tied to the sender's offer.",
    "6. Each hook's `signalIndex` must point at one of the signals you return (0-based).",
    "7. Return only the JSON object; no prose around it.",
  ].join("\n");
}

export function researchSynthesisUserPrompt(input: {
  input: ResearchPromptInput;
  evidence: string;
}): string {
  return [
    researchUserPrompt(input.input),
    "",
    "## Tool transcript",
    input.evidence,
    "",
    "Write the brief now, grounded in the transcript above.",
  ].join("\n");
}

/** Kept next to the prompt so a reader can see the shape the prompt targets. */
export type ResearchPromptOutput = ResearchBriefOutput;

function listOrNone(values: string[]): string {
  return values.length > 0 ? values.join("; ") : "none stated";
}
