import { Auth } from "googleapis";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { VendorError } from "@/src/lib/errors";
import type { OutboundMessage } from "@/src/ports/channel";
import { createGmailChannel, type GmailCredentials, type GmailMailbox } from "./gmail";

/**
 * Section 10 rule 4: "Every port has a fake. Tests run against in-memory fakes and MSW
 * mocks; no test hits a real vendor." The Gmail client is real, so the request MSW
 * captures is the request Scout would really send; the OAuth client and the mailbox
 * reader are injected, so no Google call and no database read happens.
 */

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const MAILBOX_HANDLE = "founder@scoutmail.example";
const NOW = new Date("2026-09-24T12:00:00Z");
const VALID_EXPIRY = NOW.getTime() + 3_600_000;

const server = setupServer();

interface SendBody {
  raw?: string;
  threadId?: string;
}

let captured: { authorization: string | null; body: SendBody } | null = null;
let sendCalls = 0;

function captureSend(threadId = "thread_1") {
  return http.post(SEND_URL, async ({ request }) => {
    sendCalls += 1;
    captured = {
      authorization: request.headers.get("authorization"),
      body: (await request.json()) as SendBody,
    };
    return HttpResponse.json({ id: "msg_1", threadId, labelIds: ["SENT"] });
  });
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  captured = null;
  sendCalls = 0;
});
afterAll(() => server.close());

