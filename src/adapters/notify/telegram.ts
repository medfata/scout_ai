import type { Alert, Notifier } from "@/src/ports/notifier";
import { VendorError } from "@/src/lib/errors";
import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";

/**
 * Section 4: owner alerts go to a Telegram bot; the daily digest goes by email (phase 5).
 * Section 13 names two env vars: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
 *
 * Bot API only, called with `fetch` — no SDK, so nothing to keep in sync. The message is
 * HTML-parsed, so every value from an alert is escaped before it is sent.
 */

const TELEGRAM_API = "https://api.telegram.org";
/** Telegram rejects messages longer than 4096 characters. */
const MAX_TEXT_LENGTH = 4096;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
  /** Used to turn `/replies?contact=x` into an absolute button URL. */
  appUrl: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
}

interface TelegramSendMessagePayload {
  chat_id: string;
  text: string;
  parse_mode: "HTML";
  disable_web_page_preview: boolean;
  reply_markup?: TelegramInlineKeyboard;
}

export class TelegramNotifier implements Notifier {
  readonly name = "telegram";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: TelegramNotifierOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(alert: Alert): Promise<void> {
    const payload: TelegramSendMessagePayload = {
      chat_id: this.options.chatId,
      text: formatAlertText(alert),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };

    if (alert.url) {
      payload.reply_markup = {
        inline_keyboard: [[{ text: "Open in Scout", url: absoluteUrl(this.options.appUrl, alert.url) }]],
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${TELEGRAM_API}/bot${this.options.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      logger.warn("telegram.unreachable", {});
      throw new VendorError("telegram", "Telegram could not be reached.", {
        code: "vendor_unavailable",
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      // Never log or store the response body: Telegram echoes the chat id back.
      logger.warn("telegram.rejected", { status: response.status });
      throw new VendorError("telegram", `Telegram rejected the message (${response.status}).`, {
        code: telegramErrorCode(response.status),
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
  }
}

/** Telegram now, email later (section 4: "daily digest by email"). Missing config is normal. */
export function createTelegramNotifier(options?: TelegramNotifierOptions): TelegramNotifier | null {
  if (options) return new TelegramNotifier(options);

  const env = readEnv();
  const botToken = env?.TELEGRAM_BOT_TOKEN;
  const chatId = env?.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  return new TelegramNotifier({ botToken, chatId, appUrl: env?.APP_URL ?? "http://localhost:3000" });
}

export function formatAlertText(alert: Alert): string {
  const title = escapeHtml(alert.title);
  const body = escapeHtml(alert.body);
  const text = body.length > 0 ? `<b>${title}</b>\n\n${body}` : `<b>${title}</b>`;
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function absoluteUrl(appUrl: string, path: string): string {
  try {
    return new URL(path, appUrl).toString();
  } catch {
    return path;
  }
}

function telegramErrorCode(status: number): "vendor_auth" | "vendor_rate_limited" | "vendor_unavailable" | "vendor_bad_request" {
  if (status === 401 || status === 403) return "vendor_auth";
  if (status === 429) return "vendor_rate_limited";
  if (status >= 500) return "vendor_unavailable";
  return "vendor_bad_request";
}

function readEnv(): ReturnType<typeof getEnv> | null {
  try {
    return getEnv();
  } catch {
    return null;
  }
}
