// This import must stay first. `tests/fakes/channel.ts` registers the `createGmailChannel`
// mock when it is evaluated; importing any service above it would build the channel
// registry with the real factory before the mock exists.
import { createFakeChannel, installFakeChannel, type FakeChannel } from "../fakes/channel";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/src/db/client";
import {
  activityEvents,
  connectedAccounts,
  messages,
  suppressions,
  type Company,
  type ConnectedAccount,
  type Contact,
  type Enrollment,
  type Message,
  type NewCompany,
  type NewContact,
  type NewMessage,
  type Settings,
} from "@/src/db/schema";
import { EMAIL_LINKEDIN_V1, type SequenceStep } from "@/src/domain";
import type { MessageStatus, SendBucket } from "@/src/domain/types";
import { getEnv, resetEnvCache, type Env } from "@/src/lib/env";
import type * as EnvModule from "@/src/lib/env";
import { ScoutError, type SendGuardRule } from "@/src/lib/errors";
import { dateOnlyInZone } from "@/src/lib/time-windows";
import { reserveSendSlot, type UpsertAccountInput } from "@/src/services/accounts";
import { getMessage, type MarkSentInput } from "@/src/services/messages";
import type * as MessagesModule from "@/src/services/messages";
import { getSendCounters } from "@/src/services/quota";
import { buildDeterministicMessageId, sendMessage, type SendOutcome } from "@/src/services/sending";
import type { SettingsPatch } from "@/src/services/settings";
import {
  configureSettings,
  createCompany,
  createContact,
  createEmailAccount,
  createEnrollment,
  createIcp,
  createInboundMessage,
  createMessage,
  createSuppression,
  seedSendCounters,
  testSendingWindow,
} from "../factories";
import { closeTestDatabase, hasDatabase, resetDatabase } from "../setup/db";

/**
 * Section 10 rule 6: "One send path. Nothing sends except `sendMessage` and its guard;
 * each guard rule has a test." Section 10 rule 4: no test here calls Gmail — the channel
 * is `tests/fakes/channel.ts`, installed through the registry's own factory seam.
 *
 * Every suite in this file is database-backed (the guard's state lives in Postgres) and
 * skips cleanly when `DATABASE_URL` is unreachable:
 *
 *     describe.skipIf(!(await hasDatabase()))
 *
 * The `pacing` rule (review item B2) has its own block at the end of the main describe.
 */

/** Mutable env override; keeps `getEnv()` valid while removing one var for a test. */
const envOverrides = vi.hoisted(() => ({ current: {} as Partial<Env> }));

vi.mock("@/src/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    getEnv: () => ({ ...actual.getEnv(), ...envOverrides.current }),
  };
});

/**
 * Two deterministic simulations of database-level races/failures:
 *  - `stealClaimFor`: another worker claims the message between the guard's read and its
 *    conditional UPDATE (the lost claim race);
 *  - `failMarkSentOnce`: `markMessageSent` fails after the provider already accepted.
 * Everything else passes through to the real service.
 */
const messagesHooks = vi.hoisted(() => ({
  stealClaimFor: null as { messageId: string; rfcMessageId: string } | null,
  failMarkSentOnce: false,
}));

vi.mock("@/src/services/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof MessagesModule>();
  return {
    ...actual,
    claimMessageForSend: async (messageId: string, rfcMessageId?: string) => {
      const steal = messagesHooks.stealClaimFor;
      if (steal && steal.messageId === messageId) {
        messagesHooks.stealClaimFor = null;
        // The other worker wins the conditional UPDATE...
        await actual.claimMessageForSend(messageId, steal.rfcMessageId);
      }
      // ...so this worker's claim matches no `approved` row and returns null.
      return actual.claimMessageForSend(messageId, rfcMessageId);
    },
    markMessageSent: async (messageId: string, input: MarkSentInput) => {
      if (messagesHooks.failMarkSentOnce) {
        messagesHooks.failMarkSentOnce = false;
        throw new Error("simulated database failure while recording the send");
      }
      return actual.markMessageSent(messageId, input);
    },
  };
});

