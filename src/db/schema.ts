import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type {
  AccountKind,
  AccountStatus,
  Actor,
  Angle,
  AutonomyLevel,
  Caps,
  ChannelKind,
  ContactStage,
  Direction,
  EmailStatus,
  EnrollmentStatus,
  IcpScores,
  IcpSearchFilters,
  IcpStatus,
  LearningScope,
  MessageStatus,
  OfferStatus,
  ProofItem,
  ReferralDetails,
  ReplyIntent,
  ResearchHook,
  ResearchSignal,
  SendBucket,
  SendingWindows,
  SizeBand,
  SuppressionKind,
  Tier,
} from "@/src/domain/types";

/**
 * Section 5: sixteen domain tables. Fixed sets are stored as `text` with a
 * compile-time `$type<>()` rather than Postgres enums, because the allowed values
 * live in one typed map in `src/domain` (section 5) and altering a Postgres enum
 * inside a migration is a footgun. Uniqueness constraints do the real safety work.
 *
 * Better Auth's four tables (`user`, `session`, `account`, `verification`) are
 * framework-owned and live at the bottom of this file.
 */

const now = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => now("created_at").defaultNow().notNull();
const updatedAt = () => now("updated_at").defaultNow().notNull();

// ---------------------------------------------------------------------------
// 1. offers — the owner's services and ideas
// ---------------------------------------------------------------------------

export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    /** Case studies, demos, numbers. Copy may only claim proof that lives here (section 6). */
    proof: jsonb("proof").$type<ProofItem[]>().default([]).notNull(),
    priceHint: text("price_hint"),
    status: text("status").$type<OfferStatus>().default("active").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("offers_status_idx").on(t.status)],
);

// ---------------------------------------------------------------------------
// 2. icps — ideal-customer hypotheses per offer
// ---------------------------------------------------------------------------

export const icps = pgTable(
  "icps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rationale: text("rationale").notNull(),
    industries: text("industries").array().default([]).notNull(),
    sizeBands: text("size_bands").array().$type<SizeBand[]>().default([]).notNull(),
    geos: text("geos").array().default([]).notNull(),
    titles: text("titles").array().default([]).notNull(),
    pains: text("pains").array().default([]).notNull(),
    triggers: text("triggers").array().default([]).notNull(),
    disqualifiers: text("disqualifiers").array().default([]).notNull(),
    /** Provider filters are built by adapters from the fields above (section 6). */
    searchFilters: jsonb("search_filters").$type<IcpSearchFilters>().default({}).notNull(),
    angles: jsonb("angles").$type<Angle[]>().default([]).notNull(),
    scores: jsonb("scores").$type<IcpScores>(),
    /** 1 = best. Ties go to `reach` (section 6). */
    rank: integer("rank"),
    status: text("status").$type<IcpStatus>().default("proposed").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("icps_offer_idx").on(t.offerId), index("icps_status_idx").on(t.status)],
);

// ---------------------------------------------------------------------------
// 3. companies
// ---------------------------------------------------------------------------

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domain: text("domain").notNull(),
    name: text("name"),
    linkedinUrl: text("linkedin_url"),
    industry: text("industry"),
    sizeBand: text("size_band").$type<SizeBand>(),
    country: text("country"),
    source: text("source"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    enrichedAt: now("enriched_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("companies_domain_unique").on(t.domain)],
);

// ---------------------------------------------------------------------------
// 4. contacts
// ---------------------------------------------------------------------------

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    fullName: text("full_name").notNull(),
    title: text("title"),
    email: text("email"),
    emailStatus: text("email_status").$type<EmailStatus>().default("unknown").notNull(),
    linkedinUrl: text("linkedin_url"),
    linkedinProviderId: text("linkedin_provider_id"),
    timezone: text("timezone"),
    language: text("language"),
    /** Section 9: every contact stores where it came from and when it was collected. */
    source: text("source"),
    collectedAt: now("collected_at").defaultNow().notNull(),
    stage: text("stage").$type<ContactStage>().default("new").notNull(),
    /** Set when the contact is deleted under the 12-month retention rule (phase 8). */
    deletedAt: now("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("contacts_email_unique").on(t.email),
    uniqueIndex("contacts_linkedin_url_unique").on(t.linkedinUrl),
    index("contacts_company_idx").on(t.companyId),
    index("contacts_stage_idx").on(t.stage),
  ],
);

