import { describe, expect, it } from 'vitest';
import { knowledgeRelevance, significantTerms, MIN_SHARED_TERMS } from '@/domain/knowledge/relevance';

/**
 * Relevance is the eligibility signal that stops wholesale injection. Shared subject terms make an
 * item eligible; membership and recency never do (recency lives in the ranker, not here).
 */
describe('knowledgeRelevance', () => {
  it('drops stopwords and short tokens from significant terms', () => {
    const terms = significantTerms('The refund window is on the invoice');
    expect(terms.has('refund')).toBe(true);
    expect(terms.has('window')).toBe(true);
    expect(terms.has('invoice')).toBe(true);
    expect(terms.has('the')).toBe(false);
    expect(terms.has('is')).toBe(false);
    expect(terms.has('on')).toBe(false);
  });

  it('is eligible only with at least the minimum shared significant terms', () => {
    const query = significantTerms('postgres database schema migration');
    const related = knowledgeRelevance('Database migration policy — postgres schema', query);
    expect(related.eligible).toBe(true);
    expect(related.score).toBeGreaterThanOrEqual(MIN_SHARED_TERMS);

    const unrelated = knowledgeRelevance('Brand voice: warm, concise, plain language', query);
    expect(unrelated.eligible).toBe(false);
    expect(unrelated.score).toBe(0);
  });

  it('a single incidental shared term is not enough', () => {
    const query = significantTerms('database backup schedule');
    const one = knowledgeRelevance('The company database of employee birthdays', query); // shares only "database"
    expect(one.score).toBe(1);
    expect(one.eligible).toBe(false);
  });

  it('generic business vocabulary is excluded and cannot create relevance', () => {
    // These share only generic words (customer, project, process, price, task, work, company).
    const query = significantTerms('customer project process price task work company');
    expect(query.size).toBe(0); // all generic → no significant terms
    const rel = knowledgeRelevance('Customer project process price task work company handbook', query);
    expect(rel.eligible).toBe(false);
  });
});
