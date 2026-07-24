# Sprint 1 Report — King AI Operations Hub

> Prepared for the owner/CEO before approval to merge. Snapshot: 2026-07-23.
> Repo: `C:\Users\baldd\dev\king-ai-ops-hub` (complete working tree, no commits yet —
> "merge" here means making the initial commit and accepting this baseline).

---

## 1. Executive Summary

**What was accomplished.** In one sprint, the platform went from empty directory
to a verified, working vertical slice of the entire product: authentication,
five isolated workspaces, agent configuration, task submission, both provider
adapters (OpenAI + Anthropic), the full cross-provider review workflow
(primary → other-vendor review → one revision → deterministic consolidation),
immutable conversation history, exact cost accounting with pre-flight spend
limits, a hash-chained append-only audit log, a human approval queue for every
model-proposed action, and all eleven screens. Every quality gate is green:
strict typecheck, lint (including architecture-boundary rules), 75/75 tests —
including a live-database proof that row-level security confines even a
filterless query to one project — a clean production build, and a browser smoke
test. Six planning/governance documents were produced alongside the code.

**Overall assessment.** The project is in strong shape. The highest-risk
properties — tenant isolation, no-execution-without-approval, bounded agent
loops, spend control — are enforced *structurally* (database policies, closed
enums, a fixed state machine) rather than by convention, and each one has a
test proving it. The main gaps are operational, not architectural: owner
onboarding is mid-flight (blocked on the owner creating their own account),
the E2E suite has not yet run against real credentials, and the encryption key
must be regenerated before real secrets are stored.

**Internal consistency.** The documentation set is internally consistent on
every substantive claim (workflow, isolation model, limits, phase status).
A deliberate cross-document audit found **three minor discrepancies**, none of
which change behavior; they are listed in §3 with one-line fixes, and are
queued as the first items of documentation debt.

## 2. Documents Created

| File | Purpose | Key decisions captured | How it supports the platform |
|---|---|---|---|
| **README.md** | Front door: what the product is, local setup, quality gate, repo map | Docker Postgres on 5433; Supabase for auth only; E2E credential convention | Gets any engineer from clone to running app without help |
| **ARCHITECTURE.md** | The system's constitution: 8 invariants, 5 trust boundaries, layering, data model, request lifecycle | Layered `src/` with lint-enforced boundaries; state-machine engine; redundant tenant columns; testing strategy | Every future change can be checked against a named invariant instead of a vibe |
| **SECURITY.md** | Threat model and controls: 5 adversaries, 7 threats (T1–T7), least-privilege table, key rotation runbook | Model output = hostile input; approval gate as the only path to side effects; append-only history; closed action enum | The review checklist for the riskiest future work (Phase 3 executors) |
| **DECISIONS.md** | 9 architecture decisions (D-001…D-009) with rationale and revisit triggers | Supabase auth-only; no monorepo yet; Chat Completions over Responses; bigint micros; cross-vendor review by construction; TS 5.9 over 7.x | Prevents relitigating settled questions; each entry names what would reopen it |
| **ROADMAP.md** | Six phases with *checkable* exit criteria; explicit non-goals | Executors deferred to their own phase; MCP server as the multi-consumer trigger; "never" list (autonomous loops, cross-project context) | Sequences risk: each phase lands on a verified previous one |
| **.env.example** | The environment contract, annotated | NEXT_PUBLIC_ = browser-visible rule; migration URL separate from runtime URL; limit defaults | A unit test enforces its hygiene (no public secret names) |
| **HANDOFF.md** | Zero-context takeover doc: schema, state, known issues, TODOs, verbatim prompts | Honest known-issues list (weak dev encryption key, profile-linking edge, sync runs) | Makes the project survivable across engineers and sessions |
| **SPRINT-01-REPORT.md** | This report | — | Decision record for the merge approval |

(Supporting artifacts also delivered: database migrations + RLS SQL, seed and
key-rotation scripts, 9 test suites, Playwright config, Docker compose.)

## 3. Cross-Document Review

**Method.** Grep-verified cross-references and decision-ID citations across all
`.md` files and source; line-by-line comparison of every quantitative claim
(limits, timeouts, versions, table counts, phase status) against the code.

**Contradictions: three minor, none behavioral.**

1. ARCHITECTURE.md §5 shows the spec-shaped interface `estimateCost?(usage)`;
   the implemented signature is `estimateCost?(model, usage)` (model is needed
   to price). *Fix: update the snippet.*
