'use client';

import { useState } from 'react';
import { type Reasoning } from '@/domain/dashboard/briefing';

/**
 * The Hub's universal explanation surface (HUB-PRODUCT.md). It teaches how the Hub reached a
 * judgment — it does not defend it. Business impact leads (outcomes first); causal claims are
 * already labeled as inference upstream. Depth scales with consequence: this is the fuller
 * form, for a standout judgment worth explaining.
 */
export function ReasoningPanel({ reasoning }: { reasoning: Reasoning }) {
  const [open, setOpen] = useState(false);

  const rows: [string, string, boolean][] = [
    ['Why it matters to the business', reasoning.businessImpact, true],
    ['Evidence', reasoning.evidence, false],
    ['Reasoning', reasoning.reasoning, false],
    ['Confidence', reasoning.confidence, false],
    ['What would change this', reasoning.whatWouldChange, false],
  ];

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
        aria-expanded={open}
      >
        {open ? 'Hide reasoning' : 'How I reached this'}
      </button>
      {open ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            {rows.map(([label, value, lead]) => (
              <div key={label} className="contents">
                <dt className={lead ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}>{label}</dt>
                <dd className="text-[var(--foreground)]">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs italic text-[var(--muted)]">
            I&rsquo;m telling you what matters — not what to do about it. That&rsquo;s yours, for now.
          </p>
        </div>
      ) : null}
    </div>
  );
}
