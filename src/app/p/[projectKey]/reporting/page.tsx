import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { assertProjectReportAccess } from '@/domain/reporting/access';
import {
  getProjectAttributionReconciliation,
  getProjectBaselineMetadata,
  getProjectDataQualityWarnings,
  getProjectEmployeeDefaults,
  getProjectModelUsage,
  getProjectPricingVersionBreakdown,
  getProjectRunCostDistribution,
  getProjectStepCostBreakdown,
  getProjectUsageSummary,
} from '@/domain/reporting/m0a';
import { resolveReportWindow, resolveTopN } from '@/domain/reporting/window';
import { PageHeader } from '@/components/ui';
import { DataTable, StatCard, Warn, money, pct } from '@/components/reporting';

/**
 * M0a — project usage & cost reporting (MEASUREMENT ONLY, project-admin only).
 *
 * Access: `requireTenant` (session + project membership + RLS context) → `assertProjectReportAccess`
 * (projectRole === 'admin') → all reads inside `withTenant`. No org-owner elevation, no implicit membership,
 * no RLS bypass. This route reads nothing but identifiers and metrics — no prompts/responses/results/evidence.
 *
 * NOTE: this is a NEW read-only route file under the project segment (authorized M0a §7). No existing routing,
 * navigation, or layout is modified; the page is reachable by direct URL only.
 */
