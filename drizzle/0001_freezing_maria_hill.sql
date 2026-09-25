DROP INDEX "suppressions_kind_value_unique";--> statement-breakpoint
DROP INDEX "suppressions_kind_hash_idx";--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "last_history_id" text;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "next_send_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_handled_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_kind_hash_unique" ON "suppressions" USING btree ("kind","value_hash");