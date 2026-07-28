'use client';

import { useActionState } from 'react';
import { type PurgeActionState, assessDocumentPurgeAction, authorizeDocumentPurgeAction, cancelDocumentPurgeAction, executeDocumentPurgeAction, proposeDocumentPurgeAction } from './purge-actions';
import type { LivePurgeOperation } from '@/domain/documents/purge';

/**
 * The document PURGE control — a deliberate, admin-only, multi-step, IRREVERSIBLE capability, kept separate
 * from the safe lifecycle actions. Assess (read-only scope + reference blockers) → Propose → Authorize (enters
 * a visible retention/quarantine window, still cancellable) → after the window, Execute. It never exposes
 * restricted content; the deletion is the only path that removes a document and its versions.
 */

const initial: PurgeActionState = { assessment: null, operationId: null, result: null, message: null, error: null };
const btn = 'rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50';
const danger = 'rounded-md border border-[var(--danger)] px-2 py-1 text-xs font-medium text-[var(--danger)] hover:bg-[#3a2026] disabled:opacity-50';

function Hidden({ projectKey, documentId, operationId }: { projectKey: string; documentId: string; operationId?: string }) {
  return (
    <>
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="documentId" value={documentId} />
      {operationId ? <input type="hidden" name="operationId" value={operationId} /> : null}
    </>
  );
}

