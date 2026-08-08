# Real isolated file-write executor: next owner gate

> **NO REAL FILESYSTEM WRITE CAPABILITY EXISTS**

## Repository-only capabilities now implemented

- Durable tenant-scoped lifecycle storage and RLS.
- Canonical path and sensitive-target policy.
- Mockable symlink, junction, reparse, hard-link, special-file, and identity policy.
- Exact UTF-8 `create`/`replace` action contract with a 256 KiB byte limit.
- Ten-minute, single-use, payload/path/actor/workspace-bound confirmation identity.
- Fail-closed lifecycle transitions and mock reconciliation.
- Four-layer OFF-by-default enablement plus emergency kill-switch policy.
- Sandbox interfaces, in-memory fake, atomic-write design state machine, and consolidated adversarial tests.

## Not implemented

- Actual write syscalls, temporary files, rename/replace, chmod, links, or directory creation.
- A real container or microVM, mounted workspace, helper process, or network policy.
- Live executor registration, configuration, secrets, enablement, staging, or production rollout.

## Sandbox technology decision

1. **Firecracker microVM + jailer (recommended).** KVM-backed per-execution microVM, minimal device model, REST control API, resource rate limiting, and jailer defense in depth. Strongest option for a future multi-tenant write boundary; highest host/kernel/image operational cost. Primary source: [Firecracker](https://firecracker-microvm.github.io/).
2. **gVisor `runsc`.** User-space kernel/sentry boundary with its own networking stack. Lower operational cost than microVMs and stronger syscall mediation than ordinary containers, but a different isolation model and compatibility surface. Primary sources: [gVisor architecture](https://gvisor.dev/docs/architecture_guide/) and [resource model](https://gvisor.dev/docs/architecture_guide/resources/).
3. **Rootless OCI container with seccomp.** Easiest operational path, using non-root daemon/container user namespaces and a restrictive syscall allowlist. Lowest recommended isolation tier for untrusted executor payloads. Primary sources: [Docker rootless mode](https://docs.docker.com/engine/security/rootless/) and [seccomp profiles](https://docs.docker.com/engine/security/seccomp/).

Recommendation: approve a disposable Linux Firecracker microVM proof in an isolated, non-production rehearsal environment. Keep gVisor as the fallback if KVM operations are unavailable. Do not approve ordinary rootless OCI as the production trust boundary without a separate security review.

## Proposed limits and isolation

- One execution per fresh microVM; 1 vCPU, 128 MiB memory, 15-second wall timeout, 2 CPU-seconds, and 64 KiB combined structured output.
- No network device; read-only root image pinned by digest; no credentials or metadata service available to the guest.
- One explicitly identified `/workspace` volume; no host root or control socket; non-root guest UID; minimal capabilities.
- Kill means stop the microVM, preserve only bounded lifecycle/evidence records, detach/quarantine the workspace, then destroy ephemeral resources. Cleanup failure becomes reconciliation-required.

## Real filesystem and atomic implementation proposal

The future Linux helper should walk components descriptor-relatively with `openat2` containment/no-link/no-mount-crossing constraints, verify `statx` identity/type/link count, and retain parent descriptors. It should create a restricted same-directory temporary inode/name, write exact approved bytes, verify SHA-256, meet file durability requirements, re-check parent/target identity and precondition, perform descriptor-relative atomic rename/replace, fsync the directory, and verify the final hash. Unknown support or evidence must deny.

Lifecycle interaction order: persist intent and claim; record sandbox/mount identity and lease; checkpoint before possible side effect; checkpoint after atomic commit; verify final evidence; persist terminal result. Crash after possible commit or failure to persist a result becomes ambiguous and is reconciled from independent evidence. Never retry an ambiguous write automatically.

## Rehearsal and rollout

1. Implement the real adapter and Linux helper behind compile-time/runtime registration that remains absent by default.
2. Run unit, fuzz, race, fault-injection, image-scan, escape, resource-exhaustion, cleanup, and crash-point tests in disposable infrastructure.
3. Rehearse create/replace against synthetic workspaces with no secrets or production data.
4. Prove kill switch, all four enablement layers, lifecycle persistence, and reconciliation under process/VM loss.
5. Conduct security review and owner GO/NO-GO. Any later rollout remains OFF by default and progresses disposable → isolated staging → one allowlisted workspace only under a separate authorization.

## Exact future side-effecting code paths requiring approval

- `src/infrastructure/executors/firecracker-sandbox.ts`: microVM create/start/stop/destroy and volume attachment.
- `src/infrastructure/executors/linux-file-write-helper/`: descriptor inspection, temporary-byte staging, fsync, rename/replace, and cleanup.
- `src/domain/execution/file-write-executor.ts`: lifecycle orchestration invoking the real sandbox adapter.
- Runtime executor registry/configuration and operational kill-switch source.

Creating any of those paths—or wiring current interfaces to a real adapter—requires the next explicit owner authorization.
