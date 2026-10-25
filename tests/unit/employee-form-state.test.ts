import { describe, expect, it } from 'vitest';
import { agentFormKey, employeeFormKey, employeePagePaths } from '@/app/p/[projectKey]/agents/employee-form-state';

// Hub prod 2026-10-25: the reviewer's model saved as gpt-5.4, but the page showed Claude Sonnet 5 again after save.
describe('employee page after a save', () => {
  it('revalidates the employee page as well as the list', () => {
    expect(employeePagePaths('empera-air-conditioning-and-heating', 'abc')).toEqual([
      '/p/empera-air-conditioning-and-heating/agents',
      '/p/empera-air-conditioning-and-heating/agents/abc',
    ]);
  });

  const agent = {
    id: '5fce0cbd',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    systemPrompt: 'You are the principal reviewer.',
    reviewRubric: null,
    temperatureMilli: 200,
    maxOutputTokens: 16384,
    enabled: true,
  };

  it('the agent form key changes when any saved value changes, so the form remounts with the new values', () => {
    const before = agentFormKey(agent);
    expect(agentFormKey({ ...agent })).toBe(before);
    for (const changed of [
      { ...agent, provider: 'openai', model: 'gpt-5.4' },
      { ...agent, systemPrompt: agent.systemPrompt + ' Be strict.' },
      { ...agent, reviewRubric: 'cite sources' },
      { ...agent, temperatureMilli: 0 },
      { ...agent, maxOutputTokens: 8000 },
      { ...agent, enabled: false },
    ]) {
      expect(agentFormKey(changed)).not.toBe(before);
    }
  });

  it('the key stays short for a long prompt', () => {
    expect(agentFormKey({ ...agent, systemPrompt: 'x'.repeat(50_000) }).length).toBeLessThan(120);
  });

  it('the identity form key changes with its fields', () => {
    const e = { id: 'e1', name: 'Principal Reviewer', title: null, departmentId: null, reportsToId: null, enabled: true };
    const k = employeeFormKey(e);
    expect(employeeFormKey({ ...e, name: 'Chief Reviewer' })).not.toBe(k);
    expect(employeeFormKey({ ...e, reportsToId: 'm1' })).not.toBe(k);
    expect(employeeFormKey({ ...e, enabled: false })).not.toBe(k);
  });
});
