CREATE TYPE "public"."notification_channel" AS ENUM('email', 'in_app', 'sms');--> statement-breakpoint
CREATE TYPE "public"."notification_event_type" AS ENUM('approval_pending', 'owner_question_raised', 'run_failed', 'run_reconciliation_required', 'run_completed');--> statement-breakpoint
CREATE TYPE "public"."notification_message_kind" AS ENUM('immediate', 'digest');--> statement-breakpoint
CREATE TYPE "public"."notification_message_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'ambiguous', 'suppressed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."notification_routing" AS ENUM('immediate', 'digest', 'in_app_only');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('critical', 'action_required', 'warning', 'informational', 'success');--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"event_type" "notification_event_type" NOT NULL,
	"severity" "notification_severity" NOT NULL,
	"routing" "notification_routing" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_tenant_id_uq" UNIQUE("org_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "notification_message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"kind" "notification_message_kind" NOT NULL,
	"status" "notification_message_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"subject" text,
	"body" text,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"result_code" text,
	"result_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_messages_attempt_ck" CHECK ("notification_messages"."attempt_count" >= 0 and "notification_messages"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"email_override" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"quiet_hours_start_local" text,
	"quiet_hours_end_local" text,
	"digest_times_local" text[] DEFAULT '{}'::text[] NOT NULL,
	"routing_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_digest_at" timestamp with time zone,
	"next_digest_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_quiet_pairing_ck" CHECK (("notification_preferences"."quiet_hours_start_local" is null) = ("notification_preferences"."quiet_hours_end_local" is null)),
	CONSTRAINT "notification_preferences_quiet_format_ck" CHECK (("notification_preferences"."quiet_hours_start_local" is null or "notification_preferences"."quiet_hours_start_local" ~ '^[0-2][0-9]:[0-5][0-9]$') and ("notification_preferences"."quiet_hours_end_local" is null or "notification_preferences"."quiet_hours_end_local" ~ '^[0-2][0-9]:[0-5][0-9]$'))
);
--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_recipient_user_id_profiles_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_message_events" ADD CONSTRAINT "notification_message_events_recipient_user_id_profiles_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_message_events" ADD CONSTRAINT "notification_message_events_message_id_notification_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."notification_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_message_events" ADD CONSTRAINT "notification_message_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_message_events" ADD CONSTRAINT "notification_message_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_message_events" ADD CONSTRAINT "notification_message_events_event_tenant_fk" FOREIGN KEY ("org_id","project_id","event_id") REFERENCES "public"."notification_events"("org_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_recipient_user_id_profiles_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_dedupe_uq" ON "notification_events" USING btree ("org_id","project_id","recipient_user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_events_recipient_unread_idx" ON "notification_events" USING btree ("recipient_user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "notification_events_project_created_idx" ON "notification_events" USING btree ("org_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_events_routing_idx" ON "notification_events" USING btree ("routing","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_message_events_uq" ON "notification_message_events" USING btree ("message_id","event_id");--> statement-breakpoint
CREATE INDEX "notification_message_events_event_idx" ON "notification_message_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "notification_message_events_recipient_idx" ON "notification_message_events" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_messages_idempotency_uq" ON "notification_messages" USING btree ("recipient_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_messages_due_idx" ON "notification_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_messages_recipient_created_idx" ON "notification_messages" USING btree ("recipient_user_id","created_at");