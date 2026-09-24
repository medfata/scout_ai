import { describe, expect, it } from "vitest";

import { LlmValidationError, type StructuredCallResult } from "@/src/ai/client";
import type { CopyPromptInput } from "@/src/ai/prompts/copy";
import { DraftSchema, type DraftOutput, type ResearchBriefOutput } from "@/src/ai/schemas";
import { EMAIL_LINKEDIN_V1, type SequenceStep } from "@/src/domain/sequence";
import type { AutonomyLevel, Tier } from "@/src/domain/types";
import type { CritiqueDraftResult } from "./critic";
import {
  decideDraftStatus,
  draftMessage,
  MAX_REVISIONS,
  runRevisionLoop,
  type DraftCall,
  type DraftMessageInput,
  type RevisionContext,
} from "./copy";

/**
 * Section 6: "Up to 2 revision loops, then owner edits" and section 9's autonomy table.
 * These tests drive the loop with fakes; no model is called and no database is touched.
 */

const firstTouch = EMAIL_LINKEDIN_V1.steps[0]!;
const followUp = EMAIL_LINKEDIN_V1.steps[3]!;
const linkedinMessage = EMAIL_LINKEDIN_V1.steps[2]!;

const SIGNATURE = "Karim Haddad\nAcme Consulting, 1 Main Street";
const OPT_OUT = "Not useful? Reply stop and I will.";

function leadBrief(): ResearchBriefOutput {
  return {
    summary: "Acme's support team doubled while recurring tickets grew.",
    signals: [{ fact: "Support team doubled in a quarter", url: "https://example.com/careers" }],
    likelyPains: ["Repeating tickets"],
    aiOpportunity: "Deflect recurring tickets with a self-serve answer flow.",
    hooks: [{ text: "Your support team doubled", signalIndex: 0 }],
    confidence: "medium",
  };
}

function draftOutput(overrides: Partial<DraftOutput> = {}): DraftOutput {
  const parsed = DraftSchema.parse({
    subject: "A quick idea for your support team",
    body: `Hi,\n\nOne observation, one idea. Worth a look?\n\n${SIGNATURE}\n${OPT_OUT}`,
    claims: [{ text: "Support team doubled in a quarter", signalIndex: 0 }],
    cta: "Worth a look?",
    angle: "support_load",
    ...overrides,
  });
  return parsed;
}

function okDraft(overrides: Partial<DraftOutput> = {}): StructuredCallResult<DraftOutput> {
  return {
    object: draftOutput(overrides),
    model: "fake-copy",
    promptVersion: "copy.test",
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.0001,
    attempts: 1,
  };
}

function passingCritique(): CritiqueDraftResult {
  return {
    verdict: {
      passed: true,
      criticPassed: true,
      violations: [],
      fix: null,
      critic: { passed: true, violations: [] },
      codeViolations: [],
    },
    model: "fake-critic",
    promptVersion: "critic.test",
    costUsd: 0.0001,
    attempts: 1,
  };
}

function failingCritique(fix = "Add a grounded observation."): CritiqueDraftResult {
  return {
    verdict: {
      passed: false,
      criticPassed: false,
      violations: [{ code: "no_observation", message: "No observation about the company.", severity: "error" }],
      fix,
      critic: {
        passed: false,
        violations: [{ code: "no_observation", message: "No observation about the company.", severity: "error" }],
        fix,
      },
      codeViolations: [],
    },
    model: "fake-critic",
    promptVersion: "critic.test",
    costUsd: 0.0001,
    attempts: 1,
  };
}

