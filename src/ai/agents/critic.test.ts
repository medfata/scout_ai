import { describe, expect, it } from "vitest";

import type { CriticPromptInput } from "@/src/ai/prompts/critic";
import type { CriticResultOutput } from "@/src/ai/schemas";
import { evaluateCopyRules, type CopyRuleInput } from "@/src/domain/copy-rules";
import { EMAIL_LINKEDIN_V1 } from "@/src/domain/sequence";
import { critiqueDraft, dedupeViolations, mergeVerdicts, type DraftViolation } from "./critic";

/**
 * Section 6: "A draft may only be marked as passing when both the critic and the code
 * checks agree." These tests prove the code checks can veto a passing critic and that
 * the merged verdict dedupes by code. No model is called.
 */

const firstTouch = EMAIL_LINKEDIN_V1.steps[0]!;
const followUp = EMAIL_LINKEDIN_V1.steps[3]!;

const SIGNATURE = "Karim Haddad\nAcme Consulting, 1 Main Street";
const OPT_OUT = "Not useful? Reply stop and I will.";

function compliantBody(): string {
  return [
    "Hi,",
    "",
    "Your support team doubled in a quarter while the help centre still answers the same dozen questions.",
    "The pattern I use turns those recurring tickets into self-serve answers, which cut my last client's ticket volume. Would it be worth 15 minutes to see how that would work for you?",
    "",
    SIGNATURE,
    OPT_OUT,
  ].join("\n");
}

function copyRules(overrides: Partial<CopyRuleInput> = {}): CopyRuleInput {
  return {
    step: firstTouch,
    channel: "email",
    body: compliantBody(),
    subject: "A quick idea for your support team",
    claims: [{ text: "Support team doubled in a quarter", signalIndex: 0 }],
    signalCount: 3,
    angleKeys: ["support_load"],
    angle: "support_load",
    proofCount: 1,
    hasSignature: true,
    ...overrides,
  };
}

function criticPassed(): CriticResultOutput {
  return { passed: true, violations: [] };
}

function criticPromptFixture(overrides: Partial<CriticPromptInput> = {}): CriticPromptInput {
  return {
    draft: {
      subject: "A quick idea for your support team",
      body: compliantBody(),
      claims: [{ text: "Support team doubled in a quarter", signalIndex: 0 }],
      cta: "Would it be worth 15 minutes?",
      angle: "support_load",
    },
    brief: {
      summary: "Acme's support team doubled while the help centre answers the same questions.",
      signals: [{ fact: "Support team doubled in a quarter", url: "https://example.com/careers" }],
      likelyPains: ["Repeating tickets"],
      aiOpportunity: "Deflect recurring tickets with a self-serve answer flow.",
      hooks: [{ text: "Your support team doubled", signalIndex: 0 }],
      confidence: "medium",
    },
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
    language: "English",
    thread: null,
    ...overrides,
  };
}

function criticResult(overrides: Partial<CriticResultOutput> = {}): CriticResultOutput {
  return { passed: true, violations: [], ...overrides };
}

describe("evaluateCopyRules (the code half of the verdict)", () => {
  it("passes a compliant first email", () => {
    expect(evaluateCopyRules(copyRules())).toEqual([]);
  });

  it("fails a body over the first-touch word limit", () => {
    const tooLong = `${Array.from({ length: 120 }, () => "word").join(" ")}? ${OPT_OUT}\n${SIGNATURE}`;
    const violations = evaluateCopyRules(copyRules({ body: tooLong }));
    expect(violations.some((violation) => violation.code === "too_long" && violation.severity === "error")).toBe(true);
  });

  it("fails a body with no opt-out line", () => {
    const violations = evaluateCopyRules(copyRules({ body: `${compliantBody().replace(OPT_OUT, "")}` }));
    expect(violations.some((violation) => violation.code === "missing_opt_out")).toBe(true);
  });

  it("fails a claim that points outside the brief's signals", () => {
    const violations = evaluateCopyRules(
      copyRules({ claims: [{ text: "An invented fact", signalIndex: 9 }] }),
    );
    expect(violations.some((violation) => violation.code === "ungrounded_claim")).toBe(true);
  });
});

