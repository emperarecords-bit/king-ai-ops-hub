/**
 * What Ops Chat must DO with stale work — said identically by task state, get_task_result, the conversation section and
 * the tool description. Evidence (Hub prod 2026-10-22, first v92 turn): told to "offer ONE update card", the model asked
 * "Want me to dispatch one fresh run…? Nothing runs until you confirm." — the same ask-and-wait loop P5c-2 exists to
 * remove. Preparing the card starts nothing: the card IS the owner's confirmation step.
 *
 * Its own module (no imports) so task-state, tools and the continuity section can all use it without import cycles.
 */
export const PREPARE_UPDATE_CARD =
  "PREPARE ONE update card now with propose_update_task — preparing it starts nothing (the card is the owner's confirmation), so do not ask permission to prepare it; never redo stale work with propose_dispatch_task or propose_rerun_task.";
