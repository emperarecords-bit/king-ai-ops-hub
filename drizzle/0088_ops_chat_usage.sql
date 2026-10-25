CREATE TABLE "ops_chat_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_message_id" uuid NOT NULL,
	"provider" "provider_id" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint NOT NULL,
	"pricing_version" text NOT NULL,
	"stop_reason" text,
	"cut_off" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_chat_usage_counts_chk" CHECK (input_tokens >= 0 and output_tokens >= 0 and web_searches >= 0 and cost_micros >= 0)
);
--> statement-breakpoint
ALTER TABLE "ops_chat_usage" ADD CONSTRAINT "ops_chat_usage_conversation_user_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."ops_chat_conversations"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_chat_usage" ADD CONSTRAINT "ops_chat_usage_owner_message_fk" FOREIGN KEY ("owner_message_id","conversation_id") REFERENCES "public"."ops_chat_messages"("id","conversation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_chat_usage_user_created_idx" ON "ops_chat_usage" USING btree ("user_id","created_at");