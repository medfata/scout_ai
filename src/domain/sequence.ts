import type {
  ChannelKind,
  EmailStatus,
  LeadContext,
  SizeBand,
  SkipReason,
} from "@/src/domain/types";

/**
 * Section 7: sequence templates live in code, not the database, so they are versioned
 * with the app. `enrollments.sequence_version` records which revision a lead is on, and
 * a running enrollment always finishes on the version it started with.
 */

export type StepKind = "first_touch" | "follow_up" | "close" | "invite" | "linkedin_message";

export interface SequenceStep {
  /** Stable key; part of the idempotency key `enrollmentId:step:channel`. */
  key: string;
  channel: ChannelKind;
  kind: StepKind;
  /** Calendar days after the enrollment start. */
  dayOffset: number;
  /** `new` starts a thread, `same` continues the previous email thread. */
  thread: "new" | "same" | "none";
  /** Skip when the LinkedIn invite has not been accepted within this many days. */
  acceptWithinDays?: number;
  /** Days to wait after acceptance before messaging, on business days. */
  messageAfterAcceptBusinessDays?: number;
}

export interface SequenceTemplate {
  key: string;
  version: number;
  description: string;
  steps: SequenceStep[];
}

/**
 * The default sequence from section 7. Day offsets are the authority; the workflow
 * recomputes a slot for the step when it wakes, so a late start never compresses the
 * spacing between steps.
 */
export const EMAIL_LINKEDIN_V1: SequenceTemplate = {
  key: "email_linkedin_v1",
  version: 1,
  description: "Email 1, LinkedIn invite, LinkedIn message on accept, then 3, 7 and 14 day email follow-ups.",
  steps: [
    { key: "email_1", channel: "email", kind: "first_touch", dayOffset: 0, thread: "new" },
    { key: "linkedin_invite", channel: "linkedin", kind: "invite", dayOffset: 1, thread: "none" },
    {
      key: "linkedin_message",
      channel: "linkedin",
      kind: "linkedin_message",
      dayOffset: 2,
      thread: "none",
      acceptWithinDays: 14,
      messageAfterAcceptBusinessDays: 1,
    },
    { key: "email_followup_1", channel: "email", kind: "follow_up", dayOffset: 3, thread: "same" },
    { key: "email_followup_2", channel: "email", kind: "follow_up", dayOffset: 7, thread: "same" },
    { key: "email_close", channel: "email", kind: "close", dayOffset: 14, thread: "same" },
  ],
};

export const SEQUENCES: Readonly<Record<string, SequenceTemplate>> = Object.freeze({
  [EMAIL_LINKEDIN_V1.key]: EMAIL_LINKEDIN_V1,
});

export type SequenceKey = keyof typeof SEQUENCES;

export function getSequence(key: string): SequenceTemplate {
  const sequence = SEQUENCES[key];
  if (!sequence) throw new Error(`Unknown sequence "${key}". Known keys: ${Object.keys(SEQUENCES).join(", ")}`);
  return sequence;
}

export function getStep(template: SequenceTemplate, stepIndex: number): SequenceStep | null {
  return template.steps[stepIndex] ?? null;
}

/** Emails may only be sent to a "valid" address (section 9, deliverability rule 6). */
export function isEmailSendable(status: EmailStatus): boolean {
  return status === "valid";
}

export interface StepEligibility {
  eligible: boolean;
  reason?: SkipReason;
}

/**
 * Decides whether a step can run for this lead. Pure: everything it needs is in the
 * lead's context, so the same call is used by the workflow and by the tests.
 *
 * `linkedinAutomationEnabled` is false in v1 (section 0 locks LinkedIn to assisted mode),
 * and the assisted task queue arrives in phase 6. Until then LinkedIn steps report
 * `linkedin_not_available` rather than silently disappearing.
 *
 * `hasSentAnchor` and `requiresConsent` come from the caller, which reads the enrollment's
 * sent messages and the settings' consent list. Both are review findings:
 *   - a `thread: "same"` follow-up must never be drafted for a lead who was never contacted
 *     (item 4);
 *   - section 9 excludes countries that require a form of consent from cold email (item 17).
 */
export function resolveStepEligibility(
  step: SequenceStep,
  lead: LeadContext,
  options: { linkedinAutomationEnabled: boolean; now: Date; hasSentAnchor?: boolean; requiresConsent?: boolean },
): StepEligibility {
  if (step.channel === "email") {
    if (!lead.email) return { eligible: false, reason: "no_valid_email" };
    if (!isEmailSendable(lead.emailStatus)) return { eligible: false, reason: "no_valid_email" };
    if (options.requiresConsent) return { eligible: false, reason: "requires_consent" };
    // A follow-up in the same thread needs a thread to follow.
    if (step.thread === "same" && options.hasSentAnchor === false) {
      return { eligible: false, reason: "step_abandoned" };
    }
    return { eligible: true };
  }

  if (!lead.linkedinUrl) return { eligible: false, reason: "no_linkedin_url" };
  if (!options.linkedinAutomationEnabled) return { eligible: false, reason: "linkedin_not_available" };

  if (step.kind === "invite" && lead.inviteSentAt) {
    return { eligible: false, reason: "step_abandoned" };
  }

  if (step.kind === "linkedin_message") {
    if (!lead.inviteAccepted) {
      const sentAt = lead.inviteSentAt ? new Date(lead.inviteSentAt).getTime() : null;
      const deadline = step.acceptWithinDays ?? 14;
      const expired = sentAt !== null && options.now.getTime() - sentAt > deadline * 24 * 60 * 60 * 1000;
      return { eligible: false, reason: expired ? "invite_not_accepted" : "step_abandoned" };
    }
  }

  return { eligible: true };
}

/**
 * Days between the enrollment start and a step's send slot. LinkedIn messages wait for
 * acceptance, so they have no fixed day.
 */
export function stepDayOffset(step: SequenceStep, lead: LeadContext): number {
  if (step.kind === "linkedin_message" && lead.inviteAccepted) {
    const acceptedDay = lead.inviteSentAt ? step.dayOffset : step.dayOffset;
    return acceptedDay + (step.messageAfterAcceptBusinessDays ?? 1);
  }
  return step.dayOffset;
}

export function isFirstTouch(step: SequenceStep): boolean {
  return step.kind === "first_touch";
}

export function isFollowUp(step: SequenceStep): boolean {
  return step.kind === "follow_up" || step.kind === "close";
}

/**
 * Copy rules from section 6, expressed as data so the critic prompt and the code
 * check the same numbers.
 */
export const COPY_LIMITS = {
  emailFirstTouchMaxWords: 110,
  emailFollowUpMaxWords: 70,
  linkedinMessageMaxChars: 300,
  subjectMaxChars: 60,
} as const;

export function wordLimitForStep(step: SequenceStep): number | null {
  if (step.channel !== "email") return null;
  return isFirstTouch(step) ? COPY_LIMITS.emailFirstTouchMaxWords : COPY_LIMITS.emailFollowUpMaxWords;
}

export function charLimitForStep(step: SequenceStep): number | null {
  return step.channel === "linkedin" ? COPY_LIMITS.linkedinMessageMaxChars : null;
}

export const SIZE_BAND_TO_APOLLO_RANGE: Record<SizeBand, string> = {
  "1-10": "1,10",
  "11-50": "11,50",
  "51-200": "51,200",
  "201-1000": "201,1000",
  "1000+": "1001,100000",
};
