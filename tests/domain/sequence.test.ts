import { describe, expect, it } from "vitest";

import { EMAIL_LINKEDIN_V1, resolveStepEligibility, type SequenceStep } from "@/src/domain";
import type { EmailStatus, LeadContext } from "@/src/domain/types";

/**
 * `resolveStepEligibility` is the pure gate the sequencer and the send guard share. The
 * review findings it encodes:
 *  - a `thread: "same"` follow-up must never be drafted for a lead who was never
 *    contacted (review item 4, `hasSentAnchor`);
 *  - section 9 excludes countries that require a form of consent from cold email
 *    (review item 17, `requiresConsent`);
 *  - section 9's deliverability rule: only "valid" addresses may be emailed, and a
 *    catch-all goes LinkedIn-first.
 */

const NOW = new Date("2026-09-25T12:00:00Z");

function lead(overrides: Partial<LeadContext> = {}): LeadContext {
  return {
    contactId: "11111111-1111-4111-8111-111111111111",
    email: "jo@acme.example",
    emailStatus: "valid",
    linkedinUrl: null,
    inviteAccepted: false,
    inviteSentAt: null,
    enrollmentStartedAt: "2026-09-24T08:00:00Z",
    ...overrides,
  };
}

function options(overrides: Partial<Parameters<typeof resolveStepEligibility>[2]> = {}) {
  return { linkedinAutomationEnabled: false, now: NOW, hasSentAnchor: true, requiresConsent: false, ...overrides };
}

function step(key: string): SequenceStep {
  const found = EMAIL_LINKEDIN_V1.steps.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Unknown sequence step ${key}`);
  return found;
}

describe("resolveStepEligibility — email", () => {
  it("allows a first touch to a valid address", () => {
    expect(resolveStepEligibility(step("email_1"), lead(), options())).toEqual({ eligible: true });
  });

  it("rejects a lead with no address", () => {
    expect(resolveStepEligibility(step("email_1"), lead({ email: null }), options())).toEqual({
      eligible: false,
      reason: "no_valid_email",
    });
  });

  it("rejects every email status except valid (catch-all goes LinkedIn-first)", () => {
    const rejected: EmailStatus[] = ["unknown", "catch_all", "invalid", "risky", "disposable"];

    for (const emailStatus of rejected) {
      expect(resolveStepEligibility(step("email_1"), lead({ emailStatus }), options()), emailStatus).toEqual({
        eligible: false,
        reason: "no_valid_email",
      });
    }
  });

  it("rejects a country that requires a form of consent, even with a valid address", () => {
    expect(resolveStepEligibility(step("email_1"), lead(), options({ requiresConsent: true }))).toEqual({
      eligible: false,
      reason: "requires_consent",
    });
  });

  it("abandons a same-thread follow-up when the enrollment has no sent anchor (review item 4)", () => {
    expect(resolveStepEligibility(step("email_followup_1"), lead(), options({ hasSentAnchor: false }))).toEqual({
      eligible: false,
      reason: "step_abandoned",
    });
  });

  it("allows a same-thread follow-up once an email was actually sent", () => {
    expect(resolveStepEligibility(step("email_followup_1"), lead(), options({ hasSentAnchor: true }))).toEqual({
      eligible: true,
    });
  });

  it("does not need an anchor for a first touch that starts a new thread", () => {
    expect(resolveStepEligibility(step("email_1"), lead(), options({ hasSentAnchor: false }))).toEqual({ eligible: true });
  });
});

describe("resolveStepEligibility — LinkedIn", () => {
  it("rejects a lead with no profile URL", () => {
    expect(resolveStepEligibility(step("linkedin_invite"), lead({ linkedinUrl: null }), options())).toEqual({
      eligible: false,
      reason: "no_linkedin_url",
    });
  });

  it("reports linkedin_not_available while automation is off (v1 is assisted)", () => {
    const withUrl = lead({ linkedinUrl: "https://www.linkedin.com/in/jo-smith" });

    expect(resolveStepEligibility(step("linkedin_invite"), withUrl, options({ linkedinAutomationEnabled: false }))).toEqual({
      eligible: false,
      reason: "linkedin_not_available",
    });
  });

  it("abandons an invite that was already sent", () => {
    const withUrl = lead({ linkedinUrl: "https://www.linkedin.com/in/jo-smith", inviteSentAt: "2026-09-24T08:00:00Z" });

    expect(
      resolveStepEligibility(step("linkedin_invite"), withUrl, options({ linkedinAutomationEnabled: true })),
    ).toEqual({ eligible: false, reason: "step_abandoned" });
  });

  it("abandons a message while the invite is still pending", () => {
    const withUrl = lead({ linkedinUrl: "https://www.linkedin.com/in/jo-smith" });

    expect(
      resolveStepEligibility(step("linkedin_message"), withUrl, options({ linkedinAutomationEnabled: true })),
    ).toEqual({ eligible: false, reason: "step_abandoned" });
  });

  it("reports invite_not_accepted once the accept window has passed", () => {
    const withUrl = lead({
      linkedinUrl: "https://www.linkedin.com/in/jo-smith",
      inviteSentAt: "2026-09-01T08:00:00Z", // 24 days before NOW; the step allows 14
    });

    expect(
      resolveStepEligibility(step("linkedin_message"), withUrl, options({ linkedinAutomationEnabled: true })),
    ).toEqual({ eligible: false, reason: "invite_not_accepted" });
  });

  it("allows the message after acceptance", () => {
    const withUrl = lead({
      linkedinUrl: "https://www.linkedin.com/in/jo-smith",
      inviteSentAt: "2026-09-24T08:00:00Z",
      inviteAccepted: true,
    });

    expect(
      resolveStepEligibility(step("linkedin_message"), withUrl, options({ linkedinAutomationEnabled: true })),
    ).toEqual({ eligible: true });
  });
});