// ---------------------------------------------------------------------------
// 5. research_briefs — evidence per lead
// ---------------------------------------------------------------------------

export const researchBriefs = pgTable(
  "research_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    signals: jsonb("signals").$type<ResearchSignal[]>().default([]).notNull(),
    likelyPains: text("likely_pains").array().default([]).notNull(),
    hooks: jsonb("hooks").$type<ResearchHook[]>().default([]).notNull(),
    aiOpportunity: text("ai_opportunity").notNull(),
    confidence: text("confidence").$type<"low" | "medium" | "high">().notNull(),
    model: text("model"),
    /** Prompt hygiene: every AI row records the prompt version that produced it (section 6). */
    promptVersion: text("prompt_version"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).default("0").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("research_briefs_contact_idx").on(t.contactId)],
);

// ---------------------------------------------------------------------------
// 6. lead_scores — fit per lead per ICP
// ---------------------------------------------------------------------------

export const leadScores = pgTable(
  "lead_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    icpId: uuid("icp_id")
      .notNull()
      .references(() => icps.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    tier: text("tier").$type<Tier>(),
    reasons: text("reasons").array().default([]).notNull(),
    disqualifiedReason: text("disqualified_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("lead_scores_contact_icp_unique").on(t.contactId, t.icpId),
    index("lead_scores_icp_idx").on(t.icpId),
    check("lead_scores_range", sql`${t.score} >= 0 AND ${t.score} <= 100`),
  ],
);

// ---------------------------------------------------------------------------
// 7. enrollments — one lead in one sequence
// ---------------------------------------------------------------------------

export const enrollments = pgTable(
  "enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    icpId: uuid("icp_id")
      .notNull()
      .references(() => icps.id, { onDelete: "restrict" }),
    sequenceKey: text("sequence_key").notNull(),
    sequenceVersion: integer("sequence_version").notNull(),
    angle: text("angle"),
    status: text("status").$type<EnrollmentStatus>().default("drafted").notNull(),
    currentStep: integer("current_step").default(0).notNull(),
    workflowRunId: text("workflow_run_id"),
    nextActionAt: now("next_action_at"),
    /**
     * Why the run is parked (review stage 1, item 2): a kill switch, incomplete config or a
     * paused mailbox parks until the next window, and only the event that clears that reason
     * may wake it. Null when the run is not parked.
     */
    parkedReason: text("parked_reason"),
    startedAt: now("started_at"),
    completedAt: now("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One *live* enrollment per contact and sequence; a finished lead may be re-enrolled
    // (for example "not now" creates a new, approval-gated enrollment — section 7).
    uniqueIndex("enrollments_live_unique")
      .on(t.contactId, t.sequenceKey)
      .where(sql`${t.status} IN ('drafted', 'pending_approval', 'active', 'waiting')`),
    index("enrollments_status_idx").on(t.status),
    index("enrollments_next_action_idx").on(t.nextActionAt),
    index("enrollments_contact_idx").on(t.contactId),
  ],
);

// ---------------------------------------------------------------------------
// 8. messages — every draft, sent and received message
// ---------------------------------------------------------------------------

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enrollmentId: uuid("enrollment_id").references(() => enrollments.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: text("channel").$type<ChannelKind>().notNull(),
    direction: text("direction").$type<Direction>().notNull(),
    step: integer("step").notNull(),
    stepKey: text("step_key"),
    subject: text("subject"),
    body: text("body").notNull(),
    status: text("status").$type<MessageStatus>().notNull(),
    /** `enrollmentId:step:channel` — the reason a retried send cannot double-send (section 5). */
    idempotencyKey: text("idempotency_key"),
    providerMessageId: text("provider_message_id"),
    threadId: text("thread_id"),
    rfcMessageId: text("rfc_message_id"),
    scheduledFor: now("scheduled_for"),
    sentAt: now("sent_at"),
    receivedAt: now("received_at"),
    intent: text("intent").$type<ReplyIntent>(),
    intentData: jsonb("intent_data").$type<{
    summary?: string;
    returnDate?: string;
    followUpAfter?: string;
    referral?: ReferralDetails;
  }>(),
    /** Set when the reply workflow has fully handled this inbound message (review item 16). */
    replyHandledAt: now("reply_handled_at"),
    /** Set when an LLM output failed schema validation twice (section 10 rule 5). */
    needsOwner: boolean("needs_owner").default(false).notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).default("0").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("messages_idempotency_unique").on(t.idempotencyKey),
    index("messages_enrollment_idx").on(t.enrollmentId, t.step),
    index("messages_thread_idx").on(t.threadId),
    index("messages_provider_idx").on(t.providerMessageId),
    index("messages_contact_direction_idx").on(t.contactId, t.direction),
  ],
);