describe("mergeVerdicts", () => {
  it("never passes when a code error exists, even when the critic passed", () => {
    const violations = evaluateCopyRules(copyRules({ claims: [{ text: "No signal", signalIndex: 9 }] }));
    const merged = mergeVerdicts(criticPassed(), violations);
    expect(merged.passed).toBe(false);
    expect(merged.violations.some((violation) => violation.code === "ungrounded_claim")).toBe(true);
    expect(merged.fix).toBeTruthy();
  });

  it("passes only when the critic passed and the code found nothing blocking", () => {
    const merged = mergeVerdicts(criticPassed(), evaluateCopyRules(copyRules()));
    expect(merged.passed).toBe(true);
    expect(merged.violations).toEqual([]);
    expect(merged.fix).toBeNull();
  });

  it("blocks a draft when the critic fails even if the code is clean", () => {
    const critic = criticResult({
      passed: false,
      violations: [{ code: "hype", message: "Reads like marketing.", severity: "error" }],
      fix: "Remove the hype sentence.",
    });
    const merged = mergeVerdicts(critic, evaluateCopyRules(copyRules()));
    expect(merged.passed).toBe(false);
    expect(merged.fix).toBe("Remove the hype sentence.");
  });

  it("keeps only the most severe entry per code", () => {
    const merged = mergeVerdicts(
      criticResult({
        violations: [{ code: "too_long", message: "Critic thinks it is long.", severity: "warning" }],
      }),
      evaluateCopyRules(copyRules({ body: `${Array.from({ length: 120 }, () => "word").join(" ")}? ${OPT_OUT}\n${SIGNATURE}` })),
    );
    const tooLong = merged.violations.filter((violation) => violation.code === "too_long");
    expect(tooLong).toHaveLength(1);
    expect(tooLong[0]?.severity).toBe("error");
  });

  it("dedupes identical codes from both judges", () => {
    const violations: DraftViolation[] = [
      { code: "banned_phrase", message: "critic", severity: "error" },
      { code: "banned_phrase", message: "code", severity: "error" },
    ];
    expect(dedupeViolations(violations)).toHaveLength(1);
  });
});

describe("critiqueDraft", () => {
  it("runs the code checks even when the critic model says pass", async () => {
    const result = await critiqueDraft(
      {
        contactId: "contact-1",
        prompt: criticPromptFixture(),
        copyRules: copyRules({ body: `${Array.from({ length: 120 }, () => "word").join(" ")}? ${OPT_OUT}\n${SIGNATURE}` }),
      },
      {
        call: async () => ({
          object: criticPassed(),
          model: "fake",
          promptVersion: "critic.test",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          attempts: 1,
        }),
      },
    );

    expect(result.verdict.criticPassed).toBe(true);
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.violations.some((violation) => violation.code === "too_long")).toBe(true);
  });

  it("passes a compliant draft when the critic agrees", async () => {
    const result = await critiqueDraft(
      { contactId: null, prompt: criticPromptFixture(), copyRules: copyRules() },
      {
        call: async () => ({
          object: criticPassed(),
          model: "fake",
          promptVersion: "critic.test",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          attempts: 1,
        }),
      },
    );

    expect(result.verdict.passed).toBe(true);
    expect(result.verdict.codeViolations).toEqual([]);
  });
});

describe("follow-up limits", () => {
  it("uses the follow-up word limit for follow-up steps", () => {
    const long = `${Array.from({ length: 80 }, () => "word").join(" ")}? ${OPT_OUT}\n${SIGNATURE}`;
    const violations = evaluateCopyRules(copyRules({ step: followUp, body: long }));
    expect(violations.some((violation) => violation.code === "too_long")).toBe(true);
  });
});
