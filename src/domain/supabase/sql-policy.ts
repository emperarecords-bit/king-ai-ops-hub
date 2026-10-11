import { parse, toSql, type Statement } from 'pgsql-ast-parser';

/**
 * Approved-SQL policy (Phase 2C) — a real parser/AST allow-list, fail-closed. It accepts ONLY a single
 * parameterized INSERT / UPDATE / DELETE against one explicitly-named schema.table, with a mandatory WHERE for
 * UPDATE/DELETE and no nested subquery or CTE. EVERYTHING else is rejected: multi-statement, DDL
 * (CREATE/ALTER/DROP/TRUNCATE), GRANT/REVOKE/ROLE, EXTENSION/FUNCTION/TRIGGER/POLICY, transaction control, COPY,
 * DO, CALL, SET, VACUUM/ANALYZE, LISTEN/NOTIFY, temp objects, INSERT…SELECT, and comment-as-bypass. Rejection is
 * by AST shape and by parse failure — never regex. The policy is an allow-list, so anything the parser cannot
 * confidently reduce to the one accepted shape fails closed.
 *
 * This module is PURE and OFFLINE: it inspects a statement's structure and never touches a database. It does not,
 * by itself, make any SQL executable — there is no live executor for approved SQL in this slice (see
 * docs/architecture/supabase-approved-sql-risk-model.md); this only decides whether a statement is even a
 * candidate and surfaces its normalized form + referenced parameters for a validation report.
 */

export type ApprovedSqlOperation = 'insert' | 'update' | 'delete';

export interface ApprovedSqlPolicyResult {
  readonly ok: boolean;
  /** Human-readable denial reasons; empty iff ok. */
  readonly violations: readonly string[];
  readonly operation: ApprovedSqlOperation | null;
  readonly schema: string | null;
  readonly table: string | null;
  readonly hasWhere: boolean;
  /** Distinct `$N` parameters referenced, sorted by index (e.g. ['$1','$2']). */
  readonly referencedParameters: readonly string[];
  /** The statement re-serialized from its AST (comments stripped, canonicalized), or null when unparseable. */
  readonly normalizedSql: string | null;
}

const ALLOWED: ReadonlySet<string> = new Set(['insert', 'update', 'delete']);

function fail(violations: string[], partial: Partial<ApprovedSqlPolicyResult> = {}): ApprovedSqlPolicyResult {
  return {
    ok: false,
    violations,
    operation: partial.operation ?? null,
    schema: partial.schema ?? null,
    table: partial.table ?? null,
    hasWhere: partial.hasWhere ?? false,
    referencedParameters: partial.referencedParameters ?? [],
    normalizedSql: partial.normalizedSql ?? null,
  };
}

/** Walk every node; collect $N parameters and detect any forbidden nested construct (subquery/CTE/call). */
function scan(node: unknown, found: { params: Set<string>; forbidden: Set<string> }): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) scan(v, found);
    return;
  }
  const obj = node as Record<string, unknown>;
  const t = typeof obj.type === 'string' ? obj.type : null;
  if (t === 'parameter' && typeof obj.name === 'string') found.params.add(obj.name);
  // No nested SELECT anywhere (blocks INSERT…SELECT, UPDATE…FROM/subselect, WHERE … IN (SELECT …)).
  if (t === 'select' || t === 'union' || t === 'union all' || t === 'with' || t === 'with recursive') {
    found.forbidden.add('a nested subquery or CTE is not allowed');
  }
  if (t === 'call') found.forbidden.add('procedure calls are not allowed');
  for (const key of Object.keys(obj)) {
    // `with` as a property (a CTE prefix on a DML) is forbidden too.
    if (key === 'with' && obj[key]) found.forbidden.add('a CTE (WITH) prefix is not allowed');
    scan(obj[key], found);
  }
}

