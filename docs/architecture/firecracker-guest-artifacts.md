# Firecracker guest artifact provenance

This package prepares—but does not authorize—the synthetic `king-file-write-v1` rehearsal. Repository proof is not host-readiness proof, artifact proof, a disposable Firecracker rehearsal, live executor authorization, or production authorization.

## Exact pins

- Firecracker: `v1.16.1`, tag commit `2038188f145fb81b8d098147a10e9d9f392fd22f`, x86_64 release archive SHA-256 `382a02a869e4d6d5cb14c40577f9545e8458021ea8b0b2d3fc10ec14d9c242e6`.
- Guest kernel repository: `https://github.com/amazonlinux/linux.git`.
- Guest kernel tag: `microvm-kernel-6.18.25-57.115.amzn2023`.
- Tag object: `239ab80f9197c3f77f0530e51aecf5f471d03a8b`.
- Dereferenced source commit: `003a7905ac5f07e7f0e213951258d5bb80ea31e5`.
- Tag signature observation: signed, but GitHub reports the signing key as unknown; this is recorded evidence, not a verified trust claim.
- Kernel configuration: repository-owned `config/firecracker/kernel-x86_64-6.18.fragment`; its hash is pinned in the acquisition manifest.

Firecracker 1.16.1 supports Linux 6.18 guests. The fragment makes VirtIO-MMIO block, ext4, devtmpfs, AF_ALG/SHA-256, seccomp, and required x86_64 boot support built in. Modules and guest networking/vsock are disabled.

## Deferred authorized build

`scripts/firecracker/build-guest-artifacts.sh` is fail-closed unless a later owner gate sets `KING_ARTIFACT_BUILD_AUTHORIZED=true` and supplies the exact acquired kernel commit plus a disposable output directory outside both the repository and the user's home. It does not acquire artifacts.

The rootfs is a 32 MiB ext4 image built from scratch with no runtime packages, shell, package manager, SSH, network configuration, secrets, or host/repository mount. PID 1 clears the environment, mounts `/dev/vdb` at `/workspace` as `rw,nodev,nosuid,noexec`, runs the worker as UID/GID 10000, applies the ten-second wall limit, syncs/unmounts, and shuts down.

Actual Firecracker, jailer, helper binary, kernel, generated kernel configuration, and rootfs hashes remain pending until separately authorized acquisition/build. Any pending execution-critical hash keeps execution blocked.