export default async function ReportingPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectKey } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(projectKey);
  assertProjectReportAccess(ctx);

  // Bounded, validated window (default 90d; max 366d) + bounded top-N (default 20; max 200). Invalid ranges
  // are rejected (ReportInputError). Half-open [from, to). Effective boundaries + their source are displayed.
  const resolved = resolveReportWindow(new Date(), sp.from, sp.to);
  const window = resolved.window;
  const topN = resolveTopN(sp.limit);

  const data = await withTenant(ctx, async (tx) => ({
    summary: await getProjectUsageSummary(tx, ctx.projectId, window),
    steps: await getProjectStepCostBreakdown(tx, ctx.projectId, window),
    model: await getProjectModelUsage(tx, ctx.projectId, window),
    runs: await getProjectRunCostDistribution(tx, ctx.projectId, window, { limit: topN }),
    employees: await getProjectEmployeeDefaults(tx, ctx.projectId),
    attribution: await getProjectAttributionReconciliation(tx, ctx.projectId, window),
    warnings: await getProjectDataQualityWarnings(tx, ctx.projectId, window),
    pricingVersions: await getProjectPricingVersionBreakdown(tx, ctx.projectId, window),
    baseline: await getProjectBaselineMetadata(tx, ctx.projectId, window),
  }));

  const s = data.summary;
  const share = (x: { numerator: number; denominator: number }) =>
    `${x.numerator} / ${x.denominator}` + (x.denominator > 0 ? ` (${((x.numerator / x.denominator) * 100).toFixed(0)}%)` : '');

  return (
    <div className="space-y-8">
      <PageHeader
        title="Usage & cost reporting"
        subtitle="Measurement only. Recorded cost is authoritative; current-schedule figures are labeled estimates."
      />

      {/* Effective window — explicit about defaulting/clamping so no future range is silently implied. */}
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300">
        Effective window ({resolved.timezone}, half-open [from, to)):{' '}
        <code>{resolved.window.from.toISOString()}</code> ({resolved.fromSource}) →{' '}
        <code>{resolved.window.to.toISOString()}</code> ({resolved.toSource}).
        {resolved.toSource === 'clamped' ? ' A future "to" was clamped to the current time.' : ''}
      </div>

      {/* Headline */}
      <section className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Recorded cost" value={money(s.recordedCostMicros)} sub="authoritative — sum of cost_micros" />
        <StatCard label="Usage events" value={String(s.usageEventCount)} sub={`${s.runAssociatedEventCount} run-assoc · ${s.runLessEventCount} run-less`} />
        <StatCard label="Input tokens" value={s.inputTokens.toLocaleString()} />
        <StatCard label="Output tokens" value={s.outputTokens.toLocaleString()} />
      </section>

      {/* Populations */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Populations (independent counts)</h2>
        <div className="grid gap-6 md:grid-cols-3">
          <div>
            <h3 className="mb-2 text-sm font-medium text-neutral-500">Tasks by status</h3>
            <DataTable columns={['Status', 'Count']} rows={Object.entries(s.taskCountByStatus).map(([k, v]) => [k, v])} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-neutral-500">Runs by status</h3>
            <DataTable columns={['Status', 'Count']} rows={Object.entries(s.runCountByStatus).map(([k, v]) => [k, v])} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-neutral-500">Run steps by kind</h3>
            <DataTable columns={['Kind', 'Count']} rows={Object.entries(s.runStepCountByKind).map(([k, v]) => [k, v])} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Review-enabled tasks" value={share(s.reviewEnabledTaskShare)} />
          <StatCard label="Reviewed runs" value={share(s.reviewedRunShare)} />
          <StatCard label="Revision-triggered runs" value={share(s.revisionTriggeredRunShare)} />
        </div>
      </section>

      {/* Step-cost breakdown */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Step-cost breakdown (recorded)</h2>
        <DataTable
          columns={['Bucket', 'Events', 'Input tok', 'Output tok', 'Recorded cost']}
          rows={data.steps.map((b) => [b.key, b.eventCount, b.inputTokens, b.outputTokens, money(b.recordedCostMicros)])}
        />
      </section>

      {/* Model usage + estimate coverage */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Model usage &amp; estimate coverage</h2>
        <p className="text-xs text-neutral-500">
          &ldquo;Recorded&rdquo; = authoritative billed <code>cost_micros</code>. &ldquo;Est.&rdquo; columns are
          ESTIMATES computed with the current verified P1a schedule (ceil-up), not historical billing components,
          and are never rescaled to recorded cost. A dash means pricing was unavailable for those events.
        </p>
        <DataTable
          columns={['Provider', 'Model', 'Match', 'Events', 'Recorded', 'Est. input (P1a)', 'Est. output (P1a)', 'Est. combined (P1a)']}
          rows={data.model.rows.map((r) => [
            r.provider,
            r.model,
            `${r.matchState} (${r.exactEventCount}/${r.aliasEventCount}/${r.unavailableEventCount})`,
            r.eventCount,
            money(r.recordedCostMicros),
            r.exactEventCount + r.aliasEventCount > 0 ? money(r.estimatedInputCostMicros) : '—',
            r.exactEventCount + r.aliasEventCount > 0 ? money(r.estimatedOutputCostMicros) : '—',
            r.exactEventCount + r.aliasEventCount > 0 ? money(r.estimatedCombinedCostMicros) : '—',
          ])}
        />
        <div className="grid gap-4 sm:grid-cols-4">
          <StatCard label="Est. event coverage" value={pct(data.model.coverage.estimatedEventCoverageBps)} sub={`${data.model.coverage.matchedEvents}/${data.model.coverage.totalEvents} matched`} />
          <StatCard label="Est. recorded-cost coverage" value={pct(data.model.coverage.estimatedRecordedCostCoverageBps)} />
          <StatCard label="Matched recorded cost" value={money(data.model.coverage.matchedRecordedCostMicros)} />
          <StatCard label="Est. − recorded (matched)" value={money(data.model.coverage.estimatedDifferenceMicros)} sub="difference on covered subset only" />
        </div>
        <p className="text-xs text-neutral-500">
          Match legend: exact / approved_snapshot_alias / unavailable. The alias map is empty in M0a, so alias
          counts are always 0.
        </p>
      </section>

      {/* Attribution reconciliation */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Attribution reconciliation</h2>
        <div className="grid gap-4 sm:grid-cols-4">
          <StatCard label="Employee-attributed" value={money(data.attribution.employeeCostMicros)} sub={`${data.attribution.employeeEventCount} events`} />
          <StatCard label="Unattributed run" value={money(data.attribution.unattributedRunCostMicros)} sub={`${data.attribution.unattributedRunEventCount} events`} />
          <StatCard label="Run-less" value={money(data.attribution.runLessCostMicros)} sub={`${data.attribution.runLessEventCount} events`} />
          <StatCard label="Reconciles to recorded" value={data.attribution.reconciles ? 'exact ✓' : 'MISMATCH ✗'} sub={money(data.attribution.recordedCostMicros)} />
        </div>
        <DataTable
          columns={['Employee id', 'Events', 'Cost']}
          rows={data.attribution.perEmployee.map((e) => [e.agentId, e.eventCount, money(e.costMicros)])}
          empty="No employee-attributed usage in the selected window."
        />
      </section>

      {/* Run-cost distribution */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Highest-cost runs (window-scoped, top 20)</h2>
        <DataTable
          columns={['Run id', 'Task id', 'Status', 'Rev?', 'Revis?', 'Events', 'Cost']}
          rows={data.runs.map((r) => [
            r.runId,
            r.taskId,
            r.status,
            r.reviewed ? 'yes' : 'no',
            r.revisionTriggered ? 'yes' : 'no',
            r.eventCount,
            money(r.recordedCostMicros),
          ])}
        />
      </section>

      {/* Employee defaults */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Enabled employees — provider / model / output cap</h2>
        <DataTable
          columns={['Name', 'Role', 'Title', 'Provider', 'Model', 'Max output tok']}
          rows={data.employees.map((e) => [e.name, e.role, e.title ?? '—', e.provider, e.model, e.maxOutputTokens])}
        />
      </section>

      {/* Pricing-version breakdown */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recorded pricing versions</h2>
        <DataTable
          columns={['Stored pricing_version', 'Events', 'Recorded cost']}
          rows={data.pricingVersions.byVersion.map((v) => [v.pricingVersion, v.eventCount, money(v.recordedCostMicros)])}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Current source version" value={data.pricingVersions.currentSourceVersion} />
          <StatCard label="Events ≠ current version" value={String(data.pricingVersions.eventsWithNonCurrentSourceVersion)} />
          <StatCard label="Matched est ≠ recorded" value={String(data.pricingVersions.matchedEventsEstimateDiffersFromRecorded)} />
        </div>
        <p className="text-xs text-neutral-500">
          A matching <code>pricing_version</code> string does NOT prove identical arithmetic or billing semantics.
        </p>
      </section>

      {/* Data-quality warnings */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Data-quality</h2>
        <div className="grid gap-4 sm:grid-cols-4">
          <StatCard label="Unknown-model events" value={String(data.warnings.unknownModelEvents)} sub={money(data.warnings.unknownModelCostMicros)} />
          <StatCard label="Price-invalid events" value={String(data.warnings.priceInvalidEvents)} />
          <StatCard label="Unattributed run" value={String(data.warnings.unattributedRunEvents)} />
          <StatCard label="Run-less" value={String(data.warnings.runLessEvents)} />
          <StatCard label="Missing employee ref" value={String(data.warnings.missingEmployeeRefEvents)} />
          <StatCard label="Est. cost coverage" value={pct(data.warnings.estimatedCostCoverageBps)} />
          <StatCard label="Matched est ≠ recorded" value={String(data.warnings.matchedEstimateDiffersFromRecordedCount)} />
        </div>
        {data.warnings.legacyPricingWarning ? (
          <Warn>
            Recorded historical cost was produced by the legacy runtime pricing path (integer FLOOR) and may
            differ from the current verified ceil-up estimate. {data.warnings.matchedEstimateDiffersFromRecordedCount}{' '}
            matched event(s) show an estimate ≠ recorded. This is not a claim that every event differs, and
            recorded cost is never modified.
          </Warn>
        ) : null}
        <Warn>
          Retries and cache usage are NOT instrumented in M0a — those figures are a known blind spot, not zero.
          Unknown/unmatched-model and price-invalid events remain in the recorded totals above; only their
          estimates are withheld.
        </Warn>
      </section>

      <section className="text-xs text-neutral-500">
        Baseline: recorded pricing_version <code>{data.baseline.recordedPricingVersion}</code> · estimate schedule{' '}
        <code>{data.baseline.estimateScheduleId}</code> · {data.baseline.totalUsageEvents} events ·{' '}
        {data.baseline.matchedEvents} matched.
      </section>
    </div>
  );
}