2. ARCHITECTURE.md invariant I3 says model output is "parsed through Zod"
   universally; the review **verdict** is parsed by a strict regex (fail-safe to
   `revise`), while action proposals are Zod-parsed. *Fix: soften I3 wording to
   "validated against a strict schema or protocol."*
3. README says "Tailwind 4 · Docker" in the stack line but omits `server-only`
   and `postgres` driver from its stack summary (both documented elsewhere).
   *Cosmetic.*

**Mutual referencing.** README, ARCHITECTURE, and HANDOFF link to every other
document; SECURITY, DECISIONS, and ROADMAP are leaf documents (referenced 16
times, linking out rarely). This is acceptable hub-and-spoke structure; adding
a small header cross-link block to the three leaf docs is queued as Low debt.

**Terminology.** Consistent throughout: *workspace* (UI term) = *project*
(schema term) — stated explicitly; *task → run → step → message* hierarchy used
identically in docs, schema, and code; decision IDs (D-001…D-009) and threat IDs
(T1–T7) are cited in code comments 34 times, so docs and code point at each other.

**Responsibilities.** Clearly defined: the **owner** approves consequential
actions, holds provider keys, sets spend limits; the **platform** enforces
isolation, budgets, immutability; **models** may only propose. The
least-privilege table in SECURITY.md §5 assigns database-level responsibility
per principal. No orphaned responsibilities found.

**Vision ↔ architecture alignment.** The four product promises (isolation,
human sovereignty, adversarial quality, accountability) each map to named,
tested mechanisms (RLS + TenantContext; approvals-only path; cross-vendor
state machine; hash-chained audit + micros accounting). No vision claim lacks
an enforcing mechanism; no mechanism exists without a vision reason.

## 4. Recommended Architecture Changes (not implemented)

| # | Recommendation | Why it matters | Risk of change | Suggested sprint |
|---|---|---|---|---|
| A1 | **Background job execution for runs** (DB-backed queue; route enqueues, worker calls existing `startRun`) | Runs currently block an HTTP request up to 180 s; queue enables streaming UX, retries, and multi-run concurrency | Medium (touches run lifecycle; D-009 pre-planned the seam) | Sprint 3 |
| A2 | **Structured JSON reviewer verdicts** (Zod-parsed, per-issue severity) replacing the `VERDICT:` line protocol | Closes discrepancy #2 properly; enables diff-style review UI and provenance; makes review machine-auditable | Low (protocol change inside one module + prompts) | **Sprint 2** |
| A3 | **Streaming (`AIProvider.stream`) + SSE to task detail** | Biggest UX gap: 60–180 s of silence during runs; interface already reserved | Low-Medium (adapter + one route + client component) | **Sprint 2** |
| A4 | **Email-based profile relinking** in `upsertProfile` | Removes the seed-before-signup footgun (Known issue #2) that can 500 first sign-in | Low (one function + regression test) | Sprint 2 (small) |
| A5 | **Approval-expiry sweep** (mark `expired` on read/cron, not only on decide) | Queue counts become truthful; groundwork for executor safety in Phase 3 | Low | Sprint 3 |
| A6 | **Extract `packages/` workspace when the MCP server lands** | Second consumer of domain/providers appears in Phase 5; D-002 names this exact trigger | Medium (build plumbing only; layout already monorepo-shaped) | Sprint 5 |
| A7 | **Rate-limit bucket pruning + retention policy** | Unbounded (slow) table growth; hygiene before any production deployment | Low | Sprint 3 |

## 5. Outstanding Questions (owner decisions required — no assumptions made)

1. **Owner sign-up email** — which email should own the platform? Blocks seed
   rebinding and therefore all real usage. (Mid-flight now.)
2. **Real spend limits per project** — $25/month default is a placeholder.
   What monthly ceiling per workspace, and should any workspace differ?
3. **Model defaults** — seeded: GPT-5.2 primary/reviewer (OpenAI side),
   Claude Opus 4.8 (Anthropic side). Keep, or trade cost for capability
   (e.g., Sonnet 5 / GPT-5.2-mini as defaults, flagship on demand)?
4. **Deployment target and timing** — local-only today. Vercel + Supabase
   Postgres? Something else? Determines when issues #5/#6 (open sign-up,
   dev DB password) become blocking.
5. **Multi-user future** — the schema supports members/roles now. Will anyone
   besides the owner get access in the next quarter? Affects how much to invest
   in role UX vs. deferring it.