function targetOf(stmt: Statement): { schema?: string; name?: string } | null {
  if (stmt.type === 'update') return stmt.table as { schema?: string; name?: string };
  if (stmt.type === 'delete') return stmt.from as { schema?: string; name?: string };
  if (stmt.type === 'insert') return stmt.into as { schema?: string; name?: string };
  return null;
}

function sortParams(params: Iterable<string>): string[] {
  return [...new Set(params)].sort((a, b) => {
    const na = Number(a.replace('$', '')), nb = Number(b.replace('$', ''));
    return Number.isNaN(na) || Number.isNaN(nb) ? a.localeCompare(b) : na - nb;
  });
}

/**
 * Validate a candidate statement against the approved-SQL allow-list. Returns ok:false with explicit violations
 * for anything outside exactly one parameterized INSERT/UPDATE/DELETE on one explicit schema.table.
 */
export function validateApprovedSqlStatement(sql: string): ApprovedSqlPolicyResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) return fail(['empty statement']);

  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch (err) {
    return fail([`unparseable SQL (rejected fail-closed): ${err instanceof Error ? err.message.split('\n')[0] : 'parse error'}`]);
  }

  // Exactly one statement — rejects multi-statement, trailing `;`-joined injections, and empty input.
  if (statements.length !== 1) {
    return fail([`exactly one statement is required (found ${statements.length}) — multi-statement SQL is not allowed`]);
  }
  const stmt = statements[0]!;

  if (!ALLOWED.has(stmt.type)) {
    return fail([`only INSERT, UPDATE, or DELETE is allowed (found "${stmt.type}")`], { operation: null });
  }
  const operation = stmt.type as ApprovedSqlOperation;

  const violations: string[] = [];

  const target = targetOf(stmt);
  const schema = target && typeof target.schema === 'string' ? target.schema : null;
  const table = target && typeof target.name === 'string' ? target.name : null;
  if (!schema) violations.push('the target must name an explicit schema (e.g. public.table)');
  if (!table) violations.push('the target table could not be determined');

  const hasWhere = Boolean((stmt as { where?: unknown }).where);
  if ((operation === 'update' || operation === 'delete') && !hasWhere) {
    violations.push(`${operation.toUpperCase()} requires a WHERE clause (a whole-table ${operation} is not allowed)`);
  }

  // INSERT must be a plain VALUES insert — never INSERT…SELECT.
  if (operation === 'insert') {
    const ins = (stmt as { insert?: { type?: string } }).insert;
    if (!ins || ins.type !== 'values') violations.push('INSERT must use VALUES (INSERT…SELECT is not allowed)');
  }

  const found = { params: new Set<string>(), forbidden: new Set<string>() };
  scan(stmt, found);
  for (const f of found.forbidden) violations.push(f);

  // Mutating values must be bound parameters, not inline literals (strict parameter list).
  if (operation === 'update') {
    for (const s of (stmt as { sets: Array<{ column: { name: string }; value: { type?: string } }> }).sets) {
      if (s.value?.type !== 'parameter') violations.push(`SET ${s.column?.name ?? '?'} must be a bound parameter, not an inline value`);
    }
  }
  if (operation === 'insert') {
    const ins = (stmt as { insert?: { type?: string; values?: Array<Array<{ type?: string }>> } }).insert;
    if (ins?.type === 'values') {
      for (const row of ins.values ?? []) {
        for (const cell of row) if (cell?.type !== 'parameter') violations.push('INSERT values must all be bound parameters, not inline values');
      }
    }
  }

  let normalizedSql: string | null = null;
  try {
    normalizedSql = toSql.statement(stmt);
  } catch {
    violations.push('statement could not be normalized (rejected fail-closed)');
  }

  const referencedParameters = sortParams(found.params);
  if (violations.length > 0) {
    return fail(violations, { operation, schema, table, hasWhere, referencedParameters, normalizedSql });
  }
  return { ok: true, violations: [], operation, schema, table, hasWhere, referencedParameters, normalizedSql };
}
