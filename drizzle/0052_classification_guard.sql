-- Custom SQL migration file, put your code below! --

-- HUB-009 Gate 3A correction — DATABASE-LEVEL enforcement of the run/usage classification snapshot.
-- Enforced in the DB (not just app code) so no path can create a null snapshot or mutate an existing one.
--   * New runs/usage MUST carry a classification (non-null on INSERT).
--   * The classification snapshot is FULLY IMMUTABLE once a row exists: ANY change is rejected — non-null →
--     different value, non-null → null, AND null → non-null (so a legacy null snapshot can never be
--     back-filled). Only NULL → NULL / same-value are allowed, so legitimate updates to OTHER columns on
--     both current and legacy rows still succeed. `IS DISTINCT FROM` treats null correctly for this.

CREATE OR REPLACE FUNCTION app.enforce_run_classification() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.classification IS NULL THEN
      RAISE EXCEPTION 'runs.classification must be set on insert (HUB-009 snapshot; run id %)', NEW.id;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.classification IS DISTINCT FROM OLD.classification THEN
      RAISE EXCEPTION 'runs.classification is immutable (HUB-009 snapshot cannot change after insert, including a legacy null state; run id %)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS runs_classification_guard ON runs;
CREATE TRIGGER runs_classification_guard
  BEFORE INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_run_classification();

CREATE OR REPLACE FUNCTION app.enforce_usage_classification() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.classification IS NULL THEN
      RAISE EXCEPTION 'usage_events.classification must be set on insert (HUB-009 snapshot; id %)', NEW.id;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.classification IS DISTINCT FROM OLD.classification THEN
      RAISE EXCEPTION 'usage_events.classification is immutable (HUB-009 snapshot cannot change after insert, including a legacy null state; id %)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS usage_events_classification_guard ON usage_events;
CREATE TRIGGER usage_events_classification_guard
  BEFORE INSERT OR UPDATE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION app.enforce_usage_classification();
