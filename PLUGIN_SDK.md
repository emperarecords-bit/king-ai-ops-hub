# Plugin SDK — Integration Specification

> **Status: SPECIFICATION ONLY.** Nothing in this document is implemented.
> Target: Phase 5+ ([ROADMAP.md](ROADMAP.md)). Any implementation sprint must
> treat this as the requirements document and [SECURITY.md](SECURITY.md) as its
> review checklist.

## Purpose

Defines how third parties (and our own future modules) extend King AI
Operations Hub with new **AI providers** and new **tools** — without weakening
any invariant. The SDK's design goal in one line: *a plugin can add
capability; a plugin can never add authority.*

## Scope

Covers the provider interface, tool interface, authentication, versioning,
events, security and approval requirements, and worked examples. Excludes UI
extension points and marketplace/distribution (future considerations).

## Definitions

| Term | Meaning |
|---|---|
| **Provider plugin** | An adapter adding a new model vendor behind the existing `AIProvider` contract. |
| **Tool plugin** | A capability an agent may *invoke for information* or *propose an action against* (e.g., GitHub, a database, a search API). |
| **Capability manifest** | The plugin's signed declaration of everything it can read/write/propose — the [AGENT_CATALOG.md](AGENT_CATALOG.md) vocabulary, machine-readable. |
| **Host** | The platform runtime that loads, sandboxes, and mediates every plugin call. |

## Design principles (inherited, non-negotiable)

1. Plugins run **server-side only**; nothing plugin-related reaches the
   browser except rendered results (I2).
2. Every plugin call is **tenant-scoped**: the host injects the
   `TenantContext`; a plugin never chooses its tenant (I1).
3. Tool *reads* return data; tool *writes* are **proposals** that land in the
   approval queue like any model proposal (I4; [SECURITY.md](SECURITY.md) §4).
   A plugin cannot execute a consequential action — only a Phase-3 executor,
   acting on an approved row, calls a plugin's `execute` entry point.
4. All plugin output is **untrusted input** (I3): schema-validated by the
   host, size-capped, and wrapped as untrusted content if it enters a prompt.
5. Plugins are **bounded**: per-call timeout, rate limit, and (for providers)
   participation in the budget gate (I5, I8).

## 1. AI provider interface

The contract is the existing one — new vendors implement it, verbatim, from
`src/types/provider.ts` (authoritative source; excerpt):

```ts
interface AIProvider {
  readonly id: ProviderId;                    // extended to a registered string id
  execute(request: AgentRequest): Promise<AgentResponse>;
  stream?(request: AgentRequest): AsyncIterable<AgentEvent>;
  estimateCost?(model: string, usage: TokenUsage): Money;   // integer USD micros
  listModels(): readonly ModelDescriptor[];
}
```

Additional SDK requirements for third-party providers:

- **Error taxonomy compliance:** all failures must map to `ProviderError`
  kinds (`rate_limited | timeout | invalid_request | auth | overloaded |
  unknown`) — the engine's retry policy is vendor-agnostic and must stay so.
- **Pricing declaration:** a provider ships a pricing table fragment
  (micros per million tokens, versioned). Unknown models bill at the
  provider's declared ceiling — fail-expensive is host-enforced.
- **No self-retry:** `maxRetries: 0` semantics; retries belong to the engine
  uniformly (see D-003 discussion and current adapters).
- **Usage honesty:** `AgentResponse.usage` must reflect vendor-metered tokens;
  the host cross-checks against declared context limits.

## 2. Tool interface

