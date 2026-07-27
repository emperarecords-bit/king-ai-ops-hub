'use client';

import { useActionState } from 'react';
import { type RevealState, revealInitial, revealRestrictedVersionAction } from './detail-actions';

/**
 * The explicit restricted-content release control. Submitting it POSTs the server action (origin/CSRF
 * validated) — the only path that releases restricted content and records an inspection. Rendering this
 * component, refreshing, or navigating back/forward does nothing; only a deliberate click releases, and no
 * reusable release command ever appears in the URL.
 */
export function RevealRestricted({
  projectKey,
  documentId,
  versionId,
  downloadHref,
}: {
  projectKey: string;
  documentId: string;
  versionId: string;
  /** Where an exact-bytes download would go, if the released version is downloadable (byte-exact). */
  downloadHref: string;
}) {
  const [state, action, pending] = useActionState<RevealState, FormData>(revealRestrictedVersionAction, revealInitial);

  if (state.released) {
    return (
      <div>
        {state.qualification ? <p className="mb-2 rounded bg-[#3a2a1f] px-3 py-2 text-xs text-[var(--warning,#e0a458)]">{state.qualification}</p> : null}
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--background)] p-3 text-xs">{state.previewText}</pre>
        {state.downloadable ? (
          <a href={downloadHref} className="mt-2 inline-block rounded-md border border-[var(--border)] px-3 py-1 text-xs font-medium hover:border-[var(--accent)]">Download exact source</a>
        ) : (
          <p className="mt-2 text-xs text-[var(--muted)]">Reconstructed indexed text — the original bytes were not retained, so there is no exact download.</p>
        )}
      </div>
    );
  }

  return (
    <form action={action} className="rounded bg-[#3a2a1f] px-3 py-3 text-sm">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="versionId" value={versionId} />
      <p className="mb-2 text-[var(--warning,#e0a458)]">This is restricted content. Revealing it records an access to your account.</p>
      <button type="submit" disabled={pending} className="inline-block rounded-md border border-[var(--border)] px-3 py-1 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50">
        {pending ? 'Revealing…' : 'Reveal restricted content'}
      </button>
      {state.message ? <p className="mt-2 text-xs text-[var(--danger)]">{state.message}</p> : null}
    </form>
  );
}
