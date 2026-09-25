import { eq } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import { settings, type Settings } from "@/src/db/schema";
import { defaultSettings, normalizeRequiresConsentGeos, requiresConsentForCountry, type SettingsValues } from "@/src/domain";
import { getEnv } from "@/src/lib/env";
import { isValidTimeZone } from "@/src/lib/time-windows";
import { recordActivity } from "./activity";

/**
 * The `settings` table is a singleton (section 5). Reading it creates the row from
 * section 7's defaults the first time, so a fresh database is usable immediately.
 */

const SINGLETON_ID = "singleton";

export async function getSettings(): Promise<Settings> {
  const db = getDb();
  const [existing] = await db.select().from(settings).where(eq(settings.id, SINGLETON_ID)).limit(1);
  if (existing) return existing;

  const env = getEnv();
  const defaults = defaultSettings({
    timezone: env.OWNER_TIMEZONE,
    dailyNewProspectTarget: env.DAILY_NEW_PROSPECTS,
  });

  const [created] = await db
    .insert(settings)
    .values({ id: SINGLETON_ID, ...defaults })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  // Another worker won the race; read the row it created.
  const [row] = await db.select().from(settings).where(eq(settings.id, SINGLETON_ID)).limit(1);
  if (!row) throw new Error("Settings row could not be created or read.");
  return row;
}

export type SettingsPatch = Partial<Omit<SettingsValues, "timezone">> & { timezone?: string };

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings();

  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) {
    throw new Error(`"${patch.timezone}" is not a valid IANA timezone.`);
  }

  // Review item 17: store the consent list as ISO 3166-1 alpha-2 codes. An unrecognised
  // entry throws here rather than being dropped silently.
  const requiresConsentGeos =
    patch.requiresConsentGeos !== undefined ? normalizeRequiresConsentGeos(patch.requiresConsentGeos) : undefined;

  const db = getDb();
  const [updated] = await db
    .update(settings)
    .set({
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.sendingWindows !== undefined ? { sendingWindows: patch.sendingWindows } : {}),
      ...(patch.caps !== undefined ? { caps: patch.caps } : {}),
      ...(patch.autonomyLevel !== undefined ? { autonomyLevel: patch.autonomyLevel } : {}),
      ...(patch.signature !== undefined ? { signature: patch.signature } : {}),
      ...(patch.postalAddress !== undefined ? { postalAddress: patch.postalAddress } : {}),
      ...(requiresConsentGeos !== undefined ? { requiresConsentGeos } : {}),
      ...(patch.killSwitch !== undefined ? { killSwitch: patch.killSwitch } : {}),
      ...(patch.dailyNewProspectTarget !== undefined ? { dailyNewProspectTarget: patch.dailyNewProspectTarget } : {}),
      updatedAt: new Date(),
    })
    .where(eq(settings.id, SINGLETON_ID))
    .returning();

  await recordActivity({
    actor: "owner",
    entityType: "settings",
    entityId: SINGLETON_ID,
    type: "settings.updated",
    data: { changed: Object.keys(patch), before: { autonomyLevel: current.autonomyLevel, killSwitch: current.killSwitch } },
  });

  if (!updated) throw new Error("Settings update matched no row.");

  // B3: a parked sequence (kill switch on, config incomplete, mailbox paused) waits until
  // the next sending window. Saving settings is one of the three events that should wake it
  // immediately instead — the owner just fixed whatever was wrong. Imported dynamically
  // because `enrollment.ts` imports this module.
  const { wakeParkedRuns } = await import("./enrollment");
  await wakeParkedRuns(patch.killSwitch === false ? "kill_switch_off" : "settings_saved");

  return updated;
}

/**
 * Section 7's kill switch, checked first by the send guard. Kept separate from
 * `getSettings` so callers do not accidentally depend on the whole row.
 */
export async function isKillSwitchOn(): Promise<boolean> {
  const row = await getSettings();
  return row.killSwitch;
}

/**
 * Review item 17: the lookup that decides `resolveStepEligibility`'s `requiresConsent`
 * flag, which in turn makes every email step for this lead ineligible (`requires_consent`).
 *
 * Callers pass the contact's company country (`company.country`): section 9 excludes
 * countries that require a form of consent for cold email. Both the company record and the
 * stored list are normalised, so names and ISO codes compare correctly.
 */
export async function countryRequiresConsent(companyCountry: string | null | undefined): Promise<boolean> {
  const row = await getSettings();
  return requiresConsentForCountry(companyCountry, row.requiresConsentGeos);
}
