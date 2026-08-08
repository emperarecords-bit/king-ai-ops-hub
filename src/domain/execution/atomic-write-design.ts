export const ATOMIC_WRITE_STAGES = [
  'intent_recorded', 'path_validated', 'links_inspected', 'precondition_verified', 'identities_captured',
  'temp_allocated', 'temp_bytes_staged', 'temp_hash_verified', 'temp_durable', 'identities_rechecked',
  'atomic_commit', 'directory_durable', 'postcondition_verified', 'result_persisted', 'cleanup_complete',
] as const;
export type AtomicWriteStage = (typeof ATOMIC_WRITE_STAGES)[number];

export interface AtomicWriteDesignState {
  readonly completed: readonly AtomicWriteStage[];
  readonly ambiguous: boolean;
}

export function advanceAtomicWriteDesign(state: AtomicWriteDesignState, next: AtomicWriteStage): AtomicWriteDesignState {
  if (state.ambiguous) throw new Error('ambiguous atomic write requires reconciliation');
  const expected = ATOMIC_WRITE_STAGES[state.completed.length];
  if (next !== expected) throw new Error(`atomic write stage out of order: expected ${expected ?? 'terminal'}`);
  return { completed: [...state.completed, next], ambiguous: false };
}

export function crashAtomicWriteDesign(state: AtomicWriteDesignState): 'definitely_not_executed' | 'ambiguous' {
  return state.completed.includes('atomic_commit') ? 'ambiguous' : 'definitely_not_executed';
}

export function identityRecheckMatches(captured: readonly string[], rechecked: readonly string[]): boolean {
  return captured.length > 0 && captured.length === rechecked.length && captured.every((value, index) => value === rechecked[index]);
}
