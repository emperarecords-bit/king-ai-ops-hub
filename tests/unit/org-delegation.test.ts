import { describe, expect, it } from 'vitest';
import { buildDelegationRules, extractDelegatedTasks } from '@/orchestration/delegations';
import { extractProposedActions } from '@/orchestration/actions';
import { ACTION_BLOCK_OPEN } from '@/orchestration/prompts';
import { orgDelegationPayloadSchema } from '@/domain/execution/org-delegation-executor';
import { EXECUTOR_RISK_BY_ACTION } from '@/domain/execution/executor-policy';

/** Cross-workspace delegation v2: extraction, prompt contract, and payload boundaries. */
describe('cross-workspace delegation (org_delegation)', () => {
  it('delegated-tasks entries accept an optional workspace key', () => {
    const text = [
      'Handled.',
      '```delegated-tasks',
      JSON.stringify([
        { assignee: 'Research Analyst', title: 'Local', instructions: 'Do local work.' },
        { assignee: 'General Manager', title: 'Remote', instructions: 'Do remote work.', workspace: 'other-business' },
      ]),
      '```',
    ].join('\n');
    const out = extractDelegatedTasks(text);
    expect(out.rejected).toEqual([]);
    expect(out.delegations).toHaveLength(2);
    expect(out.delegations[0]!.workspace).toBeUndefined();
    expect(out.delegations[1]!.workspace).toBe('other-business');
  });

  it('unknown keys in a delegation entry are still refused (strict, never repaired)', () => {
    const text = ['```delegated-tasks', JSON.stringify([{ assignee: 'A', title: 'T', instructions: 'I', target: 'x' }]), '```'].join('\n');
    const out = extractDelegatedTasks(text);
    expect(out.delegations).toHaveLength(0);
    expect(out.rejected).toHaveLength(1);
  });

  it('delegation rules mention cross-business targets ONLY when targets are provided', () => {
    const plain = buildDelegationRules(['Alice']);
    expect(plain).not.toContain('CROSS-BUSINESS');
    const hq = buildDelegationRules(['Alice'], [{ key: 'accuratebids-com', name: 'AccurateBids.com' }]);
    expect(hq).toContain('CROSS-BUSINESS');
    expect(hq).toContain('"accuratebids-com" (AccurateBids.com)');
    expect(hq).toContain("owner's Inbox");
  });

  it('a model proposing org_delegation as an action is refused at extraction', () => {
    const text = [
      `${ACTION_BLOCK_OPEN}`,
      JSON.stringify([{ type: 'org_delegation', summary: 'sneak', payload: { targetProjectKey: 'x', title: 't', instructions: 'i' } }]),
      '```',
    ].join('\n');
    const out = extractProposedActions(text);
    expect(out.actions).toHaveLength(0);
    expect(out.rejected.some((r) => r.includes('hub-minted'))).toBe(true);
  });

  it('the executor payload schema is strict and bounded', () => {
    expect(orgDelegationPayloadSchema.safeParse({ targetProjectKey: 'k', title: 't', instructions: 'i' }).success).toBe(true);
    expect(orgDelegationPayloadSchema.safeParse({ targetProjectKey: 'k', title: 't', instructions: 'i', extra: 1 }).success).toBe(false);
    expect(orgDelegationPayloadSchema.safeParse({ targetProjectKey: 'k', title: '', instructions: 'i' }).success).toBe(false);
    expect(orgDelegationPayloadSchema.safeParse({ targetProjectKey: 'k', title: 't', instructions: 'x'.repeat(8_001) }).success).toBe(false);
  });

  it('org_delegation is an internal reversible write — never external, never destructive', () => {
    expect(EXECUTOR_RISK_BY_ACTION.org_delegation).toBe('reversible_internal_write');
  });
});
