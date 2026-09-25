import type { ContactStage, EnrollmentStatus, LeadEvent, EventDecision, ReplyIntent } from "@/src/domain/types";
import { NON_HUMAN_INTENTS } from "@/src/domain/types";

/**
 * Section 5: "Allowed transitions live in one typed map in `src/domain/enrollment.ts`;
 * any other transition throws."
 *
 * The map is deliberately small. Anything not listed here is a bug in the caller,
 * not a state Scout should try to recover from.
 */
export const ENROLLMENT_TRANSITIONS: Readonly<Record<EnrollmentStatus, readonly EnrollmentStatus[]>> = Object.freeze({
  drafted: ["pending_approval", "skipped", "stopped"],
  pending_approval: ["active", "skipped", "stopped", "drafted"],
  active: ["waiting", "completed", "replied", "stopped"],
  // `waiting` → `active` when a timer fires; `completed` when the last step was sent
  // before the enrollment moved to waiting; `skipped` expires an approval window.
  waiting: ["active", "completed", "replied", "stopped", "skipped"],
  replied: [],
  stopped: [],
  completed: [],
  skipped: [],
});

/** Statuses that mean "this lead is still in play" — used by the live-unique index. */
export const LIVE_ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  "drafted",
  "pending_approval",
  "active",
  "waiting",
];

export const TERMINAL_ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  "replied",
  "stopped",
  "completed",
  "skipped",
];

export function canTransition(from: EnrollmentStatus, to: EnrollmentStatus): boolean {
  return ENROLLMENT_TRANSITIONS[from].includes(to);
}

export class IllegalEnrollmentTransitionError extends Error {
  constructor(
    readonly from: EnrollmentStatus,
    readonly to: EnrollmentStatus,
  ) {
    super(`Illegal enrollment transition ${from} -> ${to}. See ENROLLMENT_TRANSITIONS in src/domain/enrollment.ts.`);
    this.name = "IllegalEnrollmentTransitionError";
  }
}

export function assertTransition(from: EnrollmentStatus, to: EnrollmentStatus): void {
  if (!canTransition(from, to)) throw new IllegalEnrollmentTransitionError(from, to);
}

export function isLive(status: EnrollmentStatus): boolean {
  return LIVE_ENROLLMENT_STATUSES.includes(status);
}

export function isTerminal(status: EnrollmentStatus): boolean {
  return TERMINAL_ENROLLMENT_STATUSES.includes(status);
}

/**
 * Section 7: "Any human reply on any channel stops every remaining step.
 * Out-of-office replies reschedule to the return date plus one business day."
 *
 * Returns policy only — no clock reads, no timezone math. The step that applies the
 * decision turns `notBefore` (a date-only string) into an instant in the owner's zone.
 */
export function applyLeadEvent(status: EnrollmentStatus, event: LeadEvent): EventDecision {
  if (isTerminal(status)) {
    return { action: "stop", reason: `already_${status}` };
  }

  switch (event.type) {
    case "reply": {
      if (event.intent === "out_of_office") {
        return {
          action: "reschedule",
          notBefore: addBusinessDaysToDateOnly(event.returnDate ?? defaultOooDate(), 1),
          reason: "out_of_office",
        };
      }
      if (event.intent === "auto_reply") {
        return { action: "continue", reason: "auto_reply_ignored" };
      }
      if (event.intent === "bounce") {
        return { action: "stop", reason: "bounce" };
      }
      if (event.intent === "unsubscribe") {
        return { action: "stop", reason: "opt_out" };
      }
      return { action: "stop", reason: `reply:${event.intent}` };
    }
    case "accepted":
      return { action: "continue", reason: "invite_accepted" };
    case "ooo": {
      const base = event.returnDate ?? defaultOooDate();
      return { action: "reschedule", notBefore: addBusinessDaysToDateOnly(base, 1), reason: "out_of_office" };
    }
    case "bounce":
      return { action: "stop", reason: event.kind === "hard" ? "hard_bounce" : "soft_bounce" };
    case "optout":
      return { action: "stop", reason: "opt_out" };
    case "resume":
      // Review item B3: the workflow re-computes the step's slot after this event, so a
      // cleared block inside the sending window sends at once instead of at the park time.
      return { action: "continue", reason: "resumed" };
  }
}

export function isHumanIntent(intent: ReplyIntent): boolean {
  return !NON_HUMAN_INTENTS.includes(intent as (typeof NON_HUMAN_INTENTS)[number]);
}

/**
 * Section 7: "'Not now' creates a new, approval-gated enrollment on the date the lead
 * gave, or in 90 days."
 */
export const NOT_NOW_DEFAULT_DAYS = 90;

export function notNowDateOnly(followUpAfter: string | undefined, today: string): string {
  if (followUpAfter) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(followUpAfter) ? followUpAfter : null;
    if (parsed) return parsed;
  }
  return addDaysToDateOnly(today, NOT_NOW_DEFAULT_DAYS);
}

/** Default when an out-of-office reply gives no return date: 3 days out. */
export const OOO_DEFAULT_DAYS = 3;

function defaultOooDate(today: string = new Date().toISOString().slice(0, 10)): string {
  return addDaysToDateOnly(today, OOO_DEFAULT_DAYS);
}

// ---------------------------------------------------------------------------
// Date-only helpers (pure, UTC-based; callers handle timezones)
// ---------------------------------------------------------------------------

export function addDaysToDateOnly(dateOnly: string, days: number): string {
  const date = parseDateOnly(dateOnly);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

export function addBusinessDaysToDateOnly(dateOnly: string, days: number): string {
  const date = parseDateOnly(dateOnly);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return formatDateOnly(date);
}

export function isBusinessDay(dateOnly: string): boolean {
  const weekday = parseDateOnly(dateOnly).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function parseDateOnly(dateOnly: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) throw new Error(`Expected a YYYY-MM-DD date, received "${dateOnly}"`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Contact stage
// ---------------------------------------------------------------------------

export const CONTACT_STAGE_TRANSITIONS: Readonly<Record<ContactStage, readonly ContactStage[]>> = Object.freeze({
  new: ["researched", "disqualified"],
  researched: ["qualified", "disqualified"],
  qualified: ["contacted", "disqualified"],
  contacted: ["replied", "interested", "lost", "disqualified"],
  replied: ["interested", "meeting", "lost", "disqualified"],
  interested: ["meeting", "won", "lost"],
  meeting: ["won", "lost"],
  won: [],
  lost: ["interested"],
  disqualified: ["qualified"],
});

export function canMoveStage(from: ContactStage, to: ContactStage): boolean {
  return CONTACT_STAGE_TRANSITIONS[from].includes(to);
}

/** Stage changes are best-effort bookkeeping, so an out-of-order move is ignored rather than thrown. */
export function advanceStage(from: ContactStage, to: ContactStage): ContactStage {
  return canMoveStage(from, to) ? to : from;
}
