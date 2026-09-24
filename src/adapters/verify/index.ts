import type { EmailStatus } from "@/src/domain/types";
import { getEnv, hasVendorVar } from "@/src/lib/env";
import { ConfigurationError, QuotaExceededError, VendorError } from "@/src/lib/errors";
import { logger } from "@/src/lib/logger";
import type { EmailVerifier } from "@/src/ports/email-verifier";
import { assertVerificationQuota, recordVerification } from "@/src/services/quota";
import { createReoonVerifier } from "./reoon";
import { createZeroBounceVerifier } from "./zerobounce";

/**
 * The verifier chain: Reoon first, ZeroBounce as the fallback (section 0:
 * "600 + 100 free checks/month, 23/day").
 *
 * Every vendor call goes through `assertVerificationQuota()` first and
 * `recordVerification()` after it, so the quota can never be exceeded and every check is
 * metered in `activity_events`. A Reoon failure (rate limit, 5xx, bad key) falls through
 * to ZeroBounce; a Reoon *answer* — even `unknown` — is final. Quota exhaustion stops the
 * chain and surfaces as `QuotaExceededError` so the stage pauses (section 0).
 *
 * Hooks are injectable so `verify.test.ts` can run against MSW with no database.
 */

export { createReoonVerifier, mapReoonStatus, REOON_RESPONSE_SCHEMA } from "./reoon";
export { createZeroBounceVerifier, mapZeroBounceStatus, ZEROBOUNCE_RESPONSE_SCHEMA } from "./zerobounce";
export type { ReoonVerifierOptions, ReoonResponse } from "./reoon";
export type { ZeroBounceVerifierOptions, ZeroBounceResponse } from "./zerobounce";

export interface VerificationQuotaHooks {
  assert(): Promise<void>;
  record(input: { email: string; provider: string; status: EmailStatus }): Promise<void>;
}

export interface VerifierChainOptions {
  /** Ordered: the first entry runs first, later entries only on a VendorError. */
  verifiers: EmailVerifier[];
  quota?: VerificationQuotaHooks;
}

const DEFAULT_QUOTA: VerificationQuotaHooks = {
  assert: () => assertVerificationQuota(),
  record: (input) => recordVerification(input),
};

export function createVerifierChain(options: VerifierChainOptions): EmailVerifier {
  const quota = options.quota ?? DEFAULT_QUOTA;
  const verifiers = [...options.verifiers];

  return {
    name: verifiers.length > 0 ? `verify:${verifiers.map((verifier) => verifier.name).join("+")}` : "verify",
    checksPerCall: 1,
    async verify(email) {
      let lastError: VendorError | null = null;

      for (const verifier of verifiers) {
        await quota.assert();

        try {
          const result = await verifier.verify(email);
          await quota.record({ email, provider: result.provider, status: result.status });
          return result;
        } catch (error) {
          if (error instanceof QuotaExceededError) throw error;
          // Only vendor failures fall through; a programming error must not be hidden.
          if (!(error instanceof VendorError)) throw error;

          lastError = error;
          // The attempt was made, so it is metered (conservative: pause early, never late).
          await quota.record({ email, provider: verifier.name, status: "unknown" });
          logger.warn("verify.provider_failed", {
            provider: verifier.name,
            code: error.code,
            status: typeof error.context.status === "number" ? error.context.status : null,
          });
        }
      }

      throw lastError ?? new VendorError("verify", "No email verifier is configured.", { code: "configuration" });
    },
  };
}

export interface EmailVerifierOptions {
  reoonApiKey?: string;
  zeroBounceApiKey?: string;
  fetchImpl?: typeof fetch;
  quota?: VerificationQuotaHooks;
}

/**
 * Builds the chain from env. If neither key is configured this throws a readable
 * `ConfigurationError` and the caller (the enrichment service) decides to skip —
 * no import-time crash (section 0 rule 2/4).
 */
export function createEmailVerifier(options: EmailVerifierOptions = {}): EmailVerifier {
  const reoonKey = options.reoonApiKey ?? optionalVendorVar("REOON_API_KEY");
  const zeroBounceKey = options.zeroBounceApiKey ?? optionalVendorVar("ZEROBOUNCE_API_KEY");

  const verifiers: EmailVerifier[] = [];
  if (reoonKey) verifiers.push(createReoonVerifier({ apiKey: reoonKey, fetchImpl: options.fetchImpl }));
  if (zeroBounceKey) verifiers.push(createZeroBounceVerifier({ apiKey: zeroBounceKey, fetchImpl: options.fetchImpl }));

  if (verifiers.length === 0) {
    throw new ConfigurationError(
      "Neither REOON_API_KEY nor ZEROBOUNCE_API_KEY is set. Add one to .env.local (see .env.example) to verify emails; " +
        "scoring and drafting can run without verification, but nothing may be sent to an unverified address.",
      { vendor: "verify" },
    );
  }

  return createVerifierChain({ verifiers, quota: options.quota });
}

/** True when at least one verifier key is configured; lets a caller skip cleanly. */
export function hasVerifierKeys(): boolean {
  return hasVendorVar("REOON_API_KEY") || hasVendorVar("ZEROBOUNCE_API_KEY");
}

function optionalVendorVar(name: "REOON_API_KEY" | "ZEROBOUNCE_API_KEY"): string | undefined {
  if (!hasVendorVar(name)) return undefined;
  const value = getEnv()[name];
  return value ? value : undefined;
}