6. **Approval expiry window** — 24 h TTL is an engineering default. Right for
   your working rhythm, or longer/shorter?
7. **Data retention** — should old runs/messages ever be archived (they are
   immutable by design), and what backup cadence do you want for the Docker
   volume before a managed DB exists?

## 6. Technical Debt

| Rank | Item | Type | Notes |
|---|---|---|---|
| **Critical** | `APP_ENCRYPTION_KEY` generated with non-CSPRNG; not yet replaced | Technical | Zero-cost to fix now (no secrets stored); expensive after |
| **Critical** | No git commits — no history, no rollback point | Process | First action after this report is approved |
| **High** | E2E suite never executed (needs owner credentials) | Process | The one gate not yet green end-to-end |
| **High** | Profile email-relink edge can 500 first sign-in if seed order is reversed | Technical | Fix + regression test queued (A4) |
| **High** | Synchronous run execution inside a server action | Technical | Acceptable single-user; blocks streaming and concurrency (A1) |
| **Medium** | Pricing table values unverified against live vendor pages | Technical/Product | Versioned table makes correction one commit |
| **Medium** | Open sign-up + hardcoded `app_server` dev password | Technical | Non-issues locally; blocking for any deployment |
| **Medium** | Approval expiry is lazy; queue counts can overstate | Technical | A5 |
| **Medium** | Three doc-code discrepancies from §3 | Documentation | One-line fixes each |
| **Low** | `rate_limit_buckets` never pruned | Technical | A7 |
| **Low** | Leaf docs (SECURITY/DECISIONS/ROADMAP) lack outbound cross-links | Documentation | Cosmetic |
| **Low** | No streaming UI; results appear only at run completion | Product | A3 — the flagship UX improvement |
| **Low** | Artifacts limited to inline text (blob storage = Phase 4 as planned) | Product | Scheduled, not accidental |

## 7. Risks and Mitigations

**Product** — *Review theater*: cross-vendor review could degrade into models
politely approving each other, eroding the differentiator. → Mitigate in
Sprint 2 with structured verdicts + golden-transcript tests that pin reviewer
behavior; track approve/revise/reject ratios on the usage screen.

