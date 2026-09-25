import type { ResearchBriefOutput } from "@/src/ai/schemas";
import type { Angle, EmailStatus, SizeBand, Tier } from "@/src/domain/types";
import type { SkipReason } from "@/src/domain/types";

/**
 * Golden-set vocabulary (section 11 phase 3, stage 1b).
 *
 * Every fixture is fictional: `.example` domains, invented companies, invented people. Briefs
 * are fixed on purpose — evals never run live research (stage 1b) — and signal indices are
 * numbered so `Draft.claims[].signalIndex` and the copy-rule check can be exercised exactly
 * as they are in the real pipeline.
 */

export interface GoldenCompany {
  name: string;
  /** Always a `.example` domain: fictional, and the model must not fetch anything. */
  domain: string;
  industry: string;
  sizeBand: SizeBand;
  country: string | null;
}

/** What code (not a model) can check about a fixture's outcome after the real pipeline ran. */
export interface GoldenExpectation {
  /** true = must be disqualified; false = must not be; "either" = weak fixture, code rules may go either way. */
  disqualified: boolean | "either";
  /** Exact tier after `applyScoreRules`, when the fixture is strong enough to know it. */
  tier?: Tier | null;
  minScore?: number;
  maxScore?: number;
  /** Case-insensitive substring the disqualification reason must contain. */
  disqualifiedReasonIncludes?: string;
  /** What `resolveStepEligibility` must say for the email first-touch step (section 7). */
  emailEligibility?: { eligible: boolean; reason?: SkipReason };
}

export interface GoldenLead {
  id: string;
  /** One line: what this fixture is testing. */
  tests: string;
  company: GoldenCompany;
  contactTitle: string;
  /** Prospect language; null means English. Used by the copywriter. */
  language: string | null;
  emailStatus: EmailStatus;
  /** Contact or company is on the do-not-contact list (section 9). */
  suppressed: boolean;
  /** Fixed brief with numbered signals; no live research in evals. */
  brief: ResearchBriefOutput;
  expect: GoldenExpectation;
}

export interface LabelledReply {
  id: string;
  /** The expected `ReplyLabel.intent` from `src/ai/schemas.ts`. */
  intent: import("@/src/domain/types").ReplyIntent;
  /** What this fixture is testing. */
  tests: string;
  subject: string | null;
  body: string;
  fromName: string | null;
  companyName: string | null;
  /** The outbound message this replies to, when the fixture needs thread context. */
  previousMessage?: string;
  /** Extra code-checked facts beyond the intent. */
  expect?: {
    returnDate?: { present: boolean; exact?: string };
    followUpAfter?: { present: boolean };
    referralName?: string;
  };
}

export interface GoldenIcp {
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

export type GoldenAngles = readonly Angle[];
