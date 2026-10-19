'use client';

import { ATTACHMENT_EXT_KIND, ATTACHMENT_LIMITS, formatBytes } from '@/domain/opschat/attachment-limits';
import { type AttachmentChip } from './ops-chat-transcript';

/**
 * Ops Chat attachment UI: the composer's pending-file chips and the chips on sent owner messages.
 * Display + upload only. The server re-validates everything (type by content signature, size, owner,
 * conversation); these client checks just give a fast, friendly refusal.
 */

export interface ComposerFile {
  readonly localId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly state: 'uploading' | 'ready' | 'error';
  readonly chip?: AttachmentChip;
  readonly error?: string;
}

const KIND_ICON: Record<string, string> = {
  pdf: '📄',
  docx: '📝',
  xlsx: '📊',
  csv: '📊',
  text: '📃',
  markdown: '📃',
  image: '🖼️',
};

const STATUS_NOTE: Record<string, string> = {
  failed: 'could not be read',
  unsupported: 'no readable text',
};

/** Fast client-side refusal before any upload (the server is authoritative). */
export function precheckFile(file: File): string | null {
  const dot = file.name.lastIndexOf('.');
  const kind = dot < 0 ? undefined : ATTACHMENT_EXT_KIND[file.name.slice(dot).toLowerCase()];
  if (!kind) return `${file.name}: unsupported file type.`;
  const max = kind === 'image' ? ATTACHMENT_LIMITS.maxImageBytes : ATTACHMENT_LIMITS.maxDocumentBytes;
  if (file.size === 0) return `${file.name}: the file is empty.`;
  if (file.size > max) return `${file.name}: too large (max ${formatBytes(max)}).`;
  return null;
}

/** Upload one file into a conversation. Never throws. */
export async function uploadAttachment(
  file: File,
  conversationId: string,
): Promise<{ ok: true; chip: AttachmentChip } | { ok: false; error: string }> {
  const form = new FormData();
  form.set('file', file);
  form.set('conversationId', conversationId);
  try {
    const res = await fetch('/api/ops-chat/attachments', { method: 'POST', body: form });
    const json = (await res.json().catch(() => null)) as { attachment?: AttachmentChip; error?: string } | null;
    if (!res.ok || !json?.attachment) return { ok: false, error: json?.error ?? 'The upload failed.' };
    const a = json.attachment;
    return { ok: true, chip: { id: a.id, filename: a.filename, kind: a.kind, sizeBytes: a.sizeBytes, status: a.status, error: a.error ?? null } };
  } catch {
    return { ok: false, error: 'The upload failed — check your connection and try again.' };
  }
}

function ChipBody({ chip }: { chip: AttachmentChip }) {
  const note = STATUS_NOTE[chip.status];
  return (
    <>
      <span aria-hidden>{KIND_ICON[chip.kind] ?? '📎'}</span>
      <span className="max-w-[14rem] truncate">{chip.filename}</span>
      <span className="opacity-60">· {chip.kind.toUpperCase()} · {formatBytes(chip.sizeBytes)}</span>
      {note ? <span className="text-[var(--danger,#c37474)]">· {note}</span> : null}
    </>
  );
}

/** Chips on a SENT owner message — each opens the owner's original file. */
export function SentAttachmentChips({ chips }: { chips: readonly AttachmentChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <a
          key={c.id}
          href={`/api/ops-chat/attachments/${encodeURIComponent(c.id)}`}
          target="_blank"
          rel="noopener noreferrer"
          title={c.error ?? c.filename}
          className="inline-flex items-center gap-1 rounded-full border border-[#0b0e14]/25 bg-[#0b0e14]/10 px-2 py-0.5 text-[11px] hover:bg-[#0b0e14]/20"
        >
          <ChipBody chip={c} />
        </a>
      ))}
    </div>
  );
}

/** The composer's pending files (uploading / ready / error), each removable before sending. */
export function ComposerAttachmentChips({
  files,
  disabled,
  onRemove,
}: {
  files: readonly ComposerFile[];
  disabled: boolean;
  onRemove: (localId: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((f) => (
        <span
          key={f.localId}
          className={
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ' +
            (f.state === 'error' ? 'border-[var(--danger,#c37474)] text-[var(--danger,#c37474)]' : 'border-[var(--border)] text-[var(--muted)]')
          }
          title={f.error ?? f.filename}
        >
          {f.chip ? (
            <ChipBody chip={f.chip} />
          ) : (
            <>
              <span aria-hidden>📎</span>
              <span className="max-w-[14rem] truncate">{f.filename}</span>
              <span className="opacity-60">· {formatBytes(f.sizeBytes)}</span>
            </>
          )}
          {f.state === 'uploading' ? <span className="opacity-70">· uploading…</span> : null}
          {f.state === 'error' ? <span>· {f.error ?? 'failed'}</span> : null}
          <button
            type="button"
            aria-label={`Remove ${f.filename}`}
            disabled={disabled || f.state === 'uploading'}
            onClick={() => onRemove(f.localId)}
            className="ml-0.5 rounded-full px-1 hover:bg-[var(--border)] disabled:opacity-40"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