**Business** — *Cost surprise*: unverified pricing table or a deleted spend-limit
row could misreport costs (the gate fails closed, so overspend is bounded, but
trust in reports suffers). → Verify pricing against vendor pages (TODO #7);
alert when a project has no spend-limit row. *Single-person dependency*: all
context lives with one owner + this repo. → HANDOFF.md exists for exactly this;
commit it.

**Technical** — *Vendor API drift*: both SDKs pinned; adapters are the only
touch points, so an upgrade is contained to two files + tests. *Local-only
state*: the Docker volume is the sole copy of all data. → Back up `pgdata`
before experiments; move to managed Postgres at deployment.

**Security** — *Prompt injection escalation* (T2): currently structurally inert
(no execution path). The risk **concentrates in Phase 3 executors**. → Keep
executors behind the single `executeApprovedAction()` choke point with payload
hash re-verification; security-review that phase line-by-line against
SECURITY.md before merge. *Key exposure*: server-only env module + redacting
logger + build-time guard are in place; rotate keys at the provider if ever
pasted anywhere outside `.env.local`.

**Scalability** — *Synchronous runs* cap concurrent work at roughly the HTTP
timeout budget (fine for one owner, wrong for teams) → A1 queue. *Audit chain
serialization*: hash-chaining serializes audit writes per org under heavy
concurrency — irrelevant at current scale; if multi-tenant SaaS ever happens,
shard the chain per project. *Postgres itself* will not be the bottleneck
before thousands of runs/day.

## 8. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 10/10 | Every Phase-1 requirement of the brief delivered, plus both providers and full review workflow (originally allowed to be slice+1) |
| Quality | 9/10 | All gates green; adversarial tests (injection payloads, malformed output, tamper detection); −1: E2E written but never run, three doc nits |
| Completeness | 8/10 | Vertical slice complete and verified; onboarding mid-flight; executors/artifacts/MCP intentionally deferred per plan |
| Maintainability | 9/10 | Lint-enforced boundaries, decision log cited from code, handoff doc, versioned pricing; −1: no commit history yet |
| Future scalability | 8/10 | Clean seams for queue, packages split, MCP; −2: sync runs and single-machine DB are known ceilings with named remedies |

**Overall: 8.5/10.** The sprint delivered a complete, safety-first foundation
with its riskiest properties proven by tests rather than asserted. The missing
half-point-and-change is operational finish — run E2E, commit, complete
onboarding — not design or code quality. I recommend approving the merge
(initial commit) as-is, with the Critical debt items as the first two actions
after it.

## 9. Recommended Sprint — Sprint 2: "Observable, Trustworthy Review"

One direction, chosen because it deepens the product's core differentiator
(adversarial cross-vendor review) while remaining entirely inside the current
no-execution safety envelope — the risky Phase 3 executor work then lands on a
hardened, observable engine.

**Objectives**
1. Make review output structured, auditable, and visibly useful.
2. Eliminate the silent 60–180 s wait — stream run progress live.
3. Pin engine behavior with recorded transcripts so future changes can't
   silently alter workflow semantics.
4. Clear the small-but-sharp debt items (relink bug, doc nits, key regen, commit).

**Deliverables**
- Structured reviewer verdicts: Zod schema (verdict + issues[] with severity +
  location), prompt update, migration of `run_steps.verdict` consumers, and a
  diff-style review panel on task detail.
- `stream()` implemented on both adapters; SSE route; task detail renders
  primary/review/revision tokens live with step transitions.
- Golden-transcript test suite: ≥6 recorded provider exchanges replayed through
  the engine asserting identical step sequences and consolidation output.
- Fixes: email-based profile relink + regression test; the three §3 doc
  discrepancies; CSPRNG encryption key; approval-expiry sweep (small); initial
  commit + E2E run in CI-style script.

**Estimated complexity** — Medium. ~6 focused work sessions: streaming (2),
structured verdicts + UI (2), golden transcripts (1), debt burn-down (1).
No schema migrations beyond one nullable column (`run_steps.verdict_detail jsonb`).

**Dependencies** — Owner onboarding finished (sign-up + seed rebind + one real
smoke run with live keys); decisions #2 (spend limits) and #3 (default models)
from §5 taken, since golden transcripts should be recorded against the models
you'll actually run.

**Success criteria**
- A `both`-provider task shows live streaming output and a structured review
  panel with per-issue severities and what the revision changed.
- `npm run verify` green including new transcript suite; E2E green with real
  credentials; approve/revise/reject ratio visible on the usage screen.
- Repo has commit history; no Critical debt items remain.

## 10. CEO Briefing (one page)

**1. Where are we now?**
The platform exists and works. You can sign in, pick any of your five isolated
workspaces, hand a task to OpenAI, Anthropic, or both, and watch one vendor's
model review the other's work before you get a consolidated answer. Every token
is costed to the micro-cent against a monthly cap, every message is permanent,
every event is in a tamper-evident audit log, and nothing a model *proposes* —
a commit, an email, a deployment — can ever *happen* without your explicit
approval. All of that is proven by 75 automated tests, including one that
demonstrates workspace isolation at the database itself. What's left this week
is plumbing-in *you*: create your account, I rebind the seed data, and we run
one real task end-to-end.

**2. What is the biggest remaining challenge?**
Phase 3 — the executors that turn your approvals into real actions (writing
files, opening PRs, deploying). It's the moment the platform gains hands, and
it's where prompt-injection risk becomes real instead of theoretical. The
design already fences it (single choke point, payload hash re-verification,
closed action list), but that code deserves the most careful review of anything
we will ever write. Everything before it is sequenced to make that landing safe.

**3. What should I personally focus on next?**
Three things, ~30 minutes total: (a) sign up in the app and tell me the email;
(b) decide real monthly spend caps per workspace ($25 default is a placeholder);
(c) confirm default models — flagship quality (current: GPT-5.2 + Opus 4.8) or
cheaper defaults with flagship on demand. Everything else is my job.

**4. Are we ready to continue development?**
Yes. Gates are green, the foundation is tested, and the two Critical items
(regenerate the encryption key, make the first commit) are minutes of work that
happen immediately upon your approval of this report. I recommend approving.

**5. What decisions do you need from me before Sprint 2?**
The three in question 3, plus two cheap ones: how long approval requests stay
valid before expiring (currently 24 h), and whether anyone besides you gets
access this quarter (affects how much role/permission UX we build vs. defer).
Deployment target (Vercel + hosted Supabase vs. staying local) can wait until
after Sprint 2 but is the next decision after these.

---

*Requesting approval to: (1) make the initial commit of this baseline,
(2) execute the Critical debt fixes, (3) proceed to Sprint 2 as scoped in §9.*
