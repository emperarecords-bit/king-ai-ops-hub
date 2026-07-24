# Decision Log

Architecture decisions, newest last. Each entry records the choice, the reasoning
at the time, and what would make us revisit it.

---

## D-001 — Supabase Auth for identity, Drizzle for everything else

**Decision.** Use Supabase Auth (cookie sessions via `@supabase/ssr`) for sign-in,
and Drizzle ORM against the same Postgres for all application data. Do not use the
Supabase JS client for table reads or writes.

**Why.** Auth is the part worth outsourcing: password hashing, email verification,
session rotation, and CSRF-safe cookie handling are easy to get subtly wrong.
Everything else benefits more from typed SQL and versioned migrations than from a
generated REST client. Mixing both access paths would mean two places to enforce
tenancy; one is safer.

**Revisit if.** We need realtime subscriptions on tenant tables, or we move off
Supabase and need to replace auth anyway.

---

## D-002 — Layered `src/` instead of a package-per-layer monorepo

**Decision.** One Next.js app with strictly layered directories
(`app → domain → orchestration → providers → db → lib`), enforced by ESLint import
boundaries, rather than a pnpm workspace with a package per layer.

**Why.** The stated requirement is separation of UI, domain, database, providers,
orchestration, shared types, and tests — which is a *dependency* requirement, not a
*packaging* requirement. A workspace adds build orchestration, duplicate tsconfigs,
and cross-package type-resolution friction, and buys isolation we already get from
a lint rule that fails CI. There is exactly one deployable and exactly one consumer
of the domain layer today.

The layout is deliberately monorepo-shaped: `src/domain` has no imports from
`src/app`, so promoting it to `packages/domain` is a `git mv` plus a tsconfig path,
not a rewrite.

**Revisit if.** A second consumer appears — the planned MCP server is the likely
trigger. At that point `providers`, `orchestration`, `domain`, and `db` get
extracted and the Next app becomes one of two consumers.

---

## D-003 — OpenAI Chat Completions rather than the Responses API

**Decision.** `OpenAIProvider` uses `client.chat.completions.create()`.

**Why.** Both are supported in SDK v6. Chat Completions has the same request/response
shape as Anthropic's Messages API — an ordered list of role-tagged turns, a system
prompt, and a usage block — which means the adapter layer stays thin and the two
providers normalize onto `AgentRequest`/`AgentResponse` without one of them needing
a translation layer the other does not. Statefulness and server-side conversation
storage, the Responses API's main draw, are things we specifically do not want: our
conversation state is our immutable `messages` table.

**Revisit if.** We need built-in tools (web search, code interpreter) or reasoning
summaries, both of which are Responses-only.

---

## D-004 — Money as integer USD micros

**Decision.** All monetary values are `bigint` micros (1 USD = 1,000,000). Never
`float`, never `numeric` in application code.

**Why.** Per-token pricing produces values like `$0.0000025`. Floating point
accumulates error across thousands of steps, and `numeric` round-trips through JS as
a string that invites accidental `parseFloat`. Integers are exact, sortable, and
summable in SQL. Formatting happens once, at the edge, in `formatMoney()`.

---

## D-005 — Cross-provider review is the default for `provider = both`

**Decision.** When a task selects `both`, the reviewer is always the *other*
vendor's agent — OpenAI primary → Anthropic reviewer, and vice versa.

**Why.** Two instances of the same model share failure modes; a review by the same
family mostly restates the original with more confidence. The value of the review
step comes from the disagreement, so the engine makes the cross-vendor pairing
structural rather than a setting someone has to remember to configure.

**Revisit if.** Users want same-vendor review with a different model tier
(e.g., a large model reviewing a small one). That is a config flag, not a redesign.

---

## D-006 — One revision, enforced by a state machine and not a loop

**Decision.** The run path is a fixed sequence of at most four steps: primary,
review, revision, consolidate. `MAX_STEPS` and `MAX_REVISIONS` are constants checked
at every transition. Consolidation is deterministic assembly, not a model call.

**Why.** "Prevent infinite model-to-model loops" is a safety requirement, and the
strongest way to satisfy it is to make an unbounded loop unrepresentable. A `while
(!converged)` with a counter is one bad edit away from a runaway; a state machine
with an explicit transition table is not. Making consolidation deterministic also
removes a third model call from the cost of every task and makes the final result
reproducible from the stored messages.

**Revisit if.** A task class genuinely needs iterative refinement. That would be a
new, separately-named workflow with its own explicit bound — not a relaxation of
this one.

---

## D-007 — TypeScript 5.9 rather than 7.x

**Decision.** Pin `typescript@~5.9.3` even though `latest` is `7.0.2`.

