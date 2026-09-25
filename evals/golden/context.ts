import type { CopyOfferContext } from "@/src/ai/prompts/copy";
import type { Angle } from "@/src/domain/types";

import type { GoldenIcp } from "./types";

/**
 * Shared scenario context for every eval. One ICP, one offer, three angles — exactly the
 * shape the real scorer and copywriter receive from the database, without a database.
 */

/** Section 6's `ScoreIcpContext` shape; `src/ai/agents/score.ts` takes it unchanged. */
export const GOLDEN_ICP: GoldenIcp = {
  name: "Ops-heavy B2B SaaS and e-commerce teams",
  rationale:
    "Teams between 11 and 1000 people where support, reporting or inbound qualification is still done by hand and one shipped workflow is visible in two weeks.",
  pains: [
    "Support volume grows faster than headcount",
    "Manual triage, routing and reporting consume specialist time",
    "Data is spread across helpdesk, CRM and spreadsheets",
  ],
  triggers: [
    "Hiring support or operations roles",
    "Raised a funding round in the last 12 months",
    "Migrating helpdesk or CRM",
  ],
  titles: [
    "Head of Operations",
    "COO",
    "Head of Customer Support",
    "VP Operations",
    "Head of Customer Experience",
  ],
  industries: ["Software", "Information Technology", "E-commerce", "Logistics"],
  sizeBands: ["11-50", "51-200", "201-1000"],
  geos: ["United States", "United Kingdom", "Germany", "Canada", "France", "Netherlands"],
  disqualifiers: ["crypto", "gambling", "adult", "recruitment agency", "ai automation agency", "staffing agency"],
};

/** Section 6's ICP angles; `Draft.angle` must be one of these keys. */
export const GOLDEN_ANGLES: readonly Angle[] = [
  {
    key: "support_triage",
    hook: "Their support queue grows faster than the team; a triage agent can classify and route tickets before a human opens them.",
  },
  {
    key: "ops_reporting",
    hook: "Weekly ops reporting is stitched together by hand; an agent can compile it from the tools they already use.",
  },
  {
    key: "lead_qualification",
    hook: "Inbound leads arrive faster than sales can qualify them; a scoring agent can sort and route them.",
  },
];

/** Section 6: proof comes only from the offer record, so evals need one with real-looking proof. */
export const GOLDEN_OFFER: CopyOfferContext = {
  title: "AI workflow builds for support and ops teams",
  description:
    "I scope and ship one production AI workflow in two weeks: ticket triage, weekly ops reporting or inbound lead scoring, built on the tools the team already pays for.",
  proof: [
    { label: "Support triage", detail: "First-response time down 38% for a 40-person SaaS support team." },
    { label: "Ops reporting", detail: "A 12-person ops team stopped spending about 20 hours a month compiling weekly reports." },
  ],
};

/** Section 9: every email carries who the owner is plus a postal address. Fictional here. */
export const GOLDEN_SIGNATURE = {
  signature: "Karim B.",
  postalAddress: "1 Example Street, 75001 Paris, France",
};

/** The thread a follow-up test continues; drafted once, reused everywhere. */
export const GOLDEN_THREAD = {
  subject: "Ticket triage before your team opens the queue",
  body: [
    "Hi,",
    "",
    "I saw Brightloom is hiring three support agents. Before those seats are filled, a triage",
    "agent could classify and route incoming tickets so the team only sees the ones that need",
    "a human.",
    "",
    "Worth a 15-minute look at how that would sit on top of your helpdesk?",
    "",
    "Karim B.",
    "1 Example Street, 75001 Paris, France",
  ].join("\n"),
};

/** Fixed clock for eligibility checks; no live reads in evals. */
export const GOLDEN_NOW = new Date("2026-09-25T09:00:00.000Z");

export function findAngle(key: string): Angle {
  const angle = GOLDEN_ANGLES.find((candidate) => candidate.key === key);
  if (!angle) throw new Error(`Golden angle "${key}" does not exist. Known keys: ${GOLDEN_ANGLES.map((a) => a.key).join(", ")}`);
  return angle;
}
