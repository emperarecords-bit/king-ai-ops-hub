ALTER TABLE "run_jobs" ADD COLUMN "ops_chat_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ops_chat_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ops_chat_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "run_jobs" ADD CONSTRAINT "run_jobs_ops_chat_proposal_id_ops_chat_proposals_id_fk" FOREIGN KEY ("ops_chat_proposal_id") REFERENCES "public"."ops_chat_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ops_chat_proposal_id_ops_chat_proposals_id_fk" FOREIGN KEY ("ops_chat_proposal_id") REFERENCES "public"."ops_chat_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ops_chat_proposal_id_ops_chat_proposals_id_fk" FOREIGN KEY ("ops_chat_proposal_id") REFERENCES "public"."ops_chat_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_jobs_ops_chat_proposal_idx" ON "run_jobs" USING btree ("ops_chat_proposal_id");--> statement-breakpoint
CREATE INDEX "runs_ops_chat_proposal_idx" ON "runs" USING btree ("ops_chat_proposal_id");--> statement-breakpoint
CREATE INDEX "tasks_ops_chat_proposal_idx" ON "tasks" USING btree ("ops_chat_proposal_id");--> statement-breakpoint
-- P4 provenance is IMMUTABLE: set once at insert, never re-pointed (a re-run never overwrites the task's
-- originating card; each attempt carries its own card on run_jobs/runs). The only permitted change is the
-- foreign key's own ON DELETE SET NULL, which runs as a referential action (nested trigger depth > 1).
CREATE OR REPLACE FUNCTION app.enforce_ops_chat_provenance_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.ops_chat_proposal_id IS DISTINCT FROM OLD.ops_chat_proposal_id THEN
    IF NEW.ops_chat_proposal_id IS NULL AND pg_trigger_depth() > 1 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '%.ops_chat_proposal_id is immutable provenance (set once at insert)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER tasks_ops_chat_provenance_immutable BEFORE UPDATE OF ops_chat_proposal_id ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_ops_chat_provenance_immutable();--> statement-breakpoint
CREATE TRIGGER run_jobs_ops_chat_provenance_immutable BEFORE UPDATE OF ops_chat_proposal_id ON "run_jobs"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_ops_chat_provenance_immutable();--> statement-breakpoint
CREATE TRIGGER runs_ops_chat_provenance_immutable BEFORE UPDATE OF ops_chat_proposal_id ON "runs"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_ops_chat_provenance_immutable();
