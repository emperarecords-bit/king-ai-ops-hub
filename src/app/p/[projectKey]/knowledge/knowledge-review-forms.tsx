'use client';

import { useActionState, useState } from 'react';
import {
  submitKnowledgeVerification,
  submitProposalPromote,
  submitProposalReject,
  submitProposalRevise,
  submitProposalSplit,
  submitSupportJudgment,
  type KnowledgeMutationState,
} from './actions';

const initial: KnowledgeMutationState = { error: null };
const inputCls = 'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]';
const btn = 'rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50';
const primaryBtn = 'rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50';

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="mt-2 rounded-md bg-[#3a2026] px-3 py-2 text-xs text-[var(--danger)]">{error}</p>;
}

function Toggle({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className={btn}>{label}</button>;
  return (
    <div className="w-full rounded-md border border-[var(--border)] p-3">
      <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium">{label}</span><button type="button" onClick={() => setOpen(false)} className={btn}>Cancel</button></div>
      {children}
    </div>
  );
}

/**
 * Explicit structured promotion — the operator states scope, temporal validity, disclosure, and whether
 * to activate. Suggested values are shown as placeholders only; the operator chooses. Promotion never
 * verifies. Disclosure may tighten but not loosen below the inherited floor (enforced server-side).
 */
export function PromoteProposalForm({ projectKey, proposalId, suggested }: { projectKey: string; proposalId: string; suggested: { scopeKind: string; disclosure: string } }) {
  const [state, action, pending] = useActionState(submitProposalPromote, initial);
  const [scopeKind, setScopeKind] = useState(suggested.scopeKind);
  return (
    <Toggle label="Promote">
      <form action={action} className="space-y-2">
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="proposalId" value={proposalId} />
        <label className="block text-xs text-[var(--muted)]">Scope (AI suggested: {suggested.scopeKind})
          <select name="scopeKind" value={scopeKind} onChange={(e) => setScopeKind(e.target.value)} className={inputCls}>
            <option value="workspace">Workspace</option>
            <option value="objective">Objective</option>
            <option value="task">Task</option>
          </select>
        </label>
        {scopeKind === 'task' ? <input name="scopeTaskId" placeholder="Task id" className={inputCls} /> : null}
        {scopeKind === 'objective' ? <input name="scopeObjectiveId" placeholder="Objective id" className={inputCls} /> : null}
        <label className="block text-xs text-[var(--muted)]">Disclosure (inherited floor: {suggested.disclosure})
          <select name="disclosure" defaultValue={suggested.disclosure} className={inputCls}>
            <option value="workspace_internal">Workspace-internal</option>
            <option value="restricted">Restricted</option>
          </select>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="block text-xs text-[var(--muted)]">As of<input type="date" name="asOf" className={inputCls} /></label>
          <label className="block text-xs text-[var(--muted)]">Review after<input type="date" name="reviewAfter" className={inputCls} /></label>
          <label className="block text-xs text-[var(--muted)]">Expires<input type="date" name="expiresAt" className={inputCls} /></label>
        </div>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="activate" className="accent-[var(--accent)]" />Activate now (still not verification)</label>
        <button type="submit" disabled={pending} className={primaryBtn}>{pending ? 'Promoting…' : 'Promote'}</button>
        <ErrorNote error={state.error} />
      </form>
    </Toggle>
  );
}

export function RejectProposalForm({ projectKey, proposalId }: { projectKey: string; proposalId: string }) {
  const [state, action, pending] = useActionState(submitProposalReject, initial);
  return (
    <Toggle label="Reject">
      <form action={action} className="space-y-2">
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="proposalId" value={proposalId} />
        <textarea name="reason" required rows={2} placeholder="Why is this not worth remembering? (preserved with the rejected proposal)" className={inputCls} />
        <button type="submit" disabled={pending} className={btn}>{pending ? 'Rejecting…' : 'Reject proposal'}</button>
        <ErrorNote error={state.error} />
      </form>
    </Toggle>
  );
}

export function ReviseProposalForm({ projectKey, proposalId, title, claim }: { projectKey: string; proposalId: string; title: string; claim: string }) {
  const [state, action, pending] = useActionState(submitProposalRevise, initial);
  return (
    <Toggle label="Revise">
      <form action={action} className="space-y-2">
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="proposalId" value={proposalId} />
        <input name="title" defaultValue={title} maxLength={200} className={inputCls} />
        <textarea name="claim" defaultValue={claim} rows={3} maxLength={20_000} className={inputCls} />
        <button type="submit" disabled={pending} className={btn}>{pending ? 'Saving…' : 'Save revision'}</button>
        <ErrorNote error={state.error} />
      </form>
    </Toggle>
  );
}

/** Split a bundled proposal into 2+ independently-reviewable children (each a fresh draft). */
export function SplitProposalForm({ projectKey, proposalId }: { projectKey: string; proposalId: string }) {
  const [state, action, pending] = useActionState(submitProposalSplit, initial);
  const [children, setChildren] = useState([{ title: '', claim: '' }, { title: '', claim: '' }]);
  const update = (i: number, key: 'title' | 'claim', v: string) => setChildren((c) => c.map((row, j) => (j === i ? { ...row, [key]: v } : row)));
  return (
    <Toggle label="Split">
      <form action={action} className="space-y-2">
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="proposalId" value={proposalId} />
        <input type="hidden" name="children" value={JSON.stringify(children.filter((c) => c.title.trim() && c.claim.trim()))} />
        {children.map((c, i) => (
          <div key={i} className="space-y-1 rounded border border-[var(--border)] p-2">
            <input value={c.title} onChange={(e) => update(i, 'title', e.target.value)} placeholder={`Child ${i + 1} title`} className={inputCls} />
            <textarea value={c.claim} onChange={(e) => update(i, 'claim', e.target.value)} rows={2} placeholder="One bounded claim" className={inputCls} />
          </div>
        ))}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setChildren((c) => [...c, { title: '', claim: '' }])} className={btn}>+ Add claim</button>
          <input name="reason" placeholder="Why split? (optional)" className={inputCls} />
        </div>
        <button type="submit" disabled={pending} className={btn}>{pending ? 'Splitting…' : 'Split into children'}</button>
        <ErrorNote error={state.error} />
      </form>
    </Toggle>
  );
}

