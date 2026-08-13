#!/usr/bin/env bash
set -euo pipefail

# This script is a deferred, repository-owned recipe. Running it requires the
# separate artifact-build authorization and pre-acquired, hash-approved inputs.
: "${KING_ARTIFACT_BUILD_AUTHORIZED:?explicit artifact-build authorization required}"
[ "$KING_ARTIFACT_BUILD_AUTHORIZED" = 'true' ] || { echo 'BLOCKED: authorization must equal true' >&2; exit 2; }
: "${KING_KERNEL_SOURCE_DIR:?approved kernel source directory required}"
: "${KING_BUILD_OUTPUT_DIR:?disposable output directory required}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
expected_commit='003a7905ac5f07e7f0e213951258d5bb80ea31e5'
actual_commit="$(git -C "$KING_KERNEL_SOURCE_DIR" rev-parse HEAD)"
[ "$actual_commit" = "$expected_commit" ] || { echo 'BLOCKED: kernel source commit mismatch' >&2; exit 2; }

case "$KING_BUILD_OUTPUT_DIR" in
  "$repo_root"|"$repo_root"/*|"${HOME:-/__no_home__}"|"${HOME:-/__no_home__}"/*)
    echo 'BLOCKED: output must be outside repository and home' >&2; exit 2 ;;
esac

for tool in make gcc musl-gcc mke2fs e2fsck sha256sum file readelf; do command -v "$tool" >/dev/null || { echo "BLOCKED: missing $tool" >&2; exit 2; }; done
mkdir -p "$KING_BUILD_OUTPUT_DIR/rootfs-tree/sbin"

musl-gcc -std=c17 -O2 -static -D_FORTIFY_SOURCE=2 -fstack-protector-strong -Wl,-z,relro,-z,now -Wall -Wextra -Werror \
  "$repo_root/guest/king-file-write-v1/king-file-write-v1.c" -o "$KING_BUILD_OUTPUT_DIR/king-file-write-v1"
file "$KING_BUILD_OUTPUT_DIR/king-file-write-v1" | grep -q 'statically linked'
if readelf -l "$KING_BUILD_OUTPUT_DIR/king-file-write-v1" | grep -q 'INTERP'; then echo 'BLOCKED: dynamic interpreter present' >&2; exit 2; fi
install -o 0 -g 0 -m 0555 "$KING_BUILD_OUTPUT_DIR/king-file-write-v1" "$KING_BUILD_OUTPUT_DIR/rootfs-tree/sbin/king-file-write-v1"
mkdir -p "$KING_BUILD_OUTPUT_DIR/rootfs-tree/dev" "$KING_BUILD_OUTPUT_DIR/rootfs-tree/proc" "$KING_BUILD_OUTPUT_DIR/rootfs-tree/run" "$KING_BUILD_OUTPUT_DIR/rootfs-tree/sys" "$KING_BUILD_OUTPUT_DIR/rootfs-tree/workspace"
find "$KING_BUILD_OUTPUT_DIR/rootfs-tree" -exec touch -h -d '@0' {} +

truncate -s 32M "$KING_BUILD_OUTPUT_DIR/rootfs.ext4"
E2FSPROGS_FAKE_TIME=0 SOURCE_DATE_EPOCH=0 mke2fs -q -t ext4 -F -U 00000000-0000-0000-0000-000000000001 -E lazy_itable_init=0,lazy_journal_init=0 -d "$KING_BUILD_OUTPUT_DIR/rootfs-tree" "$KING_BUILD_OUTPUT_DIR/rootfs.ext4"
e2fsck -fn "$KING_BUILD_OUTPUT_DIR/rootfs.ext4"

make -C "$KING_KERNEL_SOURCE_DIR" x86_64_defconfig
"$KING_KERNEL_SOURCE_DIR/scripts/kconfig/merge_config.sh" -m "$KING_KERNEL_SOURCE_DIR/.config" "$repo_root/config/firecracker/kernel-x86_64-6.18.fragment"
make -C "$KING_KERNEL_SOURCE_DIR" olddefconfig
make -C "$KING_KERNEL_SOURCE_DIR" -j1 vmlinux
cp "$KING_KERNEL_SOURCE_DIR/vmlinux" "$KING_BUILD_OUTPUT_DIR/vmlinux"

sha256sum "$KING_BUILD_OUTPUT_DIR/king-file-write-v1" "$KING_BUILD_OUTPUT_DIR/rootfs.ext4" "$KING_BUILD_OUTPUT_DIR/vmlinux" "$KING_KERNEL_SOURCE_DIR/.config"
