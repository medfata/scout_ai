/**
 * No-key self-test fixture for the real assertion scripts.
 *
 * It returns the same metadata shape the real providers return, so `evals/smoke/assertions.yaml`
 * can run `copy-rules.ts`, `scorer-expectations.ts`, `lead-facts.ts` and the classifier
 * assertions without an AI Gateway key. Two of the scenarios are deliberately wrong and are
 * checked with `not-javascript`, proving the assertions can fail.
 *
 * Bodies and scores here are fabricated for the harness; nothing is sent.
 */
import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";

import { buildSignature } from "@/src/domain/copy-rules";

import { GOLDEN_ANGLES, GOLDEN_SIGNATURE, emailFirstTouchStep, findAngle, leadById, replyById } from "../golden/leads";
import { readVar } from "../lib/grading";

const SIGNATURE_BLOCK = buildSignature(GOLDEN_SIGNATURE.signature, GOLDEN_SIGNATURE.postalAddress);

/**
 * Note: `DEFAULT_OPT_OUT_LINE` from the app is deliberately NOT used here.
 * `src/domain/copy-rules.ts` does not recognise its own default opt-out line yet
 * ("Missing opt-out line" was observed on 2026-09-25); that finding is reported in the stage
 * report, and the real provider keeps using the app's default. This fixture uses a phrase the
 * code check recognises so the self-test exercises assertion plumbing, not an app bug.
 */
const FIXTURE_OPT_OUT_LINE = "Reply stop to opt out.";

const VALID_BODY = [
  "Hi,",
  "",
  "Brightloom is hiring three support agents at once, and the helpdesk migration is the moment",
  "before that backlog moves over. Before the new seats fill, a triage agent could classify and",
  "route tickets so your team only opens the ones that need a human.",
  "",
  "Worth a 15-minute look at where that would sit in your queue?",
  "",
  SIGNATURE_BLOCK,
  FIXTURE_OPT_OUT_LINE,
].join("\n");

const VALID_DRAFT = {
  subject: "Ticket triage before your team opens the queue",
  body: VALID_BODY,
  claims: [
    { text: "hiring three support agents at once", signalIndex: 0 },
    { text: "a helpdesk migration is underway", signalIndex: 1 },
  ],
  cta: "Worth a 15-minute look at where that would sit in your queue?",
  angle: findAngle("support_triage").key,
};

const VIOLATING_DRAFT = {
  ...VALID_DRAFT,
  body: [
    "Hi,",
    "",
    "I saw the helpdesk migration. Here is a case study: https://example.com/case-study",
    "",
    "Worth a look?",
    "",
    SIGNATURE_BLOCK,
    FIXTURE_OPT_OUT_LINE,
  ].join("\n"),
};

function copyPayload(leadId: string, draft: typeof VALID_DRAFT): Record<string, unknown> {
  const lead = leadById(leadId);
  const step = emailFirstTouchStep();
  const angle = findAngle("support_triage");
  return {
    leadId,
    stepKey: step.key,
    stepKind: step.kind,
    channel: step.channel,
    isFirstTouch: step.kind === "first_touch",
    outcome: "passed",
    draft,
    verdict: { passed: true, criticPassed: true, violations: [], criticViolations: [], fix: null },
    signalCount: lead.brief.signals.length,
    angleKeys: GOLDEN_ANGLES.map((candidate) => candidate.key),
    angle: angle.key,
    proofCount: 2,
    hasSignature: true,
    signatureBlock: SIGNATURE_BLOCK,
    optOutLine: FIXTURE_OPT_OUT_LINE,
    attempts: 1,
    model: "fixture",
    costUsd: 0,
  };
}

export default class AssertionResultsProvider implements ApiProvider {
  id(): string {
    return "scout-eval:assertion-results";
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const scenario = readVar(context, "scenario");
    const leadId = readVar(context, "leadId");

    switch (scenario) {
      case "scorer-ok":
        return metadata({
          leadId: "clear-fit-support-saas",
          score: 88,
          tier: "A",
          disqualified: false,
          disqualifiedReason: null,
        });
      case "scorer-wrong":
        return metadata({
          leadId: "clear-fit-support-saas",
          score: 52,
          tier: "C",
          disqualified: false,
          disqualifiedReason: null,
        });
      case "copy-ok":
        return metadata(copyPayload(leadId ?? "clear-fit-support-saas", VALID_DRAFT));
      case "copy-violates":
        return metadata(copyPayload(leadId ?? "clear-fit-support-saas", VIOLATING_DRAFT));
      case "classifier-ok": {
        const reply = replyById("ooo-explicit-date");
        return metadata({
          replyId: reply.id,
          intent: reply.intent,
          returnDate: "2026-10-05",
          followUpAfter: null,
          referral: null,
        });
      }
      default:
        return { error: `assertion-results provider: unknown scenario "${scenario ?? "(missing)"}"` };
    }
  }
}

function metadata(scout: Record<string, unknown>): ProviderResponse {
  return { output: JSON.stringify({ fixture: true }), metadata: { scout } };
}
