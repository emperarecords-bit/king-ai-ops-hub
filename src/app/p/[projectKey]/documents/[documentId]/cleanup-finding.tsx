'use client';

import { useActionState } from 'react';
import { type CleanupActionState, assessObjectCleanupAction, executeObjectCleanupAction, proposeObjectCleanupAction } from './detail-actions';

/**
 * A bounded, unreferenced-only cleanup control for ONE orphaned storage object. Three deliberate steps:
 * ASSESS (read-only — shows eligibility + every reference location checked), PROPOSE (records the proposal
 * and starts the quiet period that protects in-flight uploads), and AUTHORIZE + DELETE (only after the quiet
 * period, re-checking every guard before the irreversible delete). Nothing here deletes a document, version,
 * or tombstone; and no deletion is ever presented before storage confirms it.
 */

const initial: CleanupActionState = { assessment: null, proposal: null, result: null, error: null };
const btn = 'rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50';

export function CleanupFinding({ projectKey, documentId, objectKey }: { projectKey: string; documentId: string; objectKey: string }) {
  const [assessState, assess, assessing] = useActionState(assessObjectCleanupAction, initial);
  const [propState, propose, proposing] = useActionState(proposeObjectCleanupAction, initial);
  const [execState, execute, executing] = useActionState(executeObjectCleanupAction, initial);

  const hidden = (
    <>
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="objectKey" value={objectKey} />
    </>
  );

  const r = execState.result;
  if (r) {
    const label = r.outcome === 'deleted' ? 'Object deleted' : r.outcome === 'reconciled_absent' ? 'Reconciled (object already absent)' : r.outcome === 'already_deleted' ? 'Already cleaned up' : r.outcome === 'ambiguous' ? 'Deletion unconfirmed' : r.outcome === 'failed' ? 'Deletion failed' : 'Refused';
    return (
      <div className="mt-2 rounded border border-[var(--border)] p-2 text-xs">
        <div className="font-medium">{label}</div>
        <div className="mt-1 text-[var(--muted)]">{r.detail}</div>
        {/* Three honest, separate signals — never claim a deletion that storage did not confirm. */}
        <ul className="mt-1 space-y-0.5 text-[var(--muted)]">
          <li>Deletion performed by this operation: {r.objectDeleted ? 'yes' : 'no'}</li>
          <li>Lifecycle committed: {r.committed ? 'yes' : 'no'} · storage-confirmed: {r.verified ? 'yes' : 'no'}</li>
        </ul>
      </div>
    );
  }

  const proposal = propState.proposal;
  const a = propState.assessment ?? assessState.assessment;

  return (
    <div className="mt-2 rounded border border-[var(--border)] p-2 text-xs">
      <div className="font-medium">Orphaned storage object — legacy-object cleanup</div>

      {!a ? (
        <form action={assess} className="mt-1">
          {hidden}
          <button type="submit" disabled={assessing} className={btn}>{assessing ? 'Assessing…' : 'Assess object'}</button>
          {assessState.error ? <span className="ml-2 text-[var(--danger)]">{assessState.error}</span> : null}
        </form>
      ) : (
        <div className="mt-1">
          <div className="text-[var(--muted)]">{a.reason}</div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[var(--muted)]">Reference checks performed</summary>
            <ul className="mt-1 space-y-0.5 font-mono text-[var(--muted)]">
              {a.referencesChecked.map((c) => <li key={c.location}>{c.location}: {c.count}</li>)}
            </ul>
            {a.size !== null ? <div className="mt-1 text-[var(--muted)]">size {a.size} B · sha {a.sha256?.slice(0, 12)}…</div> : null}
          </details>

          {a.eligibility === 'eligible' && !proposal ? (
            <form action={propose} className="mt-2">
              {hidden}
              <button type="submit" disabled={proposing} className={btn}>{proposing ? 'Proposing…' : 'Propose cleanup'}</button>
              {propState.error ? <span className="ml-2 text-[var(--danger)]">{propState.error}</span> : null}
            </form>
          ) : null}

          {proposal ? (
            <div className="mt-2">
              <div className="text-[var(--muted)]">
                Proposed. A quiet period protects any in-flight upload before deletion is allowed
                {proposal.quietUntilMs ? ` (until ~${new Date(proposal.quietUntilMs).toLocaleString()})` : ''}.
              </div>
              <form action={execute} className="mt-1">
                {hidden}
                <input type="hidden" name="operationId" value={proposal.operationId} />
                <button type="submit" disabled={executing} className={btn}>{executing ? 'Authorizing…' : 'Authorize & delete'}</button>
                {execState.error ? <span className="ml-2 text-[var(--danger)]">{execState.error}</span> : null}
              </form>
            </div>
          ) : a.eligibility !== 'eligible' ? (
            <div className="mt-2 text-[var(--muted)]">This object cannot be cleaned up now.</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
