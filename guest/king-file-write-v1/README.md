# `king-file-write-v1`

Linux-only, fixed-purpose guest PID 1 for the synthetic Firecracker rehearsal. It has no network or command-execution interface. Production compilation omits the test workspace override.

Invocation contract: `king-file-write-v1 create <relative-target> absent <desired-sha256>` or `king-file-write-v1 replace <relative-target> <expected-sha256> <desired-sha256>`. Exact canonical UTF-8/LF payload bytes arrive on stdin, are limited to 262,144 bytes, and must match the desired hash before installation. Output is one bounded JSON result line; exit `0` means verified success, `2` blocked, `3` definitely failed before a proven install, `4` ambiguous, and `124` timed out.

PID 1 clears the environment, mounts ext4 `/dev/vdb` at `/workspace` with `nodev,nosuid,noexec`, verifies the filesystem, forks a UID/GID 10000 worker, reaps it, syncs/unmounts, and requests Firecracker termination through reboot. The worker uses `openat2` beneath/no-symlink/no-cross-device resolution, `O_NOFOLLOW`, regular-file/single-link identity checks, a same-directory exclusive temporary file, `fsync`, identity recheck, and `renameat2` atomic installation. It performs zero retries.

The build is intentionally deferred. The later authorized build must use the pinned musl toolchain from `rootfs-build.json` and compile statically with `-O2 -static -D_FORTIFY_SOURCE=2 -fstack-protector-strong -Wl,-z,relro,-z,now -Wall -Wextra -Werror`. Tests may additionally define `KING_FILE_WRITE_TESTING`; rehearsal artifacts must not.