function revisionContext(): RevisionContext {
  return {
    contactId: "contact-1",
    prompt: {
      offer: {
        title: "AI support automation",
        description: "I build self-serve answer flows for support teams.",
        proof: [{ label: "Last client", detail: "Cut ticket volume by half" }],
      },
      angle: { key: "support_load", hook: "Your support team doubled", allowedKeys: ["support_load"] },
      step: {
        key: firstTouch.key,
        kind: firstTouch.kind,
        channel: "email",
        dayOffset: firstTouch.dayOffset,
        isFirstTouch: true,
        wordLimit: 110,
        charLimit: null,
      },
      recipient: { companyName: "Acme", contactTitle: "Head of Support" },
      brief: leadBrief(),
      thread: null,
      signatureBlock: SIGNATURE,
      optOutLine: OPT_OUT,
      language: null,
    },
    criticPrompt: {
      brief: leadBrief(),
      step: {
        key: firstTouch.key,
        kind: firstTouch.kind,
        channel: "email",
        isFirstTouch: true,
        wordLimit: 110,
        charLimit: null,
      },
      angleKeys: ["support_load"],
      proofCount: 1,
      signatureBlock: SIGNATURE,
      optOutLine: OPT_OUT,
      language: null,
      thread: null,
    },
    copyRules: {
      step: firstTouch,
      channel: "email",
      signalCount: 1,
      angleKeys: ["support_load"],
      proofCount: 1,
    },
    signatureBlock: SIGNATURE,
  };
}

function messageInput(overrides: Partial<DraftMessageInput> = {}): DraftMessageInput {
  return {
    enrollmentId: "enrollment-1",
    contactId: "contact-1",
    step: firstTouch,
    channel: "email",
    threadContext: null,
    offer: {
      title: "AI support automation",
      description: "I build self-serve answer flows for support teams.",
      proof: [{ label: "Last client", detail: "Cut ticket volume by half" }],
    },
    icp: { name: "Support-heavy SaaS", angles: [{ key: "support_load", hook: "Your support team doubled" }] },
    angle: { key: "support_load", hook: "Your support team doubled" },
    brief: leadBrief(),
    recipient: { companyName: "Acme", contactTitle: "Head of Support" },
    settings: { signature: SIGNATURE, postalAddress: "1 Main Street", autonomyLevel: "L0" },
    tier: "A",
    language: null,
    ...overrides,
  };
}

describe("runRevisionLoop", () => {
  it(`stops after ${MAX_REVISIONS} revisions and marks the draft needs owner`, async () => {
    const prompts: CopyPromptInput[] = [];
    let draftCalls = 0;
    let critiqueCalls = 0;

    const draft: DraftCall = async (input) => {
      draftCalls += 1;
      prompts.push(input.prompt);
      return okDraft();
    };
    const critique = async (): Promise<CritiqueDraftResult> => {
      critiqueCalls += 1;
      return failingCritique();
    };

    const result = await runRevisionLoop(revisionContext(), { draft, critique });

    expect(draftCalls).toBe(MAX_REVISIONS + 1);
    expect(critiqueCalls).toBe(MAX_REVISIONS + 1);
    expect(result.outcome).toBe("needs_owner");
    expect(result.attempts).toBe(MAX_REVISIONS + 1);
    expect(result.draft).not.toBeNull();
    expect(result.validationError).toBe(false);

    expect(prompts[0]?.revision).toBeNull();
    expect(prompts[1]?.revision?.attempt).toBe(2);
    expect(prompts[1]?.revision?.previousDraft).toEqual(draftOutput());
    expect(prompts[2]?.revision?.attempt).toBe(3);
    expect(prompts[2]?.revision?.fix).toBe("Add a grounded observation.");
  });

  it("stops early as soon as a revision passes both judges", async () => {
    let draftCalls = 0;
    let critiqueCalls = 0;

    const draft: DraftCall = async () => {
      draftCalls += 1;
      return okDraft();
    };
    const critique = async (): Promise<CritiqueDraftResult> => {
      critiqueCalls += 1;
      return critiqueCalls === 1 ? failingCritique() : passingCritique();
    };

    const result = await runRevisionLoop(revisionContext(), { draft, critique });

    expect(result.outcome).toBe("passed");
    expect(result.attempts).toBe(2);
    expect(draftCalls).toBe(2);
    expect(critiqueCalls).toBe(2);
  });

  it("marks needs owner when the draft model fails schema validation twice", async () => {
    const draft: DraftCall = async () => {
      throw new LlmValidationError("copy.draft", 2);
    };

    const result = await runRevisionLoop(revisionContext(), { draft, critique: async () => passingCritique() });

    expect(result.outcome).toBe("needs_owner");
    expect(result.validationError).toBe(true);
    expect(result.draft).toBeNull();
  });
});

