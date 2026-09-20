-- Rollback for 0069_verification_ingest.sql (VER-002).
-- Drops the two tables (and their policies/indexes/constraints cascade with them).
-- Safe to run repeatedly. No other object depends on these tables.

DROP TABLE IF EXISTS "verification_evidence" CASCADE;
DROP TABLE IF EXISTS "verification_requests" CASCADE;

-- The RLS grants/policies in src/db/rls.sql are wrapped in `to_regclass(...) IS NOT NULL`
-- guards, so once the tables are gone those blocks become no-ops on the next bootstrap.
