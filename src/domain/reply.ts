import type { ContactStage, ReplyIntent, SuppressionKind } from "@/src/domain/types";
import { NON_HUMAN_INTENTS, POSITIVE_INTENTS } from "@/src/domain/types";

/**
 * Section 6: "Classify, then code routes." The classifier returns a label; this file
 * decides what Scout does with it. Every rule traces back to section 7 or section 9.
 */

export interface IntentRouting {
  /** Any human reply stops every remaining step (section 7). */
  stopSequence: boolean;
  /** Add the lead to the suppression list, permanently (section 9). */
  suppressKinds: SuppressionKind[];
  /** Send the owner a Telegram alert. `hot` also deep-links and bypasses the digest. */
  alert: "hot" | "normal" | "none";
  /** Draft a suggested reply for the owner (never sent automatically — section 1). */
  suggestReply: boolean;
  /** Move the contact to this stage, when the current stage allows it. */
  stage: ContactStage | null;
  /** Create a new, approval-gated enrollment (section 7, "not now"). */
  createReEnrollment: boolean;
  /** Reschedule the existing sequence instead of stopping it (out of office). */
  reschedule: boolean;
}

const ROUTING: Record<ReplyIntent, IntentRouting> = {
  interested: {
    stopSequence: true,
    suppressKinds: [],
    alert: "hot",
    suggestReply: true,
    stage: "interested",
    createReEnrollment: false,
    reschedule: false,
  },
  meeting_request: {
    stopSequence: true,
    suppressKinds: [],
    alert: "hot",
    suggestReply: true,
    stage: "meeting",
    createReEnrollment: false,
    reschedule: false,
  },
  question: {
    stopSequence: true,
    suppressKinds: [],
    alert: "hot",
    suggestReply: true,
    stage: "replied",
    createReEnrollment: false,
    reschedule: false,
  },
  referral: {
    stopSequence: true,
    suppressKinds: [],
    alert: "hot",
    suggestReply: true,
    stage: "replied",
    createReEnrollment: false,
    reschedule: false,
  },
  not_now: {
    stopSequence: true,
    suppressKinds: [],
    alert: "normal",
    suggestReply: false,
    stage: "replied",
    createReEnrollment: true,
    reschedule: false,
  },
  not_interested: {
    stopSequence: true,
    suppressKinds: [],
    alert: "normal",
    suggestReply: false,
    stage: "lost",
    createReEnrollment: false,
    reschedule: false,
  },
  unsubscribe: {
    stopSequence: true,
    suppressKinds: ["email", "linkedin"],
    alert: "normal",
    suggestReply: false,
    stage: "lost",
    createReEnrollment: false,
    reschedule: false,
  },
  out_of_office: {
    stopSequence: false,
    suppressKinds: [],
    alert: "none",
    suggestReply: false,
    stage: null,
    createReEnrollment: false,
    reschedule: true,
  },
  bounce: {
    stopSequence: true,
    suppressKinds: ["email"],
    alert: "normal",
    suggestReply: false,
    stage: null,
    createReEnrollment: false,
    reschedule: false,
  },
  auto_reply: {
    stopSequence: false,
    suppressKinds: [],
    alert: "none",
    suggestReply: false,
    stage: null,
    createReEnrollment: false,
    reschedule: false,
  },
  other: {
    stopSequence: true,
    suppressKinds: [],
    alert: "normal",
    suggestReply: true,
    stage: "replied",
    createReEnrollment: false,
    reschedule: false,
  },
};

export function routeIntent(intent: ReplyIntent): IntentRouting {
  return ROUTING[intent];
}

export function isHumanReply(intent: ReplyIntent): boolean {
  return !NON_HUMAN_INTENTS.includes(intent as (typeof NON_HUMAN_INTENTS)[number]);
}

export function isPositiveReply(intent: ReplyIntent): boolean {
  return POSITIVE_INTENTS.includes(intent as (typeof POSITIVE_INTENTS)[number]);
}

/** Section 9, circuit breaker: "an ICP x angle arm with 30%+ negative replies after 30 sends". */
export const ARM_NEGATIVE_REPLY_THRESHOLD = 0.3;
export const ARM_MIN_SENDS = 30;

export function isNegativeReply(intent: ReplyIntent): boolean {
  return intent === "not_interested" || intent === "unsubscribe";
}

export interface ArmHealth {
  sends: number;
  negatives: number;
}

export function shouldPauseArm(health: ArmHealth): boolean {
  if (health.sends < ARM_MIN_SENDS) return false;
  return health.negatives / health.sends >= ARM_NEGATIVE_REPLY_THRESHOLD;
}

/**
 * Section 6, copy rules: every email ends with an easy opt-out. When a prospect asks
 * for a suggested reply, the owner gets the thread plus this label.
 */
export function suggestedReplySeeds(intent: ReplyIntent, companyName: string | null, calendarUrl: string | null): string[] {
  const company = companyName ?? "your team";
  switch (intent) {
    case "interested":
      return [
        `Thanks for the reply. Happy to share how this could look for ${company}.`,
        calendarUrl ? `If it is easier, grab a slot here: ${calendarUrl}` : "Would a 20 minute call next week work?",
      ];
    case "meeting_request":
      return [
        "Happy to talk.",
        calendarUrl ? `Here is my calendar: ${calendarUrl}` : "What does your calendar look like next week?",
      ];
    case "question":
      return ["Good question — here is the short answer.", "Want me to go deeper on a quick call?"];
    case "referral":
      return ["Thanks for pointing me to the right person.", "I will reach out to them and mention you suggested it."];
    case "other":
      return ["Thanks for getting back to me.", ""];
    default:
      return [];
  }
}