describe("decideDraftStatus (section 9 autonomy levels)", () => {
  const cases: Array<{ level: AutonomyLevel; step: SequenceStep; tier: Tier | null; expected: "approved" | "pending_approval" }> = [
    { level: "L0", step: firstTouch, tier: "A", expected: "pending_approval" },
    { level: "L1", step: firstTouch, tier: "A", expected: "pending_approval" },
    { level: "L1", step: followUp, tier: "B", expected: "approved" },
    { level: "L1", step: linkedinMessage, tier: "A", expected: "pending_approval" },
    { level: "L2", step: firstTouch, tier: "A", expected: "approved" },
    { level: "L2", step: firstTouch, tier: "B", expected: "pending_approval" },
    { level: "L2", step: followUp, tier: "C", expected: "pending_approval" },
    { level: "L2", step: linkedinMessage, tier: "A", expected: "pending_approval" },
  ];

  for (const testCase of cases) {
    it(`${testCase.level} + ${testCase.step.key} + tier ${testCase.tier} -> ${testCase.expected}`, () => {
      expect(
        decideDraftStatus({
          autonomyLevel: testCase.level,
          step: testCase.step,
          tier: testCase.tier,
          passed: true,
          needsOwner: false,
        }),
      ).toBe(testCase.expected);
    });
  }

  it("never approves a draft that needs the owner, whatever the level", () => {
    expect(
      decideDraftStatus({
        autonomyLevel: "L2",
        step: firstTouch,
        tier: "A",
        passed: false,
        needsOwner: true,
      }),
    ).toBe("pending_approval");
  });
});

describe("draftMessage", () => {
  it("passes the thread context to a follow-up draft and auto-approves at L1", async () => {
    const captured: CopyPromptInput[] = [];
    const draft: DraftCall = async (input) => {
      captured.push(input.prompt);
      return okDraft();
    };

    const result = await draftMessage(
      messageInput({
        step: followUp,
        channel: "email",
        threadContext: { subject: "A quick idea for your support team", body: "Previous body" },
        settings: { signature: SIGNATURE, postalAddress: "1 Main Street", autonomyLevel: "L1" },
        tier: "B",
      }),
      { draft, critique: async () => passingCritique() },
    );

    expect(captured[0]?.thread).toEqual({ subject: "A quick idea for your support team", body: "Previous body" });
    expect(result.outcome).toBe("passed");
    expect(result.needsOwner).toBe(false);
    expect(result.status).toBe("approved");
  });

  it("routes a failing draft to the approval queue even at L2 with a tier A lead", async () => {
    const result = await draftMessage(messageInput({ settings: { signature: SIGNATURE, postalAddress: "1 Main Street", autonomyLevel: "L2" } }), {
      draft: async () => okDraft(),
      critique: async () => failingCritique(),
    });

    expect(result.outcome).toBe("needs_owner");
    expect(result.needsOwner).toBe(true);
    expect(result.status).toBe("pending_approval");
    expect(result.attempts).toBe(MAX_REVISIONS + 1);
  });

  it("keeps L0 first touches in the approval queue even when everything passes", async () => {
    const result = await draftMessage(messageInput(), {
      draft: async () => okDraft(),
      critique: async () => passingCritique(),
    });

    expect(result.status).toBe("pending_approval");
    expect(result.needsOwner).toBe(false);
  });
});
