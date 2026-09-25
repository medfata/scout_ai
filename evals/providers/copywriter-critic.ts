/**
 * Copywriter + critic eval provider. It calls the real `draftMessage` agent, which runs the
 * real evaluator–optimizer loop: `copySystemPrompt`/`copyUserPrompt` from
 * `src/ai/prompts/copy.ts` through `generateStructured`, then `critiqueDraft` (the critic
 * prompt plus `evaluateCopyRules` in code), then up to two revisions (section 6).
 *
 * Nothing here can send: the agent depends on draft/critique calls only, and the step keys come
 * from the real `email_linkedin_v1` template (section 7). The printed output is redacted; the
 * draft and the merged verdict travel in `metadata.scout` for the assertions.
 */
import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";

import { bodyHasSignature, draftMessage } from "@/src/ai/agents/copy";
import { buildSignature, DEFAULT_OPT_OUT_LINE } from "@/src/domain/copy-rules";
import { EMAIL_LINKEDIN_V1 } from "@/src/domain/sequence";

import { requireEvalEnv } from "../lib/env";
import { readVar } from "../lib/grading";
import {
  findAngle,
  GOLDEN_ANGLES,
  GOLDEN_ICP,
  GOLDEN_OFFER,
  GOLDEN_SIGNATURE,
  GOLDEN_THREAD,
  leadById,
} from "../golden/leads";

export default class CopywriterCriticProvider implements ApiProvider {
  id(): string {
    return "scout-eval:copywriter-critic";
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    requireEvalEnv();

    const leadId = readVar(context, "leadId");
    if (leadId === null) return { error: "copywriter eval: vars.leadId is required" };

    const stepKey = readVar(context, "stepKey") ?? "email_1";
    const step = EMAIL_LINKEDIN_V1.steps.find((candidate) => candidate.key === stepKey);
    if (!step) {
      return { error: `copywriter eval: email_linkedin_v1 has no step "${stepKey}"` };
    }

    const lead = leadById(leadId);
    const offerVariant = readVar(context, "offerVariant");
    const offer = offerVariant === "no_proof" ? { ...GOLDEN_OFFER, proof: [] } : GOLDEN_OFFER;
    const angle = findAngle(readVar(context, "angleKey") ?? "support_triage");
    const threadContext = step.thread === "same" ? GOLDEN_THREAD : null;
    const signatureBlock = buildSignature(GOLDEN_SIGNATURE.signature, GOLDEN_SIGNATURE.postalAddress);

    const result = await draftMessage({
      enrollmentId: `eval:${lead.id}:${step.key}`,
      contactId: `eval:${lead.id}`,
      step,
      channel: step.channel,
      threadContext,
      offer,
      icp: { name: GOLDEN_ICP.name, angles: [...GOLDEN_ANGLES] },
      angle,
      brief: lead.brief,
      recipient: { companyName: lead.company.name, contactTitle: lead.contactTitle },
      settings: {
        signature: GOLDEN_SIGNATURE.signature,
        postalAddress: GOLDEN_SIGNATURE.postalAddress,
        autonomyLevel: "L0",
      },
      tier: lead.expect.tier ?? null,
      language: lead.language,
    });

    const draft = result.draft;
    const violations = (result.verdict?.violations ?? []).map(
      (violation) => `${violation.severity}:${violation.code}`,
    );
    const criticViolations = (result.verdict?.critic.violations ?? []).map(
      (violation) => `${violation.severity}:${violation.code}`,
    );

    return {
      output: JSON.stringify({
        leadId: lead.id,
        stepKey: step.key,
        outcome: result.outcome,
        criticPassed: result.verdict?.criticPassed ?? null,
        violations,
      }),
      metadata: {
        scout: {
          leadId: lead.id,
          stepKey: step.key,
          stepKind: step.kind,
          channel: step.channel,
          isFirstTouch: step.kind === "first_touch",
          outcome: result.outcome,
          draft,
          verdict: result.verdict
            ? {
                passed: result.verdict.passed,
                criticPassed: result.verdict.criticPassed,
                violations,
                criticViolations,
                fix: result.verdict.fix,
              }
            : null,
          signalCount: lead.brief.signals.length,
          angleKeys: GOLDEN_ANGLES.map((candidate) => candidate.key),
          angle: angle.key,
          proofCount: offer.proof.length,
          hasSignature: draft !== null && bodyHasSignature(draft.body, signatureBlock),
          signatureBlock,
          optOutLine: DEFAULT_OPT_OUT_LINE,
          attempts: result.attempts,
          model: result.model,
          costUsd: result.costUsd,
        },
      },
    };
  }
}