const databaseAvailable = await hasDatabase();

describe.skipIf(!databaseAvailable)("sendMessage guard and failure handling", () => {
  let fake: FakeChannel;

  beforeEach(async () => {
    await resetDatabase();
    envOverrides.current = {};
    messagesHooks.stealClaimFor = null;
    messagesHooks.failMarkSentOnce = false;
    fake = createFakeChannel();
    await installFakeChannel(fake);
  });

  afterAll(async () => {
    await installFakeChannel(null);
    await closeTestDatabase();
  });

  // -------------------------------------------------------------------------
  // One describe per guard rule, named exactly after the rule
  // -------------------------------------------------------------------------

  describe("config_incomplete", () => {
    it("blocks when the signature is blank", async () => {
      const seeded = await seedOutreach({ settings: { signature: "   " } });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "config_incomplete");

      expect(outcome.detail).toContain("Signature or postal address");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("blocks when the postal address is blank", async () => {
      const seeded = await seedOutreach({ settings: { postalAddress: " " } });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "config_incomplete");

      expect(outcome.detail).toContain("Signature or postal address");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("blocks when no sending mailbox is connected", async () => {
      const seeded = await seedOutreach({ account: null });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "config_incomplete");

      expect(outcome.detail).toContain("mailbox");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("blocks when the email channel adapter is not configured", async () => {
      const seeded = await seedOutreach();
      await installFakeChannel(null);

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "config_incomplete");

      expect(outcome.detail).toContain("Gmail channel is not configured");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("returns a message to approved and releases counters when credentials are rejected", async () => {
      const seeded = await seedOutreach({ counters: { new: 2, total: 3 } });
      fake.setBehaviour({ type: "auth" });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "config_incomplete");

      expect(outcome.detail).toContain("credentials rejected");
      expect((await getMessage(seeded.message.id))?.status).toBe("approved");
      expect(await readCounters(seeded)).toEqual({ new: 2, total: 3 });
      expect(fake.sendCalls).toHaveLength(1);
    });
  });

  describe("kill_switch", () => {
    it("blocks every send while the switch is on", async () => {
      const seeded = await seedOutreach({ settings: { killSwitch: true } });

      blocked(await sendStep(seeded.enrollment.id, 0), "kill_switch");

      expect(fake.sendCalls).toHaveLength(0);
    });
  });

  describe("dry_run_unconfigured", () => {
    it("blocks when DRY_RUN has no redirect destination", async () => {
      envOverrides.current = { DRY_RUN: true, DRY_RUN_REDIRECT_EMAIL: "" };
      const seeded = await seedOutreach();

      blocked(await sendStep(seeded.enrollment.id, 0), "dry_run_unconfigured");

      expect(fake.sendCalls).toHaveLength(0);
    });

    it("is refused at boot by env validation (the real protection, review item 21)", async () => {
      const previous = process.env.DRY_RUN_REDIRECT_EMAIL;
      delete process.env.DRY_RUN_REDIRECT_EMAIL;
      resetEnvCache();
      try {
        expect(() => getEnv()).toThrow(/DRY_RUN_REDIRECT_EMAIL/);
      } finally {
        if (previous === undefined) delete process.env.DRY_RUN_REDIRECT_EMAIL;
        else process.env.DRY_RUN_REDIRECT_EMAIL = previous;
        resetEnvCache();
      }
    });
  });

  describe("enrollment_status", () => {
    it("blocks when the enrollment is waiting, not active", async () => {
      const seeded = await seedOutreach({ enrollmentStatus: "waiting" });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "enrollment_status");

      expect(outcome.detail).toContain('"waiting"');
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("blocks when the enrollment is stopped", async () => {
      const seeded = await seedOutreach({ enrollmentStatus: "stopped" });

      blocked(await sendStep(seeded.enrollment.id, 0), "enrollment_status");

      expect(fake.sendCalls).toHaveLength(0);
    });
  });

  describe("suppressed", () => {
    it("skips a lead whose exact email is suppressed, and records why", async () => {
      const seeded = await seedOutreach({ contact: { email: "jo@acme.example" } });
      await createSuppression({ kind: "email", value: "JO@Acme.example", reason: "unsubscribe" });

      const outcome = skipped(await sendStep(seeded.enrollment.id, 0), "suppressed");

      expect(outcome.messageId).toBeNull();
      expect(fake.sendCalls).toHaveLength(0);
      const events = await getDb()
        .select({ id: activityEvents.id })
        .from(activityEvents)
        .where(and(eq(activityEvents.type, "suppression.matched"), eq(activityEvents.entityId, seeded.contact.id)));
      expect(events).toHaveLength(1);
    });

    it("skips every address on a suppressed email domain", async () => {
      const seeded = await seedOutreach({ contact: { email: "jo@acme.example" } });
      await createSuppression({ kind: "domain", value: "https://www.ACME.example/" });

      skipped(await sendStep(seeded.enrollment.id, 0), "suppressed");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("skips a lead whose company domain is suppressed even from another email domain", async () => {
      const seeded = await seedOutreach({
        company: { domain: "acme.example" },
        contact: { email: "jo@personal.example" },
      });
      await createSuppression({ kind: "domain", value: "acme.example" });

      skipped(await sendStep(seeded.enrollment.id, 0), "suppressed");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("skips a lead whose LinkedIn profile is suppressed, on every channel", async () => {
      const seeded = await seedOutreach({
        contact: { linkedinUrl: "https://www.linkedin.com/in/jo-smith/" },
      });
      await createSuppression({ kind: "linkedin", value: "linkedin.com/in/jo-smith" });

      skipped(await sendStep(seeded.enrollment.id, 0), "suppressed");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("still matches a suppression row whose plaintext value is NULL (review item 19)", async () => {
      const seeded = await seedOutreach({ contact: { email: "jo@acme.example" } });
      const suppression = await createSuppression({ kind: "email", value: "jo@acme.example" });
      await getDb().update(suppressions).set({ value: null }).where(eq(suppressions.id, suppression.id));

      skipped(await sendStep(seeded.enrollment.id, 0), "suppressed");
      expect(fake.sendCalls).toHaveLength(0);
    });
  });

  describe("unclassified_inbound", () => {
    it("blocks while a reply has not been classified yet", async () => {
      const seeded = await seedOutreach();
      await createInboundMessage({ contactId: seeded.contact.id, intent: null });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "unclassified_inbound");

      expect(outcome.detail).toContain("not resolved");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("blocks on a classified human reply too (the reply workflow handles it)", async () => {
      const seeded = await seedOutreach();
      await createInboundMessage({ contactId: seeded.contact.id, intent: "interested" });

      blocked(await sendStep(seeded.enrollment.id, 0), "unclassified_inbound");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("does not block on a non-human intent such as an auto-reply", async () => {
      const seeded = await seedOutreach();
      await createInboundMessage({ contactId: seeded.contact.id, intent: "auto_reply" });

      const outcome = await sendStep(seeded.enrollment.id, 0);

      expect(outcome.status).toBe("sent");
      expect(fake.sendCalls).toHaveLength(1);
    });
  });

  describe("requires_consent", () => {
    it("skips an email step when the company country requires consent (Germany)", async () => {
      const seeded = await seedOutreach({ company: { country: "Germany" } });

      const outcome = skipped(await sendStep(seeded.enrollment.id, 0), "requires_consent");

      expect(outcome.messageId).toBeNull();
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("sends to a country the consent list does not name", async () => {
      const seeded = await seedOutreach({ company: { country: "US" } });

      expect((await sendStep(seeded.enrollment.id, 0)).status).toBe("sent");
      expect(fake.sendCalls).toHaveLength(1);
    });
  });

  describe("sending_window", () => {
    it("blocks outside the window and proposes the next opening", async () => {
      const now = new Date();
      const later = testSendingWindow(now, 2);
      const seeded = await seedOutreach({ settings: { sendingWindows: { email: later, linkedin: later } } });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "sending_window");

      expect(outcome.messageId).toBe(seeded.message.id);
      expect(outcome.nextAt?.getTime()).toBeGreaterThan(now.getTime());
      expect(fake.sendCalls).toHaveLength(0);
    });
  });

  describe("not_approved", () => {
    it("blocks when no message exists for the step yet", async () => {
      await configureSettings();
      await createEmailAccount();
      const company = await createCompany();
      const contact = await createContact({ companyId: company.id });
      const icp = await createIcp();
      const enrollment = await createEnrollment({ contactId: contact.id, icpId: icp.id, status: "active" });

      const outcome = blocked(await sendStep(enrollment.id, 0), "not_approved");

      expect(outcome.detail).toContain("No message exists");
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("blocks while the message is still pending approval", async () => {
      const seeded = await seedOutreach({ messageStatus: "pending_approval" });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "not_approved");

      expect(outcome.detail).toContain('"pending_approval"');
      expect(outcome.messageId).toBe(seeded.message.id);
      expect(fake.sendCalls).toHaveLength(0);
    });
  });

  describe("daily_cap", () => {
    it("blocks a first touch when the new-conversation bucket is full", async () => {
      // Warmup week 1 gives 5 new and 5 total; the total bucket still has room.
      const seeded = await seedOutreach({ account: { warmupStage: 1 }, counters: { new: 5, total: 0 } });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "daily_cap");

      expect(outcome.detail).toContain("new-conversation cap");
      expect(outcome.nextAt?.getTime()).toBeGreaterThan(Date.now());
      expect(fake.sendCalls).toHaveLength(0);
      expect(await readCounters(seeded)).toEqual({ new: 5, total: 0 });
    });

    it("blocks when the total bucket is full even though the new bucket is free", async () => {
      const seeded = await seedOutreach({ account: { warmupStage: 1 }, counters: { new: 0, total: 5 } });

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "daily_cap");

      expect(outcome.detail).toContain("total cap");
      expect(await readCounters(seeded)).toEqual({ new: 0, total: 5 });
      expect(fake.sendCalls).toHaveLength(0);
    });
  });

  describe("idempotency", () => {
    it("releases both counters when another worker wins the claim race", async () => {
      const seeded = await seedOutreach({ counters: { new: 0, total: 0 } });
      const key = requireIdempotencyKey(seeded.message);
      messagesHooks.stealClaimFor = {
        messageId: seeded.message.id,
        rfcMessageId: buildDeterministicMessageId(key, "scoutmail.example"),
      };

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "idempotency");

      expect(outcome.detail).toContain("Another worker");
      expect(fake.sendCalls).toHaveLength(0);
      expect(await readCounters(seeded)).toEqual({ new: 0, total: 0 });
      expect((await getMessage(seeded.message.id))?.status).toBe("sending");
    });
  });

  // -------------------------------------------------------------------------
  // The pacing reservation the guard depends on (review item 11/B2)
  // -------------------------------------------------------------------------

  /**
   * Regression pin for the review item 11/B2 bug found while writing these tests: the
   * original `reserveSendSlot` passed `now` (a `Date`) into a raw `sql` fragment inside
   * `.set()`, and postgres.js could not serialize it (`ERR_INVALID_ARG_TYPE`). Every
   * guarded send died there. It was fixed in the working tree with an ISO string plus an
   * explicit `::timestamptz` cast; this test keeps it fixed. The `pacing` rule itself is
   * owned by the B2 change and is tested in its own block below.
   */
  describe("reserveSendSlot (review item 11/B2 dependency)", () => {
    it("records a slot for the mailbox instead of failing to serialize the Date", async () => {
      const account = await createEmailAccount();

      const reservation = await reserveSendSlot(account.id, 60_000, new Date());

      expect(reservation.slotAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(reservation.nextSlotAt.getTime()).toBeGreaterThan(reservation.slotAt.getTime());
      const stored = await getDb()
        .select({ nextSendAt: connectedAccounts.nextSendAt })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, account.id))
        .limit(1);
      expect(stored[0]?.nextSendAt?.getTime()).toBe(reservation.nextSlotAt.getTime());
    });
  });

  // -------------------------------------------------------------------------
  // Review item 6: a block must never burn a send counter
  // -------------------------------------------------------------------------

  describe("counter safety", () => {
    it("leaves both counters unchanged when the sending window blocks the send", async () => {
      const now = new Date();
      const later = testSendingWindow(now, 2);
      const seeded = await seedOutreach({
        settings: { sendingWindows: { email: later, linkedin: later } },
        counters: { new: 3, total: 4 },
      });

      blocked(await sendStep(seeded.enrollment.id, 0), "sending_window");

      expect(await readCounters(seeded)).toEqual({ new: 3, total: 4 });
    });

    it("leaves both counters unchanged when approval blocks the send", async () => {
      const seeded = await seedOutreach({ messageStatus: "pending_approval", counters: { new: 3, total: 4 } });

      blocked(await sendStep(seeded.enrollment.id, 0), "not_approved");

      expect(await readCounters(seeded)).toEqual({ new: 3, total: 4 });
    });
  });

  // -------------------------------------------------------------------------
  // Review item 8: ambiguous failures reconcile, never double-send
  // -------------------------------------------------------------------------

  describe("ambiguous failure and reconciliation", () => {
    it("keeps the message sending and the counters, then reconciles without a second provider call", async () => {
      const seeded = await seedOutreach({ counters: { new: 2, total: 3 } });
      fake.setBehaviour({ type: "ambiguous" });

      const error: unknown = await sendStep(seeded.enrollment.id, 0).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ScoutError);
      if (!(error instanceof ScoutError)) throw new Error("expected a retryable ScoutError");
      expect(error.retryable).toBe(true);

      const inFlight = await getMessage(seeded.message.id);
      expect(inFlight?.status).toBe("sending");
      expect(inFlight?.rfcMessageId).not.toBeNull();
      expect(await readCounters(seeded)).toEqual({ new: 3, total: 4 });
      expect(fake.sendCalls).toHaveLength(1);

      fake.setBehaviour({ type: "ok" });
      fake.setReconciliation("found");

      const retry = await sendStep(seeded.enrollment.id, 0);

      expect(retry.status).toBe("sent");
      expect(fake.sendCalls).toHaveLength(1);
      expect(fake.lookupCalls).toEqual([inFlight?.rfcMessageId]);
      const recorded = await getMessage(seeded.message.id);
      expect(recorded?.status).toBe("sent");
      expect(recorded?.providerMessageId).toBe("reconciled-1");
      expect(recorded?.threadId).toBe("thread-reconciled");
      expect(await readCounters(seeded)).toEqual({ new: 3, total: 4 });
    });

    it("keeps the message sending when the provider reports a retryable failure", async () => {
      const seeded = await seedOutreach({ counters: { new: 2, total: 3 } });
      fake.setBehaviour({ type: "retryable" });

      const error: unknown = await sendStep(seeded.enrollment.id, 0).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ScoutError);
      if (!(error instanceof ScoutError)) throw new Error("expected a retryable ScoutError");
      expect(error.retryable).toBe(true);
      expect((await getMessage(seeded.message.id))?.status).toBe("sending");
      expect(await readCounters(seeded)).toEqual({ new: 3, total: 4 });
      expect(fake.sendCalls).toHaveLength(1);
    });

    it("resends exactly once when the mailbox does not have the message", async () => {
      const seeded = await seedOutreach({ counters: { new: 2, total: 3 } });
      fake.setBehaviour({ type: "ambiguous" });

      await sendStep(seeded.enrollment.id, 0).catch(() => undefined);
      expect(fake.sendCalls).toHaveLength(1);

      fake.setBehaviour({ type: "ok" });
      fake.setReconciliation("not_found");

      const retry = await sendStep(seeded.enrollment.id, 0);

      expect(retry.status).toBe("sent");
      expect(fake.sendCalls).toHaveLength(2);
      expect(fake.lookupCalls).toHaveLength(1);
      expect(await readCounters(seeded)).toEqual({ new: 3, total: 4 });
    });

    it("never calls the provider twice when recording a successful send fails (review item 7)", async () => {
      const seeded = await seedOutreach({ counters: { new: 2, total: 3 } });
      messagesHooks.failMarkSentOnce = true;

      const error: unknown = await sendStep(seeded.enrollment.id, 0).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ScoutError);
      if (!(error instanceof ScoutError)) throw new Error("expected a retryable ScoutError");
      expect(error.retryable).toBe(true);
      expect(fake.sendCalls).toHaveLength(1);
      expect((await getMessage(seeded.message.id))?.status).toBe("sending");
      expect(await readCounters(seeded)).toEqual({ new: 3, total: 4 });

      fake.setReconciliation("found");

      const retry = await sendStep(seeded.enrollment.id, 0);

      expect(retry.status).toBe("sent");
      expect(fake.sendCalls).toHaveLength(1);
      expect((await getMessage(seeded.message.id))?.status).toBe("sent");
      expect(await readCounters(seeded)).toEqual({ new: 3, total: 4 });
    });
  });

  // -------------------------------------------------------------------------
  // A definite rejection is a failure, not a retry
  // -------------------------------------------------------------------------

  describe("definite rejection", () => {
    it("marks the message failed and releases both counters on a 400", async () => {
      const seeded = await seedOutreach({ counters: { new: 2, total: 3 } });
      fake.setBehaviour({ type: "rejected", status: 400 });

      const outcome = await sendStep(seeded.enrollment.id, 0);

      if (outcome.status !== "failed") throw new Error(`expected failed, received ${outcome.status}`);
      expect(outcome.error).toContain("400");
      expect((await getMessage(seeded.message.id))?.status).toBe("failed");
      expect(await readCounters(seeded)).toEqual({ new: 2, total: 3 });
      expect(fake.sendCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Review item 10: threading
  // -------------------------------------------------------------------------

  describe("threading", () => {
    it("a follow-up carries In-Reply-To = the last sent Message-ID and References = all prior", async () => {
      const seeded = await seedOutreach({
        account: { warmupStage: 5 },
        message: { step: 4, stepKey: "email_followup_2", threadId: "thread-root" },
      });
      await createMessage({
        enrollmentId: seeded.enrollment.id,
        contactId: seeded.contact.id,
        step: 0,
        stepKey: "email_1",
        status: "sent",
        rfcMessageId: "<root@scoutmail.example>",
        threadId: "thread-root",
        sentAt: new Date("2026-09-20T09:00:00Z"),
      });
      await createMessage({
        enrollmentId: seeded.enrollment.id,
        contactId: seeded.contact.id,
        step: 3,
        stepKey: "email_followup_1",
        status: "sent",
        rfcMessageId: "<followup-1@scoutmail.example>",
        threadId: "thread-root",
        sentAt: new Date("2026-09-23T09:00:00Z"),
      });

      const outcome = await sendStep(seeded.enrollment.id, 4, stepAt(4));

      expect(outcome.status).toBe("sent");
      const sent = fake.sendCalls[0];
      expect(sent?.threadId).toBe("thread-root");
      expect(sent?.inReplyTo).toBe("<followup-1@scoutmail.example>");
      expect(sent?.references).toEqual(["<root@scoutmail.example>", "<followup-1@scoutmail.example>"]);
    });

    it("a first touch starts a new thread with no In-Reply-To and no References", async () => {
      const seeded = await seedOutreach();

      expect((await sendStep(seeded.enrollment.id, 0)).status).toBe("sent");
      const sent = fake.sendCalls[0];
      expect(sent?.threadId).toBeNull();
      expect(sent?.inReplyTo).toBeNull();
      expect(sent?.references).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // B2: per-enrollment pacing slots (added with the pacing change)
  // -------------------------------------------------------------------------

  describe("pacing", () => {
    /** A mailbox that already has an hour of queue ahead, so a reservation is future. */
    function queuedSlot(): Date {
      return new Date(Date.now() + 60 * 60 * 1000);
    }

    async function queueMailbox(seeded: Outreach, slotAt: Date): Promise<void> {
      await getDb()
        .update(connectedAccounts)
        .set({ nextSendAt: slotAt })
        .where(eq(connectedAccounts.id, requireAccount(seeded).id));
    }

    async function readNextSendAt(seeded: Outreach): Promise<Date | null> {
      const [row] = await getDb()
        .select({ nextSendAt: connectedAccounts.nextSendAt })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, requireAccount(seeded).id))
        .limit(1);
      return row?.nextSendAt ?? null;
    }

    it("blocks under the pacing rule and stores the reserved slot on the message", async () => {
      const seeded = await seedOutreach();
      await queueMailbox(seeded, queuedSlot());

      const outcome = blocked(await sendStep(seeded.enrollment.id, 0), "pacing");

      expect(outcome.messageId).toBe(seeded.message.id);
      expect(outcome.nextAt?.getTime()).toBeGreaterThan(Date.now());
      expect(fake.sendCalls).toHaveLength(0);

      // `messages.scheduled_for` (section 5) is where the reserved slot lives.
      const stored = await getMessage(seeded.message.id);
      expect(stored?.scheduledFor?.getTime()).toBe(outcome.nextAt?.getTime());
    });

    it("gives two enrollments distinct slots instead of the mailbox's shared next slot", async () => {
      const first = await seedOutreach();
      await queueMailbox(first, queuedSlot());

      const secondIcp = await createIcp();
      const secondContact = await createContact({ companyId: first.company.id });
      const secondEnrollment = await createEnrollment({
        contactId: secondContact.id,
        icpId: secondIcp.id,
        status: "active",
      });
      const secondMessage = await createMessage({
        enrollmentId: secondEnrollment.id,
        contactId: secondContact.id,
        status: "approved",
      });

      const firstOutcome = blocked(await sendStep(first.enrollment.id, 0), "pacing");
      const secondOutcome = blocked(await sendStep(secondEnrollment.id, 0), "pacing");

      const firstSlot = firstOutcome.nextAt!.getTime();
      const secondSlot = secondOutcome.nextAt!.getTime();
      expect(secondSlot).toBeGreaterThan(firstSlot);
      expect((await getMessage(first.message.id))?.scheduledFor?.getTime()).toBe(firstSlot);
      expect((await getMessage(secondMessage.id))?.scheduledFor?.getTime()).toBe(secondSlot);
      expect((await readNextSendAt(first))?.getTime()).toBeGreaterThan(secondSlot);
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("re-uses the slot the message already owns instead of reserving another", async () => {
      const seeded = await seedOutreach();
      await queueMailbox(seeded, queuedSlot());

      const firstOutcome = blocked(await sendStep(seeded.enrollment.id, 0), "pacing");
      const queuedAfterFirst = await readNextSendAt(seeded);

      const secondOutcome = blocked(await sendStep(seeded.enrollment.id, 0), "pacing");

      expect(secondOutcome.nextAt?.getTime()).toBe(firstOutcome.nextAt?.getTime());
      expect((await readNextSendAt(seeded))?.getTime()).toBe(queuedAfterFirst?.getTime());
      expect(fake.sendCalls).toHaveLength(0);
    });

    it("sends on wake once the message's own slot has arrived, without re-checking next_send_at", async () => {
      const seeded = await seedOutreach();
      const queuedAt = queuedSlot();
      await queueMailbox(seeded, queuedAt);
      // The wake: the slot reserved on the previous attempt has arrived, while the
      // mailbox's shared next slot still belongs to a later reservation.
      await getDb()
        .update(messages)
        .set({ scheduledFor: new Date(Date.now() - 60_000) })
        .where(eq(messages.id, seeded.message.id));

      const outcome = await sendStep(seeded.enrollment.id, 0);

      expect(outcome.status).toBe("sent");
      expect(fake.sendCalls).toHaveLength(1);
      // The arrived slot was honoured: `next_send_at` was neither read nor advanced.
      expect((await readNextSendAt(seeded))?.getTime()).toBe(queuedAt.getTime());
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures and assertions
// ---------------------------------------------------------------------------

interface Outreach {
  settings: Settings;
  account: ConnectedAccount | null;
  company: Company;
  contact: Contact;
  enrollment: Enrollment;
  message: Message;
  counterDate: string;
}

interface SeedOutreachOptions {
  settings?: SettingsPatch;
  /** `null` leaves the database with no sending mailbox at all. */
  account?: Partial<UpsertAccountInput> | null;
  enrollmentStatus?: Enrollment["status"];
  messageStatus?: MessageStatus;
  message?: Partial<NewMessage>;
  contact?: Partial<NewContact>;
  company?: Partial<NewCompany>;
  counters?: Partial<Record<SendBucket, number>>;
}

/**
 * A sendable first-touch (by default): valid settings, a healthy mailbox, an approved
 * message for step 0 on an active enrollment. Tests override the one thing they exercise.
 */
async function seedOutreach(options: SeedOutreachOptions = {}): Promise<Outreach> {
  const settings = await configureSettings(options.settings);
  const account = options.account === null ? null : await createEmailAccount(options.account ?? {});
  const company = await createCompany(options.company ?? {});
  const contact = await createContact({ ...options.contact, companyId: company.id });
  const icp = await createIcp();
  const enrollment = await createEnrollment({
    contactId: contact.id,
    icpId: icp.id,
    status: options.enrollmentStatus ?? "active",
  });
  const message = await createMessage({
    enrollmentId: enrollment.id,
    contactId: contact.id,
    status: options.messageStatus ?? "approved",
    ...options.message,
  });

  const counterDate = dateOnlyInZone(new Date(), settings.timezone);
  if (account && options.counters) {
    await seedSendCounters(account.id, counterDate, options.counters);
  }

  return { settings, account, company, contact, enrollment, message, counterDate };
}

function sendStep(enrollmentId: string, index: number, stepDefinition?: SequenceStep): Promise<SendOutcome> {
  return sendMessage({
    enrollmentId,
    step: index,
    channel: "email",
    stepDefinition: stepDefinition ?? stepAt(index),
  });
}

function stepAt(index: number): SequenceStep {
  const step = EMAIL_LINKEDIN_V1.steps[index];
  if (!step) throw new Error(`The default sequence has no step ${index}`);
  return step;
}

function blocked(outcome: SendOutcome, rule: SendGuardRule): Extract<SendOutcome, { status: "blocked" }> {
  if (outcome.status !== "blocked") throw new Error(`Expected blocked ${rule}, received ${outcome.status}`);
  expect(outcome.rule).toBe(rule);
  return outcome;
}

function skipped(outcome: SendOutcome, reason: string): Extract<SendOutcome, { status: "skipped" }> {
  if (outcome.status !== "skipped") throw new Error(`Expected skipped ${reason}, received ${outcome.status}`);
  expect(outcome.reason).toBe(reason);
  return outcome;
}

async function readCounters(seeded: Outreach): Promise<Record<SendBucket, number>> {
  return getSendCounters(requireAccount(seeded).id, seeded.counterDate);
}

function requireAccount(seeded: Outreach): ConnectedAccount {
  if (!seeded.account) throw new Error("This fixture has no sending mailbox");
  return seeded.account;
}

function requireIdempotencyKey(message: Message): string {
  if (!message.idempotencyKey) throw new Error("The fixture message has no idempotency key");
  return message.idempotencyKey;
}
