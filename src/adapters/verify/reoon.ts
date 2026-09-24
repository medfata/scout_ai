import { z } from "zod";

import type { EmailStatus } from "@/src/domain/types";
import { VendorError } from "@/src/lib/errors";
import type { EmailVerifier, VerifiedEmail } from "@/src/ports/email-verifier";

/**
 * Reoon Email Verifier adapter (section 0: 600 free checks a month; Reoon runs first,
 * ZeroBounce is the fallback). Endpoint: `GET https://emailverifier.reoon.com/api/v1/verify`
 * with `email`, `key` and `mode=power` (docs: reoon.com, read 2026-09-24).
 *
 * Pure HTTP + Zod: quota accounting lives in the verifier chain (`./index.ts`), so this
 * adapter never touches the database and every failure is a typed `VendorError`.
 */

const REOON_URL = "https://emailverifier.reoon.com/api/v1/verify";
const REOON_TIMEOUT_MS = 15_000;

export const REOON_RESPONSE_SCHEMA = z.looseObject({
  email: z.string().optional(),
  status: z.string(),
  mode: z.string().optional(),
  is_safe_to_send: z.boolean().nullish(),
  domain: z.string().nullish(),
  username: z.string().nullish(),
  mx_record: z.string().nullish(),
  mx_accept_all: z.boolean().nullish(),
  smtp_connected: z.boolean().nullish(),
  smtp_check: z.boolean().nullish(),
  catch_all: z.boolean().nullish(),
  disposable: z.boolean().nullish(),
  role_account: z.boolean().nullish(),
  free_account: z.boolean().nullish(),
  spamtrap: z.boolean().nullish(),
  overall_score: z.number().nullish(),
  power_score: z.number().nullish(),
  is_domain_valid: z.boolean().nullish(),
  is_smtp_valid: z.boolean().nullish(),
  is_syntax_valid: z.boolean().nullish(),
});

export type ReoonResponse = z.infer<typeof REOON_RESPONSE_SCHEMA>;

export interface ReoonVerifierOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** `power` detects catch-all domains; `quick` is cheaper but weaker. */
  mode?: "quick" | "power" | "validator";
}

export function createReoonVerifier(options: ReoonVerifierOptions): EmailVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? REOON_URL;
  const timeoutMs = options.timeoutMs ?? REOON_TIMEOUT_MS;
  const mode = options.mode ?? "power";

  return {
    name: "reoon",
    checksPerCall: 1,
    async verify(email) {
      const url = new URL(baseUrl);
      url.searchParams.set("email", email);
      url.searchParams.set("key", options.apiKey);
      url.searchParams.set("mode", mode);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new VendorError("reoon", `Verification request failed: ${messageOf(error)}`, {
          code: "vendor_unavailable",
          retryable: true,
          cause: error,
        });
      }

      if (!response.ok) {
        throw VendorError.fromStatus("reoon", response.status, await readBodyText(response));
      }

      const payload = await parseJson(response, "reoon");
      const parsed = REOON_RESPONSE_SCHEMA.safeParse(payload);
      if (!parsed.success) {
        throw new VendorError("reoon", "Unexpected verification response shape.", {
          code: "vendor_unavailable",
          context: { issues: parsed.error.issues.length },
        });
      }

      return {
        email,
        status: mapReoonStatus(parsed.data.status, parsed.data.is_safe_to_send ?? null),
        provider: "reoon",
        raw: { ...parsed.data } as Record<string, unknown>,
      } satisfies VerifiedEmail;
    },
  };
}

/**
 * Maps Reoon statuses onto Scout's `EmailStatus`. Conservative everywhere:
 * `spamtrap` is invalid, `role_account` is risky (never send), and `safe` only counts
 * as valid when Reoon also says the address is safe to send.
 */
export function mapReoonStatus(rawStatus: string, isSafeToSend: boolean | null): EmailStatus {
  switch (rawStatus.trim().toLowerCase()) {
    case "valid":
    case "safe":
      return isSafeToSend === false ? "risky" : "valid";
    case "invalid":
    case "spamtrap":
      return "invalid";
    case "catch_all":
    case "catchall":
      return "catch_all";
    case "disposable":
      return "disposable";
    case "risky":
    case "role_account":
      return "risky";
    case "unknown":
    case "unverified":
    default:
      return "unknown";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "network error";
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function parseJson(response: Response, vendor: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new VendorError(vendor, "Response was not valid JSON.", {
      code: "vendor_unavailable",
      retryable: true,
      cause: error,
    });
  }
}
