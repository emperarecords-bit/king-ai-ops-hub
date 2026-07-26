import { type ConsequenceProfile, type ConsequenceReadout } from '@/domain/approvals/consequence';

/** Compact level signal for the queue — evidence-driven, not a color-code of the action type. */
export function ConsequenceLevelChip({ readout }: { readout: ConsequenceReadout }) {
  if (readout.needsClarification) {
    return (
      <span className="rounded bg-[#3a3220] px-2 py-0.5 text-xs text-[var(--warning,#c99a3a)]">
        needs clarification
      </span>
    );
  }
  if (readout.level === 'consequential') {
    return <span className="rounded bg-[#3a2c20] px-2 py-0.5 text-xs text-[var(--accent)]">consequential</span>;
  }
  return <span className="rounded bg-[var(--surface-raised)] px-2 py-0.5 text-xs text-[var(--muted)]">routine</span>;
}

const DIMENSION_LABEL: Record<string, string> = {
  target: 'Target',
  externalPartiesAffected: 'External parties',
  dataAffected: 'Data affected',
  financialExposure: 'Financial exposure',
  reversibility: 'Reversibility',
  authorityRequested: 'Authority requested',
  preconditions: 'Preconditions',
  executionMethod: 'Execution method',
};

/**
 * The established-vs-unknown consequence read (detail §3). Separates what the Hub can establish (with
 * source + confidence) from what it cannot — and never fills an absent dimension with a reassuring
 * default. "Reversibility" appearing under *cannot establish* is the point, not an omission.
 */
export function ConsequenceReadPanel({ profile }: { profile: ConsequenceProfile }) {
  const dims: [string, (typeof profile)['target']][] = [
    ['target', profile.target],
    ['externalPartiesAffected', profile.externalPartiesAffected],
    ['dataAffected', profile.dataAffected],
    ['financialExposure', profile.financialExposure],
    ['reversibility', profile.reversibility],
    ['preconditions', profile.preconditions],
    ['executionMethod', profile.executionMethod],
  ];
  const established = dims.filter(([, c]) => c.established);
  const unknown = dims.filter(([, c]) => !c.established);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          What the Hub can establish
        </h3>
        {established.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing beyond the action itself.</p>
        ) : (
          <ul className="space-y-2">
            {established.map(([key, c]) => (
              <li key={key} className="text-sm">
                <span className="text-[var(--foreground)]">{DIMENSION_LABEL[key]}:</span> {c.value}
                <span className="ml-1 text-xs text-[var(--muted)]">
                  ({c.source}
                  {c.confidence ? `, ${c.confidence} confidence` : ''})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          What it cannot establish
        </h3>
        {unknown.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Every dimension is accounted for.</p>
        ) : (
          <ul className="space-y-1">
            {unknown.map(([key]) => (
              <li key={key} className="text-sm text-[var(--muted)]">
                {DIMENSION_LABEL[key]} — not established
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