**Why.** TypeScript 7 is the native-Go compiler port. It is GA, but the surrounding
ecosystem we depend on — `typescript-eslint`, `drizzle-kit`'s type generation,
Next's build-time type checking — is still stabilizing against it. The cost of being
early here is a toolchain that fails for reasons unrelated to our code; the benefit
is compile speed on a codebase that takes seconds to check either way. Wrong trade.

**Revisit if.** `typescript-eslint` and `eslint-config-next` both declare TS 7 in
their peer ranges. Then it is a one-line bump.

---

## D-008 — Redundant `org_id` and `project_id` on every tenant table

**Decision.** Carry both columns on every tenant-scoped table even where they are
derivable through a foreign key (e.g., `messages` could reach `project_id` through
`task_id`).

**Why.** It makes every RLS policy a single-table predicate with no join, which is
both faster and far easier to audit — you can read one policy and know it is
correct. It also makes a forgotten filter a visible bug: if a query on `messages`
has no `project_id` in its `WHERE`, that is obviously wrong at a glance, whereas a
missing three-table join condition is not. Denormalization is a real cost; here it
buys a security property, which is the right thing to spend it on.

---

## D-009 — Run triggered by a separate call, not inline in the create action

**Decision.** `createTask` returns immediately; `POST /api/tasks/:id/run` executes
the state machine.

**Why.** A provider call can take 60+ seconds. Holding a Server Action open that
long means no progress feedback, a request timeout on most hosts, and no way to
retry without re-submitting the form. Splitting them gives us a durable `tasks` row
before any money is spent, an obvious retry point, and a place to add a queue later
without changing the UI contract.

**Revisit if.** We add a job queue — the route handler becomes an enqueue and the
worker calls the same `engine.execute()`.

---

## D-010 — Objective-first product orientation

**Decision.** The platform's central object is the **Objective**, not the Task.
New features are designed top-down through `Objective → Milestone → Task → Run`
and must justify their place in that hierarchy; task-first designs are the
exception and need a stated reason.

**Why.** CTO review (2026-07-23): people don't wake up wanting to complete
tasks — they want to launch products, ship releases, grow revenue. Tasks exist
only to accomplish objectives. The product ceiling of an "AI orchestrator" is a
tool; the ceiling of an objective-driven system is an AI company operating
system. The specification already exists ([OBJECTIVES.md](OBJECTIVES.md)); this
decision makes it the design lens rather than one feature among many.

**Revisit if.** Real usage shows owners consistently working in standalone
tasks and ignoring objectives — then the hierarchy is ceremony and should be
made optional at the UI level (it already is at the schema level:
`tasks.milestone_id` is nullable).

---

## D-011 — Work and Knowledge are separate layers

**Decision.** The platform models two distinct things and never conflates them:
**Work** (objectives, tasks, runs, messages — things that happen and complete)
and **Knowledge** (decisions, standards, playbooks, personas, policies — things
that persist and govern). Knowledge is specified in [KNOWLEDGE.md](KNOWLEDGE.md);
`project_context_items` is its seed and will grow into it rather than being a
parallel system.

**Why.** CTO review: conversations are a terrible place for permanent truth.
Every AI should consult project knowledge before beginning work, and knowledge
must persist independently of any conversation, task, or session. Separating
the layers keeps work records immutable (I7) while knowledge stays *versioned
and curated* — different lifecycles, different tables, different UX.

**Revisit if.** Never in substance; the boundary line (e.g., is a research
artifact work-output or knowledge?) is settled per KNOWLEDGE.md's promotion
rule: artifacts are work until a human promotes them.

---

## D-012 — Agents organize into Departments

**Decision.** Agents are grouped into stable **departments** (Engineering,
Marketing, Finance, Support, Operations) as the organizing structure of the
AI workforce. Departments are stable; agents within them evolve, get replaced,
or retire. [AGENT_CATALOG.md](AGENT_CATALOG.md) is organized by department.

**Why.** CTO review: a flat, ever-growing agent list becomes unmanageable and
communicates nothing. Departments give owners a mental model they already have,
give future permissions a natural scope ("Finance agents may read usage data"),
and give the Coordinator a routing structure.

**Revisit if.** Department boundaries fight real usage (e.g., cross-functional
agents proliferate) — then departments become tags rather than containers.

---

## D-013 — The simplicity gate

**Decision.** Every proposed feature must pass three questions before design
proceeds: (1) Does it strengthen the mission? (2) Does it reduce — or at least
not increase — complexity? (3) Can a new engineer understand it within minutes?
A feature failing any question is redesigned or rejected. The gate is recorded
in [MISSION.md](MISSION.md) as a core principle.

**Why.** CTO review: the architecture's understandability is an asset with
compounding value, and it erodes one reasonable-sounding feature at a time.
Making the test explicit turns "protect simplicity" from sentiment into
procedure.

**Revisit if.** Never. If the gate itself becomes ceremony, fix the gate's
application, not its existence.

---

## D-014 — Two model tiers, chosen by humans, resolved in code

