import { eq } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import {
  companies,
  contacts,
  enrollments,
  icps,
  messages,
  offers,
  sendCounters,
  suppressions,
  type Company,
  type ConnectedAccount,
  type Contact,
  type Enrollment,
  type Icp,
  type Message,
  type NewCompany,
  type NewContact,
  type NewEnrollment,
  type NewIcp,
  type NewMessage,
  type NewOffer,
  type Offer,
  type Suppression,
} from "@/src/db/schema";
import { normalizeSuppressionValue } from "@/src/domain";
import type { SendBucket, SendingWindow, SuppressionKind } from "@/src/domain/types";
import { hashValue } from "@/src/lib/crypto";
import { idempotencyKey } from "@/src/lib/ids";
import { upsertAccount, type UpsertAccountInput } from "@/src/services/accounts";
import { updateSettings, type SettingsPatch } from "@/src/services/settings";

/**
 * Row builders for database-backed tests. The goal is that a test reads as intent:
 *
 *   const { enrollment, message } = await seedOutreach();
 *
 * instead of sixty lines of inserts. Every builder creates the rows its foreign keys
 * require (an ICP creates its offer, a contact creates its company, a message creates an
 * enrollment) unless the test passes one in — passing `companyId: null` is how a test
 * asks for a contact with no company.
 *
 * These builders write through `getDb()` directly. They are test fixtures, not the
 * product's write path; the services are exercised by the tests that use the rows.
 */

let sequence = 0;

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

/** Empties the in-process counter so ids do not look like they leaked between tests. */
export function resetFactorySequence(): void {
  sequence = 0;
}

// ---------------------------------------------------------------------------
// Offer / ICP / company / contact
// ---------------------------------------------------------------------------

