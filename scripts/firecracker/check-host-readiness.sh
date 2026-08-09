#!/usr/bin/env bash
set -eu

failures=0

check() {
  if "$@" >/dev/null 2>&1; then
    printf 'PASS %s\n' "$1"
  else
    printf 'FAIL %s\n' "$1" >&2
    failures=$((failures + 1))
  fi
}

check uname -s
if [ "$(uname -s 2>/dev/null || true)" != "Linux" ]; then
  printf 'FAIL Linux kernel required\n' >&2
  failures=$((failures + 1))
else
  printf 'PASS Linux kernel\n'
fi

if [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  printf 'PASS /dev/kvm is accessible\n'
else
  printf 'FAIL /dev/kvm must be a readable and writable character device\n' >&2
  failures=$((failures + 1))
fi

if command -v firecracker >/dev/null 2>&1; then
  printf 'PASS Firecracker binary found\n'
  firecracker --version
else
  printf 'FAIL Firecracker binary not found on PATH\n' >&2
  failures=$((failures + 1))
fi

if [ "${KING_REHEARSAL_DISPOSABLE:-}" = "true" ]; then
  printf 'PASS disposable-environment acknowledgement present\n'
else
  printf 'FAIL set KING_REHEARSAL_DISPOSABLE=true only on the approved disposable host\n' >&2
  failures=$((failures + 1))
fi

if [ -n "${AWS_ACCESS_KEY_ID:-}${AWS_SECRET_ACCESS_KEY:-}${GOOGLE_APPLICATION_CREDENTIALS:-}${AZURE_CLIENT_SECRET:-}" ]; then
  printf 'FAIL cloud credential environment variables detected\n' >&2
  failures=$((failures + 1))
else
  printf 'PASS no common cloud credential variables detected\n'
fi

if [ "$failures" -ne 0 ]; then
  printf 'NOT READY: %s requirement(s) failed\n' "$failures" >&2
  exit 1
fi

printf 'READY FOR OWNER-APPROVED REHEARSAL (this checker launches nothing)\n'
