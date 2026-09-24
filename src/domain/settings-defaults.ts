import type { AutonomyLevel, Caps, SendingWindows } from "@/src/domain/types";

/**
 * Starting defaults for the `settings` row. Section 7's pacing table and section 9's
 * guardrails: "Thresholds below are starting defaults the owner can change in settings."
 *
 * Anything the owner changes is stored in the database; these values are only used to
 * create the singleton row the first time Scout boots.
 */

export const DEFAULT_SENDING_WINDOWS: SendingWindows = {
  email: { days: [1, 2, 3, 4, 5], start: "08:30", end: "16:30" },
  linkedin: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30" },
};

export const DEFAULT_CAPS: Caps = {
  emailNew: 30,
  emailTotal: 50,
  linkedinInvites: 10,
  linkedinMessages: 25,
  linkedinProfileLookups: 50,
};

/** Section 9: the first two weeks run in L0 — nothing sends without approval. */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "L0";

/**
 * Countries that require a form of consent for most cold email. Section 9 names Germany
 * and Canada, defaults for v1; the owner edits the list in settings.
 */
export const DEFAULT_REQUIRES_CONSENT_GEOS: string[] = ["Germany", "Canada"];

/** Section 9: "Contacts who never replied are deleted after 12 months." */
export const CONTACT_RETENTION_MONTHS = 12;

/** Section 0: "prune raw payloads after 30 days". */
export const RAW_PAYLOAD_RETENTION_DAYS = 30;

export interface DefaultSettingsInput {
  timezone: string;
  dailyNewProspectTarget: number;
}

export interface SettingsValues {
  timezone: string;
  sendingWindows: SendingWindows;
  caps: Caps;
  autonomyLevel: AutonomyLevel;
  signature: string;
  postalAddress: string;
  requiresConsentGeos: string[];
  killSwitch: boolean;
  dailyNewProspectTarget: number;
}

export function defaultSettings(input: DefaultSettingsInput): SettingsValues {
  return {
    timezone: input.timezone,
    sendingWindows: DEFAULT_SENDING_WINDOWS,
    caps: DEFAULT_CAPS,
    autonomyLevel: DEFAULT_AUTONOMY_LEVEL,
    signature: "",
    postalAddress: "",
    requiresConsentGeos: [...DEFAULT_REQUIRES_CONSENT_GEOS],
    killSwitch: false,
    dailyNewProspectTarget: input.dailyNewProspectTarget,
  };
}

/**
 * Section 9's autonomy table, as code. Returns true when this step may send without
 * waiting in the approval inbox.
 */
export function maySendWithoutApproval(input: {
  autonomyLevel: AutonomyLevel;
  isFirstTouch: boolean;
  isLinkedIn: boolean;
  tier: "A" | "B" | "C" | null;
  criticPassed: boolean;
}): boolean {
  if (!input.criticPassed) return false;
  switch (input.autonomyLevel) {
    case "L0":
      return false;
    case "L1":
      // Follow-ups that pass the critic; first emails and LinkedIn messages still wait.
      return !input.isFirstTouch && !input.isLinkedIn;
    case "L2":
      // Tier A leads within caps; tier B and C still wait.
      return input.tier === "A" && !input.isLinkedIn;
  }
}
