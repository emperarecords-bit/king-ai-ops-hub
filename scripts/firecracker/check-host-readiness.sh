#!/usr/bin/env bash
set -u

# Discovery and hashing only. This script must never execute Firecracker,
# jailer, a guest kernel, a rootfs, or the guest entrypoint.
failures=0

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

if [ "$(uname -s 2>/dev/null || true)" = "Linux" ]; then
  pass 'Linux kernel'
else
  fail 'Linux kernel required'
fi

architecture="$(uname -m 2>/dev/null || true)"
case "$architecture" in
  x86_64|aarch64) pass "supported architecture: $architecture" ;;
  *) fail "unsupported architecture: ${architecture:-unknown}" ;;
esac

if [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  pass '/dev/kvm is a readable and writable character device'
else
  fail '/dev/kvm must be a readable and writable character device'
fi

if [ "$architecture" = 'x86_64' ]; then
  if grep -Eqm1 '(vmx|svm)' /proc/cpuinfo 2>/dev/null; then
    pass 'CPU virtualization flag is present'
  else
    fail 'CPU virtualization flag vmx/svm is absent'
  fi
fi

if grep -Eq '^kvm(_intel|_amd)? ' /proc/modules 2>/dev/null; then
  pass 'KVM module is loaded'
else
  fail 'KVM module is not visible in /proc/modules'
fi

for tool in sha256sum readlink stat findmnt jq grep sed awk tr; do
  if command -v "$tool" >/dev/null 2>&1; then pass "required tool: $tool"; else fail "missing required tool: $tool"; fi
done

if [ "${KING_REHEARSAL_DISPOSABLE:-}" = 'true' ]; then
  pass 'disposable-environment acknowledgement present'
else
  fail 'set KING_REHEARSAL_DISPOSABLE=true only on the approved disposable host'
fi

credential_names="$(compgen -e | grep -Ei '(^|_)(AWS|AZURE|GOOGLE|SSH|TOKEN|SECRET|PASSWORD|DATABASE_URL|FLY|TIGRIS|SUPABASE|OPENAI|ANTHROPIC)(_|$)' || true)"
if [ -n "$credential_names" ]; then
  fail 'credential-related environment variable names detected (values suppressed)'
  printf '%s\n' "$credential_names" | sed 's/^/  NAME /' >&2
else
  pass 'no credential-related environment variable names detected'
fi

discover_path() {
  label="$1"
  configured_path="$2"
  command_name="$3"
  if [ -n "$configured_path" ]; then
    printf '%s' "$configured_path"
  else
    command -v "$command_name" 2>/dev/null || true
  fi
}

hash_artifact() {
  label="$1"
  artifact_path="$2"
  expected_hash="$3"
  if [ -z "$artifact_path" ] || [ ! -f "$artifact_path" ]; then
    fail "$label artifact not found"
    return
  fi

  resolved_path="$(readlink -f "$artifact_path" 2>/dev/null || true)"
  if [ -z "$resolved_path" ]; then
    fail "$label artifact path cannot be resolved"
    return
  fi
  case "$resolved_path" in
    "$PWD"|"$PWD"/*|"${HOME:-/__no_home__}"|"${HOME:-/__no_home__}"/*)
      fail "$label artifact must not be stored in the repository or home directory"
      return
      ;;
  esac

  actual_hash="$(sha256sum "$resolved_path" | awk '{print $1}')"
  printf 'ARTIFACT %s PATH %s\n' "$label" "$resolved_path"
  printf 'ARTIFACT %s SHA256 %s\n' "$label" "$actual_hash"
  if ! printf '%s' "$expected_hash" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    fail "$label expected SHA-256 is missing or invalid"
  elif [ "$(printf '%s' "$expected_hash" | tr 'A-F' 'a-f')" = "$actual_hash" ]; then
    pass "$label SHA-256 matches the owner-approved pin"
  else
    fail "$label SHA-256 does not match the owner-approved pin"
  fi
}

firecracker_path="$(discover_path firecracker "${KING_FIRECRACKER_PATH:-}" firecracker)"
jailer_path="$(discover_path jailer "${KING_JAILER_PATH:-}" jailer)"

hash_artifact firecracker "$firecracker_path" "${KING_FIRECRACKER_EXPECTED_SHA256:-}"
hash_artifact jailer "$jailer_path" "${KING_JAILER_EXPECTED_SHA256:-}"
hash_artifact kernel "${KING_KERNEL_PATH:-}" "${KING_KERNEL_EXPECTED_SHA256:-}"
hash_artifact rootfs "${KING_ROOTFS_PATH:-}" "${KING_ROOTFS_EXPECTED_SHA256:-}"
hash_artifact entrypoint "${KING_ENTRYPOINT_PATH:-}" "${KING_ENTRYPOINT_EXPECTED_SHA256:-}"

workspace_path="${KING_SYNTHETIC_WORKSPACE_PATH:-}"
case "$workspace_path" in
  /*)
    case "$workspace_path" in
      "$PWD"|"$PWD"/*|"${HOME:-/__no_home__}"|"${HOME:-/__no_home__}"/*)
        fail 'synthetic workspace path must be outside the repository and home directory'
        ;;
      *) pass 'synthetic workspace path is absolute and outside repository/home' ;;
    esac
    ;;
  *) fail 'KING_SYNTHETIC_WORKSPACE_PATH must be an absolute future path' ;;
esac

if [ "$failures" -ne 0 ]; then
  printf 'BLOCKED: %s readiness requirement(s) failed\n' "$failures" >&2
  exit 1
fi

printf 'READY FOR OWNER ARTIFACT-PIN REVIEW (nothing was executed or launched)\n'