// ---------------------------------------------------------------------------
// 9. connected_accounts — sending identities
// ---------------------------------------------------------------------------

export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    kind: text("kind").$type<AccountKind>().notNull(),
    externalAccountId: text("external_account_id"),
    handle: text("handle").notNull(),
    dailyCap: integer("daily_cap"),
    /** 0–4; the 5 → 10 → 20 → 30 ramp (section 7). */
    warmupStage: integer("warmup_stage").default(0).notNull(),
    warmupStartedAt: now("warmup_started_at"),
    status: text("status").$type<AccountStatus>().default("ok").notNull(),
    statusDetail: text("status_detail"),
    /** Gmail: the `historyId` the last successful ingest advanced to (review item 13). */
    lastHistoryId: text("last_history_id"),
    /** Per-mailbox pacing: the earliest instant the next send may leave this account (item 11). */
    nextSendAt: now("next_send_at"),
    /** AES-256-GCM with ENCRYPTION_KEY (section 8). Never logged. */
    credentialsEncrypted: text("credentials_encrypted"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("connected_accounts_provider_external_unique").on(t.provider, t.externalAccountId)],
);

// ---------------------------------------------------------------------------
// 10. send_counters — daily rate limiting
// ---------------------------------------------------------------------------

export const sendCounters = pgTable(
  "send_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    bucket: text("bucket").$type<SendBucket>().notNull(),
    count: integer("count").default(0).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("send_counters_account_date_bucket_unique").on(t.accountId, t.date, t.bucket)],
);

// ---------------------------------------------------------------------------
// 11. suppressions — do-not-contact list
// ---------------------------------------------------------------------------

export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<SuppressionKind>().notNull(),
    /** Normalised value. Nulled out by the phase 8 retention job; `valueHash` survives. */
    value: text("value"),
    valueHash: text("value_hash").notNull(),
    reason: text("reason"),
    source: text("source"),
    createdAt: createdAt(),
  },
  (t) => [
    // Review item 19: matching is by `value_hash` so phase 8 can null the plaintext without
    // un-suppressing anyone. The hash is an HMAC keyed with ENCRYPTION_KEY (see D11).
    uniqueIndex("suppressions_kind_hash_unique").on(t.kind, t.valueHash),
  ],
);

// ---------------------------------------------------------------------------
// 12. webhook_events — raw inbound events
// ---------------------------------------------------------------------------

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: now("received_at").defaultNow().notNull(),
    processedAt: now("processed_at"),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("webhook_events_provider_external_unique").on(t.provider, t.externalId),
    index("webhook_events_unprocessed_idx").on(t.processedAt),
  ],
);

// ---------------------------------------------------------------------------
// 13. activity_events — append-only audit and analytics log
// ---------------------------------------------------------------------------

export const activityEvents = pgTable(
  "activity_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: now("at").defaultNow().notNull(),
    actor: text("actor").$type<Actor>().notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (t) => [
    index("activity_events_entity_idx").on(t.entityType, t.entityId),
    index("activity_events_type_at_idx").on(t.type, t.at),
    index("activity_events_at_idx").on(t.at),
  ],
);

