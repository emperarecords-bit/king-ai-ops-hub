import { describe, expect, it } from 'vitest';
import { validateApprovedSqlStatement } from '@/domain/supabase/sql-policy';

/**
 * Phase 2C approved-SQL policy — a real parser/AST allow-list, fail-closed. Only a single parameterized
 * INSERT/UPDATE/DELETE on one explicit schema.table (mandatory WHERE for UPDATE/DELETE, no subquery/CTE, bound
 * parameters) is accepted; every other SQL family is rejected by AST shape or parse failure, not regex.
 */

describe('validateApprovedSqlStatement — accepted shapes', () => {
  it('accepts a single parameterized UPDATE with WHERE on an explicit schema.table', () => {
    const r = validateApprovedSqlStatement("update public.quotes set status = $1 where id = $2");
    expect(r.ok).toBe(true);
    expect(r.operation).toBe('update');
    expect(r.schema).toBe('public');
    expect(r.table).toBe('quotes');
    expect(r.hasWhere).toBe(true);
    expect(r.referencedParameters).toEqual(['$1', '$2']);
    expect(typeof r.normalizedSql).toBe('string');
  });
  it('accepts a single parameterized DELETE with WHERE', () => {
    const r = validateApprovedSqlStatement("delete from app.sessions where id = $1");
    expect(r.ok).toBe(true);
    expect(r.operation).toBe('delete');
    expect(r.schema).toBe('app');
  });
  it('accepts a single parameterized INSERT … VALUES', () => {
    const r = validateApprovedSqlStatement("insert into public.t (a, b) values ($1, $2)");
    expect(r.ok).toBe(true);
    expect(r.operation).toBe('insert');
    expect(r.referencedParameters).toEqual(['$1', '$2']);
  });
});

describe('validateApprovedSqlStatement — rejected (allow-list, fail-closed)', () => {
  const denied: Array<[string, string]> = [
    ['empty', '   '],
    ['SELECT (not a write)', 'select * from public.t'],
    ['UPDATE without WHERE', "update public.t set a = $1"],
    ['DELETE without WHERE', 'delete from public.t'],
    ['no explicit schema', "update quotes set status = $1 where id = $2"],
    ['multi-statement', "update public.t set a=$1 where id=$2; delete from public.t where id=$3"],
    ['trailing semicolon injection', "update public.t set a=$1 where id=$2; drop table public.t"],
    ['CTE hiding a delete', 'with x as (delete from public.t where id=1 returning *) select * from x'],
    ['CTE prefix on update', 'with y as (select 1) update public.t set a=$1 where id=$2'],
    ['subquery in WHERE', 'delete from public.t where id in (select id from public.other)'],
    ['INSERT…SELECT', 'insert into public.t (a) select a from public.other'],
    ['CREATE table (DDL)', 'create table public.t (a int)'],
    ['ALTER table (DDL)', 'alter table public.t add column b int'],
    ['DROP table (DDL)', 'drop table public.t'],
    ['TRUNCATE', 'truncate public.t'],
    ['GRANT', 'grant all on public.t to public'],
    ['REVOKE', 'revoke all on public.t from public'],
    ['CREATE ROLE', "create role evil login password 'x'"],
    ['CREATE EXTENSION', 'create extension if not exists pg_cron'],
    ['CREATE FUNCTION', 'create function public.f() returns int language sql as $$ select 1 $$'],
    ['CREATE TRIGGER', 'create trigger tg before insert on public.t for each row execute function public.f()'],
    ['CREATE POLICY', 'create policy p on public.t for select using (true)'],
    ['SET role', 'set role postgres'],
    ['DO block', 'do $$ begin perform 1; end $$'],
    ['CALL', 'call public.proc($1)'],
    ['COPY', "copy public.t from '/etc/passwd'"],
    ['VACUUM', 'vacuum public.t'],
    ['ANALYZE', 'analyze public.t'],
    ['inline literal in SET (not a parameter)', "update public.t set a = 'hardcoded' where id = $1"],
    ['inline literal in INSERT', "insert into public.t (a) values ('hardcoded')"],
    ['comment-only', '-- just a comment'],
  ];
  for (const [name, sql] of denied) {
    it(`rejects: ${name}`, () => {
      const r = validateApprovedSqlStatement(sql);
      expect(r.ok, `expected "${name}" to be rejected`).toBe(false);
      expect(r.violations.length).toBeGreaterThan(0);
    });
  }
});
