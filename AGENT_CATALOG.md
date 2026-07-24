# Agent Catalog

## Purpose

The registry of every AI agent that acts in or around King AI Operations Hub.
Rule (from [TEAM.md](TEAM.md)): **an agent without a catalog entry does not
run.** Each entry defines purpose, responsibilities, permissions, I/O,
escalation conditions, and human-approval requirements.

## Scope

Two registers: **§A Current agents** (operating today) and **§B Future agents**
(specified, not built). In-product agent *configuration* (model, temperature,
prompt) lives in the database (`agents` table) and the Agent Settings screen;
this catalog governs *what kind of thing each agent is allowed to be*.

## Definitions

| Term | Meaning |
|---|---|
| **In-product agent** | A configured (provider, model, role) row in the `agents` table, executed by the run engine inside one workspace. |
| **Org-level agent** | An AI worker operating on the platform from outside it (building it, drafting docs for it). |
| **Permissions** | What the agent can cause to happen. For every agent in this catalog, direct execution of consequential actions is **zero** — differences are in what they may *read* and *propose*. |
| **Escalation** | Condition under which the agent must stop and surface to a human ([TEAM.md](TEAM.md) escalation rules). |

Universal constraints inherited by every entry (current and future):

- Output is untrusted input to the platform (I3); anything structured must
  pass its schema or die in quarantine.
- No agent holds approval authority ([MISSION.md](MISSION.md) principle 2).
- No agent reads across a project boundary (I1).
- Every agent's work is bounded: step limits, token caps, timeouts, budget
  gate (I5, I8).

## Departments

Per [DECISIONS.md](DECISIONS.md) D-012, agents are organized into stable
**departments**; the department is the durable structure, the agents within it
evolve. Department membership also sets default knowledge consultation
([KNOWLEDGE.md](KNOWLEDGE.md) — e.g., Engineering agents always consult
`coding_standard` + `architecture_decision`).

| Department | Current agents | Future agents (§B) | Default knowledge kinds |
|---|---|---|---|
| **Engineering** | A1/A2 Primaries*, A3/A4 Reviewers*, A5 Claude Code | B1 Executors | coding_standard, architecture_decision |
| **Operations** | Coordinator (role, [TEAM.md](TEAM.md)) | B5 Coordinator Agent, B4 MCP Clients | playbook, policy |
| **Marketing** | — | Content, SEO, Social (unspecified — entries required before build) | brand_guideline, customer_persona |
| **Finance** | — | B3 Cost Auditor; Billing, Forecasting (unspecified) | business_rule, policy |
| **Support** | — | Customer Support (unspecified) | playbook, customer_persona, template |
| **Owner's office** | A6 Claude Cowork | B2 Research Agent | (drafts for all kinds — via promotion only) |

\* The in-product primary/reviewer pairs are Engineering *by default
configuration*; a workspace whose work is marketing-shaped may configure its
agents into Marketing with matching prompts and knowledge defaults — the
department is an attribute of the configured agent, not of the model.

Unspecified future agents listed above are placeholders only: the
"no catalog entry → no run" rule applies — each needs a full §B-style entry
and Owner sign-off before existing.

---

## §A — Current agents

### A1. Primary Agent — OpenAI (per workspace: "OpenAI Primary")

- **Purpose:** produce the first-pass answer to a task brief.
- **Responsibilities:** complete the brief using only the wrapped approved
  context; flag real-world needs as proposed actions in the fenced protocol
  ([HANDOFF.md](HANDOFF.md) §15); produce one revision when the reviewer
  verdicts `revise`.
- **Permissions:** read: its brief + this workspace's approved context items.
  write: immutable messages (via engine); proposals into the approval queue.
  Execute: nothing.
- **Inputs:** system prompt (agent config + shared safety rules), wrapped
  context, wrapped brief; on revision, wrapped reviewer feedback.
- **Outputs:** response text; optional `proposed-actions` block (≤5, closed
  enum); token usage (billed exactly).
- **Escalation conditions:** none of its own — the *engine* escalates on its
  behalf (provider errors → bounded retry → failed run; malformed proposals →
  `model.malformed_output` audit event).
- **Human approval required for:** every proposed action, without exception.
- **Config today:** `gpt-5.2`, temp 0.7, 4 096 max output tokens (seeded;
  editable per workspace in Agent Settings).

### A2. Primary Agent — Anthropic ("Anthropic Primary")

Identical contract to A1 with vendor swapped. Config today:
`claude-opus-4-8`, temp 0.7, 4 096 max output tokens.

### A3. Reviewer Agent — OpenAI ("OpenAI Reviewer")

- **Purpose:** adversarially review an Anthropic-primary response (cross-vendor
  pairing is structural, D-005).
- **Responsibilities:** verdict-first reply (`VERDICT: approve | revise |
  reject`), then specific, actionable reasoning; assess correctness,
  completeness, safety.
- **Permissions:** read: the original brief + the response under review (both
  wrapped as untrusted). write: one immutable review message. Its verdict
  steers the state machine one step — it cannot trigger anything else.
- **Inputs:** review system prompt + wrapped brief + wrapped response.
- **Outputs:** verdict line + reasoning. Malformed verdict ⇒ engine treats as
  `revise` (conservative default — costs one revision, never skips review).
- **Escalation conditions:** engine-mediated as in A1; additionally a `reject`
  verdict is itself the escalation signal — consolidation flags the result
  "treat with caution."
- **Human approval required for:** n/a — reviewers cannot propose actions into
  execution; action extraction reads the *final* body only, and a rejected
  draft's proposals die with the draft (engine rule).

### A4. Reviewer Agent — Anthropic ("Anthropic Reviewer")

