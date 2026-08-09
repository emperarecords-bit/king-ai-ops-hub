# Firecracker adapter readiness

**Status:** Contract-only; blocked from live rehearsal
**Date:** 2026-08-08

The `FirecrackerSandbox` adapter fixes the isolation boundary before a platform implementation exists. It requires Linux, KVM, and a Firecracker binary and fails closed when any capability is absent. It has no Docker, gVisor, child-process, or in-process fallback.

The machine contract permits one writable mount at `/workspace`, a read-only root filesystem, no network, no inherited environment, bounded resources, and the fixed `king-file-write-v1` entrypoint. The control-plane interface cannot accept an arbitrary command. Returned evidence must match both the sandbox and workspace-mount identities, output is bounded, and machine destruction is always requested.

This repository contains no Firecracker control-plane implementation, guest helper, VM image, descriptor-relative filesystem implementation, or executor registration. The adapter tests use a fake and perform no I/O.

The current Windows/WSL2 development host exposes neither `/dev/kvm` nor a Firecracker binary. Under the approved owner gate, live work must stop here until a disposable Linux KVM host is provided or a separate fallback is explicitly authorized. No container runtime may be silently substituted.
