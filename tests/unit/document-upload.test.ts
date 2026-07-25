import { describe, expect, it } from 'vitest';
import {
  classifyUpload,
  looksBinary,
  normalizeFilename,
  safeDecodeUtf8,
  UploadRejected,
} from '@/domain/documents/upload-validation';

/** O-23 upload validation & safety. */

describe('normalizeFilename', () => {
  it('strips directory components so traversal is neutralized to a basename', () => {
    expect(normalizeFilename('a/b/c/notes.md').filename).toBe('notes.md');
    expect(normalizeFilename('C:\\Users\\x\\notes.md').filename).toBe('notes.md');
    // Traversal paths collapse to their safe last segment, never escaping.
    expect(normalizeFilename('../../etc/passwd').filename).toBe('passwd');
    expect(normalizeFilename('../../../secrets.txt').filename).toBe('secrets.txt');
    // Degenerate names that don't yield a real basename are rejected outright.
    expect(() => normalizeFilename('..')).toThrow(UploadRejected);
    expect(() => normalizeFilename('')).toThrow(UploadRejected);
    // Leading dots are stripped (no hidden/dotfile names survive as-is).
    expect(normalizeFilename('.hidden').filename).toBe('hidden');
    expect(() => normalizeFilename('...')).toThrow(UploadRejected); // all dots → empty
  });
  it('exposes a lowercased extension', () => {
    expect(normalizeFilename('Notes.MD').ext).toBe('.md');
    expect(normalizeFilename('a.TXT').ext).toBe('.txt');
  });
});

describe('binary / text detection', () => {
  it('flags NUL and high control-byte ratios as binary', () => {
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text with\nnewlines\tand tabs'))).toBe(false);
  });
  it('safeDecodeUtf8 throws on invalid UTF-8', () => {
    expect(() => safeDecodeUtf8(Buffer.from([0xff, 0xfe, 0xfd]))).toThrow();
    expect(safeDecodeUtf8(Buffer.from('héllo', 'utf8'))).toBe('héllo');
  });
});

describe('classifyUpload', () => {
  const good = (over: Partial<Parameters<typeof classifyUpload>[0]> = {}) =>
    classifyUpload({ ext: '.md', declaredMime: 'text/markdown', sizeBytes: 5, bytes: Buffer.from('hello'), ...over });

  it('accepts markdown/text with valid UTF-8', () => {
    expect(good().kind).toBe('markdown');
    expect(good({ ext: '.txt', declaredMime: 'text/plain' }).kind).toBe('text');
    // Blank/octet-stream MIME is tolerated when bytes are text (browsers do this).
    expect(good({ declaredMime: 'application/octet-stream' }).kind).toBe('markdown');
  });

  it('marks pdf/docx as unsupported (recognized, not indexable)', () => {
    expect(() => good({ ext: '.pdf', declaredMime: 'application/pdf' })).toThrow(
      expect.objectContaining({ unsupported: true }),
    );
    expect(() => good({ ext: '.docx' })).toThrow(expect.objectContaining({ unsupported: true }));
  });

  it('rejects empty, oversized, binary-as-text, and disallowed MIME', () => {
    expect(() => good({ sizeBytes: 0, bytes: Buffer.alloc(0) })).toThrow(/empty/);
    expect(() => good({ sizeBytes: 9_999_999, bytes: Buffer.from('x') })).toThrow(/large/);
    expect(() => good({ bytes: Buffer.from([0x00, 0x01, 0x02]), sizeBytes: 3 })).toThrow(/binary/);
    expect(() => good({ declaredMime: 'application/x-msdownload' })).toThrow(/content type/);
  });
});
