/**
 * Redacted structured logging (section 10 rule 11: "Log contact ids, not emails or
 * message bodies"). Anything that looks like a secret or a personal identifier is
 * dropped before it reaches the sink, so a careless caller cannot leak a mailbox
 * address into Vercel's log drain.
 */

type Level = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

/** Keys that are never logged, whatever their value. */
const FORBIDDEN_KEYS = new Set(
  [
    "email",
    "emails",
    "to",
    "from",
    "subject",
    "body",
    "html",
    "text",
    "password",
    "token",
    "accessToken",
    "refreshToken",
    "access_token",
    "refresh_token",
    "idToken",
    "apiKey",
    "api_key",
    "secret",
    "authorization",
    "cookie",
    "phone",
    "fullName",
    "full_name",
    "name",
  ].map((key) => key.toLowerCase()),
);

const REDACTED = "[redacted]";

/** Values that look like an email address are replaced even under an allowed key. */
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return EMAIL_LIKE.test(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redactObject(value as LogContext);
  return value;
}

export function redactObject(context: LogContext): LogContext {
  const output: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redactValue(value);
  }
  return output;
}

function emit(level: Level, message: string, context: LogContext = {}): void {
  const line = {
    level,
    at: new Date().toISOString(),
    message,
    ...redactObject(context),
  };
  const serialised = JSON.stringify(line);
  if (level === "error") console.error(serialised);
  else if (level === "warn") console.warn(serialised);
  else console.log(serialised);
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export function createLogger(base: LogContext = {}): Logger {
  return {
    debug: (message, context) => emit("debug", message, { ...base, ...context }),
    info: (message, context) => emit("info", message, { ...base, ...context }),
    warn: (message, context) => emit("warn", message, { ...base, ...context }),
    error: (message, context) => emit("error", message, { ...base, ...context }),
    child: (context) => createLogger({ ...base, ...context }),
  };
}

export const logger = createLogger({ app: "scout" });