Identical contract to A3 with vendors swapped (reviews OpenAI-primary output).

### A5. Claude Code (org-level engineering agent)

- **Purpose:** build and maintain the platform itself.
- **Responsibilities / permissions / escalation:** defined in
  [TEAM.md](TEAM.md) §3 — summary: decides implementation detail inside
  D-001…D-009; keeps gates green; reports with evidence; commits/deploys only
  on explicit Owner instruction.
- **Inputs:** Owner instructions, repo state, this documentation set.
- **Outputs:** code, tests, migrations, documents, sprint reports.
- **Human approval required for:** commits/pushes, deployments, dependency on
  new external services, anything touching credentials, any invariant change.

### A6. Claude Cowork (org-level operations agent)

- **Purpose:** owner-side drafting and operations around the platform.
- **Contract:** [TEAM.md](TEAM.md) §4 — drafts freely; anything destined for
  project memory enters as a `pending` context item (quarantine); never
  touches the repo or platform data directly.
- **Human approval required for:** promotion of any draft into approved
  context; any outward communication built from its drafts.

---

## §B — Future agents (specified; build requires a catalog update + Owner sign-off)

### B1. Executor Agents (Phase 3 — highest risk in the roadmap)

- **Purpose:** turn *approved* actions into real effects (file write → git PR →
  db mutation → deployment, in that build order per [ROADMAP.md](ROADMAP.md)).
- **Permissions:** execute exactly one approval row at a time through the
  single choke point `executeApprovedAction()`; must re-read the row and
  re-verify `payload_sha256` + expiry before acting; sandboxed to the approved
  workspace path (file writes) or branch+PR only (git).
- **Inputs:** an `approved`, unexpired approval row — nothing else. Never raw
  model output.
- **Outputs:** the effect + a rollback record + before/after audit events.
- **Escalation conditions:** hash mismatch, expiry, path escape attempt, any
  partial failure ⇒ abort + audit + Owner notification. No retry without a
  fresh approval.
- **Human approval required for:** every single execution (the approval *is*
  the input). Dry-run preview shown before the approve button is live.

### B2. Research Agent

- **Purpose:** produce sourced research briefs as candidate project memory.
- **Permissions:** read: brief + approved context; write: artifacts +
  `pending` context items only — research never enters prompts without Owner
  approval (quarantine pattern).
- **Escalation:** conflicting sources or paywalled/legal-risk content ⇒
  surface, don't summarize around it.
- **Approval:** promotion of any output to approved context.

### B3. Cost Auditor Agent

- **Purpose:** periodic (scheduled) review of `usage_events` vs. pricing table
  vs. vendor invoices; drift detection.
- **Permissions:** read-only over usage/pricing within each project
  separately; write: a report artifact per project. Never mutates limits.
- **Escalation:** any per-task cost anomaly > configurable threshold; any
  pricing-table/invoice mismatch ⇒ Owner report flagged urgent.
- **Approval:** none needed for reports; any recommended limit change is an
  Owner decision.

### B4. MCP Client Agents (Phase 5)

- **Purpose:** external AI clients driving the hub over Model Context Protocol.
- **Permissions:** per-client token scoped to **one project**, revocable,
  hashed at rest; the token's project boundary is absolute. Tools mirror the
  UI surface: create/read tasks, read usage — proposals land in the same
  approval queue with no bypass ([ROADMAP.md](ROADMAP.md) Phase 5 exit
  criterion).
- **Escalation:** rate/budget denial behaves exactly as for the UI; repeated
  denials surface in audit.
- **Approval:** identical to any in-product agent — external origin grants
  nothing extra.

### B5. Coordinator Agent (product surface for the [TEAM.md](TEAM.md) role)

- **Purpose:** maintain the Objective→Milestone→Task tree
  ([OBJECTIVES.md](OBJECTIVES.md)); propose decompositions and sequencing.
- **Permissions:** read: objective tree + task statuses per project; write:
  *proposed* decompositions (pending Owner approval), status rollups.
- **Escalation:** priority conflicts, blocked > 48 h, budget-pressure
  reprioritization.
- **Approval:** all decompositions and priority changes are Owner-approved;
  the agent never activates an objective itself.

---

## Compliance checklist for adding any agent (current or future)

1. Catalog entry written **before** first run (this file).
2. Permissions expressed as read/write/execute against named tables or
   surfaces — "execute: nothing" unless it is B1.
3. Escalation conditions concrete and testable.
4. Approval requirements named per output class.
5. Prompt (if in-product) includes the shared safety rules
   ([HANDOFF.md](HANDOFF.md) §15) — non-negotiable.
6. Tenancy: the agent's entire read surface is single-project (I1).
7. Bounds: token cap, timeout, and budget participation stated.

## Future considerations

- **Per-agent identity in audit:** today audit attributes to provider + agent
  id; future agents (esp. B1/B4) should log a distinct principal per instance.
- **Capability manifests:** when [PLUGIN_SDK.md](PLUGIN_SDK.md) lands,
  third-party tools declare capabilities in the same
  read/write/execute/escalate vocabulary as this catalog — one language for
  first- and third-party agents.
- **Retirement:** removing an agent keeps its catalog entry marked
  *retired* (history must stay interpretable against the audit log).

## Related documents

[TEAM.md](TEAM.md) · [WORKFLOW.md](WORKFLOW.md) · [SECURITY.md](SECURITY.md)
§3–4 · [HANDOFF.md](HANDOFF.md) §15 · [ROADMAP.md](ROADMAP.md) Phases 3/5 ·
[PLUGIN_SDK.md](PLUGIN_SDK.md)
