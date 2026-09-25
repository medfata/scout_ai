/**
 * Fixture integrity (runs with every scorer test): the golden lead's own expectations must be
 * true of the fixture before any model result is compared against them. This is what keeps a
 * mistyped disqualifier or a broken consent fixture from silently weakening the eval.
 *
 * All checks are code — `ResearchBriefSchema`, `requiresConsentForCountry` and
 * `resolveStepEligibility` are the real functions the pipeline uses.
 */
import { ResearchBriefSchema } from "@/src/ai/schemas";
import { DEFAULT_REQUIRES_CONSENT_GEOS, requiresConsentForCountry } from "@/src/domain/settings-defaults";
import { resolveStepEligibility } from "@/src/domain/sequence";

import { GOLDEN_ICP, GOLDEN_NOW, emailFirstTouchStep, leadById, leadContextFor } from "../golden/leads";
import { grade, readVar, type GradingResult } from "../lib/grading";

export default function checkLeadFacts(_output: unknown, context: unknown): GradingResult {
  const leadId = readVar(context, "leadId");
  if (leadId === null) return grade(false, "lead-facts: vars.leadId is required");

  const lead = leadById(leadId);
  const problems: string[] = [];

  const brief = ResearchBriefSchema.safeParse(lead.brief);
  if (!brief.success) {
    problems.push(`brief fails ResearchBriefSchema: ${brief.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  if (lead.brief.signals.length < 1 || lead.brief.signals.length > 8) {
    problems.push(`brief must have 1..8 signals, has ${lead.brief.signals.length}`);
  }
  for (const signal of lead.brief.signals) {
    try {
      new URL(signal.url);
    } catch {
      problems.push(`signal url is not a URL: ${signal.url}`);
    }
  }
  for (const hook of lead.brief.hooks) {
    if (hook.signalIndex < 0 || hook.signalIndex >= lead.brief.signals.length) {
      problems.push(`hook points at missing signal ${hook.signalIndex}`);
    }
  }

  const consent = requiresConsentForCountry(lead.company.country, DEFAULT_REQUIRES_CONSENT_GEOS);
  const eligibility = resolveStepEligibility(emailFirstTouchStep(), leadContextFor(lead), {
    linkedinAutomationEnabled: false,
    now: GOLDEN_NOW,
    hasSentAnchor: true,
    requiresConsent: consent,
  });
  if (lead.expect.emailEligibility !== undefined) {
    if (eligibility.eligible !== lead.expect.emailEligibility.eligible) {
      problems.push(
        `email eligibility expected ${lead.expect.emailEligibility.eligible}, got ${eligibility.eligible} (${eligibility.reason ?? "no reason"})`,
      );
    }
    if (lead.expect.emailEligibility.reason !== undefined && eligibility.reason !== lead.expect.emailEligibility.reason) {
      problems.push(`email skip reason expected ${lead.expect.emailEligibility.reason}, got ${eligibility.reason ?? "none"}`);
    }
  }

  if (lead.expect.disqualifiedReasonIncludes === "ICP disqualifier") {
    const haystack = [lead.contactTitle, lead.company.name, lead.company.industry].join(" ").toLowerCase();
    const matched = GOLDEN_ICP.disqualifiers
      .map((entry) => entry.toLowerCase().trim())
      .filter((entry) => entry.length > 3)
      .find((entry) => haystack.includes(entry));
    if (!matched) {
      problems.push(`fixture is labelled as an ICP disqualifier but nothing in "${haystack}" matches the list`);
    }
  }

  if (lead.suppressed && lead.expect.disqualified !== true) {
    problems.push("a suppressed fixture must expect disqualified=true");
  }

  if (problems.length > 0) return grade(false, `${lead.id}: ${problems.join(" | ")}`);
  return grade(true, `${lead.id}: fixture facts agree (consent=${consent}, email eligible=${eligibility.eligible})`);
}