```ts
interface ToolPlugin {
  readonly manifest: CapabilityManifest;

  /** Read-only operations: return data, never side effects. */
  read(call: ToolCall, ctx: HostContext): Promise<ToolResult>;

  /** Validate a PROPOSED action payload (schema + plugin-specific checks).
      Called at proposal time; never causes effects. */
  validateProposal(action: ProposedToolAction, ctx: HostContext): Promise<ValidationResult>;

  /** Execute ONE approved action. Callable ONLY by the Phase-3 executor path,
      which has already re-verified approval status, expiry, and payload hash. */
  execute(approved: ApprovedAction, ctx: HostContext): Promise<ExecutionResult>;

  /** Best-effort compensation for a prior execute; recorded, not guaranteed. */
  rollback?(executed: ExecutionResult, ctx: HostContext): Promise<RollbackResult>;
}

interface CapabilityManifest {
  name: string;                 // unique, e.g. "github"
  version: string;              // semver of the plugin
  sdkVersion: string;           // semver range of SDK compatibility
  reads: CapabilityDecl[];      // e.g. { surface: "repo.file", constraints: {...} }
  proposals: ActionTypeDecl[];  // MUST map into the platform's closed action enum
  secretsRequired: SecretDecl[];// names only; values via host secret store
  limits: { timeoutMs: number; maxPayloadBytes: number; ratePerMinute: number };
}
```

Key rules:

- **`proposals` map into the existing closed action enum** (`file_write`,
  `git_pr`, `email_send`, …). A tool cannot invent a new consequential action
  type; extending the enum is a platform (not plugin) change with its own
  security review — exactly as [SECURITY.md](SECURITY.md) §4 requires today.
- **`read` results are size-capped** by the manifest and host (default
  ≤ 64 KB) and always enter prompts wrapped as untrusted content.
- **`execute` is unreachable** except through the executor choke point; the
  SDK ships no public API to call it.

## 3. Authentication

- **Plugin ↔ external service:** credentials come exclusively from the
  platform's encrypted secret store (`integration_secrets` — AES-256-GCM,
  per-project; [HANDOFF.md](HANDOFF.md) §5). The manifest names required
  secrets; the host injects decrypted values into the call context at
  invocation and never persists them plugin-side. Plugins never see another
  project's secrets (tenant scoping applies to secrets like everything else).
- **External client ↔ platform (MCP, Phase 5):** per-client API tokens,
  scoped to a single project, revocable, stored hashed — see
  [ROADMAP.md](ROADMAP.md) Phase 5 and [AGENT_CATALOG.md](AGENT_CATALOG.md) B4.
- **Plugin identity:** each installed plugin instance is a named principal in
  the audit log (`plugin:github@1.2.0`), so every read, proposal, and
  execution is attributable.

## 4. Versioning

- **SDK versions are semver.** Breaking interface changes bump major; the host
  refuses a plugin whose `sdkVersion` range excludes the running SDK.
- **Plugin versions are semver**; the manifest version is recorded on every
  audit event the plugin touches, so history stays interpretable after
  upgrades (same philosophy as `pricing_version` on `usage_events`).
- **Manifest changes are upgrades:** any change to `reads`/`proposals` — even
  additive — requires re-approval by the Owner at upgrade time (capability
  creep is the threat).

## 5. Event model

Plugins observe; they do not command. The host emits a typed, ordered event
stream per project (backed by the audit trail — no second history system):

```
task.created | run.started | run.step.completed | run.completed | run.failed
approval.requested | approval.decided | approval.expired
artifact.created | usage.recorded | plugin.action.executed
```

- **Delivery:** at-least-once, per-project ordering, cursor-based replay.
- **Payloads:** reference ids + minimal metadata; a plugin wanting content must
  `read` it through its manifest-declared surface (no fat events smuggling
  data past capability checks).
- **Subscriptions are manifest-declared** and Owner-approved like any other
  capability.
- **No synchronous hooks:** a plugin cannot block or veto a platform
  transition (that would hand it authority). It reacts after the fact or
  proposes actions.

## 6. Security requirements

Checklist a plugin must pass before install (extends
[SECURITY.md](SECURITY.md); the tenancy and injection threats T1/T2 apply to
plugins verbatim):

1. Runs in the host sandbox: no ambient filesystem, network only to
   manifest-declared hosts, no process spawn.
