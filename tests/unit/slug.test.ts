import { describe, expect, it } from 'vitest';
import { METRIC_PATTERN, slugifyMetric } from '@/lib/slug';

/**
 * Regression pins for O-11. The real failure was a metric key containing a
 * slash, produced by a naive whitespace replace on a label the model wrote.
 */
describe('slugifyMetric', () => {
  it('fixes the exact key that caused O-11', () => {
    const label = 'Number of project/workspace integrations connected to the hub';
    const slug = slugifyMetric(label);
    expect(slug).not.toContain('/');
    expect(METRIC_PATTERN.test(slug)).toBe(true);
  });

  it('always produces a valid identifier', () => {
    const labels = [
      'Number of AI chat sources connected',
      '% of chats searchable in one place',
      'Revenue ($) per customer — net',
      '100 beta users signed up',
      'Café visits/month',
      '   ',
      '!!!',
      'a'.repeat(300),
    ];
    for (const label of labels) {
      const slug = slugifyMetric(label);
      expect(METRIC_PATTERN.test(slug), `${label} → ${slug}`).toBe(true);
      expect(slug.length).toBeLessThanOrEqual(60);
    }
  });

  it('prefixes slugs that would start with a digit', () => {
    expect(slugifyMetric('100 beta users')).toBe('m_100_beta_users');
  });

  it('falls back rather than returning an empty key', () => {
    expect(slugifyMetric('!!!')).toBe('metric');
    expect(slugifyMetric('')).toBe('metric');
  });

  it('collapses separators instead of stacking them', () => {
    expect(slugifyMetric('a  --  b')).toBe('a_b');
  });
});