**Decision.** Every task runs at one of two tiers: **standard**
(each agent's configured model — seeded as GPT-5.4 mini / Claude Sonnet 5; the
executive memo named "GPT-5.2 Mini", which does not exist — the mini tier is
versioned separately, and the account's newest mini was substituted) or
**flagship** (GPT-5.2 / Claude Opus 4.8, overriding the agent's model per
provider). The tier is selected by a human on the task form; flagship requires
declaring a category from the approved reserved list (architecture, security,
database design, major refactoring, product strategy, complex reasoning,
release review), stored on the task and audited. Resolution is a pure function
(`src/orchestration/routing.ts`) preserving cross-vendor review (D-005) in
both tiers.

**Why.** Executive decision (2026-07-23): flagship models for every task is
the wrong default — most work doesn't need them, and the cost difference is
roughly 5×. The category requirement makes every flagship dollar attributable
to a stated reason. Keeping resolution in code (not per-agent duplication)
means no "flagship agent" rows to drift, and the future auto-router slots in
behind the same function.

**Security constraint that must survive into any auto-router:** routing is
deterministic and content-independent of model output. No model's judgment may
select the flagship tier — only rules or a human — otherwise injected task
content could escalate its own spend.

**Revisit if.** More than two tiers earn their keep (e.g., a "budget" Haiku
tier), or per-department default tiers arrive with the Departments UI.

---

## D-015 — The platform presents as an AI workforce; employees are agents enriched, not replaced

**Decision.** (Executive direction + design review, 2026-07-24 — see
[DESIGN-REVIEW-WORKFORCE.md](DESIGN-REVIEW-WORKFORCE.md).) The product
presents itself as an AI workforce management platform: users assign work to
**employees** organized in **departments**; providers and models are
implementation details resolved per employee. Physically, employees are the
existing `agents` table progressively enriched (title, department,
responsibilities, reporting line — additive columns); the engine, providers,
tenancy, approvals, and audit are unchanged. **Department → Employee is an
assignment dimension across the objective hierarchy**
(`Company → Project → Objective → Milestone → Task → Run`), not a containment
level within it: tasks get an assigned employee, objectives get a sponsoring
department and accountable employee as attributes, never parents.

**Why.** Cross-functional objectives are the norm ("launch the beta" spans
Engineering, Marketing, Finance); strict containment would fragment them into
per-employee shards or force ownership fictions. The assignment-dimension
reading keeps OBJECTIVES.md's schema verbatim and matches how the
organizations this models actually operate. Renaming `agents` at the DB level
was rejected: the word "employee" is a presentation concern, and a table
rename buys migration risk with zero behavior.

**Consequences.** Sprint 3 M4 ships `departments` as an org-scoped reference
table (not an enum); ONBOARDING.md is written in workforce vocabulary; a
dedicated Workforce UX sprint (Phase 2.75) delivers the assignee-first task
form and employee profiles.

**Revisit if.** Real usage shows single-employee objectives dominate so
heavily that the sponsoring-department attribute is ceremony.

---

## D-017 — Activation requires a measurable definition of success

**Decision.** (Executive, 2026-07-24.) An objective may be **created** with no
success criteria, but it cannot become **active** without at least one. To
keep the gate from becoming friction, the creation form offers AI-suggested
criteria: the model proposes, the human edits, and nothing is stored until
the human submits.

**Why.** Real usage found the gap the tests could not: both objectives the
owner created outside of tests had zero criteria, and one completed instantly
(OBSERVATIONS.md O-1). The completion gate — the spine of the objectives
model — is vacuous when there is nothing to satisfy. Drafting is allowed to
be unfinished; committing the company to an objective is not.

**Note on the suggester.** It is a proposal surface, not an authority: Zod-
validated, standard-tier, budget-gated, consults only that workspace's
knowledge, and stores nothing. A model helping write the definition of
success never gets to *decide* the definition of success.

**Revisit if.** Owners routinely create one throwaway criterion to satisfy
the gate — that would mean the gate is being paid, not met, and the honest
fix is a lighter object than an objective.

---

## D-018 — Platform defaults use models with verifiable public pricing

**Decision.** (Executive, 2026-07-24.) The flagship tier moves to `gpt-5.4`
($2.50/$15, verified). `gpt-5.2` remains callable through per-agent
configuration but is no longer a platform default, because it was delisted
from OpenAI's public pricing page and its rate can no longer be confirmed.

**Why.** Cost accounting is a load-bearing feature here — budgets refuse
runs, and insights reason about cost per outcome. A default whose price
cannot be verified quietly corrupts all of it. Sprint 10's verification found
the mini tier under-billed 3× and Sonnet over-billed 50%; the lesson
generalizes: if we cannot check the price, we do not make it a default.

**Revisit if.** A delisted model is the only one that can do a job. Then it
becomes an explicit per-agent choice with an unverified-pricing warning,
never a default.
