import { describe, expect, it } from 'vitest';
import { splitPriceSources, suggestedCount } from '@/domain/opschat/price-sources';

describe('splitPriceSources', () => {
  it('strips source / source_note from every line and labels each one; missing or unknown source = the owner', () => {
    const { cleaned, pricing } = splitPriceSources({
      job_name: 'J',
      materials: [
        { description: 'Unit', quantity: 2, unit_cost: 5000 },
        { description: 'Kit', quantity: 2, unit_cost: 450, source: 'estimate', source_note: '  typical\n kit  ' },
        { description: 'Odd', quantity: 1, unit_cost: 1, source: 'made-up' },
      ],
      labor: [{ description: 'Labour', hours: 16, hourly_rate: 110, source: 'research', source_note: 'x'.repeat(500) }],
      additional_charges: [{ description: 'Permit', amount: 150, source: 'estimate' }],
    });
    expect(JSON.stringify(cleaned)).not.toMatch(/source/);
    expect(cleaned.job_name).toBe('J');
    expect(pricing.map((p) => p.source)).toEqual(['owner', 'estimate', 'owner', 'research', 'estimate']);
    expect(pricing[1]!.note).toBe('typical kit');
    expect(pricing[3]!.note!.length).toBe(200);
    expect(suggestedCount(pricing)).toBe(3);
    expect(suggestedCount(undefined)).toBe(0);
  });
});
