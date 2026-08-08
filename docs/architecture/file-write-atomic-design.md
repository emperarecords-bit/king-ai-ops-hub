# File-write atomic design (no implementation)

This document specifies a future algorithm. **NO REAL FILESYSTEM WRITE CAPABILITY EXISTS.**

The future isolated executor must record intent, validate the canonical path, inspect every component without following links, verify the create/replace precondition, and capture parent/target identities. It then creates a restricted temporary file in the same directory and filesystem, stages the exact approved UTF-8 bytes, verifies their SHA-256, and meets the platform durability contract before any commit.

Immediately before commit it must re-inspect parent and target identities and re-check the precondition. Any substitution, competing writer, inserted link/reparse point, mount transition, or unknown evidence blocks the operation. Only a descriptor-relative atomic rename/replace may commit the prepared bytes. The directory durability contract and final target SHA-256 are then verified before lifecycle result persistence and cleanup.

Crashes before atomic commit are eligible for `definitely_not_executed` only when independent evidence proves no commit. Crashes after commit, timeouts, or failure to persist the database result are ambiguous until reconciliation inspects independent identity and hash evidence. A self-report is never sufficient.

The TypeScript state machine and fake sandbox in this PR model ordering, cancellation, limits, evidence, cleanup, and ambiguity only. They perform no I/O and launch nothing.
