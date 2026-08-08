import { describe, expect, it } from 'vitest';
import { canonicalizeFileWriteAction, FILE_WRITE_MAX_PAYLOAD_BYTES, sha256Utf8 } from '@/domain/execution/file-write-action';

describe('canonical file-write action contract', () => {
  it.each(['append', 'delete', 'rename', 'move', 'chmod', 'mkdir', 'symlink'])('rejects unsupported operation %s', (operation) => {
    expect(canonicalizeFileWriteAction({ operation, target: 'plans/a.md', payload: 'x' }).allowed).toBe(false);
  });
  it('accepts create and empty exact UTF-8 bytes', () => {
    const result = canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.md', payload: '' });
    expect(result).toMatchObject({ allowed: true, action: { payloadBytes: 0, expectedCurrentSha256: null, payloadSha256: sha256Utf8('') } });
  });
  it('requires replace precondition and exact desired hash', () => {
    expect(canonicalizeFileWriteAction({ operation: 'replace', target: 'plans/a.md', payload: 'x' }).allowed).toBe(false);
    const hash = sha256Utf8('old');
    expect(canonicalizeFileWriteAction({ operation: 'replace', target: 'plans/a.md', payload: 'new', expectedCurrentSha256: hash }).allowed).toBe(true);
    expect(canonicalizeFileWriteAction({ operation: 'replace', target: 'plans/a.md', payload: 'new', expectedCurrentSha256: 'A'.repeat(64) }).allowed).toBe(false);
    expect(canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.md', payload: 'x', desiredPostconditionSha256: '0'.repeat(64) }).allowed).toBe(false);
  });
  it('enforces 256 KiB by UTF-8 bytes and rejects binary intent', () => {
    expect(canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.txt', payload: 'a'.repeat(FILE_WRITE_MAX_PAYLOAD_BYTES) }).allowed).toBe(true);
    expect(canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.txt', payload: `${'a'.repeat(FILE_WRITE_MAX_PAYLOAD_BYTES)}b` }).allowed).toBe(false);
    expect(canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.txt', payload: 'é'.repeat(FILE_WRITE_MAX_PAYLOAD_BYTES / 2) }).allowed).toBe(true);
    expect(canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.txt', payload: '\0binary' }).allowed).toBe(false);
    expect(canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.txt', payload: '\ud800' }).allowed).toBe(false);
  });
  it('does not trim or normalize newline bytes', () => {
    expect(sha256Utf8('x\n')).not.toBe(sha256Utf8('x\r\n'));
    expect(sha256Utf8(' x ')).not.toBe(sha256Utf8('x'));
  });
});
