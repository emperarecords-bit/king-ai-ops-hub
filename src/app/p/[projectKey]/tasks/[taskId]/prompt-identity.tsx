import { Card } from '@/components/ui';
import { classifyRunReproducibility, RUN_REPRODUCIBILITY_LABEL } from '@/domain/prompts/effective-prompt';
import type { RunRow, RunStepRow } from '@/domain/tasks/tasks';

/**
 * HUB-008 — read-only "Prompt identity" panel on the run detail page. Surfaces the reproducibility class
 * (exact / partial / unavailable) and, when recorded, the permitted METADATA: assembler version, the prompt
 * / configuration / effective-prompt hashes, the ordered source manifest, and each step's own effective-
 * prompt hash. It renders HASHES and content-manifest entries only — never the private system-prompt text,
 * merely because a hash of it is stored. For a run that predates capture we say exactly that and do NOT read
 * or imply the current employee prompt was the one used historically.
 */

function Hash({ value }: { value: string | null }) {
  if (!value) return <span className="text-[var(--muted)]">—</span>;
  return <span className="font-mono text-xs break-all">{value}</span>;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-[minmax(11rem,auto)_1fr] gap-x-4 gap-y-1 py-1">
      <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd>
        <Hash value={value} />
      </dd>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  exact: 'border-[var(--accent)] text-[var(--accent)]',
  partial: 'border-[#6b5a3d] text-[#c9a769]',
  unavailable: 'border-[var(--border)] text-[var(--muted)]',
};

export function PromptIdentity({ run, steps }: { run: RunRow; steps: RunStepRow[] }) {
  const cls = classifyRunReproducibility(run);
  const stepHashes = steps.filter((s) => s.kind !== 'consolidate');

  return (
    <Card title="Prompt identity" className="mb-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span
          className={`rounded border px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[cls] ?? ''}`}
          data-testid="reproducibility-status"
        >
          {RUN_REPRODUCIBILITY_LABEL[cls]}
        </span>
        {run.assemblerVersion ? (
          <span className="text-xs text-[var(--muted)]">assembler {run.assemblerVersion}</span>
        ) : null}
      </div>

      {cls === 'unavailable' ? (
        <p className="text-sm text-[var(--muted)]">
          This run was created before prompt-identity capture. Its exact prompts, configuration, and
          source manifest were not recorded, so they cannot be shown. The employee prompts visible
          elsewhere are the <strong>current</strong> versions — they were not necessarily the ones used
          for this historical run, and are not presented as such.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-[var(--muted)]">
            The immutable identity captured when this run was dispatched. These are cryptographic hashes
            and a content manifest — not the private prompt text. A later edit to any employee prompt
            cannot change what is shown here.
          </p>
          <dl className="mb-4 divide-y divide-[var(--border)]">
            <Field label="Primary prompt hash" value={run.primaryPromptHash} />
            <Field label="Reviewer prompt hash" value={run.reviewerPromptHash} />
            <Field label="Primary config hash" value={run.primaryConfigHash} />
            <Field label="Reviewer config hash" value={run.reviewerConfigHash} />
            <Field label="Primary effective-prompt hash" value={run.primaryEffectivePromptHash} />
            <Field label="Reviewer effective-prompt hash" value={run.reviewerEffectivePromptHash} />
          </dl>

          <p className="mb-2 text-xs text-[var(--muted)]">
            The <strong>primary effective-prompt hash</strong> identifies the initial primary request
            only. Each dispatched step — including the revision, whose request additionally carries the
            reviewer feedback and the prior response — is identified by its own per-step hash below.
          </p>
          {stepHashes.length > 0 ? (
            <div className="mb-4">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">
                Per-step effective-prompt hash
              </h3>
              <ul className="space-y-1">
                {stepHashes.map((s) => (
                  <li key={s.id} className="grid grid-cols-[6rem_1fr] gap-4 text-sm">
                    <span className="capitalize text-[var(--muted)]">{s.kind}</span>
                    <Hash value={s.effectivePromptHash} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">
              Ordered source manifest
            </h3>
            {run.sourceManifest && run.sourceManifest.length > 0 ? (
              <ol className="space-y-1">
                {run.sourceManifest.map((entry, i) => (
                  <li key={i} className="grid grid-cols-[6rem_1fr] gap-4 text-sm">
                    <span className="text-[var(--muted)]">
                      {entry.kind}
                      {entry.scope ? ` · ${entry.scope}` : ''}
                    </span>
                    <span className="min-w-0">
                      {entry.id ? (
                        <span className="mr-2 font-mono text-xs text-[var(--muted)] break-all">{entry.id}</span>
                      ) : null}
                      <Hash value={entry.hash} />
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-[var(--muted)]">No manifest entries recorded.</p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
