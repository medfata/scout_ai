import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import reoonFixture from "@/tests/fixtures/vendor/reoon-verify.json";
import zeroBounceFixture from "@/tests/fixtures/vendor/zerobounce-validate.json";
import type { EmailStatus } from "@/src/domain/types";
import { ConfigurationError, QuotaExceededError, VendorError } from "@/src/lib/errors";
import { resetEnvCache } from "@/src/lib/env";
import { createEmailVerifier, createVerifierChain, type VerificationQuotaHooks } from "./index";
import { createReoonVerifier, mapReoonStatus } from "./reoon";
import { createZeroBounceVerifier, mapZeroBounceStatus } from "./zerobounce";

/**
 * MSW-mocked verifier tests (section 10 rule 4: "no test hits a real vendor"). The
 * fixtures are documented-shape examples; they must be re-recorded with real keys before
 * the adapters are trusted (see spikes/README.md).
 */

const REOON_URL = "https://emailverifier.reoon.com/api/v1/verify";
const ZEROBOUNCE_URL = "https://api.zerobounce.net/v2/validate";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface RecordedCheck {
  email: string;
  provider: string;
  status: EmailStatus;
}

function createFakeQuota(failOnAssertCall?: number): VerificationQuotaHooks & { assertCalls: number; records: RecordedCheck[] } {
  const quota = {
    assertCalls: 0,
    records: [] as RecordedCheck[],
    async assert(): Promise<void> {
      quota.assertCalls += 1;
      if (failOnAssertCall !== undefined && quota.assertCalls >= failOnAssertCall) {
        throw new QuotaExceededError("email_verifications", 23, 23, "day");
      }
    },
    async record(input: RecordedCheck): Promise<void> {
      quota.records.push(input);
    },
  };
  return quota;
}

describe("mapReoonStatus", () => {
  const cases: Array<[string, boolean | null, EmailStatus]> = [
    ["valid", true, "valid"],
    ["valid", false, "risky"],
    ["safe", true, "valid"],
    ["invalid", null, "invalid"],
    ["spamtrap", null, "invalid"],
    ["catch_all", null, "catch_all"],
    ["disposable", null, "disposable"],
    ["role_account", null, "risky"],
    ["risky", null, "risky"],
    ["unknown", null, "unknown"],
    ["something-new", null, "unknown"],
  ];

  it.each(cases)("maps %s (safe=%s) to %s", (raw, safe, expected) => {
    expect(mapReoonStatus(raw, safe)).toBe(expected);
  });
});

describe("mapZeroBounceStatus", () => {
  const cases: Array<[string, EmailStatus]> = [
    ["valid", "valid"],
    ["invalid", "invalid"],
    ["catch-all", "catch_all"],
    ["unknown", "unknown"],
    ["spamtrap", "invalid"],
    ["abuse", "invalid"],
    ["do_not_mail", "invalid"],
  ];

  it.each(cases)("maps %s to %s", (raw, expected) => {
    expect(mapZeroBounceStatus(raw)).toBe(expected);
  });
});

describe("Reoon verifier", () => {
  it("sends the documented request and maps a valid answer", async () => {
    let seenKey: string | null = null;
    let seenMode: string | null = null;
    let calls = 0;

    server.use(
      http.get(REOON_URL, ({ request }) => {
        calls += 1;
        const url = new URL(request.url);
        seenKey = url.searchParams.get("key");
        seenMode = url.searchParams.get("mode");
        return HttpResponse.json(reoonFixture);
      }),
    );

    const verifier = createReoonVerifier({ apiKey: "test-reoon-key" });
    const result = await verifier.verify(reoonFixture.email);

    expect(calls).toBe(1);
    expect(seenKey).toBe("test-reoon-key");
    expect(seenMode).toBe("power");
    expect(result.status).toBe("valid");
    expect(result.provider).toBe("reoon");
    expect(result.raw?.["domain"]).toBe("northwind-logistics.example");
  });

  it("maps catch_all without ever reporting it as valid", async () => {
    server.use(
      http.get(REOON_URL, () => HttpResponse.json({ ...reoonFixture, status: "catch_all", is_safe_to_send: false })),
    );

    const verifier = createReoonVerifier({ apiKey: "test-reoon-key" });
    await expect(verifier.verify("marta.kowalska@northwind-logistics.example")).resolves.toMatchObject({
      status: "catch_all",
      provider: "reoon",
    });
  });

  it("throws a typed VendorError on a provider failure", async () => {
    server.use(http.get(REOON_URL, () => new HttpResponse("service down", { status: 503 })));

    const verifier = createReoonVerifier({ apiKey: "test-reoon-key" });
    const error = await verifier.verify("marta.kowalska@northwind-logistics.example").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).code).toBe("vendor_unavailable");
    expect((error as VendorError).retryable).toBe(true);
  });
});

