'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

/** Upload one media file via the route handler (large-file safe), with progress feedback. */
export function MediaUploadForm({ projectKey }: { projectKey: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function upload(): Promise<void> {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMessage('Choose a file first.');
      return;
    }
    setBusy(true);
    setMessage(`Uploading ${file.name}…`);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`/api/media/${projectKey}`, { method: 'POST', body });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setMessage(json.error ?? 'Upload failed.');
      } else {
        setMessage(null);
        if (fileRef.current) fileRef.current.value = '';
        router.refresh();
      }
    } catch {
      setMessage('Upload failed — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={fileRef}
        type="file"
        accept="video/*,image/*,audio/*,.mp4,.webm,.mov,.m4v,.png,.jpg,.jpeg,.gif,.webp,.mp3,.wav,.m4a"
        className="text-sm"
        disabled={busy}
      />
      <button
        type="button"
        onClick={() => void upload()}
        disabled={busy}
        className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-60"
      >
        {busy ? 'Uploading…' : 'Upload'}
      </button>
      {message ? <span className="text-sm text-[var(--muted)]">{message}</span> : null}
    </div>
  );
}
