import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetEnvCache } from "@/src/lib/env";
import { notifyOwner } from "@/src/services/notifications";
import type { Alert } from "@/src/ports/notifier";
import { TelegramNotifier } from "./telegram";

/**
 * The Bot API is MSW-mocked; nothing in this file talks to Telegram. The two behaviours
 * that matter are section 3's ("an alert failure must not break a workflow" — enforced by
 * `notifyOwner`) and the deep link that takes the owner from a chat straight into Scout.
 */

const BOT_TOKEN = "test-bot-token";
const CHAT_ID = "chat-1";
const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
/** Matches whatever token the shared test env happens to use. */
const ANY_TELEGRAM_URL = /^https:\/\/api\.telegram\.org\/bot.+\/sendMessage$/;

const server = setupServer();

let captured: Record<string, unknown> | null = null;

const hotReply: Alert = {
  kind: "reply_hot",
  title: "Hot reply from Ada",
  body: "Ada asked for a call on Thursday.",
  url: "/replies?contact=11111111-1111-4111-8111-111111111111",
  contactId: "11111111-1111-4111-8111-111111111111",
};

beforeAll(() => {
  // `src/lib/env.ts` requires the core vars before any vendor check, so make sure a
  // self-contained test run still has them. Values already set win.
  process.env.APP_URL = "https://scout.example";
  process.env.ADMIN_EMAIL ??= "owner@example.com";
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-1234";
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  process.env.DATABASE_URL ??= "postgres://scout:scout@localhost:5432/scout";
  process.env.OWNER_TIMEZONE ??= "UTC";
  process.env.TELEGRAM_BOT_TOKEN ??= BOT_TOKEN;
  process.env.TELEGRAM_CHAT_ID ??= CHAT_ID;
  resetEnvCache();

  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  captured = null;
});

afterAll(() => server.close());

describe("telegram notifier", () => {
  it("includes the deep link as an inline button when the alert has a url", async () => {
    server.use(
      http.post(TELEGRAM_URL, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    await notifier().send(hotReply);

    expect(captured?.chat_id).toBe(CHAT_ID);
    expect(captured?.parse_mode).toBe("HTML");
    expect(captured?.disable_web_page_preview).toBe(true);
    expect(String(captured?.text)).toContain("<b>Hot reply from Ada</b>");
    expect(String(captured?.text)).toContain("Ada asked for a call on Thursday.");

    const markup = captured?.reply_markup as { inline_keyboard: Array<Array<{ url: string }>> } | undefined;
    expect(markup?.inline_keyboard[0]?.[0]?.url).toBe(
      "https://scout.example/replies?contact=11111111-1111-4111-8111-111111111111",
    );
  });

  it("sends no inline keyboard when the alert has no url", async () => {
    server.use(
      http.post(TELEGRAM_URL, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    await notifier().send({ kind: "quota", title: "Quota reached", body: "Exa searches are exhausted." });

    expect(captured?.reply_markup).toBeUndefined();
  });

  it("escapes HTML so an alert can never inject markup into the chat", async () => {
    server.use(
      http.post(TELEGRAM_URL, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    await notifier().send({ kind: "error", title: "Cron failed <script>", body: "a & b" });

    expect(String(captured?.text)).toContain("<b>Cron failed &lt;script&gt;</b>");
    expect(String(captured?.text)).toContain("a &amp; b");
  });

  it("never throws out of notifyOwner when the notifier fails", async () => {
    server.use(
      http.post(ANY_TELEGRAM_URL, () => HttpResponse.json({ ok: false, description: "Bad Request" }, { status: 400 })),
    );

    await expect(
      notifyOwner({ kind: "quota", title: "Quota reached", body: "Exa searches are exhausted.", url: "/dashboard" }),
    ).resolves.toBeUndefined();
  });

  it("never throws out of notifyOwner when the network is down", async () => {
    server.use(http.post(ANY_TELEGRAM_URL, () => HttpResponse.error()));

    await expect(notifyOwner({ kind: "error", title: "Send failed", body: "Gmail returned 503." })).resolves.toBeUndefined();
  });
});

function notifier(): TelegramNotifier {
  return new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, appUrl: "https://scout.example" });
}
