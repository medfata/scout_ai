import type { ScoreIcpContext } from "@/src/ai/prompts/score";
import type { ScoreLeadFacts } from "@/src/ai/prompts/score";
import { EMAIL_LINKEDIN_V1, type SequenceStep } from "@/src/domain/sequence";
import type { LeadContext } from "@/src/domain/types";

import { GOLDEN_ICP } from "./context";
import { LEADS_A } from "./leads-a";
import { LEADS_B } from "./leads-b";
import type { GoldenLead } from "./types";

export { GOLDEN_ANGLES, GOLDEN_ICP, GOLDEN_NOW, GOLDEN_OFFER, GOLDEN_SIGNATURE, GOLDEN_THREAD, findAngle } from "./context";
export type {
  GoldenCompany,
  GoldenExpectation,
  GoldenLead,
  LabelledReply,
} from "./types";
export { GOLDEN_REPLIES, GOLDEN_REPLY_BY_ID, replyById } from "./replies";

/** 25 fictional leads: clear fit (A), weak fit, disqualifiers, thin sites, non-English, consent, catch-all. */
export const GOLDEN_LEADS: readonly GoldenLead[] = [...LEADS_A, ...LEADS_B];

const BY_ID: ReadonlyMap<string, GoldenLead> = new Map(GOLDEN_LEADS.map((lead) => [lead.id, lead]));

export const GOLDEN_LEAD_BY_ID = BY_ID;

export function leadById(id: string): GoldenLead {
  const lead = BY_ID.get(id);
  if (!lead) {
    throw new Error(`Unknown golden lead "${id}". Known ids: ${[...BY_ID.keys()].join(", ")}`);
  }
  return lead;
}

/** The lead half of `ScoreLeadFacts`, exactly as `scoreLead` reads it. */
export function leadFactsFor(lead: GoldenLead): ScoreLeadFacts {
  return {
    title: lead.contactTitle,
    companyName: lead.company.name,
    companyDomain: lead.company.domain,
    industry: lead.company.industry,
    sizeBand: lead.company.sizeBand,
    country: lead.company.country,
    emailStatus: lead.emailStatus,
    suppressed: lead.suppressed,
  };
}

/** The ICP half of the scorer input. */
export function icpForScore(): ScoreIcpContext {
  return {
    name: GOLDEN_ICP.name,
    rationale: GOLDEN_ICP.rationale,
    pains: [...GOLDEN_ICP.pains],
    triggers: [...GOLDEN_ICP.triggers],
    titles: [...GOLDEN_ICP.titles],
    industries: [...GOLDEN_ICP.industries],
    sizeBands: [...GOLDEN_ICP.sizeBands],
    geos: [...GOLDEN_ICP.geos],
    disqualifiers: [...GOLDEN_ICP.disqualifiers],
  };
}

/** A lead context for `resolveStepEligibility`; fictional `.example` address, never contacted. */
export function leadContextFor(lead: GoldenLead): LeadContext {
  return {
    contactId: `eval:${lead.id}`,
    email: `contact@${lead.company.domain}`,
    emailStatus: lead.emailStatus,
    linkedinUrl: `https://linkedin.example/company/${lead.company.domain.replace(".example", "")}`,
    inviteAccepted: false,
    inviteSentAt: null,
    enrollmentStartedAt: "2026-09-25T09:00:00.000Z",
  };
}

/** Section 7's email first-touch step, the one every lead starts on. */
export function emailFirstTouchStep(): SequenceStep {
  const step = EMAIL_LINKEDIN_V1.steps.find((candidate) => candidate.kind === "first_touch");
  if (!step) throw new Error("email_linkedin_v1 no longer has a first-touch step; evals/ and gate 3 need it.");
  return step;
}
