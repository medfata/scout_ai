import { z } from "zod";

/**
 * Every env var, validated in one place (section 4: "One schema per LLM output,
 * webhook payload and env var set"). Names only in `.env.example`; values never
 * leave the server.
 *
 * Two tiers:
 *  - **core** vars are required to boot; a missing one throws with a readable list.
 *  - **vendor** vars are optional at boot and asserted by the adapter that needs
 *    them (`src/ports` delivers a typed error, never a crash on startup), so a
 *    missing Apollo key cannot take down the approval inbox.
 */

if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/env.ts was imported into a client bundle. Env vars are server-only; pass values from a Server Component or Server Action instead.",
  );
}

const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return defaultValue;
      return value === "true" || value === "1";
    });

const nonEmpty = z.string().min(1);

const coreSchema = z.object({
  APP_URL: z.string().url(),
  ADMIN_EMAIL: z.string().email(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  ENCRYPTION_KEY: z
    .string()
    .refine((value) => {
      try {
        return Buffer.from(value, "base64").length === 32;
      } catch {
        return false;
      }
    }, "ENCRYPTION_KEY must be 32 random bytes, base64 encoded"),
  DATABASE_URL: z.string().refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
    message: "DATABASE_URL must be a postgres:// or postgresql:// connection string",
  }),
  OWNER_TIMEZONE: nonEmpty,
  DRY_RUN: boolFromEnv(true),
  DRY_RUN_REDIRECT_EMAIL: z.union([z.string().email(), z.literal("")]).optional(),
  CRON_SECRET: z.union([z.string().min(16), z.literal("")]).optional(),
  SENDER_EMAIL: z.union([z.string().email(), z.literal("")]).optional(),
  // Quotas (section 0)
  DAILY_NEW_PROSPECTS: z.coerce.number().int().positive().default(5),
  MAX_DAILY_NEW_PROSPECTS: z.coerce.number().int().positive().default(12),
  DAILY_EMAIL_CAP: z.coerce.number().int().positive().default(50),
  DAILY_LINKEDIN_TASKS: z.coerce.number().int().positive().default(10),
  DAILY_EXA_SEARCHES: z.coerce.number().int().positive().default(45),
  DAILY_VERIFICATIONS: z.coerce.number().int().positive().default(23),
  MONTHLY_AI_BUDGET_USD: z.coerce.number().positive().default(5),
  DAILY_AI_BUDGET_USD: z.coerce.number().positive().optional(),
  LINKEDIN_MODE: z.enum(["assisted", "automated"]).default("assisted"),
  // AI
  MODEL_COPY: nonEmpty.default("anthropic/claude-haiku-4.5"),
  MODEL_RESEARCH: nonEmpty.default("gemini-3.8-flash"),
});

const vendorSchema = z.object({
  GOOGLE_CLIENT_ID: z.union([nonEmpty, z.literal("")]).optional(),
  GOOGLE_CLIENT_SECRET: z.union([nonEmpty, z.literal("")]).optional(),
  GMAIL_OAUTH_CLIENT_ID: z.union([nonEmpty, z.literal("")]).optional(),
  GMAIL_OAUTH_CLIENT_SECRET: z.union([nonEmpty, z.literal("")]).optional(),
  GMAIL_PUBSUB_TOPIC: z.union([nonEmpty, z.literal("")]).optional(),
  GMAIL_PUSH_SECRET: z.union([z.string().min(16), z.literal("")]).optional(),
  AI_GATEWAY_API_KEY: z.union([nonEmpty, z.literal("")]).optional(),
  GEMINI_API_KEY: z.union([nonEmpty, z.literal("")]).optional(),
  APOLLO_API_KEY: z.union([nonEmpty, z.literal("")]).optional(),
  EXA_API_KEY: z.union([nonEmpty, z.literal("")]).optional(),
  REOON_API_KEY: z.union([nonEmpty, z.literal("")]).optional(),
  ZEROBOUNCE_API_KEY: z.union([nonEmpty, z.literal("")]).optional(),
  TELEGRAM_BOT_TOKEN: z.union([nonEmpty, z.literal("")]).optional(),
  TELEGRAM_CHAT_ID: z.union([nonEmpty, z.literal("")]).optional(),
  CALCOM_BOOKING_URL: z.union([z.string().url(), z.literal("")]).optional(),
  CALCOM_WEBHOOK_SECRET: z.union([z.string().min(8), z.literal("")]).optional(),
  LANGFUSE_PUBLIC_KEY: z.union([nonEmpty, z.literal("")]).optional(),
  LANGFUSE_SECRET_KEY: z.union([nonEmpty, z.literal("")]).optional(),
  LANGFUSE_HOST: z.union([z.string().url(), z.literal("")]).optional(),
});

export type CoreEnv = z.infer<typeof coreSchema>;
export type VendorEnv = z.infer<typeof vendorSchema>;
export type Env = CoreEnv & VendorEnv & { DAILY_AI_BUDGET_USD: number };

/** Names a vendor needs, so adapters can fail with a readable message. */
export type VendorVar = keyof VendorEnv;

let cached: Env | null = null;

function readProcessEnv(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

function parseEnv(): Env {
  const source = readProcessEnv();
  const core = coreSchema.safeParse(source);
  if (!core.success) {
    const details = core.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Scout is missing required environment variables. Copy .env.example to .env.local and fill these in:\n${details}`,
    );
  }

  const vendor = vendorSchema.parse(source);

  return {
    ...core.data,
    ...vendor,
    // Section 9: "Daily AI spend above DAILY_AI_BUDGET_USD". The monthly credit is the
    // fallback source of truth when no explicit daily number is set.
    DAILY_AI_BUDGET_USD: core.data.DAILY_AI_BUDGET_USD ?? core.data.MONTHLY_AI_BUDGET_USD / 30,
  };
}

/** Memoised env. Throws on first access if a core var is missing. */
export function getEnv(): Env {
  if (!cached) cached = parseEnv();
  return cached;
}

/** Test seam: drops the memoised copy so a test can re-read `process.env`. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Throws a typed, actionable error when a vendor key is not configured. Called by
 * adapter factories instead of letting a request fail with a 401 from the vendor.
 */
export function requireVendorVar(name: VendorVar): string {
  const value = getEnv()[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to .env.local (see .env.example) or turn off the feature that needs it.`,
    );
  }
  return value;
}

export function hasVendorVar(name: VendorVar): boolean {
  try {
    return Boolean(getEnv()[name]);
  } catch {
    return false;
  }
}