2. All inputs it emits toward prompts are treated as injection sources
   (host-wrapped; the plugin cannot opt out).
3. Secrets: names in manifest, values only via host injection, never logged —
   the host's redacting logger wraps plugin log output too.
4. Resource bounds from the manifest are host-enforced (timeout, payload,
   rate) — a plugin cannot raise its own limits at runtime.
5. Tenant proof: an install is scoped to specific project(s); the SDK's test
   kit includes a mandatory cross-tenant denial test (mirror of
   `tenancy.test.ts`).
6. Supply chain: plugins are content-hashed at install; the hash is recorded
   in the audit log; changed bytes ⇒ re-approval.

## 7. Approval requirements

| Plugin event | Approval needed |
|---|---|
| Install / upgrade / capability change | Owner, explicit, audited |
| Read within declared surface | None (that's what install approved) |
| Any proposal | Standard approval queue — human decision per action (I4) |
| Execution | Only via Phase-3 executor path over an `approved` row |
| New secret required | Owner enters it via Provider Settings (platform never asks the plugin to collect credentials) |

## 8. Example implementations (illustrative only)

**A. Provider plugin — "Mistral" (hypothetical):** implements `AIProvider`;
maps Mistral SDK errors onto the six error kinds; declares pricing fragment
(e.g., input 250 000 micros/M); ships model descriptors with output caps.
~200 lines by analogy with `src/providers/openai.ts`. Passes: engine tests
with the fake-provider suite pattern, pricing fail-expensive test.

**B. Tool plugin — "GitHub":**

```jsonc
// manifest (abridged)
{
  "name": "github", "version": "1.0.0", "sdkVersion": "^1.0",
  "reads": [{ "surface": "repo.tree" }, { "surface": "repo.file", "constraints": { "maxBytes": 65536 } }],
  "proposals": [{ "actionType": "git_pr" }, { "actionType": "git_commit" }],
  "secretsRequired": [{ "name": "github_app_token" }],
  "limits": { "timeoutMs": 15000, "maxPayloadBytes": 65536, "ratePerMinute": 30 }
}
```

Flow: an agent's task references repo context → host calls `read(repo.file)` →
content returns wrapped as untrusted → model proposes `git_pr` → proposal
validated by `validateProposal` (branch naming, no default-branch push —
[ROADMAP.md](ROADMAP.md) Phase 6 rule) → Owner approves → executor calls
`execute` → PR opened, URL recorded, rollback record = close-PR handle,
audit events on both sides.

**C. Event consumer — "Slack notifier":** manifest declares subscription to
`approval.requested`; on event, posts "1 approval waiting in AccurateBids"
with a deep link. Note: posting to Slack is itself outward communication — the
notifier's install approval covers this exact, fixed message shape; free-form
outbound content would instead require `email_send`/`social_publish`-class
proposals.

## Future considerations

- **Marketplace & signing chain** (publisher identity, review tiers) — Year
  4–5 ([PRODUCT_VISION.md](PRODUCT_VISION.md)).
- **UI extension points** (custom artifact viewers) — explicitly out of scope
  until the security story for third-party frontend code exists; CSP currently
  forbids it wholesale, which is the right default.
- **Wasm sandboxing** as the plugin runtime is the leading candidate; decision
  record required at implementation time.
- **Extending the action enum** for genuinely new action classes (e.g.,
  `calendar_write`): platform-level change, security review, new executor —
  never a plugin-level addition.

## Related documents

[SECURITY.md](SECURITY.md) · [ARCHITECTURE.md](ARCHITECTURE.md) §5 ·
[AGENT_CATALOG.md](AGENT_CATALOG.md) · [ROADMAP.md](ROADMAP.md) Phases 3/5/6 ·
[DECISIONS.md](DECISIONS.md) D-003/D-004 · [HANDOFF.md](HANDOFF.md) §5–6
