import type { IcpOutput } from "@/src/ai/schemas";
import type { ProofItem } from "@/src/domain/types";

/**
 * Section 6, "Prompt hygiene": prompts are versioned functions in `src/ai/prompts/`.
 * Static context (offer, proof, rules, learnings) goes first — `src/ai/agents/icp.ts`
 * passes it as the system message so provider prompt caching applies — and the request
 * that changes per call is the user message.
 *
 * Bump the version whenever the wording of either prompt changes: `icp/v2`.
 */
export const ICP_PROMPT_VERSION = "icp/v1";

/**
 * The phase-1 brief names this constant `ICPC_PROMPT_VERSION`; the alias keeps both
 * spellings on the same value.
 */
export const ICPC_PROMPT_VERSION = ICP_PROMPT_VERSION;

export interface IcpPromptOffer {
  title: string;
  description: string;
  /** Case studies, demos, numbers. The only evidence a prompt may reference. */
  proof: ProofItem[];
  priceHint?: string | null;
}

export interface IcpGenerationContext {
  offer: IcpPromptOffer;
  /** Distilled insights from the learning loop (phase 7); empty in phase 1. */
  learnings: string[];
}

export interface IcpCritiqueContext {
  offer: IcpPromptOffer;
  icps: IcpOutput[];
}

export interface PromptParts {
  /** Static context: passed as the system message. */
  system: string;
  /** The dynamic request: changes per call. */
  prompt: string;
}

const SCORE_RUBRIC = [
  "- pain: how frequent and expensive the problem is for this segment.",
  "- budget: whether the segment can pay for the offer without a long procurement cycle.",
  "- reach: whether Scout can find these people and their emails with Exa/Apollo-class tools, without gatekeepers.",
  "- proofFit: how well the offer's recorded proof matches this segment's problem.",
  "- speed: how quickly the segment can say yes and start.",
].join("\n");

/**
 * Section 6 ICP generator. The model proposes the set; `rankIcpCandidates` and the
 * critic in `src/ai/agents/icp.ts` decide the order.
 */
export function buildIcpGenerationPrompt(context: IcpGenerationContext): PromptParts {
  const system = [
    "You are Scout's ICP strategist for a one-person AI problem-solving studio.",
    "Turn one offer into 3-7 ideal customer profiles (ICPs) the owner can reach, research and sell to with cold email and assisted LinkedIn outreach.",
    "",
    offerBlock(context.offer),
    "",
    "## Hard rules",
    "- Return between 3 and 7 ICPs. Fewer or more fails schema validation and wastes the run.",
    "- Every ICP needs at least 2 distinct pains, 2-3 angles, and an Exa search: `exa.query` plus up to 5 `exa.criteria`.",
    "- `angles` are outreach angles: `key` is a short slug, `hook` is one opening sentence tied to a pain or trigger.",
    '- `sizeBands` values must come from this exact list: "1-10", "11-50", "51-200", "201-1000", "1000+".',
    "- `titles` are job titles to search for, `industries` are plain industry words, `geos` are countries or regions, `disqualifiers` are short phrases that mean \"skip this company\".",
    "- `triggers` are observable events (hiring for a role, launching a product, raising a round, starting an AI initiative).",
    "- Scores are integers from 1 to 5 on each criterion. Use the whole range: a set where every ICP scores 4-5 is useless for ranking.",
    SCORE_RUBRIC,
    "",
    "## Never",
    "- Never invent proof, clients, numbers or results. The offer block above is the only evidence you may cite. If proof is thin, say so in the rationale and lower `proofFit`.",
    "- Never include personal data or private information about individuals. ICPs describe segments, not people.",
    "- Never output Apollo or other vendor field names. Only the Exa query and criteria; code maps them to providers later.",
    "",
    "## House style",
    "- English, concrete, no hype adjectives (revolutionary, cutting-edge, 10x).",
    "- The rationale is for the owner: why this segment, why now, why it is reachable.",
    "",
    learningsBlock(context.learnings),
    "",
    "## Output",
    'Return JSON exactly matching this shape: {"icps":[{"name","rationale","pains":[at least 2],"triggers":[],"titles":[at least 1],"industries":[at least 1],"sizeBands":[],"geos":[],"disqualifiers":[],"angles":[2-3 x {"key","hook"}],"exa":{"query","criteria":[at most 5]},"scores":{"pain","budget","reach","proofFit","speed"}}]}',
  ].join("\n");

  return {
    system,
    prompt: "Generate the candidate ICP set for this offer now. Do not rank them; the critic and the code rank afterwards.",
  };
}

/**
 * Section 6 ICP critic: re-scores every candidate on the same five criteria and names
 * the ones to drop. Code applies the merger afterwards with `rankIcpCandidates`.
 */
export function buildIcpCritiquePrompt(context: IcpCritiqueContext): PromptParts {
  const system = [
    "You are Scout's ICP critic. You re-score candidate ICPs for one offer on five criteria and cut the weak ones. You never rewrite candidates and never invent evidence.",
    "",
    offerBlock(context.offer),
    "",
    "## Scoring (integers 1-5)",
    SCORE_RUBRIC,
    "",
    "## How to judge",
    "- Score what the candidate actually claims, not what it could have claimed. Vague titles, untestable industries, or geos where emails are unreachable score low on `reach`.",
    "- `proofFit` is capped by the offer's recorded proof: if the proof block has nothing for a segment, `proofFit` cannot exceed 2.",
    "- Drop a candidate only when it is clearly weak: no proof fit, unreachable segment, or an offer that cannot serve it. Never drop more than half of the set; when in doubt, keep it and lower its scores.",
    "- List every candidate you were given in `rankings`, including the dropped ones, each with scores and a one-line note.",
    "",
    "## Output",
    'Return JSON exactly matching this shape: {"rankings":[{"name","scores":{"pain","budget","reach","proofFit","speed"},"note"}],"drop":[{"name","reason"}]}',
  ].join("\n");

  return {
    system,
    prompt: [
      "Candidate ICPs to re-score and prune:",
      JSON.stringify({ icps: context.icps }, null, 2),
      "",
      "Return the critique now.",
    ].join("\n"),
  };
}

function offerBlock(offer: IcpPromptOffer): string {
  const proof =
    offer.proof.length > 0
      ? offer.proof.map((item) => `- ${item.label}: ${item.detail}${item.url ? ` (${item.url})` : ""}`).join("\n")
      : "- No proof recorded yet. Treat proofFit as 1-2 for every candidate and say so in the rationale.";

  return [
    "## The offer (the only allowed evidence)",
    `Title: ${offer.title}`,
    `Description: ${offer.description}`,
    ...(offer.priceHint ? [`Price hint: ${offer.priceHint}`] : []),
    "Recorded proof:",
    proof,
  ].join("\n");
}

function learningsBlock(learnings: string[]): string {
  if (learnings.length === 0) return "## Learnings\nNo learnings recorded yet.";

  return [
    "## Learnings from previous outreach (apply these, never contradict the proof above)",
    ...learnings.map((text) => `- ${text}`),
  ].join("\n");
}
