import { z } from "zod";

import { SIZE_BANDS } from "@/src/domain/types";

/**
 * Section 6's output schemas, written as the plan specifies and extended only where a
 * downstream rule needs a field (each addition is commented).
 *
 * Every model call is parsed with one of these. `src/ai/client.ts` retries once on a
 * schema failure and then marks the item "needs owner" (section 10 rule 5).
 */

// ---------------------------------------------------------------------------
// ICP generator + critic
// ---------------------------------------------------------------------------

export const AngleSchema = z.object({
  key: z.string().min(1).max(40),
  hook: z.string().min(1).max(240),
});

export const IcpScoresSchema = z.object({
  pain: z.number().int().min(1).max(5),
  budget: z.number().int().min(1).max(5),
  reach: z.number().int().min(1).max(5),
  proofFit: z.number().int().min(1).max(5),
  speed: z.number().int().min(1).max(5),
});

export const IcpSchema = z.object({
  name: z.string().min(1).max(120),
  rationale: z.string().min(1).max(600),
  pains: z.array(z.string()).min(2),
  triggers: z.array(z.string()),
  titles: z.array(z.string()).min(1),
  industries: z.array(z.string()).min(1),
  sizeBands: z.array(z.enum(SIZE_BANDS)),
  geos: z.array(z.string()),
  disqualifiers: z.array(z.string()),
  angles: z.array(AngleSchema).min(2).max(3),
  exa: z.object({ query: z.string().min(1), criteria: z.array(z.string()).max(5) }),
  scores: IcpScoresSchema,
});

export const IcpSetSchema = z.object({
  icps: z.array(IcpSchema).min(3).max(7),
});

export type IcpOutput = z.infer<typeof IcpSchema>;
export type IcpSetOutput = z.infer<typeof IcpSetSchema>;

/** The critic ranks and prunes the generated set; code then re-ranks with `rankIcps`. */
export const IcpCritiqueSchema = z.object({
  rankings: z
    .array(
      z.object({
        name: z.string(),
        scores: IcpScoresSchema,
        note: z.string().max(300),
      }),
    )
    .min(1),
  drop: z.array(z.object({ name: z.string(), reason: z.string().max(300) })).max(6),
});

export type IcpCritiqueOutput = z.infer<typeof IcpCritiqueSchema>;

// ---------------------------------------------------------------------------
// Research agent
// ---------------------------------------------------------------------------

export const ResearchBriefSchema = z.object({
  summary: z.string().max(600),
  signals: z
    .array(
      z.object({
        fact: z.string().max(400),
        url: z.string().url(),
        date: z.string().optional(),
      }),
    )
    .max(8),
  likelyPains: z.array(z.string()).max(3),
  aiOpportunity: z.string().min(1).max(600),
  hooks: z
    .array(
      z.object({
        text: z.string().max(300),
        signalIndex: z.number().int().min(0),
      }),
    )
    .max(3),
  confidence: z.enum(["low", "medium", "high"]),
});

export type ResearchBriefOutput = z.infer<typeof ResearchBriefSchema>;

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

export const LeadScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string().max(240)).min(1).max(6),
  disqualified: z.boolean(),
  disqualifiedReason: z.string().max(240).optional(),
});

export type LeadScoreOutput = z.infer<typeof LeadScoreSchema>;

// ---------------------------------------------------------------------------
// Copywriter + critic
// ---------------------------------------------------------------------------

export const DraftSchema = z.object({
  subject: z.string().max(60).optional(),
  body: z.string().min(1),
  claims: z.array(z.object({ text: z.string(), signalIndex: z.number().int().min(0) })).max(5),
  cta: z.string().min(1),
  angle: z.string().min(1),
});

export type DraftOutput = z.infer<typeof DraftSchema>;

export const CriticResultSchema = z.object({
  passed: z.boolean(),
  violations: z
    .array(
      z.object({
        code: z.string().max(60),
        message: z.string().max(300),
        severity: z.enum(["error", "warning"]),
      }),
    )
    .max(10),
  /** Concrete instruction for the revision loop; required when `passed` is false. */
  fix: z.string().max(600).optional(),
});

export type CriticResultOutput = z.infer<typeof CriticResultSchema>;

// ---------------------------------------------------------------------------
// Reply classifier
// ---------------------------------------------------------------------------

export const ReplyLabelSchema = z.object({
  intent: z.enum([
    "interested",
    "meeting_request",
    "question",
    "referral",
    "not_now",
    "not_interested",
    "unsubscribe",
    "out_of_office",
    "bounce",
    "auto_reply",
    "other",
  ]),
  summary: z.string().max(200),
  returnDate: z.string().optional(),
  followUpAfter: z.string().optional(),
  referral: z
    .object({ name: z.string(), email: z.string().optional(), title: z.string().optional() })
    .optional(),
});

export type ReplyLabelOutput = z.infer<typeof ReplyLabelSchema>;

// ---------------------------------------------------------------------------
// Suggested reply (section 7: "alert the owner, suggest a response")
// ---------------------------------------------------------------------------

export const SuggestedReplySchema = z.object({
  subject: z.string().max(80).optional(),
  body: z.string().min(1).max(2000),
});

export type SuggestedReplyOutput = z.infer<typeof SuggestedReplySchema>;

// ---------------------------------------------------------------------------
// Weekly strategist (phase 7 — schema lives here so the prompt file can be versioned
// with it, but nothing calls it yet)
// ---------------------------------------------------------------------------

export const StrategyProposalSchema = z.object({
  proposals: z
    .array(
      z.object({
        kind: z.enum(["icp", "angle", "learning"]),
        icpName: z.string().optional(),
        angleKey: z.string().optional(),
        change: z.string().max(400),
        reason: z.string().max(400),
        evidence: z.array(z.string().max(200)).max(5),
      }),
    )
    .max(6),
});

export type StrategyProposalOutput = z.infer<typeof StrategyProposalSchema>;
