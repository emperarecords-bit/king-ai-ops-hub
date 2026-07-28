'use client';

import { useActionState } from 'react';
import { type IntegrityAuditState, runIntegrityAuditAction } from './detail-actions';
import type { DocIntegrityFinding, DocIntegrityLimitation, DocumentIntegrityAudit } from '@/domain/documents/integrity';

/**
 * Read-only integrity audit control + result. Running it is a deliberate POST (server action) that mutates
 * NOTHING; it only observes and reports. No repair control appears here.
 */

const integrityInitial: IntegrityAuditState = { audit: null, error: null };

const OUTCOME_LABEL: Record<DocumentIntegrityAudit['outcome'], string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  partially_verified: 'Partially verified',
  audit_failed: 'Audit failed',
};
const OUTCOME_CLASS: Record<DocumentIntegrityAudit['outcome'], string> = {
  healthy: 'bg-[#1f3a2a] text-[var(--success)]',
  degraded: 'bg-[#3a2a1f] text-[var(--warning,#e0a458)]',
  unavailable: 'bg-[#2a2f3a] text-[var(--muted)]',
  partially_verified: 'bg-[#2a2f3a] text-[var(--muted)]',
  audit_failed: 'bg-[#3a2026] text-[var(--danger)]',
};
const AFFECTS_LABEL: Record<DocIntegrityFinding['affects'], string> = {
  current: 'affects current use',
  historical: 'affects a historical version',
  both: 'affects current and historical use',
  reference: 'affects reference integrity',
  none: 'informational',
};
const LIMIT_LABEL: Record<DocIntegrityLimitation['reason'], string> = {
  object_store_inaccessible: 'Object storage was not reachable, so some bytes could not be verified.',
  source_bytes_unavailable: 'Source bytes were not available to verify.',
  unsupported_adapter: 'This source adapter does not support full verification.',
  missing_historical_evidence: 'Required historical evidence is not present.',
  always_unavailable_version: 'A version was recorded as having no retained evidence; its bytes cannot be verified.',
};

function Findings({ findings }: { findings: DocIntegrityFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="mt-2 space-y-2">
      {findings.map((f, i) => (
        <li key={i} className="rounded border border-[var(--border)] p-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${f.severity === 'high' ? 'bg-[#3a2026] text-[var(--danger)]' : f.severity === 'medium' ? 'bg-[#3a2a1f] text-[var(--warning,#e0a458)]' : 'border border-[var(--border)] text-[var(--muted)]'}`}>{f.severity}</span>
            <span>{f.explanation}</span>
          </div>
          <div className="mt-1 text-xs text-[var(--muted)]">{AFFECTS_LABEL[f.affects]}{f.repairPossibleLater ? ' · repair may be possible in a later increment' : ''}</div>
          <details className="mt-1"><summary className="cursor-pointer text-xs text-[var(--muted)]">Technical evidence</summary><div className="mt-1 font-mono text-xs text-[var(--muted)]">{f.category}{f.versionId ? ` · version ${f.versionId.slice(0, 8)}…` : ''} — {f.technicalDetail}</div></details>
        </li>
      ))}
    </ul>
  );
}

export function IntegrityAudit({ projectKey, documentId }: { projectKey: string; documentId: string }) {
  const [state, run, running] = useActionState(runIntegrityAuditAction, integrityInitial);
  const a = state.audit;

  return (
    <div>
      <form action={run}>
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="documentId" value={documentId} />
        <button type="submit" disabled={running} className="rounded-md border border-[var(--border)] px-3 py-1 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50">
          {running ? 'Auditing…' : 'Run integrity audit'}
        </button>
      </form>
      {state.error && !a ? <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{state.error}</p> : null}

      {a ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase text-[var(--muted)]">Audit result:</span>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${OUTCOME_CLASS[a.outcome]}`}>{OUTCOME_LABEL[a.outcome]}</span>
            {a.archived ? <span className="text-xs text-[var(--muted)]">archived — excluded from retrieval by intent, not a defect</span> : null}
          </div>

          {a.outcome === 'audit_failed' ? (
            <p className="mt-2 text-sm text-[var(--danger)]">The audit could not complete{state.error ? `: ${state.error}` : ''}. This is not a finding of corruption — re-run when the issue clears.</p>
          ) : a.outcome === 'healthy' ? (
            <p className="mt-2 text-sm text-[var(--muted)]">All applicable checks passed. Current-version integrity and historical inspectability are intact.</p>
          ) : null}

          {a.findings.length > 0 ? (
            <>
              <div className="mt-3 text-xs uppercase text-[var(--muted)]">Findings ({a.findings.length})</div>
              <Findings findings={a.findings} />
            </>
          ) : null}

          {a.limitations.length > 0 ? (
            <>
              <div className="mt-3 text-xs uppercase text-[var(--muted)]">Could not verify</div>
              <ul className="mt-1 space-y-1 text-sm text-[var(--muted)]">
                {a.limitations.map((l, i) => <li key={i}>• {LIMIT_LABEL[l.reason]}{l.versionId ? ` (version ${l.versionId.slice(0, 8)}…)` : ''}</li>)}
              </ul>
            </>
          ) : null}

          <details className="mt-3 rounded border border-[var(--border)] px-3 py-2">
            <summary className="cursor-pointer text-xs text-[var(--muted)]">Per-version results & checks applied</summary>
            <div className="mt-2 space-y-1 text-xs text-[var(--muted)]">
              {a.versions.map((v) => <div key={v.versionId}>version {v.versionId.slice(0, 8)}… {v.isCurrent ? '(current) ' : ''}· {v.fidelity} · {v.state}</div>)}
              <div className="mt-2">Checks applied: {a.checksApplied.join(', ')}</div>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}
