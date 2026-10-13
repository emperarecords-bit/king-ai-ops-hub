CREATE TABLE "ops_chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_chat_conversations_id_user_uq" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ops_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "ops_chat_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"role" text NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"content" text NOT NULL,
	"question" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_chat_messages_id_conversation_uq" UNIQUE("id","conversation_id"),
	CONSTRAINT "ops_chat_messages_role_chk" CHECK (role in ('user', 'assistant')),
	CONSTRAINT "ops_chat_messages_status_chk" CHECK (status in ('complete', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "ops_chat_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "ops_chat_proposals_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_chat_proposals_state_chk" CHECK (state in ('pending', 'confirming', 'done', 'error', 'cancelled', 'stale'))
);
--> statement-breakpoint
ALTER TABLE "ops_chat_conversations" ADD CONSTRAINT "ops_chat_conversations_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_chat_messages" ADD CONSTRAINT "ops_chat_messages_conversation_user_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."ops_chat_conversations"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_chat_proposals" ADD CONSTRAINT "ops_chat_proposals_message_conversation_fk" FOREIGN KEY ("message_id","conversation_id") REFERENCES "public"."ops_chat_messages"("id","conversation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_chat_proposals" ADD CONSTRAINT "ops_chat_proposals_conversation_user_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."ops_chat_conversations"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_chat_conversations_user_updated_idx" ON "ops_chat_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_chat_messages_conversation_seq_uq" ON "ops_chat_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "ops_chat_messages_conversation_created_idx" ON "ops_chat_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ops_chat_proposals_conversation_created_idx" ON "ops_chat_proposals" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ops_chat_proposals_message_idx" ON "ops_chat_proposals" USING btree ("message_id");