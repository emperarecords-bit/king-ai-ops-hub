'use client';

import { useActionState } from 'react';
import {
  archiveDocumentAction,
  declassifyDocumentAction,
  replaceDocumentAction,
  restoreDocumentAction,
  restrictDocumentAction,
  retryDocumentAction,
  type DocumentsState,
} from '../actions';
import type { DocumentActionAvailability } from '@/domain/documents/portfolio';

/**
 * Documents Detail — safe lifecycle actions (P3). Button visibility comes from the SHARED assessment
 * (`assessDocument`, the same one the Portfolio uses); it is never authorization. Every submission is a
 * server action (POST, origin/CSRF-validated by Next) that independently re-authenticates, re-checks admin
 * authority + workspace membership + document ownership + lifecycle validity, and audits only on success.
 * No purge / integrity execution / repair here.
 */

const initial: DocumentsState = { error: null, message: null };
const btn = 'rounded-md border border-[var(--border)] px-3 py-1 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50';
const field = 'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]';

function Note({ state }: { state: DocumentsState }) {
  if (state.error) return <p role="alert" className="mt-1 text-xs text-[var(--danger)]">{state.error}</p>;
  if (state.message) return <p className="mt-1 text-xs text-[var(--success)]">{state.message}</p>;
  return null;
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-[var(--border)] p-3">
      <div className="mb-2 text-xs font-medium uppercase text-[var(--muted)]">{title}</div>
      {children}
    </div>
  );
}

export function DetailLifecycleActions({
  projectKey,
  documentId,
  actions,
}: {
  projectKey: string;
  documentId: string;
  actions: DocumentActionAvailability;
}) {
  const [restrictState, restrict, restricting] = useActionState(restrictDocumentAction, initial);
  const [declassifyState, declassify, declassifying] = useActionState(declassifyDocumentAction, initial);
  const [archiveState, archive, archiving] = useActionState(archiveDocumentAction, initial);
  const [restoreState, restore, restoring] = useActionState(restoreDocumentAction, initial);
  const [retryState, retry, retrying] = useActionState(retryDocumentAction, initial);
  const [replaceState, replace, replacing] = useActionState(replaceDocumentAction, initial);

  const hidden = (
    <>
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="documentId" value={documentId} />
    </>
  );

  const none = !actions.restrict && !actions.declassify && !actions.archive && !actions.restore && !actions.retry && !actions.replace;
  if (none) return <p className="text-sm text-[var(--muted)]">No lifecycle actions are available to you for this source.</p>;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {actions.restrict ? (
        <Row title="Restrict">
          <form action={restrict} className="space-y-1">
            {hidden}
            <input name="reason" placeholder="Reason (optional)" className={field} />
            <button type="submit" disabled={restricting} className={btn}>{restricting ? 'Restricting…' : 'Restrict source'}</button>
            <Note state={restrictState} />
          </form>
        </Row>
      ) : null}

      {actions.declassify ? (
        <Row title="Declassify">
          <form action={declassify} className="space-y-1">
            {hidden}
            <input name="reason" placeholder="Reason (required)" required className={field} />
            <button type="submit" disabled={declassifying} className={btn}>{declassifying ? 'Declassifying…' : 'Declassify source'}</button>
            <Note state={declassifyState} />
          </form>
        </Row>
      ) : null}

      {actions.archive ? (
        <Row title="Archive">
          <form action={archive}>
            {hidden}
            <button type="submit" disabled={archiving} className={btn}>{archiving ? 'Archiving…' : 'Archive source'}</button>
            <Note state={archiveState} />
          </form>
        </Row>
      ) : null}

      {actions.restore ? (
        <Row title="Restore">
          <form action={restore}>
            {hidden}
            <button type="submit" disabled={restoring} className={btn}>{restoring ? 'Restoring…' : 'Restore source'}</button>
            <Note state={restoreState} />
          </form>
        </Row>
      ) : null}

      {actions.retry ? (
        <Row title="Retry indexing">
          <form action={retry}>
            {hidden}
            <button type="submit" disabled={retrying} className={btn}>{retrying ? 'Retrying…' : 'Retry indexing'}</button>
            <Note state={retryState} />
          </form>
        </Row>
      ) : null}

      {actions.replace ? (
        <Row title="Replace source (cloud)">
          <form action={replace} className="space-y-1">
            {hidden}
            <input name="file" type="file" accept=".md,.markdown,.txt,.text" className={`${field} file:mr-2 file:rounded file:border-0 file:bg-[var(--border)] file:px-2 file:text-xs`} />
            <button type="submit" disabled={replacing} className={btn}>{replacing ? 'Uploading…' : 'Upload replacement'}</button>
            <Note state={replaceState} />
          </form>
        </Row>
      ) : null}
    </div>
  );
}
