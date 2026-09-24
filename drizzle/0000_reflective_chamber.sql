CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"name" text,
	"linkedin_url" text,
	"industry" text,
	"size_band" text,
	"country" text,
	"source" text,
	"raw" jsonb,
	"enriched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"external_account_id" text,
	"handle" text NOT NULL,
	"daily_cap" integer,
	"warmup_stage" integer DEFAULT 0 NOT NULL,
	"warmup_started_at" timestamp with time zone,
	"status" text DEFAULT 'ok' NOT NULL,
	"status_detail" text,
	"credentials_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"full_name" text NOT NULL,
	"title" text,
	"email" text,
	"email_status" text DEFAULT 'unknown' NOT NULL,
	"linkedin_url" text,
	"linkedin_provider_id" text,
	"timezone" text,
	"language" text,
	"source" text,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stage" text DEFAULT 'new' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"icp_id" uuid NOT NULL,
	"sequence_key" text NOT NULL,
	"sequence_version" integer NOT NULL,
	"angle" text,
	"status" text DEFAULT 'drafted' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"workflow_run_id" text,
	"next_action_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_arms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"icp_id" uuid NOT NULL,
	"angle" text NOT NULL,
	"alpha" real DEFAULT 1 NOT NULL,
	"beta" real DEFAULT 1 NOT NULL,
	"sends" integer DEFAULT 0 NOT NULL,
	"positives" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rationale" text NOT NULL,
	"industries" text[] DEFAULT '{}' NOT NULL,
	"size_bands" text[] DEFAULT '{}' NOT NULL,
	"geos" text[] DEFAULT '{}' NOT NULL,
	"titles" text[] DEFAULT '{}' NOT NULL,
	"pains" text[] DEFAULT '{}' NOT NULL,
	"triggers" text[] DEFAULT '{}' NOT NULL,
	"disqualifiers" text[] DEFAULT '{}' NOT NULL,
	"search_filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"angles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scores" jsonb,
	"rank" integer,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"icp_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"tier" text,
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"disqualified_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_scores_range" CHECK ("lead_scores"."score" >= 0 AND "lead_scores"."score" <= 100)
);
--> statement-breakpoint
CREATE TABLE "learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"icp_id" uuid,
	"text" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"step" integer NOT NULL,
	"step_key" text,
	"subject" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text,
	"provider_message_id" text,
	"thread_id" text,
	"rfc_message_id" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"intent" text,
	"intent_data" jsonb,
	"needs_owner" boolean DEFAULT false NOT NULL,
	"model" text,
	"prompt_version" text,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"proof" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_hint" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"likely_pains" text[] DEFAULT '{}' NOT NULL,
	"hooks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_opportunity" text NOT NULL,
	"confidence" text NOT NULL,
	"model" text,
	"prompt_version" text,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "send_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"bucket" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"timezone" text NOT NULL,
	"sending_windows" jsonb NOT NULL,
	"caps" jsonb NOT NULL,
	"autonomy_level" text DEFAULT 'L0' NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"postal_address" text DEFAULT '' NOT NULL,
	"requires_consent_geos" text[] DEFAULT '{}' NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"daily_new_prospect_target" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id" = 'singleton')
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"value" text,
	"value_hash" text NOT NULL,
	"reason" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_arms" ADD CONSTRAINT "experiment_arms_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icps" ADD CONSTRAINT "icps_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_briefs" ADD CONSTRAINT "research_briefs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_counters" ADD CONSTRAINT "send_counters_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_entity_idx" ON "activity_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "activity_events_type_at_idx" ON "activity_events" USING btree ("type","at");--> statement-breakpoint
CREATE INDEX "activity_events_at_idx" ON "activity_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_unique" ON "companies" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "connected_accounts_provider_external_unique" ON "connected_accounts" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_unique" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_linkedin_url_unique" ON "contacts" USING btree ("linkedin_url");--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_stage_idx" ON "contacts" USING btree ("stage");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_live_unique" ON "enrollments" USING btree ("contact_id","sequence_key") WHERE "enrollments"."status" IN ('drafted', 'pending_approval', 'active', 'waiting');--> statement-breakpoint
CREATE INDEX "enrollments_status_idx" ON "enrollments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "enrollments_next_action_idx" ON "enrollments" USING btree ("next_action_at");--> statement-breakpoint
CREATE INDEX "enrollments_contact_idx" ON "enrollments" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_arms_icp_angle_unique" ON "experiment_arms" USING btree ("icp_id","angle");--> statement-breakpoint
CREATE INDEX "icps_offer_idx" ON "icps" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "icps_status_idx" ON "icps" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_scores_contact_icp_unique" ON "lead_scores" USING btree ("contact_id","icp_id");--> statement-breakpoint
CREATE INDEX "lead_scores_icp_idx" ON "lead_scores" USING btree ("icp_id");--> statement-breakpoint
CREATE INDEX "learnings_scope_idx" ON "learnings" USING btree ("scope","active");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_unique" ON "messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "messages_enrollment_idx" ON "messages" USING btree ("enrollment_id","step");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_provider_idx" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_contact_direction_idx" ON "messages" USING btree ("contact_id","direction");--> statement-breakpoint
CREATE INDEX "offers_status_idx" ON "offers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "research_briefs_contact_idx" ON "research_briefs" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "send_counters_account_date_bucket_unique" ON "send_counters" USING btree ("account_id","date","bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_kind_value_unique" ON "suppressions" USING btree ("kind","value");--> statement-breakpoint
CREATE INDEX "suppressions_kind_hash_idx" ON "suppressions" USING btree ("kind","value_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_external_unique" ON "webhook_events" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("processed_at");