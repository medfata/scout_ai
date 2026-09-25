/**
 * Typed errors. Adapters translate vendor failures into these, so the rest of Scout
 * decides with codes and never parses a vendor's prose.
 */

export type ErrorCode =
  | "vendor_unavailable"
  | "vendor_auth"
  | "vendor_rate_limited"
  | "vendor_bad_request"
  | "quota_exceeded"
  | "guard_failed"
  | "configuration"
  | "not_found"
  | "conflict"
  | "validation";

export class ScoutError extends Error {
  readonly code: ErrorCode;
  readonly context: Record<string, unknown>;
  /** True when the same call might succeed later (a retry in a step is safe). */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code: ErrorCode; context?: Record<string, unknown>; retryable?: boolean; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.context = options.context ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export class ConfigurationError extends ScoutError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: "configuration", context });
  }
}

export class VendorError extends ScoutError {
  readonly vendor: string;

  constructor(
    vendor: string,
    message: string,
    options: { code?: ErrorCode; status?: number; context?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(`[${vendor}] ${message}`, {
      code: options.code ?? "vendor_unavailable",
      context: { vendor, status: options.status, ...options.context },
      retryable: options.retryable ?? false,
      cause: options.cause,
    });
    this.vendor = vendor;
  }

  static fromStatus(vendor: string, status: number, body: string, context?: Record<string, unknown>): VendorError {
    const trimmed = body.length > 300 ? `${body.slice(0, 300)}…` : body;
    if (status === 401 || status === 403) {
      return new VendorError(vendor, `Authentication failed (${status}). Check the API key.`, {
        code: "vendor_auth",
        status,
        context,
      });
    }
    if (status === 429) {
      return new VendorError(vendor, `Rate limited (429).`, {
        code: "vendor_rate_limited",
        status,
        retryable: true,
        context,
      });
    }
    if (status >= 500) {
      return new VendorError(vendor, `Vendor error (${status}): ${trimmed}`, {
        code: "vendor_unavailable",
        status,
        retryable: true,
        context,
      });
    }
    return new VendorError(vendor, `Request rejected (${status}): ${trimmed}`, {
      code: "vendor_bad_request",
      status,
      context,
    });
  }
}

/**
 * Section 0: "When a quota runs out, that stage pauses until the quota resets and the
 * owner gets an alert." Modelled as an error so no code path can accidentally continue.
 */
export class QuotaExceededError extends ScoutError {
  constructor(
    readonly resource: string,
    readonly used: number,
    readonly limit: number,
    readonly period: "day" | "month",
  ) {
    super(`Quota exhausted for ${resource}: ${used}/${limit} per ${period}. The stage pauses until it resets.`, {
      code: "quota_exceeded",
      context: { resource, used, limit, period },
    });
  }
}

/** The ordered send guard rules from section 7. */
export type SendGuardRule =
  /** Rule 0 (review item 18): signature or postal address missing — nothing may send. */
  | "config_incomplete"
  | "kill_switch"
  | "enrollment_status"
  | "suppressed"
  | "unclassified_inbound"
  | "daily_cap"
  | "sending_window"
  /**
   * Review item B2: the mailbox is paced. The message owns a reserved slot that has not
   * arrived yet; it is a distinct rule from `sending_window` so the workflow can tell a
   * per-enrollment slot from an out-of-hours block.
   */
  | "pacing"
  | "not_approved"
  | "idempotency"
  /** Review item 21: DRY_RUN is on but there is nowhere safe to redirect to. */
  | "dry_run_unconfigured";

export class SendGuardError extends ScoutError {
  constructor(
    readonly rule: SendGuardRule,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, { code: "guard_failed", context: { rule, ...context } });
  }
}

export function isScoutError(error: unknown): error is ScoutError {
  return error instanceof ScoutError;
}
