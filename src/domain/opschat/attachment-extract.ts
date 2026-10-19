import 'server-only';
import { capExtracted } from './attachment-policy';
import { ATTACHMENT_LIMITS, type AttachmentKind, type AttachmentStatus } from './attachment-limits';

/**
 * Server-side text extraction for Ops Chat attachments. Runs SYNCHRONOUSLY inside the upload request
 * under a wall-clock cap; the result (bounded text + non-content facts) is stored on the attachment
 * row so it survives reload and is never re-extracted per turn.
 *
 * Fail-closed and quiet: a parser error or timeout yields `failed` with a GENERIC message (parser
 * internals never reach the owner or the model). Images are not text-extracted; their original is
 * kept in the object store and sent to the model as an image block. Nothing here executes document
 * content — PDFs are parsed for text only, and OOXML is read as data.
 */

export const EXTRACTION_TIMEOUT_MS = 20_000;
/** Spreadsheet bound: rows read per sheet and cells kept per row (the char cap applies on top). */
const XLSX_MAX_ROWS_PER_SHEET = 2_000;
const XLSX_MAX_CELLS_PER_ROW = 60;

export interface ExtractionResult {
  readonly status: AttachmentStatus;
  readonly text: string | null;
  readonly error: string | null;
  readonly meta: { pages?: number; sheets?: number; truncated?: boolean; chars?: number };
}

class ExtractionTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new ExtractionTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function extractPdf(bytes: Buffer): Promise<{ text: string; pages: number }> {
  // unpdf's serverless pdf.js build contains no eval/new Function path; it loads + releases the doc.
  const { extractText } = await import('unpdf');
  const { totalPages, text } = await extractText(new Uint8Array(bytes), { mergePages: true });
  return { text, pages: totalPages };
}

async function extractDocx(bytes: Buffer): Promise<{ text: string }> {
  const mammoth = (await import('mammoth')).default;
  const res = await mammoth.extractRawText({ buffer: bytes });
  return { text: res.value };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { text?: unknown; result?: unknown; richText?: Array<{ text?: string }>; hyperlink?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text ?? '').join('');
    if (o.result !== undefined) return cellText(o.result); // formula → its cached result, never the formula
    if (typeof o.text === 'string') return o.text;
    return '';
  }
  return String(v);
}

async function extractXlsx(bytes: Buffer): Promise<{ text: string; sheets: number; truncated: boolean }> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const out: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const ws of wb.worksheets) {
    if (chars >= ATTACHMENT_LIMITS.maxExtractedChars) {
      truncated = true;
      break;
    }
    out.push(`## Sheet: ${ws.name}`);
    let rows = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows >= XLSX_MAX_ROWS_PER_SHEET || chars >= ATTACHMENT_LIMITS.maxExtractedChars) {
        truncated = true;
        return;
      }
      const values = Array.isArray(row.values) ? row.values.slice(1, 1 + XLSX_MAX_CELLS_PER_ROW) : [];
      const line = values.map((v) => cellText(v).replace(/[\t\r\n]+/g, ' ')).join('\t');
      out.push(line);
      chars += line.length + 1;
      rows += 1;
    });
  }
  return { text: out.join('\n'), sheets: wb.worksheets.length, truncated };
}

/** Extract bounded text for a CLASSIFIED attachment (classification already proved the format). */
export async function extractAttachmentText(kind: AttachmentKind, bytes: Buffer): Promise<ExtractionResult> {
  if (kind === 'image') return { status: 'ready', text: null, error: null, meta: {} };
  try {
    let raw: string;
    const meta: ExtractionResult['meta'] = {};
    switch (kind) {
      case 'pdf': {
        const r = await withTimeout(extractPdf(bytes), EXTRACTION_TIMEOUT_MS);
        raw = r.text;
        meta.pages = r.pages;
        break;
      }
      case 'docx':
        raw = (await withTimeout(extractDocx(bytes), EXTRACTION_TIMEOUT_MS)).text;
        break;
      case 'xlsx': {
        const r = await withTimeout(extractXlsx(bytes), EXTRACTION_TIMEOUT_MS);
        raw = r.text;
        meta.sheets = r.sheets;
        if (r.truncated) meta.truncated = true;
        break;
      }
      case 'csv':
      case 'text':
      case 'markdown':
        raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        break;
    }
    const capped = capExtracted(raw);
    if (capped.truncated) meta.truncated = true;
    meta.chars = capped.text.length;
    if (capped.text.trim().length === 0) {
      // e.g. a scanned PDF with no text layer (OCR is out of scope for v1).
      return { status: 'unsupported', text: null, error: 'No readable text was found in this file.', meta };
    }
    return { status: 'ready', text: capped.text, error: null, meta };
  } catch (err) {
    const error = err instanceof ExtractionTimeout ? 'Reading this file took too long.' : 'This file could not be read.';
    return { status: 'failed', text: null, error, meta: {} };
  }
}
