import 'server-only';
import { createHash } from 'node:crypto';
import { type DocumentKind } from '@/types/domain';

/**
 * Upload validation & safety (O-23). Every uploaded byte passes through here
 * before it is stored or indexed. The rules are deliberately strict: this is a
 * text-indexing library, not a file host — we accept Markdown/plain-text only,
 * reject binary masquerading as text, and never trust client-supplied paths,
 * MIME, or sizes over what we measure server-side.
 */

/** Configurable ceilings (env, with safe defaults). */
export function maxUploadBytes(): number {
  const v = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 2_000_000; // 2 MB of text is a long doc
}
export function maxBatchFiles(): number {
  const v = Number(process.env.MAX_UPLOAD_BATCH);
  return Number.isFinite(v) && v > 0 ? v : 20;
}

/** Extension → kind. Markdown/text are indexable; pdf/docx are recognized only
 *  so they can be reported `unsupported` rather than silently skipped. */
const EXT_KIND: Record<string, DocumentKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.text': 'text',
  '.pdf': 'pdf',
  '.docx': 'docx',
};
const INDEXABLE: ReadonlySet<DocumentKind> = new Set(['markdown', 'text']);

/** MIME allowlist for the indexable kinds. A wrong/blank MIME is tolerated ONLY
 *  when the extension is indexable AND the bytes decode as text (checked
 *  separately) — we never index on MIME alone. */
const ALLOWED_MIME = new Set([
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'application/octet-stream', // browsers often send this for .md; bytes decide
  '',
]);

export interface NormalizedName {
  filename: string;
  ext: string;
}

/**
 * Normalize a client filename to a safe display name. Strips any directory
 * component (basename only), rejects traversal, control chars, and empties.
 */
export function normalizeFilename(raw: string): NormalizedName {
  // Take the last path segment regardless of / or \ — no directories survive.
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = Array.from(base)
    .filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; })
    .join('')
    .replace(/^\.+/, '') // strip leading dots (hidden files, traversal)
    .trim();
  if (cleaned.length === 0 || cleaned === '.' || cleaned.includes('..')) {
    throw new UploadRejected('invalid filename');
  }
  if (cleaned.length > 255) throw new UploadRejected('filename too long');
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 ? cleaned.slice(dot).toLowerCase() : '';
  return { filename: cleaned, ext };
}

export class UploadRejected extends Error {
  constructor(
    public readonly reason: string,
    public readonly unsupported = false,
  ) {
    super(reason);
    this.name = 'UploadRejected';
  }
}

/** Heuristic: NUL byte or a high fraction of non-text control bytes ⇒ binary. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i += 1) {
    const b = buf[i]!;
    if (b === 0) return true; // NUL — definitively binary for our purposes
    // Allow tab(9) LF(10) CR(13); count other C0 controls as suspicious.
    if (b < 9 || (b > 13 && b < 32)) suspicious += 1;
  }
  return suspicious / n > 0.02;
}

/** Strict UTF-8 decode; throws on invalid sequences (binary-as-text). */
export function safeDecodeUtf8(buf: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  return text;
}

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface UploadClassification {
  kind: DocumentKind;
  indexable: boolean;
  mimeType: string;
}

/**
 * Classify a normalized upload. Throws UploadRejected (with `unsupported=true`
 * for recognized-but-not-indexable types like pdf/docx, so the caller records
 * an `unsupported` document instead of a hard error). Returns the resolved kind
 * for indexable Markdown/plain-text.
 */
export function classifyUpload(args: {
  ext: string;
  declaredMime: string;
  sizeBytes: number;
  bytes: Buffer;
}): UploadClassification {
  if (args.sizeBytes <= 0) throw new UploadRejected('empty file');
  if (args.sizeBytes > maxUploadBytes()) throw new UploadRejected('file too large');

  const kind = EXT_KIND[args.ext];
  if (!kind) throw new UploadRejected('unrecognized file type', true);
  if (!INDEXABLE.has(kind)) throw new UploadRejected(`${kind} is not supported for indexing`, true);

  const mime = (args.declaredMime || '').toLowerCase().split(';')[0]!.trim();
  if (!ALLOWED_MIME.has(mime)) throw new UploadRejected(`disallowed content type: ${mime}`);

  // Content must actually be text — reject binary masquerading as .md/.txt.
  if (looksBinary(args.bytes)) throw new UploadRejected('binary content in a text file');
  try {
    safeDecodeUtf8(args.bytes);
  } catch {
    throw new UploadRejected('content is not valid UTF-8 text');
  }

  return { kind, indexable: true, mimeType: mime || 'text/plain' };
}
