# 0057 reviewer rubric

Adds nullable `agents.review_rubric text` and `agents_review_rubric_bytes_ck`, which permits null or at most 8192 UTF-8 bytes using PostgreSQL `octet_length`.

The migration is additive and performs no data rewrite. Existing agents retain `NULL`, meaning no additional reviewer-specific rubric. Existing runs and review JSON are unchanged.

Rollback requires first removing application reads/writes of `review_rubric`, then dropping the constraint and column. Any rubric content would be lost by that rollback; review executions remain reconstructable because new-run provenance snapshots the effective rubric independently in `run_steps.verdict_detail`.