// ---------------------------------------------------------------------------
// 14. experiment_arms — learning loop state
// ---------------------------------------------------------------------------

export const experimentArms = pgTable(
  "experiment_arms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    icpId: uuid("icp_id")
      .notNull()
      .references(() => icps.id, { onDelete: "cascade" }),
    angle: text("angle").notNull(),
    /** Beta(alpha, beta) belief: alpha = 1 + positive replies, beta = 1 + other sends. */
    alpha: real("alpha").default(1).notNull(),
    beta: real("beta").default(1).notNull(),
    sends: integer("sends").default(0).notNull(),
    positives: integer("positives").default(0).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("experiment_arms_icp_angle_unique").on(t.icpId, t.angle)],
);

// ---------------------------------------------------------------------------
// 15. learnings — distilled insights fed into prompts
// ---------------------------------------------------------------------------

export const learnings = pgTable(
  "learnings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").$type<LearningScope>().notNull(),
    icpId: uuid("icp_id").references(() => icps.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("learnings_scope_idx").on(t.scope, t.active)],
);

// ---------------------------------------------------------------------------
// 16. settings — singleton config
// ---------------------------------------------------------------------------

export const settings = pgTable(
  "settings",
  {
    id: text("id").primaryKey().default("singleton"),
    timezone: text("timezone").notNull(),
    sendingWindows: jsonb("sending_windows").$type<SendingWindows>().notNull(),
    caps: jsonb("caps").$type<Caps>().notNull(),
    autonomyLevel: text("autonomy_level").$type<AutonomyLevel>().default("L0").notNull(),
    signature: text("signature").default("").notNull(),
    postalAddress: text("postal_address").default("").notNull(),
    /** Countries excluded from cold email unless the owner turns consent on (section 9). */
    requiresConsentGeos: text("requires_consent_geos").array().default([]).notNull(),
    /**
     * LinkedIn mode lives in the `LINKEDIN_MODE` env var, not here: section 0 locks it to
     * `assisted` for v1 and it must not be switchable from the UI. The settings page shows
     * the env value read-only.
     */
    /** Global stop. When true, `sendMessage` aborts before anything else (section 7). */
    killSwitch: boolean("kill_switch").default(false).notNull(),
    dailyNewProspectTarget: integer("daily_new_prospect_target").default(5).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [check("settings_singleton", sql`${t.id} = 'singleton'`)],
);

// ---------------------------------------------------------------------------
// Better Auth tables (framework-owned shape; do not hand-edit without checking
// the version's drizzle adapter docs in node_modules/better-auth).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: now("created_at").defaultNow().notNull(),
  updatedAt: now("updated_at").defaultNow().notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: now("expires_at").notNull(),
  token: text("token").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: now("created_at").defaultNow().notNull(),
  updatedAt: now("updated_at").defaultNow().notNull(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: now("access_token_expires_at"),
  refreshTokenExpiresAt: now("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: now("created_at").defaultNow().notNull(),
  updatedAt: now("updated_at").defaultNow().notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: now("expires_at").notNull(),
  createdAt: now("created_at").defaultNow().notNull(),
  updatedAt: now("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;
export type Icp = typeof icps.$inferSelect;
export type NewIcp = typeof icps.$inferInsert;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ResearchBrief = typeof researchBriefs.$inferSelect;
export type NewResearchBrief = typeof researchBriefs.$inferInsert;
export type LeadScore = typeof leadScores.$inferSelect;
export type NewLeadScore = typeof leadScores.$inferInsert;
export type Enrollment = typeof enrollments.$inferSelect;
export type NewEnrollment = typeof enrollments.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type ConnectedAccount = typeof connectedAccounts.$inferSelect;
export type NewConnectedAccount = typeof connectedAccounts.$inferInsert;
export type SendCounter = typeof sendCounters.$inferSelect;
export type Suppression = typeof suppressions.$inferSelect;
export type NewSuppression = typeof suppressions.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;
export type ExperimentArm = typeof experimentArms.$inferSelect;
export type Learning = typeof learnings.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
