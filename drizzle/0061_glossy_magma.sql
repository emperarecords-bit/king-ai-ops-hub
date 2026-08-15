ALTER TYPE "public"."provider_id" ADD VALUE 'google';--> statement-breakpoint
ALTER TYPE "public"."provider_id" ADD VALUE 'deepseek';--> statement-breakpoint
ALTER TYPE "public"."provider_selection" ADD VALUE 'google' BEFORE 'both';--> statement-breakpoint
ALTER TYPE "public"."provider_selection" ADD VALUE 'deepseek' BEFORE 'both';