describe("ZeroBounce verifier", () => {
  it("maps the documented valid response", async () => {
    server.use(http.get(ZEROBOUNCE_URL, () => HttpResponse.json(zeroBounceFixture)));

    const verifier = createZeroBounceVerifier({ apiKey: "test-zb-key" });
    const result = await verifier.verify(zeroBounceFixture.address);

    expect(result.status).toBe("valid");
    expect(result.provider).toBe("zerobounce");
  });

  it("turns an HTTP-200 error payload into a vendor_auth VendorError", async () => {
    server.use(http.get(ZEROBOUNCE_URL, () => HttpResponse.json({ error: "Invalid API Key or your account ran out of credits" })));

    const verifier = createZeroBounceVerifier({ apiKey: "bad-key" });
    const error = await verifier.verify("tomas.becker@kestrel-analytics.example").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).code).toBe("vendor_auth");
  });
});

describe("verifier chain", () => {
  it("falls back to ZeroBounce when Reoon fails, metering both attempts", async () => {
    server.use(
      http.get(REOON_URL, () => new HttpResponse("reoon down", { status: 500 })),
      http.get(ZEROBOUNCE_URL, () => HttpResponse.json(zeroBounceFixture)),
    );

    const quota = createFakeQuota();
    const chain = createVerifierChain({
      verifiers: [createReoonVerifier({ apiKey: "test-reoon-key" }), createZeroBounceVerifier({ apiKey: "test-zb-key" })],
      quota,
    });

    const result = await chain.verify(zeroBounceFixture.address);

    expect(result.provider).toBe("zerobounce");
    expect(result.status).toBe("valid");
    expect(quota.assertCalls).toBe(2);
    expect(quota.records).toEqual([
      { email: zeroBounceFixture.address, provider: "reoon", status: "unknown" },
      { email: zeroBounceFixture.address, provider: "zerobounce", status: "valid" },
    ]);
  });

  it("keeps Reoon's answer and does not call ZeroBounce when Reoon replies", async () => {
    let zeroBounceCalls = 0;
    server.use(
      http.get(REOON_URL, () => HttpResponse.json({ ...reoonFixture, status: "unknown", is_safe_to_send: null })),
      http.get(ZEROBOUNCE_URL, () => {
        zeroBounceCalls += 1;
        return HttpResponse.json(zeroBounceFixture);
      }),
    );

    const quota = createFakeQuota();
    const chain = createVerifierChain({
      verifiers: [createReoonVerifier({ apiKey: "test-reoon-key" }), createZeroBounceVerifier({ apiKey: "test-zb-key" })],
      quota,
    });

    const result = await chain.verify(reoonFixture.email);

    expect(result.provider).toBe("reoon");
    expect(result.status).toBe("unknown");
    expect(zeroBounceCalls).toBe(0);
    expect(quota.assertCalls).toBe(1);
    expect(quota.records).toEqual([{ email: reoonFixture.email, provider: "reoon", status: "unknown" }]);
  });

  it("throws the last VendorError when every verifier fails", async () => {
    server.use(
      http.get(REOON_URL, () => new HttpResponse("reoon down", { status: 500 })),
      http.get(ZEROBOUNCE_URL, () => new HttpResponse("zerobounce down", { status: 502 })),
    );

    const chain = createVerifierChain({
      verifiers: [createReoonVerifier({ apiKey: "test-reoon-key" }), createZeroBounceVerifier({ apiKey: "test-zb-key" })],
      quota: createFakeQuota(),
    });

    const error = await chain.verify(reoonFixture.email).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).vendor).toBe("zerobounce");
  });

  it("stops before the network when the daily verification quota is exhausted", async () => {
    const quota = createFakeQuota(1);
    const chain = createVerifierChain({
      verifiers: [createReoonVerifier({ apiKey: "test-reoon-key" })],
      quota,
    });

    // No MSW handler is registered: `onUnhandledRequest: "error"` would surface any call.
    await expect(chain.verify(reoonFixture.email)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(quota.records).toHaveLength(0);
  });

  it("throws a readable ConfigurationError when no key is configured", () => {
    const saved = { reoon: process.env.REOON_API_KEY, zeroBounce: process.env.ZEROBOUNCE_API_KEY };
    delete process.env.REOON_API_KEY;
    delete process.env.ZEROBOUNCE_API_KEY;
    resetEnvCache();

    try {
      expect(() => createEmailVerifier()).toThrowError(ConfigurationError);
    } finally {
      if (saved.reoon !== undefined) process.env.REOON_API_KEY = saved.reoon;
      if (saved.zeroBounce !== undefined) process.env.ZEROBOUNCE_API_KEY = saved.zeroBounce;
      resetEnvCache();
    }
  });
});