export function PurgeControl({ projectKey, documentId, live, retentionElapsed }: { projectKey: string; documentId: string; live: LivePurgeOperation | null; retentionElapsed: boolean }) {
  const [assessState, assess, assessing] = useActionState(assessDocumentPurgeAction, initial);
  const [propState, propose, proposing] = useActionState(proposeDocumentPurgeAction, initial);
  const [authState, authorize, authorizing] = useActionState(authorizeDocumentPurgeAction, initial);
  const [cancelState, cancel, cancelling] = useActionState(cancelDocumentPurgeAction, initial);
  const [execState, execute, executing] = useActionState(executeDocumentPurgeAction, initial);

  // A live quarantined / in-progress operation → show its state, cancel, and (once eligible) execute.
  if (live) {
    const inWindow = live.status === 'quarantined';
    const purging = live.status === 'database_purged' || live.status === 'object_cleanup_pending';
    return (
      <div className="rounded border border-[var(--danger)] p-3 text-xs">
        <div className="font-medium text-[var(--danger)]">Purge {inWindow ? 'authorized — retention window' : 'in progress'}</div>
        <div className="mt-1 text-[var(--muted)]">
          Scope: {live.scope.versions} version(s), {live.scope.chunks} chunk(s), {live.scope.disclosureGrants} disclosure grant(s), {live.scope.jobs} job(s), {live.scope.objects} object(s).
        </div>
        {inWindow && live.retentionUntil ? (
          <div className="mt-1 text-[var(--muted)]">
            The document is quarantined (excluded from retrieval) and still restorable until ~{new Date(live.retentionUntil).toLocaleString()}.
            {retentionElapsed ? ' The retention window has elapsed — purge may now be executed.' : ' Purge cannot execute until the window elapses.'}
          </div>
        ) : null}
        {purging ? <div className="mt-1 text-[var(--muted)]">The database purge is committed; object cleanup is finishing.</div> : null}

        <div className="mt-2 flex flex-wrap gap-2">
          {inWindow ? (
            <form action={cancel}>
              <Hidden projectKey={projectKey} documentId={documentId} operationId={live.operationId} />
              <button type="submit" disabled={cancelling} className={btn}>{cancelling ? 'Cancelling…' : 'Cancel purge (restore)'}</button>
            </form>
          ) : null}
          {(retentionElapsed && inWindow) || purging ? (
            <form action={execute}>
              <Hidden projectKey={projectKey} documentId={documentId} operationId={live.operationId} />
              <button type="submit" disabled={executing} className={danger}>{executing ? 'Purging…' : purging ? 'Resume object cleanup' : 'Execute purge now'}</button>
            </form>
          ) : null}
        </div>
        {execState.result ? <ExecResult r={execState.result} /> : null}
        {(cancelState.message || execState.error || cancelState.error) ? <p className="mt-2 text-[var(--muted)]">{cancelState.message ?? execState.error ?? cancelState.error}</p> : null}
      </div>
    );
  }

  // The completed/refused result of an execute on a now-gone document (page will 404 on next load).
  if (execState.result) {
    return <div className="rounded border border-[var(--border)] p-3 text-xs"><ExecResult r={execState.result} /></div>;
  }

  const a = propState.assessment ?? assessState.assessment;
  return (
    <div className="rounded border border-[var(--border)] p-3 text-xs">
      <div className="font-medium">Purge this document (irreversible)</div>
      <p className="mt-1 text-[var(--muted)]">Permanently removes the document, its versions, chunks, disclosure grants, and objects after an admin authorization and a retention window. Blocked while any Knowledge or AI-run evidence relies on it.</p>

      {!a ? (
        <form action={assess} className="mt-2">
          <Hidden projectKey={projectKey} documentId={documentId} />
          <button type="submit" disabled={assessing} className={btn}>{assessing ? 'Assessing…' : 'Assess for purge'}</button>
          {assessState.error ? <span className="ml-2 text-[var(--danger)]">{assessState.error}</span> : null}
        </form>
      ) : (
        <div className="mt-2">
          <div className="text-[var(--muted)]">Scope: {a.scope.versions.length} version(s), {a.scope.chunkCount} chunk(s), {a.scope.disclosureGrantCount} disclosure grant(s), {a.scope.jobCount} job(s), {a.scope.objectKeys.length} object(s); {a.scope.tombstonesToCreate} tombstone(s) will be retained.</div>
          {a.decision === 'purge_blocked' ? (
            <div className="mt-1 text-[var(--warning,#e0a458)]">Blocked — still referenced: {a.blockers.map((b) => `${b.category} (${b.count})`).join(', ')}. Purge is refused while evidence relies on this document.</div>
          ) : (
            <form action={propose} className="mt-2 flex flex-wrap items-center gap-2">
              <Hidden projectKey={projectKey} documentId={documentId} />
              <input type="text" name="reason" placeholder="Reason (optional)" className="rounded border border-[var(--border)] bg-transparent px-2 py-1" />
              <button type="submit" disabled={proposing} className={btn}>{proposing ? 'Proposing…' : 'Propose purge'}</button>
            </form>
          )}
          {propState.message ? <div className="mt-1 text-[var(--muted)]">{propState.message}</div> : null}
          {propState.operationId ? (
            <form action={authorize} className="mt-2">
              <Hidden projectKey={projectKey} documentId={documentId} operationId={propState.operationId} />
              <button type="submit" disabled={authorizing} className={danger}>{authorizing ? 'Authorizing…' : 'Authorize purge (start retention window)'}</button>
              {authState.message ? <span className="ml-2 text-[var(--muted)]">{authState.message}</span> : null}
            </form>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ExecResult({ r }: { r: NonNullable<PurgeActionState['result']> }) {
  const label = r.outcome === 'completed' ? 'Document purged'
    : r.outcome === 'database_purged_objects_pending' ? 'Database purged — object cleanup pending'
    : r.outcome === 'already_completed' ? 'Already purged'
    : 'Purge refused';
  return (
    <div>
      <div className="font-medium">{label}</div>
      <div className="mt-1 text-[var(--muted)]">{r.detail}</div>
      {r.deleted ? <div className="mt-1 text-[var(--muted)]">Deleted: {r.deleted.documents} document, {r.deleted.versions} version(s), {r.deleted.chunks} chunk(s), {r.deleted.disclosureGrants} grant(s), {r.deleted.jobs} job(s); {r.deleted.tombstonesCreated} tombstone(s) retained.</div> : null}
      {typeof r.objectsTotal === 'number' ? <div className="mt-1 text-[var(--muted)]">Objects confirmed absent: {r.objectsDeleted}/{r.objectsTotal}{r.objectsAllConfirmedAbsent ? '' : ' — remaining will be retried'}.</div> : null}
    </div>
  );
}
