import { describe, expect, it } from 'vitest';
import {
  POSITION_KEYS,
  POSITION_TEMPLATES,
  getPositionTemplate,
} from '@/domain/agents/position-templates';
import { STANDARD_DEPARTMENTS } from '@/domain/projects/provision';
import { knownModel, providerSupportsModel } from '@/providers/pricing';
import { AGENT_ROLES } from '@/types/domain';

/**
 * The position library backs voice/MCP provisioning — every template must be
 * hireable as-is through createEmployeeWithConfig, so each default config is
 * validated here against the same catalogs that gate the real hire.
 */

const DEPARTMENT_KEYS = new Set<string>(STANDARD_DEPARTMENTS.map(([key]) => key));

describe('position templates', () => {
  it('has unique keys and a working lookup', () => {
    expect(new Set(POSITION_KEYS).size).toBe(POSITION_TEMPLATES.length);
    for (const t of POSITION_TEMPLATES) expect(getPositionTemplate(t.key)).toBe(t);
    expect(getPositionTemplate('court_jester')).toBeUndefined();
  });

  it('every default provider/model pair passes the provisioning catalog gate', () => {
    for (const t of POSITION_TEMPLATES) {
      expect(knownModel(t.model), `${t.key} model`).toBe(true);
      expect(providerSupportsModel(t.provider, t.model), `${t.key} provider/model`).toBe(true);
    }
  });

  it('every department key is a STANDARD_DEPARTMENTS member (no orphan hires)', () => {
    for (const t of POSITION_TEMPLATES) {
      expect(DEPARTMENT_KEYS.has(t.department), `${t.key} → ${t.department}`).toBe(true);
    }
  });

  it('every role is a valid agent role and at least one reviewer exists', () => {
    for (const t of POSITION_TEMPLATES) {
      expect((AGENT_ROLES as readonly string[]).includes(t.role), t.key).toBe(true);
    }
    expect(POSITION_TEMPLATES.some((t) => t.role === 'reviewer')).toBe(true);
  });

  it('missions embed the business name and fit the employee prompt cap', () => {
    for (const t of POSITION_TEMPLATES) {
      const mission = t.mission("Rosie's Bakery");
      expect(mission).toContain("Rosie's Bakery");
      expect(mission.trim().length).toBeGreaterThan(100);
      expect(mission.length).toBeLessThanOrEqual(20_000);
    }
  });

  it('defaults keep the owner cost posture: majority of primaries on low-cost vendors', () => {
    const primaries = POSITION_TEMPLATES.filter((t) => t.role === 'primary');
    const cheap = primaries.filter((t) => t.provider === 'google' || t.provider === 'deepseek');
    expect(cheap.length).toBe(primaries.length);
  });
});