export async function createOffer(overrides: Partial<NewOffer> = {}): Promise<Offer> {
  const index = nextSequence();
  const [row] = await getDb()
    .insert(offers)
    .values({
      title: `Test offer ${index}`,
      description: "AI problem-solving retainer for support teams.",
      proof: [{ label: "Case study", detail: "Cut first-response time in half." }],
      status: "active",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("createOffer: insert returned no row");
  return row;
}

export async function createIcp(overrides: Partial<NewIcp> = {}): Promise<Icp> {
  const index = nextSequence();
  const offerId = overrides.offerId ?? (await createOffer()).id;
  const [row] = await getDb()
    .insert(icps)
    .values({
      name: `Test ICP ${index}`,
      rationale: "Support leads with repetitive tickets and a budget.",
      industries: ["software"],
      sizeBands: ["51-200"],
      geos: ["United States"],
      titles: ["Head of Support"],
      pains: ["slow first response", "repetitive tickets"],
      triggers: ["hiring support agents"],
      disqualifiers: ["intern"],
      angles: [{ key: "speed", hook: "Cut first-response time" }],
      status: "approved",
      rank: 1,
      ...overrides,
      offerId,
    })
    .returning();
  if (!row) throw new Error("createIcp: insert returned no row");
  return row;
}

export async function createCompany(overrides: Partial<NewCompany> = {}): Promise<Company> {
  const index = nextSequence();
  const domain = overrides.domain ?? `acme-${index}.example`;
  const [row] = await getDb()
    .insert(companies)
    .values({
      name: `Acme ${index}`,
      industry: "software",
      sizeBand: "51-200",
      country: "US",
      source: "csv",
      ...overrides,
      domain,
    })
    .returning();
  if (!row) throw new Error("createCompany: insert returned no row");
  return row;
}

/**
 * A contact with a valid email by default. Pass `companyId: null` for a contact with no
 * company, or `email: null` for a contact with no address (the LinkedIn-first case).
 */
export async function createContact(overrides: Partial<NewContact> = {}): Promise<Contact> {
  const index = nextSequence();
  const company = overrides.companyId === undefined ? await createCompany() : null;
  const companyId = overrides.companyId === undefined ? (company?.id ?? null) : overrides.companyId;
  const email =
    overrides.email === undefined ? `prospect-${index}@${company?.domain ?? `acme-${index}.example`}` : overrides.email;

  const [row] = await getDb()
    .insert(contacts)
    .values({
      fullName: `Prospect ${index}`,
      title: "Head of Support",
      emailStatus: "valid",
      linkedinUrl: null,
      timezone: null,
      language: "en",
      source: "csv",
      stage: "new",
      ...overrides,
      companyId,
      email,
    })
    .returning();
  if (!row) throw new Error("createContact: insert returned no row");
  return row;
}

// ---------------------------------------------------------------------------
// Enrollment / message / inbound
// ---------------------------------------------------------------------------

export async function createEnrollment(overrides: Partial<NewEnrollment> = {}): Promise<Enrollment> {
  const contactId = overrides.contactId ?? (await createContact()).id;
  const icpId = overrides.icpId ?? (await createIcp()).id;
  const status = overrides.status ?? "active";

  const [row] = await getDb()
    .insert(enrollments)
    .values({
      sequenceKey: "email_linkedin_v1",
      sequenceVersion: 1,
      angle: "support_automation",
      status,
      currentStep: 0,
      startedAt: status === "active" ? new Date() : null,
      ...overrides,
      contactId,
      icpId,
    })
    .returning();
  if (!row) throw new Error("createEnrollment: insert returned no row");
  return row;
}

/**
 * An outbound message. When no enrollment is given, one is created together with the
 * contact and ICP it needs; the idempotency key is derived exactly as the product does,
 * so `sendMessage` finds the row.
 */
export async function createMessage(overrides: Partial<NewMessage> = {}): Promise<Message> {
  const index = nextSequence();
  const enrollmentId = overrides.enrollmentId ?? (await createEnrollment()).id;
  const contactId = overrides.contactId ?? (await contactIdForEnrollment(enrollmentId));
  const channel = overrides.channel ?? "email";
  const step = overrides.step ?? 0;
  const key =
    overrides.idempotencyKey === undefined ? idempotencyKey(enrollmentId, step, channel) : overrides.idempotencyKey;

  const [row] = await getDb()
    .insert(messages)
    .values({
      direction: "outbound",
      stepKey: `test_step_${step}`,
      subject: "A quick idea",
      body: `Hi, one observation about your support queue (${index}).`,
      status: "approved",
      ...overrides,
      enrollmentId,
      contactId,
      channel,
      step,
      idempotencyKey: key,
    })
    .returning();
  if (!row) throw new Error("createMessage: insert returned no row");
  return row;
}

/**
 * An inbound message; `intent: null` is the unclassified state the send guard blocks on.
 *
 * `fromEmail` mirrors `RecordInboundInput.fromEmail` from `src/services/messages.ts`: the
 * `messages` table has no "from" column, so it is used to resolve the contact when no
 * `contactId` is given and never stored.
 */
export interface InboundMessageOverrides extends Partial<NewMessage> {
  fromEmail?: string | null;
}

export async function createInboundMessage(overrides: InboundMessageOverrides = {}): Promise<Message> {
  const { fromEmail, ...messageOverrides } = overrides;
  const index = nextSequence();
  const contactId = messageOverrides.contactId ?? (await resolveContactForInbound(fromEmail));

  const [row] = await getDb()
    .insert(messages)
    .values({
      enrollmentId: null,
      channel: "email",
      direction: "inbound",
      step: -1,
      stepKey: null,
      subject: "Re: A quick idea",
      body: "Thanks for reaching out.",
      status: "received",
      providerMessageId: `inbound-${index}`,
      receivedAt: new Date(),
      intent: null,
      ...messageOverrides,
      contactId,
    })
    .returning();
  if (!row) throw new Error("createInboundMessage: insert returned no row");
  return row;
}

async function resolveContactForInbound(fromEmail: string | null | undefined): Promise<string> {
  if (fromEmail) {
    const email = fromEmail.trim().toLowerCase();
    const [existing] = await getDb()
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, email))
      .limit(1);
    if (existing) return existing.id;
    return (await createContact({ email })).id;
  }
  return (await createContact()).id;
}

