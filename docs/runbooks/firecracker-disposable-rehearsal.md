# Disposable Firecracker rehearsal package

**Status:** preparation only; launch requires the next owner authorization.

## Host gate

Use a dedicated disposable Linux host with working KVM access. It must contain no staging/production credentials, customer data, Hub repository mount, home-directory mount, SSH keys, cloud credentials, or network path from the guest. Firecracker, the kernel, rootfs, and guest entrypoint must come from trusted pinned releases/builds with recorded SHA-256 digests.

Run `KING_REHEARSAL_DISPOSABLE=true scripts/firecracker/check-host-readiness.sh`. This read-only checker launches nothing. A passing result is necessary but not sufficient; record the host image identity, kernel version, Firecracker version, executing user, `/dev/kvm` ownership/mode, and the explicit owner authorization.

## Artifact preparation

1. Build or obtain a minimal Linux kernel and read-only rootfs compatible with the pinned Firecracker release. The rootfs contains only the fixed `/sbin/king-file-write-v1` entrypoint and its runtime dependencies; it contains no shell, package manager, SSH service, credentials, or Hub application source.
2. Record and independently verify the kernel, rootfs, and entrypoint SHA-256 digests in an evidence copy of `config/firecracker/guest-entrypoint.manifest.json`. Do not commit populated host paths or credentials.
3. Materialize `tests/fixtures/firecracker/synthetic-workspace.json` into a new disposable filesystem image. Never use the repository directory as the workspace backing path.
4. Resolve the three path placeholders in `config/firecracker/rehearsal-machine.template.json` in an untracked, host-local copy. The API configuration must retain an empty `network-interfaces` list, read-only rootfs, and exactly one writable synthetic workspace drive.

## Disposable database

Create a brand-new PostgreSQL instance/database whose URL is supplied only through the approved test process. It must contain no persistent local, staging, production, or customer data. Apply the normal repository bootstrap through migration `0058`, verify the migration manifest, run lifecycle/RLS integration tests, capture redacted results, and destroy the database after evidence capture. Do not place its URL in files, command history, logs, screenshots, or evidence.

Required database evidence: fresh bootstrap success, endpoint/count, executor lifecycle constraints, tenant RLS denial, reconciliation state transitions, and confirmation/idempotency consumption. Database-profile evidence does not prove Firecracker execution.

## Rehearsal command sequence

The exact launch and write commands are intentionally absent until the launch gate is approved. The next authorization must identify the disposable host and authorize: Firecracker launch; synthetic workspace attachment; isolated create and preconditioned replace; crash/fault injection; traversal/link escape attempts; lifecycle persistence and reconciliation; kill-switch behavior; and teardown.

Before that authorization, only run the host checker, JSON/template tests, checksums, and read-only inspection. Do not start Firecracker, create a VM API socket, invoke the guest entrypoint, or mutate the synthetic workspace.

## Teardown procedure

After an authorized rehearsal: stop and destroy the microVM; delete its API socket and ephemeral runtime directory; destroy the synthetic workspace image and disposable database; remove untracked rendered configurations; verify no process, mount, network namespace, credential, or execution lease remains; retain only redacted hashes, logs, test conclusions, and lifecycle evidence under the approved retention policy.

## Evidence checklist

- Owner authorization and disposable-host identity
- Linux/kernel, KVM access, executing user, and Firecracker version
- Trusted-source references and SHA-256 for Firecracker, kernel, rootfs, and entrypoint
- Machine configuration proving no network, read-only rootfs, and one synthetic workspace
- Resource-limit and zero-retry evidence
- Synthetic fixture identity and pre/post hashes
- Create, replace, precondition-conflict, traversal, symlink, hard-link, and mount-escape conclusions
- Crash-before-write, crash-after-commit, ambiguity, reconciliation, and kill-switch conclusions
- Lifecycle/RLS database conclusions and migration endpoint/count
- Teardown proof and confirmation that staging, production, credentials, customer data, and the Hub repository were untouched
