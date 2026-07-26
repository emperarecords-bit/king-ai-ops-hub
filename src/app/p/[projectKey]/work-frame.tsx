import { CONDITION_LABEL, type ExecutionAssessment } from '@/domain/execution/assess';

/**
 * The shared operator frame (Execution 2c). Both human Work Item and AI Task detail pages open
 * with this same read — what it is, its purpose, condition, whether you're needed, why, who's
 * accountable, who performs it, how the Hub knows, and what changed — before the engine mechanics
 * diverge below. It's one coherent read, not ten fields.
 */
export function WorkFrame({
  kind,
  purpose,
  assessment,
  accountable,
  performer,
  recent,
}: {
  kind: 'work_item' | 'ai_task';
  purpose: string | null;
  assessment: ExecutionAssessment;
  accountable: string | null;
  /** null for human work unless a separate performer is recorded. */
  performer: string | null;
  recent: string | null;
}) {
  const a = assessment;
  return (
    <div className="mb-6 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs text-[var(--muted)]">
        {kind === 'ai_task' ? 'AI Task' : 'Work Item'}
        {purpose ? ` · toward ${purpose}` : ' · operational — not tied to an objective'}
      </p>
      <p className="mt-1 text-[15px] leading-relaxed text-[var(--foreground)]">
        <span className="font-medium">{CONDITION_LABEL[a.condition]}</span>
        {a.intervention === 'required' ? (
          <span className="text-[var(--accent)]"> — needs you{a.requiredAction ? `: ${a.requiredAction}` : ''}</span>
        ) : a.intervention === 'watch' ? (
          <span className="text-[var(--warning,#c99a3a)]"> — watch</span>
        ) : null}
        . {a.reason}
        {a.confidence ? ` ${a.confidence}` : ''}
      </p>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Accountable: {accountable ?? 'unowned'} ·{' '}
        {performer ? `performed by ${performer}` : 'a separate performer is not recorded'} · {a.source} state
        {recent ? ` · recently: ${recent}` : ''}
      </p>
    </div>
  );
}
