CREATE TABLE "ops_chat_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"project_id" uuid,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"extracted_text" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_chat_attachments_status_chk" CHECK (status in ('ready', 'failed', 'unsupported')),
	CONSTRAINT "ops_chat_attachments_kind_chk" CHECK (kind in ('pdf', 'docx', 'xlsx', 'csv', 'text', 'markdown', 'image')),
	CONSTRAINT "ops_chat_attachments_size_chk" CHECK (size_bytes > 0 and size_bytes <= 10485760),
	CONSTRAINT "ops_chat_attachments_text_cap_chk" CHECK (extracted_text is null or char_length(extracted_text) <= 100000)
);
--> statement-breakpoint
ALTER TABLE "ops_chat_attachments" ADD CONSTRAINT "ops_chat_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_chat_attachments" ADD CONSTRAINT "ops_chat_attachments_conversation_user_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."ops_chat_conversations"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_chat_attachments" ADD CONSTRAINT "ops_chat_attachments_message_conversation_fk" FOREIGN KEY ("message_id","conversation_id") REFERENCES "public"."ops_chat_messages"("id","conversation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_chat_attachments_conversation_created_idx" ON "ops_chat_attachments" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ops_chat_attachments_message_idx" ON "ops_chat_attachments" USING btree ("message_id");