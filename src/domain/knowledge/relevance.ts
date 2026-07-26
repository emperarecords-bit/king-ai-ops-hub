/**
 * Knowledge relevance — the eligibility signal that stops wholesale injection. Approval permits a
 * record to be used; relevance decides whether it belongs in THIS run. Until Knowledge carries
 * narrower structural scope fields, the safest available signal is shared subject vocabulary between
 * the item and the run's query (task input + objective). Workspace membership alone is NOT relevance,
 * and recency never creates it — recency may only rank records already found eligible.
 *
 * This is deliberately conservative: no shared subject terms → omit the item. Reduced recall is safer
 * than unrelated context silently shaping work.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'has', 'have', 'had',
  'not', 'but', 'you', 'your', 'our', 'their', 'its', 'his', 'her', 'they', 'them', 'then', 'than',
  'into', 'onto', 'over', 'under', 'about', 'above', 'below', 'when', 'where', 'what', 'which', 'who',
  'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must', 'shall', 'a', 'an', 'of', 'to',
  'in', 'on', 'at', 'by', 'is', 'it', 'as', 'be', 'or', 'if', 'we', 'do', 'does', 'did', 'all', 'any',
  'each', 'every', 'some', 'more', 'most', 'such', 'only', 'own', 'same', 'so', 'too', 'very', 'up',
  'out', 'off', 'per', 'via', 'use', 'used', 'using', 'make', 'made',
]);

/**
 * Generic business vocabulary that co-occurs across unrelated work, so it must NOT create relevance.
 * A shared "customer"/"project"/"process" term is not evidence that two records concern the same
 * subject. Excluded from the significant-term set entirely (lexical relevance is transitional — real
 * structural scope/entity signals will supersede it).
 */
const GENERIC = new Set([
  'customer', 'customers', 'client', 'clients', 'project', 'projects', 'process', 'processes',
  'price', 'prices', 'pricing', 'task', 'tasks', 'work', 'working', 'company', 'business',
  'team', 'workspace', 'objective', 'objectives', 'goal', 'goals', 'data', 'info', 'information',
  'system', 'systems', 'service', 'services', 'product', 'products', 'update', 'updates',
  'general', 'standard', 'standards', 'policy', 'policies', 'note', 'notes', 'item', 'items',
]);

/** Significant terms of a text: lowercased alphanumeric tokens ≥3 chars, minus stopwords AND generics. */
export function significantTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw) && !GENERIC.has(raw)) out.add(raw);
  }
  return out;
}

/** The minimum shared significant terms for a workspace item to be considered relevant to a run. */
export const MIN_SHARED_TERMS = 2;

export interface KnowledgeRelevance {
  eligible: boolean;
  score: number;
  sharedTerms: string[];
}

/**
 * Subject relevance between a knowledge item and the run query. Eligible only when they share at
 * least MIN_SHARED_TERMS significant terms; the score is the shared-term count (ranking only).
 */
export function knowledgeRelevance(itemText: string, queryTerms: Set<string>): KnowledgeRelevance {
  const terms = significantTerms(itemText);
  const shared: string[] = [];
  for (const t of terms) if (queryTerms.has(t)) shared.push(t);
  return { eligible: shared.length >= MIN_SHARED_TERMS, score: shared.length, sharedTerms: shared };
}