async function contactIdForEnrollment(enrollmentId: string): Promise<string> {
  const [row] = await getDb()
    .select({ contactId: enrollments.contactId })
    .from(enrollments)
    .where(eq(enrollments.id, enrollmentId))
    .limit(1);
  if (!row) throw new Error(`createMessage: enrollment ${enrollmentId} not found`);
  return row.contactId;
}

// ---------------------------------------------------------------------------
// Sending infrastructure
// ---------------------------------------------------------------------------

/** The one v1 mailbox (section 8), healthy and by default in warmup week 1. */
export async function createEmailAccount(overrides: Partial<UpsertAccountInput> = {}): Promise<ConnectedAccount> {
  const index = nextSequence();
  return upsertAccount({
    provider: "google",
    kind: "email",
    externalAccountId: `mailbox-${index}`,
    handle: `founder-${index}@scoutmail.example`,
    warmupStage: 1,
    ...overrides,
  });
}

export async function seedSendCounters(
  accountId: string,
  date: string,
  counts: Partial<Record<SendBucket, number>>,
): Promise<void> {
  const db = getDb();
  for (const bucket of Object.keys(counts) as SendBucket[]) {
    const count = counts[bucket];
    if (count === undefined) continue;
    await db
      .insert(sendCounters)
      .values({ accountId, date, bucket, count })
      .onConflictDoUpdate({
        target: [sendCounters.accountId, sendCounters.date, sendCounters.bucket],
        set: { count, updatedAt: new Date() },
      });
  }
}

/**
 * A suppression with the matching hash, written directly (the `addSuppression` service
 * refuses freemail domains and bounce reasons, which is not the fixture's job).
 */
export async function createSuppression(input: {
  kind: SuppressionKind;
  value: string;
  reason?: string;
  source?: string;
}): Promise<Suppression> {
  const value = normalizeSuppressionValue(input.kind, input.value);
  const [row] = await getDb()
    .insert(suppressions)
    .values({
      kind: input.kind,
      value,
      valueHash: hashValue(input.kind, value),
      reason: input.reason ?? "opt_out",
      source: input.source ?? "test",
    })
    .returning();
  if (!row) throw new Error("createSuppression: insert returned no row");
  return row;
}

// ---------------------------------------------------------------------------
// Settings and time
// ---------------------------------------------------------------------------

/** `"HH:MM"` for a UTC instant; tests keep the settings timezone at UTC. */
export function hhmmUtc(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * A window that contains `now` when `offsetHours` is 0, and that does not when it is any
 * other value (the window is `[now + offset − 1h, now + offset + 1h)`). Cross-midnight
 * wrap is handled by `isWithinWindow`, so a test never depends on the wall clock.
 */
export function testSendingWindow(now: Date = new Date(), offsetHours = 0): SendingWindow {
  const start = new Date(now.getTime() + (offsetHours - 1) * 60 * 60 * 1000);
  const end = new Date(now.getTime() + (offsetHours + 1) * 60 * 60 * 1000);
  return { days: [1, 2, 3, 4, 5, 6, 7], start: hhmmUtc(start), end: hhmmUtc(end) };
}

/**
 * A settings row a cold send can pass: signature and postal address set (review item 18),
 * UTC timezone, and a sending window that contains now. Tests override the one field they
 * are exercising.
 */
export async function configureSettings(patch: SettingsPatch = {}) {
  const open = testSendingWindow(new Date());
  return updateSettings({
    signature: "— Scout Test Owner",
    postalAddress: "1 Test Street, Testville",
    timezone: "UTC",
    sendingWindows: { email: open, linkedin: open },
    ...patch,
  });
}
