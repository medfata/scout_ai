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
 *
 * Review item 17: stored as ISO 3166-1 alpha-2 codes, because company records arrive as
 * either names ("Germany") or codes ("DE") depending on the source. `normalizeCountryCode`
 * and `requiresConsentForCountry` below are the only comparison points.
 */
export const DEFAULT_REQUIRES_CONSENT_GEOS: string[] = ["DE", "CA"];

/**
 * Spellings that `Intl.DisplayNames` does not produce but real sources do. Keys are
 * lower-cased with punctuation collapsed (see `countryNameKey`).
 */
const COUNTRY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["america", "US"],
  ["bolivia", "BO"],
  ["britain", "GB"],
  ["burma", "MM"],
  ["cape verde", "CV"],
  ["congo", "CG"],
  ["congo brazzaville", "CG"],
  ["congo kinshasa", "CD"],
  ["czech republic", "CZ"],
  ["democratic republic of the congo", "CD"],
  ["drc", "CD"],
  ["east timor", "TL"],
  ["england", "GB"],
  ["great britain", "GB"],
  ["hong kong", "HK"],
  ["iran", "IR"],
  ["ivory coast", "CI"],
  ["laos", "LA"],
  ["macao", "MO"],
  ["macedonia", "MK"],
  ["moldova", "MD"],
  ["north korea", "KP"],
  ["palestine", "PS"],
  ["republic of ireland", "IE"],
  ["republic of korea", "KR"],
  ["russia", "RU"],
  ["russian federation", "RU"],
  ["scotland", "GB"],
  ["south korea", "KR"],
  ["swaziland", "SZ"],
  ["syria", "SY"],
  ["taiwan", "TW"],
  ["tanzania", "TZ"],
  ["timor leste", "TL"],
  ["turkey", "TR"],
  ["turkiye", "TR"],
  ["uae", "AE"],
  ["uk", "GB"],
  ["united arab emirates", "AE"],
  ["united states of america", "US"],
  ["usa", "US"],
  ["venezuela", "VE"],
  ["viet nam", "VN"],
  ["wales", "GB"],
];

/** Lower-case, accent-free, punctuation-free form used as the lookup key. */
function countryNameKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let regionNameIndex: ReadonlyMap<string, string> | null = null;

/**
 * Every ISO 3166-1 English region name, inverted from the platform's own CLDR data. Built
 * once per process so nothing has to hard-code 250 country names; unknown aliases above
 * cover the spellings real sources use.
 */
function regionNames(): ReadonlyMap<string, string> {
  if (regionNameIndex) return regionNameIndex;

  const index = new Map<string, string>();
  if (typeof Intl.DisplayNames === "function") {
    const display = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    for (let first = 65; first <= 90; first += 1) {
      for (let second = 65; second <= 90; second += 1) {
        const code = String.fromCharCode(first, second);
        try {
          const name = display.of(code);
          if (name && name !== code) index.set(countryNameKey(name), code);
        } catch {
          // Not a valid region subtag; nothing to index.
        }
      }
    }
  }
  for (const [alias, code] of COUNTRY_ALIASES) index.set(countryNameKey(alias), code);

  regionNameIndex = index;
  return index;
}

/** "Germany", "germany" and "DE" all become "DE"; unknown values return null. */
export function normalizeCountryCode(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const byName = regionNames().get(countryNameKey(trimmed));
  if (byName) return byName;
  if (/^[a-z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

/** Code when the value can be normalised, otherwise the raw name key, so two unknown names still match. */
function countryKey(value: string): string | null {
  const key = countryNameKey(value);
  if (!key) return null;
  return normalizeCountryCode(value) ?? key;
}

/**
 * Review item 17: the lookup that decides whether a contact's company country is on the
 * consent list. Both sides are normalised, so a stored "Germany" still matches a company
 * country of "DE" until the owner saves the list again.
 */
export function requiresConsentForCountry(
  companyCountry: string | null | undefined,
  requiresConsentGeos: readonly string[],
): boolean {
  if (!companyCountry) return false;
  const country = countryKey(companyCountry);
  if (!country) return false;
  return requiresConsentGeos.some((geo) => countryKey(geo) === country);
}

/**
 * Normalises the owner's list to ISO codes before it is stored. An unrecognised entry
 * throws instead of being dropped: silently shrinking a compliance list is worse than an
 * error message that asks for a two-letter code (review item 17).
 */
export function normalizeRequiresConsentGeos(countries: readonly string[]): string[] {
  const codes = new Set<string>();
  for (const country of countries) {
    const code = normalizeCountryCode(country);
    if (!code) {
      throw new Error(
        `"${country}" is not a recognised country name or ISO 3166-1 alpha-2 code. Use two-letter codes such as DE or CA.`,
      );
    }
    codes.add(code);
  }
  return [...codes];
}

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
