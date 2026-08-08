CREATE TABLE "executor_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"sandbox_id" text NOT NULL,
	"sandbox_image_digest" text NOT NULL,
	"workspace_mount_identity" text NOT NULL,
	"lease_token_hash" text NOT NULL,
	"leased_by" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"started_at" timestamp with time zone,
	"pre_write_checkpoint_at" timestamp with time zone,
	"atomic_install_checkpoint_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"observed_precondition_sha256" text,
	"observed_postcondition_sha256" text,
	"temp_artifact_identity" text,
	"exit_code" integer,
	"timeout_stage" text,
	"result_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "executor_execution_attempts_number_ck" CHECK ("executor_execution_attempts"."attempt_number" > 0),
	CONSTRAINT "executor_execution_attempts_state_ck" CHECK ("executor_execution_attempts"."state" in ('claimed','sandbox_starting','precondition_verified','writing','verifying','succeeded','definitely_not_executed','failed','ambiguous','cancelled')),
	CONSTRAINT "executor_execution_attempts_hashes_ck" CHECK ("executor_execution_attempts"."lease_token_hash" ~ '^[0-9a-f]{64}$' and ("executor_execution_attempts"."observed_precondition_sha256" is null or "executor_execution_attempts"."observed_precondition_sha256" ~ '^[0-9a-f]{64}$') and ("executor_execution_attempts"."observed_postcondition_sha256" is null or "executor_execution_attempts"."observed_postcondition_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "executor_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"executor_id" text NOT NULL,
	"executor_version" text NOT NULL,
	"action_type" "action_type" NOT NULL,
	"risk_class" text NOT NULL,
	"mode" text NOT NULL,
	"workspace_storage_id" text NOT NULL,
	"normalized_target" text NOT NULL,
	"target_collision_key" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"precondition_kind" text NOT NULL,
	"precondition_sha256" text,
	"desired_sha256" text NOT NULL,
	"confirmation_id" uuid NOT NULL,
	"confirmation_sha256" text NOT NULL,
	"confirmed_by" uuid NOT NULL,
	"confirmation_expires_at" timestamp with time zone NOT NULL,
	"actor_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"reconciliation_state" text DEFAULT 'not_required' NOT NULL,
	"reconciliation_owner" text,
	"reconcile_after" timestamp with time zone,
	"reconciliation_deadline" timestamp with time zone,
	"result_code" text,
	"result_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rollback_artifact_id" text,
	"rollback_sha256" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"side_effect_checkpoint_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "executor_executions_tenant_id_uq" UNIQUE("org_id","project_id","id"),
	CONSTRAINT "executor_executions_risk_ck" CHECK ("executor_executions"."risk_class" in ('read_only','reversible_internal_write','external_reversible','financial_regulated','destructive_irreversible')),
	CONSTRAINT "executor_executions_mode_ck" CHECK ("executor_executions"."mode" in ('dry_run','live')),
	CONSTRAINT "executor_executions_state_ck" CHECK ("executor_executions"."state" in ('proposed','confirmed','claimed','sandbox_starting','precondition_verified','writing','verifying','succeeded','blocked','definitely_not_executed','failed','ambiguous','reconciling','reconciled_succeeded','reconciled_not_executed','manual_resolution_required')),
	CONSTRAINT "executor_executions_reconciliation_ck" CHECK ("executor_executions"."reconciliation_state" in ('not_required','required','in_progress','resolved','manual_required')),
	CONSTRAINT "executor_executions_precondition_ck" CHECK (("executor_executions"."precondition_kind" = 'absent' and "executor_executions"."precondition_sha256" is null) or ("executor_executions"."precondition_kind" = 'sha256' and "executor_executions"."precondition_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "executor_executions_hashes_ck" CHECK ("executor_executions"."payload_sha256" ~ '^[0-9a-f]{64}$' and "executor_executions"."desired_sha256" ~ '^[0-9a-f]{64}$' and "executor_executions"."confirmation_sha256" ~ '^[0-9a-f]{64}$' and ("executor_executions"."rollback_sha256" is null or "executor_executions"."rollback_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "executor_executions_attempt_count_ck" CHECK ("executor_executions"."attempt_count" >= 0 and "executor_executions"."version" > 0),
	CONSTRAINT "executor_executions_ambiguity_ck" CHECK ("executor_executions"."state" <> 'ambiguous' or "executor_executions"."reconciliation_state" in ('required','in_progress','manual_required'))
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_uq" UNIQUE("org_id","project_id","id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_uq" UNIQUE("org_id","project_id","id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_uq" UNIQUE("org_id","project_id","id");--> statement-breakpoint
ALTER TABLE "executor_execution_attempts" ADD CONSTRAINT "executor_execution_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_execution_attempts" ADD CONSTRAINT "executor_execution_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_execution_attempts" ADD CONSTRAINT "executor_execution_attempts_execution_tenant_fk" FOREIGN KEY ("org_id","project_id","execution_id") REFERENCES "public"."executor_executions"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_executions" ADD CONSTRAINT "executor_executions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_executions" ADD CONSTRAINT "executor_executions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_executions" ADD CONSTRAINT "executor_executions_confirmed_by_profiles_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_executions" ADD CONSTRAINT "executor_executions_actor_id_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_executions" ADD CONSTRAINT "executor_executions_approval_tenant_fk" FOREIGN KEY ("org_id","project_id","approval_id") REFERENCES "public"."approvals"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_executions" ADD CONSTRAINT "executor_executions_task_tenant_fk" FOREIGN KEY ("org_id","project_id","task_id") REFERENCES "public"."tasks"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_executions" ADD CONSTRAINT "executor_executions_run_tenant_fk" FOREIGN KEY ("org_id","project_id","run_id") REFERENCES "public"."runs"("org_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "executor_execution_attempts_number_uq" ON "executor_execution_attempts" USING btree ("execution_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "executor_execution_attempts_active_lease_uq" ON "executor_execution_attempts" USING btree ("execution_id") WHERE state in ('claimed','sandbox_starting','precondition_verified','writing','verifying','ambiguous');--> statement-breakpoint
CREATE INDEX "executor_execution_attempts_lease_idx" ON "executor_execution_attempts" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "executor_execution_attempts_state_lease_idx" ON "executor_execution_attempts" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "executor_execution_attempts_tenant_idx" ON "executor_execution_attempts" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "executor_executions_idempotency_uq" ON "executor_executions" USING btree ("org_id","project_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "executor_executions_confirmation_uq" ON "executor_executions" USING btree ("confirmation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "executor_executions_live_target_uq" ON "executor_executions" USING btree ("org_id","project_id","workspace_storage_id","target_collision_key") WHERE state in ('claimed','sandbox_starting','precondition_verified','writing','verifying','ambiguous','reconciling','manual_resolution_required');--> statement-breakpoint
CREATE INDEX "executor_executions_state_reconcile_idx" ON "executor_executions" USING btree ("state","reconcile_after");--> statement-breakpoint
CREATE INDEX "executor_executions_project_created_idx" ON "executor_executions" USING btree ("org_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "executor_executions_approval_idx" ON "executor_executions" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "executor_executions_target_idx" ON "executor_executions" USING btree ("workspace_storage_id","target_collision_key");