/** Human-confirm or mark-disputed an active record. Neither is source_supported (that needs a judgment). */
export function VerificationForm({ projectKey, itemId }: { projectKey: string; itemId: string }) {
  const [state, action, pending] = useActionState(submitKnowledgeVerification, initial);
  return (
    <Toggle label="Confirm / dispute">
      <form action={action} className="space-y-2">
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="itemId" value={itemId} />
        <textarea name="reason" rows={2} placeholder="Reason (required to dispute)" className={inputCls} />
        <div className="flex items-center gap-2">
          <button type="submit" name="verification" value="human_confirmed" disabled={pending} className={btn}>Human-confirm</button>
          <button type="submit" name="verification" value="disputed" disabled={pending} className={btn}>Mark disputed</button>
        </div>
        <p className="text-xs text-[var(--muted)]">Confirming or disputing is not source-support — that requires a judgment over relied-upon sources.</p>
        <ErrorNote error={state.error} />
      </form>
    </Toggle>
  );
}

/** Record a source-support judgment over explicitly-chosen relied-upon sources (draft with sources). */
export function SupportJudgmentForm({ projectKey, itemId, sources }: { projectKey: string; itemId: string; sources: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState(submitSupportJudgment, initial);
  const [relied, setRelied] = useState<string[]>([]);
  const toggle = (id: string) => setRelied((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));
  if (sources.length === 0) return null;
  return (
    <Toggle label="Record source-support judgment">
      <form action={action} className="space-y-2">
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="reliedOnSourceIds" value={JSON.stringify(relied)} />
        <p className="text-xs text-[var(--muted)]">Which sources did you rely on to judge this claim supported?</p>
        {sources.map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={relied.includes(s.id)} onChange={() => toggle(s.id)} className="accent-[var(--accent)]" />
            {s.label}
          </label>
        ))}
        <textarea name="rationale" rows={2} placeholder="Rationale (optional)" className={inputCls} />
        <textarea name="limitations" rows={2} placeholder="Limitations (optional)" className={inputCls} />
        <button type="submit" disabled={pending} className={btn}>{pending ? 'Recording…' : 'Record judgment'}</button>
        <ErrorNote error={state.error} />
      </form>
    </Toggle>
  );
}
