/**
 * Ops Chat attachment limits and file-type table — plain constants with NO imports, so the browser
 * client (file picker, chips) and the server (validation, prompt construction) share one source of
 * truth that can never drift.
 */

export const ATTACHMENT_LIMITS = {
  /** Largest accepted document (bytes). Mirrors the DB CHECK (size_bytes <= 10 MiB). */
  maxDocumentBytes: 10 * 1024 * 1024,
  /** Largest accepted image (bytes) — the provider's per-image ceiling. */
  maxImageBytes: 5 * 1024 * 1024,
  /** Attachments one owner message may carry. */
  maxPerMessage: 5,
  /** Extracted text stored per attachment (chars). Mirrors the DB CHECK. */
  maxExtractedChars: 100_000,
  /** Extracted text placed in the CURRENT turn's prompt, per file and in total (chars). */
  promptCharsPerFile: 20_000,
  promptCharsPerTurn: 40_000,
  /** One read_attachment call returns at most this many chars. */
  readChunkChars: 8_000,
  /** Filename length kept (chars). */
  maxFilenameChars: 200,
} as const;

export type AttachmentKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text' | 'markdown' | 'image';
export type AttachmentStatus = 'ready' | 'failed' | 'unsupported';

export const ATTACHMENT_EXT_KIND: Readonly<Record<string, AttachmentKind>> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.csv': 'csv',
  '.txt': 'text',
  '.text': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
};

/** The accept list for the file picker (extensions only — the server never trusts it). */
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_EXT_KIND).join(',');

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
