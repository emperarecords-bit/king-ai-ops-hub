'use client';

import { useActionState } from 'react';
import { type RepairActionState, executeRepairAction, previewRepairAction } from './detail-actions';

/**
 * A bounded, representation-safe repair control for ONE finding on ONE exact version. Two deliberate steps:
 * PREVIEW (read-only — shows what is wrong, the proposed mutation, why it is safe, and what stays unchanged)
 * then APPLY (only offered when the rebuild is provably identical; bound to the previewed state). Nothing is
 * ever presented as already executed, and there is no cleanup/purge here.
 */

const initial: RepairActionState = { preview: null, result: null, error: null };
const btn = 'rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50';

export function RepairFinding({ projectKey, documentId, versionId }: { projectKey: string; documentId: string; versionId: string }) {
  const [previewState, preview, previewing] = useActionState(previewRepairAction, initial);
  const [execState, execute, executing] = useActionState(executeRepairAction, initial);
  const p = previewState.preview;
  const r = execState.result;
  const hidden = (
    <>
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="versionId" value={versionId} />
    </>
  );

  // After execution, show only the recorded result.
  if (r) {
    return (
      <div className="mt-2 rounded border border-[var(--border)] p-2 text-xs">
        <div className="font-medium">Repair {r.outcome === 'repaired' ? 'applied' : r.outcome === 'no_change_needed' ? 'not needed' : r.outcome === 'marked_degraded' ? 'not possible (marked degraded)' : 'refused'}</div>
        <div className="mt-1 text-[var(--muted)]">{r.detail}</div>
        <div className="mt-1 text-[var(--muted)]">Integrity before: {r.beforeOutcome ?? '—'} → after: {r.afterOutcome ?? '—'} · targeted finding resolved: {String(r.targetedFindingResolved)}{r.regressed ? ' · ⚠ a higher-severity finding appeared' : ''}</div>
      </div>
    );
  }

  return (
    <div className="mt-2">
      {!p ? (
        <form action={preview}>
          {hidden}
          <button type="submit" disabled={previewing} className={btn}>{previewing ? 'Previewing…' : 'Preview repair'}</button>
          {previewState.error ? <span className="ml-2 text-xs text-[var(--danger)]">{previewState.error}</span> : null}
        </form>
      ) : (
        <div className="rounded border border-[var(--border)] p-2 text-xs">
          <div className="font-medium">Proposed repair (preview — nothing has changed)</div>
          <div className="mt-1 text-[var(--muted)]">What is wrong: {p.whatIsWrong}</div>
          <div className="mt-1 text-[var(--muted)]">Proposed: {p.proposedMutation}</div>
          <div className="mt-1 text-[var(--muted)]">Why safe: {p.whySafe}</div>
          <div className="mt-1 text-[var(--muted)]">Unchanged: {p.whatUnchanged}</div>
          {p.refusalReason ? <div className="mt-1 text-[var(--warning,#e0a458)]">{p.refusalReason}</div> : null}
          {p.applicable && p.expectation === 'would_repair' ? (
            <form action={execute} className="mt-2">
              {hidden}
              <input type="hidden" name="fingerprint" value={p.fingerprint} />
              <button type="submit" disabled={executing} className={btn}>{executing ? 'Applying…' : 'Apply repair'}</button>
              {execState.error ? <span className="ml-2 text-xs text-[var(--danger)]">{execState.error}</span> : null}
            </form>
          ) : p.expectation === 'already_consistent' ? (
            <div className="mt-2 text-[var(--muted)]">No change is needed — the stored text already matches the retained bytes.</div>
          ) : (
            <div className="mt-2 text-[var(--muted)]">This finding cannot be safely repaired now.</div>
          )}
        </div>
      )}
    </div>
  );
}