describe("gmail channel", () => {
  it("sends a plain-text MIME message with the right headers and no HTML part", async () => {
    server.use(captureSend());
    const { channel } = makeChannel({ credentials: validCredentials() });

    const result = await channel.send(outbound());

    expect(result.providerMessageId).toBe("msg_1");
    expect(result.sentAt).toEqual(NOW);
    expect(result.redirected).toBe(false);
    expect(captured?.authorization).toBe("Bearer access-1");

    const raw = decodeRaw(captured?.body.raw);
    expect(raw).toContain("From: founder@scoutmail.example");
    expect(raw).toContain("To: prospect@acme.example");
    expect(raw).toContain("Subject: A quick idea for Acme");
    expect(raw).toMatch(/^Date: /m);
    expect(raw).toMatch(/^Message-ID: <[0-9a-f-]+@scoutmail\.example>$/m);
    expect(raw).toContain("MIME-Version: 1.0");
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain("Content-Transfer-Encoding: quoted-printable");
    expect(raw).toContain("One observation about your support queue.");
    expect(raw).toContain("=E2=80=94 Karim");

    // Section 9: plain text only. No HTML alternative, no tracking pixel, no images.
    expect(raw).not.toContain("text/html");
    expect(raw).not.toContain("multipart/");
    expect(raw).not.toContain("<img");
    expect(raw).not.toContain("1x1");
    expect(captured?.body.threadId).toBeUndefined();
  });

  it("keeps a follow-up in the same Gmail thread with In-Reply-To and References", async () => {
    server.use(captureSend("thread_99"));
    const { channel } = makeChannel({ credentials: validCredentials() });

    const result = await channel.send(
      outbound({
        threadId: "thread_99",
        inReplyTo: "<parent@acme.example>",
        references: ["<root@scoutmail.example>", "<parent@acme.example>"],
      }),
    );

    expect(captured?.body.threadId).toBe("thread_99");
    const raw = decodeRaw(captured?.body.raw);
    expect(raw).toContain("In-Reply-To: <parent@acme.example>");
    expect(raw).toContain("References: <root@scoutmail.example> <parent@acme.example>");
    expect(result.threadId).toBe("thread_99");

    // Gmail requires the subject to match for a reply to join the thread.
    expect(raw).toContain("Subject: A quick idea for Acme");
  });

  it("tags a DRY_RUN send as a test and reports the redirect", async () => {
    server.use(captureSend());
    const { channel } = makeChannel({ credentials: validCredentials() });

    const result = await channel.send(
      outbound({ to: "owner-test@example.com", dryRunRedirect: "owner-test@example.com", isTest: true }),
    );

    expect(result.redirected).toBe(true);
    const raw = decodeRaw(captured?.body.raw);
    expect(raw).toContain("To: owner-test@example.com");
    expect(raw).toContain("X-Scout-Test: 1");
  });

  it("refreshes an expiring token, persists it, and sends with the new one", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "fresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.send",
          token_type: "Bearer",
        }),
      ),
      captureSend(),
    );
    const saver = credentialsSaver();
    const { channel } = makeChannel({
      credentials: { refreshToken: "refresh-1", accessToken: "stale-token", accessTokenExpiresAt: NOW.getTime() + 30_000 },
      saveCredentials: saver.save,
    });

    await channel.send(outbound());

    expect(saver.calls).toHaveLength(1);
    expect(saver.calls[0]?.id).toBe(ACCOUNT_ID);
    expect(saver.calls[0]?.credentials.accessToken).toBe("fresh-token");
    expect(saver.calls[0]?.credentials.refreshToken).toBe("refresh-1");
    expect(captured?.authorization).toBe("Bearer fresh-token");
  });

  it("pauses the account and throws vendor_auth when the credentials were revoked", async () => {
    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 })),
    );
    const pauser = credentialsPauser();
    const { channel } = makeChannel({
      credentials: { refreshToken: "refresh-1", accessToken: null, accessTokenExpiresAt: null },
      markCredentialsBad: pauser.mark,
    });

    const error = await channel.send(outbound()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).code).toBe("vendor_auth");
    expect(pauser.calls[0]?.id).toBe(ACCOUNT_ID);
    expect(pauser.calls[0]?.detail).toContain("invalid_grant");
    expect(sendCalls).toBe(0);
  });

  it("pauses the account and throws vendor_auth when Gmail rejects the send with 401", async () => {
    server.use(
      http.post(SEND_URL, () => HttpResponse.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 })),
    );
    const pauser = credentialsPauser();
    const { channel } = makeChannel({ credentials: validCredentials(), markCredentialsBad: pauser.mark });

    const error = await channel.send(outbound()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).code).toBe("vendor_auth");
    expect(pauser.calls[0]?.detail).toContain("Google rejected the mailbox credentials");
  });

  it("returns null instead of throwing when the mailbox is not connected", async () => {
    const { channel } = makeChannel({ mailbox: null });
    const error = await channel.send(outbound()).catch((thrown: unknown) => thrown);
    expect(error).not.toBeInstanceOf(VendorError);
    expect(error).toBeInstanceOf(Error);
    expect(sendCalls).toBe(0);
  });

  it("reports a rate limit as retryable and leaves the account alone", async () => {
    server.use(http.post(SEND_URL, () => HttpResponse.json({ error: { code: 429 } }, { status: 429 })));
    const pauser = credentialsPauser();
    const { channel } = makeChannel({ credentials: validCredentials(), markCredentialsBad: pauser.mark });

    const error = await channel.send(outbound()).catch((thrown: unknown) => thrown);

    expect((error as VendorError).code).toBe("vendor_rate_limited");
    expect((error as VendorError).retryable).toBe(true);
    expect(pauser.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validCredentials(): GmailCredentials {
  return { refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: VALID_EXPIRY, scope: null };
}

function makeChannel(options: {
  credentials?: GmailCredentials | null;
  mailbox?: GmailMailbox | null;
  saveCredentials?: (mailboxId: string, credentials: GmailCredentials) => Promise<void>;
  markCredentialsBad?: (mailboxId: string, detail: string) => Promise<void>;
}) {
  const mailbox =
    options.mailbox === undefined
      ? { id: ACCOUNT_ID, handle: MAILBOX_HANDLE, credentials: options.credentials ?? validCredentials() }
      : options.mailbox;
  const saver = credentialsSaver();
  const pauser = credentialsPauser();

  const channel = createGmailChannel({
    loadMailbox: async () => mailbox,
    createOAuthClient: () => new Auth.OAuth2Client({ clientId: "test-client-id", clientSecret: "test-client-secret" }),
    saveCredentials: options.saveCredentials ?? saver.save,
    markCredentialsBad: options.markCredentialsBad ?? pauser.mark,
    now: () => NOW,
  });
  if (!channel) throw new Error("createGmailChannel returned null for an injected configuration.");
  return { channel, saver, pauser };
}

function credentialsSaver() {
  const calls: Array<{ id: string; credentials: GmailCredentials }> = [];
  return {
    calls,
    save: async (id: string, credentials: GmailCredentials) => {
      calls.push({ id, credentials });
    },
  };
}

function credentialsPauser() {
  const calls: Array<{ id: string; detail: string }> = [];
  return {
    calls,
    mark: async (id: string, detail: string) => {
      calls.push({ id, detail });
    },
  };
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    to: "prospect@acme.example",
    subject: "A quick idea for Acme",
    body: "Hi Ada,\n\nOne observation about your support queue.\n\n— Karim",
    threadId: null,
    inReplyTo: null,
    references: [],
    ...overrides,
  };
}

function decodeRaw(raw: string | undefined): string {
  if (!raw) throw new Error("The adapter sent no raw message.");
  return Buffer.from(raw, "base64url").toString("utf8");
}
