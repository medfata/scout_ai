import type { ResearchBriefOutput } from "@/src/ai/schemas";
import type { EmailStatus, SizeBand } from "@/src/domain/types";

/**
 * Section 6: the scorer is an "LLM rubric; code rules override". This prompt asks the
 * model for a 0–100 fit score and its reasons; `src/ai/agents/score.ts` then applies the
 * code rules (suppression, email sendability, ICP disqualifiers) on top.
 *
 * The model never returns a tier: tiers come from `tierFor` in `src/domain/scoring.ts`
 * so the cutoffs stay in one place.
 */

export const SCORE_PROMPT_VERSION = "score.v1";

export interface ScoreIcpContext {
  name: string;
  rationale: string;
  pains: string[];
  triggers: string[];
  titles: string[];
  industries: string[];
  sizeBands: SizeBand[];
  geos: string[];
  disqualifiers: string[];
}

export interface ScoreLeadFacts {
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  industry: string | null;
  sizeBand: SizeBand | null;
  country: string | null;
  emailStatus: EmailStatus;
  /** True when the contact or its company is on the do-not-contact list. */
  suppressed: boolean;
}

export interface ScorePromptInput {
  icp: ScoreIcpContext;
  lead: ScoreLeadFacts;
  brief: ResearchBriefOutput;
}

/** Static context first (section 6, prompt caching). */
export function scoreSystemPrompt(): string {
  return [
    "You are Scout's lead scorer. You judge how well ONE lead fits ONE ideal-customer",
    "profile, using the research brief as evidence. Code applies hard overrides after you;",
    "your job is the nuanced part, not the rules.",
    "",
    "## Rubric (0–100 total)",
    "- 0–30 pain fit: how closely the company's situation matches the ICP's pains and triggers.",
    "- 0–20 evidence strength: how specific and recent the signals in the brief are.",
    "- 0–25 ability to pay: headcount, industry and buying signals suggest a real budget.",
    "- 0–15 reachability: a real, role-relevant person at the company is reachable.",
    "- 0–10 speed to close: a trigger suggests they may act soon.",
    "",
    "## Rules",
    "- Score low and say why when the brief is thin; never inflate for a nicer number.",
    "- Set `disqualified: true` when the lead clearly contradicts the ICP or matches a",
    "  disqualifier, and give the concrete `disqualifiedReason`.",
    "- `reasons` is 1–6 short bullet sentences that cite the evidence (a signal, a title,",
    "  a size band). No generic praise.",
    "- Return only the JSON object: score, reasons, disqualified, disqualifiedReason.",
  ].join("\n");
}

export function scoreUserPrompt(input: ScorePromptInput): string {
  const { icp, lead, brief } = input;
  return [
    "## ICP",
    `Name: ${icp.name}`,
    `Rationale: ${icp.rationale}`,
    `Target titles: ${listOrNone(icp.titles)}`,
    `Industries: ${listOrNone(icp.industries)}`,
    `Size bands: ${listOrNone(icp.sizeBands)}`,
    `Geographies: ${listOrNone(icp.geos)}`,
    `Pains: ${listOrNone(icp.pains)}`,
    `Triggers: ${listOrNone(icp.triggers)}`,
    `Disqualifiers: ${listOrNone(icp.disqualifiers)}`,
    "",
    "## Lead",
    `Title: ${lead.title ?? "unknown"}`,
    `Company: ${lead.companyName ?? "unknown"}`,
    `Company domain: ${lead.companyDomain ?? "unknown"}`,
    `Industry: ${lead.industry ?? "unknown"}`,
    `Headcount band: ${lead.sizeBand ?? "unknown"}`,
    `Country: ${lead.country ?? "unknown"}`,
    `Email status: ${lead.emailStatus}`,
    `On the do-not-contact list: ${lead.suppressed ? "yes" : "no"}`,
    "",
    "## Research brief (evidence)",
    `Summary: ${brief.summary}`,
    `Likely pains: ${listOrNone(brief.likelyPains)}`,
    `AI opportunity: ${brief.aiOpportunity}`,
    `Confidence: ${brief.confidence}`,
    "Signals:",
    ...(brief.signals.length > 0
      ? brief.signals.map((signal, index) => `  [${index}] ${signal.fact} (${signal.url})`)
      : ["  none"]),
    "",
    "Return the score object now.",
  ].join("\n");
}

/** Appended to the single retry after a schema failure (section 10 rule 5). */
export function scoreRepairHint(): string {
  return [
    "Return ONLY the JSON object: { score: integer 0-100, reasons: string[1-6],",
    "disqualified: boolean, disqualifiedReason?: string (required when disqualified). }",
  ].join("\n");
}

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join("; ") : "none stated";
}
