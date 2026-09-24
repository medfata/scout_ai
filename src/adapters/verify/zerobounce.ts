import { z } from "zod";

import type { EmailStatus } from "@/src/domain/types";
import { VendorError } from "@/src/lib/errors";
import type { EmailVerifier, VerifiedEmail } from "@/src/ports/email-verifier";

/**
 * ZeroBounce v2 Single Email Validator adapter (section 0: 100 free checks a month, the
 * fallback after Reoon). Endpoint: `GET https://api.zerobounce.net/v2/validate` with
 * `api_key` and `email` (docs.zerobounce.net, read 2026-09-24).
 *
 * Pure HTTP + Zod: quota accounting lives in the verifier chain (`./index.ts`).
 * ZeroBounce sometimes answers bad keys with HTTP 200 and an `error` field, which is
 * translated into a `vendor_auth` VendorError rather than a raw throw.
 */

const ZEROBOUNCE_URL = "https://api.zerobounce.net/v2/validate";
const ZEROBOUNCE_TIMEOUT_MS = 15_000;

export const ZEROBOUNCE_RESPONSE_SCHEMA = z.looseObject({
  address: z.string().optional(),
  status: z.string().optional(),
  sub_status: z.string().nullish(),
  free_email: z.boolean().nullish(),
  did_you_mean: z.string().nullish(),
  account: z.string().nullish(),
  domain: z.string().nullish(),
  domain_age_days: z.string().nullish(),
  smtp_provider: z.string().nullish(),
  mx_found: z.string().nullish(),
  mx_record: z.string().nullish(),
  firstname: z.string().nullish(),
  lastname: z.string().nullish(),
  processed_at: z.string().nullish(),
  /** Present when ZeroBounce refuses the request instead of validating. */
  error: z.string().optional(),
});

export type ZeroBounceResponse = z.infer<typeof ZEROBOUNCE_RESPONSE_SCHEMA>;

export interface ZeroBounceVerifierOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createZeroBounceVerifier(options: ZeroBounceVerifierOptions): EmailVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? ZEROBOUNCE_URL;
  const timeoutMs = options.timeoutMs ?? ZEROBOUNCE_TIMEOUT_MS;

  return {
    name: "zerobounce",
    checksPerCall: 1,
    async verify(email) {
      const url = new URL(baseUrl);
      url.searchParams.set("api_key", options.apiKey);
      url.searchParams.set("email", email);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new VendorError("zerobounce", `Validation request failed: ${messageOf(error)}`, {
          code: "vendor_unavailable",
          retryable: true,
          cause: error,
        });
      }

      if (!response.ok) {
        throw VendorError.fromStatus("zerobounce", response.status, await readBodyText(response));
      }

      const payload = await parseJson(response, "zerobounce");
      const parsed = ZEROBOUNCE_RESPONSE_SCHEMA.safeParse(payload);
      if (!parsed.success) {
        throw new VendorError("zerobounce", "Unexpected validation response shape.", {
          code: "vendor_unavailable",
          context: { issues: parsed.error.issues.length },
        });
      }

      if (parsed.data.error || !parsed.data.status) {
        throw new VendorError("zerobounce", parsed.data.error ?? "ZeroBounce returned no status.", {
          code: "vendor_auth",
        });
      }

      return {
        email,
        status: mapZeroBounceStatus(parsed.data.status),
        provider: "zerobounce",
        raw: { ...parsed.data } as Record<string, unknown>,
      } satisfies VerifiedEmail;
    },
  };
}

/**
 * Maps ZeroBounce statuses onto Scout's `EmailStatus`. `spamtrap`, `abuse` and
 * `do_not_mail` must never be sent to, so they are invalid, not risky.
 */
export function mapZeroBounceStatus(rawStatus: string): EmailStatus {
  switch (rawStatus.trim().toLowerCase()) {
    case "valid":
      return "valid";
    case "invalid":
    case "spamtrap":
    case "abuse":
    case "do_not_mail":
      return "invalid";
    case "catch-all":
    case "catch_all":
      return "catch_all";
    case "unknown":
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
