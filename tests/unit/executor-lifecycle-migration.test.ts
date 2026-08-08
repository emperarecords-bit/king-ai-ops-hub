import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/0058_yummy_the_hand.sql', 'utf8');
const rls = readFileSync('src/db/rls.sql', 'utf8');
const dispatch = readFileSync('src/domain/execution/dispatch.ts', 'utf8');

describe('0058 executor lifecycle migration contract', () => {
  it('creates only the two approved lifecycle tables with tenant-bound foreign keys', () => {
    expect(migration.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(migration).toContain('CREATE TABLE "executor_executions"');
    expect(migration).toContain('CREATE TABLE "executor_execution_attempts"');
    expect(migration).toContain('executor_executions_approval_tenant_fk');
    expect(migration).toContain('executor_executions_task_tenant_fk');
    expect(migration).toContain('executor_executions_run_tenant_fk');
    expect(migration).toContain('executor_execution_attempts_execution_tenant_fk');
  });

  it('creates referenced tenant uniqueness before each dependent lifecycle foreign key', () => {
    for (const [uniqueConstraint, foreignKey] of [
      ['approvals_tenant_id_uq', 'executor_executions_approval_tenant_fk'],
      ['tasks_tenant_id_uq', 'executor_executions_task_tenant_fk'],
      ['runs_tenant_id_uq', 'executor_executions_run_tenant_fk'],
    ]) {
      const uniquePosition = migration.indexOf(`ADD CONSTRAINT "${uniqueConstraint}"`);
      const foreignKeyPosition = migration.indexOf(`ADD CONSTRAINT "${foreignKey}"`);

      expect(uniquePosition).toBeGreaterThan(-1);
      expect(foreignKeyPosition).toBeGreaterThan(uniquePosition);
    }
  });

  it('enforces idempotency, confirmation single-use, active target, active attempt, hashes, and ambiguity', () => {
    for (const required of [
      'executor_executions_idempotency_uq', 'executor_executions_confirmation_uq',
      'executor_executions_live_target_uq', 'executor_execution_attempts_active_lease_uq',
      'executor_executions_hashes_ck', 'executor_executions_ambiguity_ck',
    ]) expect(migration).toContain(required);
  });

  it('adds both tables to forced tenant RLS and grants no delete or app_system authority', () => {
    const grantStatements = rls.match(/grant\s+[\s\S]*?;/gi) ?? [];
    const lifecycleGrants = grantStatements.filter((statement) =>
      /executor_executions|executor_execution_attempts/i.test(statement),
    );

    expect(rls).toContain("'executor_executions', 'executor_execution_attempts'");
    expect(rls).toMatch(/approvals, executor_executions, executor_execution_attempts,/);
    expect(lifecycleGrants).toHaveLength(1);
    expect(lifecycleGrants[0]).toMatch(/grant select, insert, update on/i);
    expect(lifecycleGrants[0]).toMatch(/to app_server/i);
    expect(lifecycleGrants[0]).not.toMatch(/delete|app_system/i);
  });

  it('does not weaken the dry-run-only dispatch boundary or add filesystem writes', () => {
    expect(dispatch).toContain("request.mode !== 'dry_run'");
    expect(dispatch).not.toMatch(/writeFile|appendFile|rename\(|unlink|mkdir/);
  });
});
