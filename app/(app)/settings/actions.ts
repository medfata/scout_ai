"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { SettingsActionState, SettingsMutationResult } from "@/components/settings/action-state";
import { DEFAULT_CAPS } from "@/src/domain/settings-defaults";
import { AUTONOMY_LEVELS, SUPPRESSION_KINDS, type AutonomyLevel } from "@/src/domain/types";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { requireOwner } from "@/src/lib/session";
import { isValidTimeOfDay, isValidTimeZone } from "@/src/lib/time-windows";
import { addSuppression, removeSuppression } from "@/src/services/leads";
import { updateSettings } from "@/src/services/settings";

/**
 * Section 8: "Server Actions re-check the session." Every mutation below starts with
 * `requireOwner()`, validates its input with Zod, then writes through
 * `updateSettings` — the only writer of the singleton `settings` row (section 5).
 *
 * Nothing here sends. The kill switch and every cap are read by `sendMessage`'s guard
 * (section 7, rule 1 and rule 5) at send time; this page only stores what the owner chose.
 */

// ---------------------------------------------------------------------------
// Kill switch and autonomy
// ---------------------------------------------------------------------------

const killSwitchSchema = z.object({ on: z.boolean() });

export async function updateKillSwitchAction(input: { on: boolean }): Promise<SettingsMutationResult> {
  await requireOwner();
  const parsed = killSwitchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "The kill-switch value was not understood. Nothing changed." };

  try {
    await updateSettings({ killSwitch: parsed.data.on });
  } catch (error) {
    logger.error("settings.kill_switch_failed", { reason: reasonOf(error) });
    return { ok: false, error: reasonOf(error) };
  }

  revalidatePath("/settings");
  return { ok: true };
}

const autonomySchema = z.object({ level: z.enum(AUTONOMY_LEVELS) });

export async function updateAutonomyAction(input: { level: AutonomyLevel }): Promise<SettingsMutationResult> {
  await requireOwner();
  const parsed = autonomySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That autonomy level does not exist. Nothing changed." };

  try {
    await updateSettings({ autonomyLevel: parsed.data.level });
  } catch (error) {
    logger.error("settings.autonomy_failed", { reason: reasonOf(error) });
    return { ok: false, error: reasonOf(error) };
  }

  revalidatePath("/settings");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Caps (section 7's pacing table, bounded by section 0's free-tier limits)
// ---------------------------------------------------------------------------

/**
 * Section 7 calls the caps configurable, but section 0 fixes the free-tier ceiling at
 * 30 new / 50 total emails a day; `emailCapsForWarmup` already documents that settings
 * "lower (never silently raise)" them. The maxima below are those ceilings, so the owner
 * cannot type Scout past the locked v1 quotas.
 */
const capsSchema = z.object({
  emailNew: z.coerce
    .number()
    .int()
    .min(1, "Use at least 1, or turn on the kill switch.")
    .max(DEFAULT_CAPS.emailNew, `The plan caps this at ${DEFAULT_CAPS.emailNew}.`),
  emailTotal: z.coerce
    .number()
    .int()
    .min(1, "Use at least 1, or turn on the kill switch.")
    .max(DEFAULT_CAPS.emailTotal, `The plan caps this at ${DEFAULT_CAPS.emailTotal}.`),
  linkedinInvites: z.coerce
    .number()
    .int()
    .min(0)
    .max(DEFAULT_CAPS.linkedinInvites, `The plan caps this at ${DEFAULT_CAPS.linkedinInvites}.`),
  linkedinMessages: z.coerce
    .number()
    .int()
    .min(0)
    .max(DEFAULT_CAPS.linkedinMessages, `The plan caps this at ${DEFAULT_CAPS.linkedinMessages}.`),
  linkedinProfileLookups: z.coerce
    .number()
    .int()
    .min(0)
    .max(DEFAULT_CAPS.linkedinProfileLookups, `The plan caps this at ${DEFAULT_CAPS.linkedinProfileLookups}.`),
});

export async function updateCapsAction(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  await requireOwner();
  const parsed = capsSchema.safeParse({
    emailNew: numberAt(formData, "emailNew"),
    emailTotal: numberAt(formData, "emailTotal"),
    linkedinInvites: numberAt(formData, "linkedinInvites"),
    linkedinMessages: numberAt(formData, "linkedinMessages"),
    linkedinProfileLookups: numberAt(formData, "linkedinProfileLookups"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error) };

  try {
    await updateSettings({ caps: parsed.data });
  } catch (error) {
    return failure("settings.caps_failed", error);
  }

  revalidatePath("/settings");
  return { status: "ok", message: "Caps saved." };
}

// ---------------------------------------------------------------------------
// Sending windows (section 7)
// ---------------------------------------------------------------------------

const sendingWindowSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one sending day."),
  start: z.string().refine(isValidTimeOfDay, "Use a 24-hour HH:MM time."),
  end: z.string().refine(isValidTimeOfDay, "Use a 24-hour HH:MM time."),
});

const sendingWindowsSchema = z
  .object({ email: sendingWindowSchema, linkedin: sendingWindowSchema })
  .superRefine((windows, ctx) => {
    if (windows.email.end <= windows.email.start) {
      ctx.addIssue({ code: "custom", path: ["email", "end"], message: "The email window must end after it starts." });
    }
    if (windows.linkedin.end <= windows.linkedin.start) {
      ctx.addIssue({ code: "custom", path: ["linkedin", "end"], message: "The LinkedIn window must end after it starts." });
    }
  });

export async function updateSendingWindowsAction(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  await requireOwner();
  const parsed = sendingWindowsSchema.safeParse({
    email: {
      days: numbersAt(formData, "emailDays"),
      start: textAt(formData, "emailStart"),
      end: textAt(formData, "emailEnd"),
    },
    linkedin: {
      days: numbersAt(formData, "linkedinDays"),
      start: textAt(formData, "linkedinStart"),
      end: textAt(formData, "linkedinEnd"),
    },
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error) };

  try {
    await updateSettings({ sendingWindows: parsed.data });
  } catch (error) {
    return failure("settings.windows_failed", error);
  }

  revalidatePath("/settings");
  return { status: "ok", message: "Sending windows saved." };
}

// ---------------------------------------------------------------------------
// Signature and postal address (section 9)
// ---------------------------------------------------------------------------

const identitySchema = z.object({
  signature: z.string().trim().max(2000, "Keep the signature under 2,000 characters."),
  postalAddress: z.string().trim().max(500, "Keep the postal address under 500 characters."),
});

export async function updateIdentityAction(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  await requireOwner();
  const parsed = identitySchema.safeParse({
    signature: textAt(formData, "signature"),
    postalAddress: textAt(formData, "postalAddress"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error) };

  try {
    await updateSettings({ signature: parsed.data.signature, postalAddress: parsed.data.postalAddress });
  } catch (error) {
    return failure("settings.identity_failed", error);
  }

  revalidatePath("/settings");

  // Section 9: every email carries the owner's identity and a working opt-out. The send
  // guard blocks email while either field is empty, so say so instead of "saved" alone.
  const incomplete = parsed.data.signature.length === 0 || parsed.data.postalAddress.length === 0;
  return {
    status: "ok",
    message: incomplete
      ? "Saved. Emails stay blocked until both the signature and the postal address are filled."
      : "Signature and postal address saved.",
  };
}

// ---------------------------------------------------------------------------
// Timezone and daily new-prospect target (section 0)
// ---------------------------------------------------------------------------

export async function updateOwnerSettingsAction(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  await requireOwner();
  const env = getEnv();
  const schema = z.object({
    timezone: z
      .string()
      .trim()
      .min(1, "Enter your timezone.")
      .refine(isValidTimeZone, "Use an IANA timezone such as Europe/Berlin."),
    dailyNewProspectTarget: z.coerce
      .number()
      .int()
      .min(0, "Use 0 to pause sourcing.")
      .max(env.MAX_DAILY_NEW_PROSPECTS, `Section 0 caps this at ${env.MAX_DAILY_NEW_PROSPECTS}.`),
  });
  const parsed = schema.safeParse({
    timezone: textAt(formData, "timezone"),
    dailyNewProspectTarget: numberAt(formData, "dailyNewProspectTarget"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error) };

  try {
    await updateSettings({
      timezone: parsed.data.timezone,
      dailyNewProspectTarget: parsed.data.dailyNewProspectTarget,
    });
  } catch (error) {
    return failure("settings.owner_failed", error);
  }

  revalidatePath("/settings");
  // The target is the numerator of the new-prospect quota on the dashboard.
  revalidatePath("/dashboard");
  return { status: "ok", message: "Timezone and daily target saved." };
}

// ---------------------------------------------------------------------------
// Do-not-contact list (section 9)
// ---------------------------------------------------------------------------

const suppressionSchema = z
  .object({
    kind: z.enum(SUPPRESSION_KINDS),
    value: z.string().trim().min(2, "Enter a value to suppress.").max(320, "That value is too long."),
    reason: z.string().trim().max(200, "Keep the reason under 200 characters."),
  })
  .superRefine((entry, ctx) => {
    // The value is normalised and hashed by `addSuppression`; a typo here would look
    // suppressed but never match a lead, so validate the shape the owner meant.
    if (entry.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "That does not look like an email address." });
    }
    if (entry.kind === "domain" && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(entry.value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Use a bare domain such as acme.com." });
    }
    if (entry.kind === "linkedin" && entry.value.length < 3) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Enter a LinkedIn URL or profile slug." });
    }
  });

export async function addSuppressionAction(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  await requireOwner();
  const parsed = suppressionSchema.safeParse({
    kind: textAt(formData, "kind"),
    value: textAt(formData, "value"),
    reason: textAt(formData, "reason"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error) };

  try {
    const result = await addSuppression({
      kind: parsed.data.kind,
      value: parsed.data.value,
      reason: parsed.data.reason.length > 0 ? parsed.data.reason : "owner_manual",
    });
    revalidatePath("/settings");
    return {
      status: "ok",
      message: result.created ? "Added to the do-not-contact list." : "That value was already suppressed.",
    };
  } catch (error) {
    return failure("settings.add_suppression_failed", error);
  }
}

const removeSuppressionSchema = z.object({ id: z.uuid("That suppression id is not valid.") });

export async function removeSuppressionAction(input: { id: string }): Promise<SettingsMutationResult> {
  await requireOwner();
  const parsed = removeSuppressionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That suppression id is not valid. Reload the page and try again." };

  try {
    await removeSuppression(parsed.data.id);
  } catch (error) {
    logger.error("settings.remove_suppression_failed", { reason: reasonOf(error) });
    return { ok: false, error: reasonOf(error) };
  }

  revalidatePath("/settings");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function textAt(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** `Number(null)` is 0, so a missing field must become NaN and fail the schema. */
function numberAt(formData: FormData, key: string): number {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim().length === 0) return Number.NaN;
  return Number(value);
}

function numbersAt(formData: FormData, key: string): number[] {
  return formData.getAll(key).map((value) => Number(value));
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That value was not understood. Nothing changed.";
}

function failure(context: string, error: unknown): SettingsActionState {
  const message = reasonOf(error);
  logger.error(context, { reason: message });
  return { status: "error", message };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error. Nothing changed.";
}
