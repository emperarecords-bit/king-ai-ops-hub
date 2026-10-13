import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { opsChatConversations, opsChatMessages, opsChatProposals } from '@/db/schema';

/**
 * Ops Chat persistence — owner-private, USER-scoped conversation store.
 *
 * Ops Chat is the owner's cross-workspace front door (no single org/project), so these
 * tables are keyed on the user and gated by the notification_*_self RLS shape. Every
 * function here must run inside `withUser({ userId })` so `app.current_user_id()` is set;
 * with it unset the policies fail closed (no rows) — see src/db/rls.sql. The `userId`
 * arg is passed explicitly AND every write stamps it, so a row can never be created for
 * another user even if the GUC and the arg disagreed.
 *
 * Ordering is the generated bigint `seq` (a strong total order), never created_at alone.
 * Proposal payloads are immutable after creation; only state/result/error/decided_at
 * mutate, and state changes go through the compare-and-set `transitionProposal` so two
 * tabs/devices cannot confirm the same proposal twice.
 */

export type OpsChatMessageRole = 'user' | 'assistant';
export type OpsChatMessageStatus = 'complete' | 'interrupted';
export type OpsChatProposalState = 'pending' | 'confirming' | 'done' | 'error' | 'cancelled' | 'stale';

/** The allowed proposal state machine. Terminal states have no outgoing edges — a
 *  stale/errored/cancelled proposal requires a NEW proposal, never a re-transition. */
const ALLOWED_TRANSITIONS: Record<OpsChatProposalState, readonly OpsChatProposalState[]> = {
  pending: ['confirming', 'cancelled'],
  confirming: ['done', 'error', 'stale'],
  done: [],
  error: [],
  cancelled: [],
  stale: [],
};

export function canTransition(from: OpsChatProposalState, to: OpsChatProposalState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

const TERMINAL: ReadonlySet<OpsChatProposalState> = new Set(['done', 'error', 'cancelled', 'stale']);

const TITLE_MAX = 60;

/** A conversation title derived from the FIRST owner message: whitespace-normalized and
 *  truncated. Never from the opening pulse or an assistant turn; no AI generation. */
export function deriveTitle(firstOwnerMessage: string): string {
  const t = firstOwnerMessage.replace(/\s+/g, ' ').trim();
  if (t.length <= TITLE_MAX) return t;
  return `${t.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export async function createConversation(tx: DbTx, userId: string): Promise<{ id: string }> {
  const [row] = await tx.insert(opsChatConversations).values({ userId }).returning({ id: opsChatConversations.id });
  return row!;
}

/** Append the owner's message. On the FIRST owner message, set the conversation title
 *  (coalesce — only if still null, so the first one wins), and bump updated_at so the
 *  conversation floats to the top of the history list. */
export async function appendOwnerMessage(
  tx: DbTx,
  userId: string,
  args: { conversationId: string; content: string },
): Promise<{ id: string; seq: bigint }> {
  const [msg] = await tx
    .insert(opsChatMessages)
    .values({ conversationId: args.conversationId, userId, role: 'user', status: 'complete', content: args.content })
    .returning({ id: opsChatMessages.id, seq: opsChatMessages.seq });
  await tx
    .update(opsChatConversations)
    .set({ title: sql`coalesce(${opsChatConversations.title}, ${deriveTitle(args.content)})`, updatedAt: sql`now()` })
    .where(and(eq(opsChatConversations.id, args.conversationId), eq(opsChatConversations.userId, userId)));
  return msg!;
}

/** Append the assistant turn. `status` is 'complete' for a finished answer or
 *  'interrupted' for a stream that never reached its terminal event — an interrupted
 *  turn is kept for history but must never be presented as a completed answer. */
export async function appendAssistantMessage(
  tx: DbTx,
  userId: string,
  args: { conversationId: string; content: string; question?: string | null; status?: OpsChatMessageStatus },
): Promise<{ id: string; seq: bigint }> {
  const [msg] = await tx
    .insert(opsChatMessages)
    .values({
      conversationId: args.conversationId,
      userId,
      role: 'assistant',
      status: args.status ?? 'complete',
      content: args.content,
      question: args.question ?? null,
    })
    .returning({ id: opsChatMessages.id, seq: opsChatMessages.seq });
  await tx
    .update(opsChatConversations)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(opsChatConversations.id, args.conversationId), eq(opsChatConversations.userId, userId)));
  return msg!;
}

/** Persist a proposal card (state 'pending'). The payload is stored verbatim and treated
 *  as immutable — confirm reloads THIS row rather than trusting the browser. */
export async function addProposal(
  tx: DbTx,
  userId: string,
  args: { conversationId: string; messageId: string; kind: string; proposal: unknown },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(opsChatProposals)
    .values({
      conversationId: args.conversationId,
      messageId: args.messageId,
      userId,
      kind: args.kind,
      proposal: args.proposal as object,
    })
    .returning({ id: opsChatProposals.id });
  return row!;
}

/**
 * Compare-and-set a proposal's state. The update matches only when the row is still in
 * `from` (and owned by this user), so a second confirmer — another tab or device —
 * sees 0 rows and loses the race. Returns the updated row, or null on a CAS miss
 * (already transitioned / wrong current state). The payload is never modified.
 */
export async function transitionProposal(
  tx: DbTx,
  userId: string,
  args: {
    proposalId: string;
    from: OpsChatProposalState;
    to: OpsChatProposalState;
    result?: unknown;
    error?: string | null;
  },
): Promise<{ id: string; state: OpsChatProposalState } | null> {
  if (!canTransition(args.from, args.to)) {
    throw new Error(`ops-chat: illegal proposal transition ${args.from} -> ${args.to}`);
  }
  const rows = await tx
    .update(opsChatProposals)
    .set({
      state: args.to,
      ...(args.result !== undefined ? { result: args.result as object } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(TERMINAL.has(args.to) ? { decidedAt: sql`now()` } : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(opsChatProposals.id, args.proposalId),
        eq(opsChatProposals.userId, userId),
        eq(opsChatProposals.state, args.from),
      ),
    )
    .returning({ id: opsChatProposals.id, state: opsChatProposals.state });
  const row = rows[0];
  return row ? { id: row.id, state: row.state as OpsChatProposalState } : null;
}

/** The immutable proposal as persisted (for the confirm path to re-load and re-validate
 *  server-side instead of trusting the client payload). */
export async function loadProposal(
  tx: DbTx,
  userId: string,
  proposalId: string,
): Promise<{ id: string; conversationId: string; messageId: string; kind: string; proposal: unknown; state: OpsChatProposalState } | null> {
  const rows = await tx
    .select({
      id: opsChatProposals.id,
      conversationId: opsChatProposals.conversationId,
      messageId: opsChatProposals.messageId,
      kind: opsChatProposals.kind,
      proposal: opsChatProposals.proposal,
      state: opsChatProposals.state,
    })
    .from(opsChatProposals)
    .where(and(eq(opsChatProposals.id, proposalId), eq(opsChatProposals.userId, userId)))
    .limit(1);
  const r = rows[0];
  return r ? { ...r, state: r.state as OpsChatProposalState } : null;
}

export interface LoadedMessage {
  id: string;
  seq: bigint;
  role: OpsChatMessageRole;
  status: OpsChatMessageStatus;
  content: string;
  question: string | null;
  createdAt: Date;
  proposals: Array<{
    id: string;
    seq: bigint;
    kind: string;
    proposal: unknown;
    state: OpsChatProposalState;
    result: unknown;
    error: string | null;
  }>;
}

/**
 * Load a conversation for display. Bounded: returns at most the last `limit` messages (by
 * seq) in chronological order, each with its proposal cards. This is the DISPLAY window;
 * the model-prompt history the server sends to the provider is bounded separately and
 * more tightly, so a long thread never bloats model context.
 */
export async function loadConversation(
  tx: DbTx,
  userId: string,
  conversationId: string,
  opts: { limit?: number } = {},
): Promise<{ conversation: { id: string; title: string | null; createdAt: Date; updatedAt: Date }; messages: LoadedMessage[] } | null> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const conv = await tx
    .select({ id: opsChatConversations.id, title: opsChatConversations.title, createdAt: opsChatConversations.createdAt, updatedAt: opsChatConversations.updatedAt })
    .from(opsChatConversations)
    .where(and(eq(opsChatConversations.id, conversationId), eq(opsChatConversations.userId, userId)))
    .limit(1);
  if (!conv[0]) return null;

  // Last `limit` by seq, then flip to chronological.
  const recent = await tx
    .select({
      id: opsChatMessages.id,
      seq: opsChatMessages.seq,
      role: opsChatMessages.role,
      status: opsChatMessages.status,
      content: opsChatMessages.content,
      question: opsChatMessages.question,
      createdAt: opsChatMessages.createdAt,
    })
    .from(opsChatMessages)
    .where(and(eq(opsChatMessages.conversationId, conversationId), eq(opsChatMessages.userId, userId)))
    .orderBy(desc(opsChatMessages.seq))
    .limit(limit);
  recent.reverse();

  const props = await tx
    .select({
      id: opsChatProposals.id,
      seq: opsChatProposals.seq,
      messageId: opsChatProposals.messageId,
      kind: opsChatProposals.kind,
      proposal: opsChatProposals.proposal,
      state: opsChatProposals.state,
      result: opsChatProposals.result,
      error: opsChatProposals.error,
    })
    .from(opsChatProposals)
    .where(and(eq(opsChatProposals.conversationId, conversationId), eq(opsChatProposals.userId, userId)))
    .orderBy(asc(opsChatProposals.seq));

  const byMessage = new Map<string, LoadedMessage['proposals']>();
  for (const p of props) {
    const list = byMessage.get(p.messageId) ?? [];
    list.push({ id: p.id, seq: p.seq, kind: p.kind, proposal: p.proposal, state: p.state as OpsChatProposalState, result: p.result, error: p.error });
    byMessage.set(p.messageId, list);
  }

  return {
    conversation: conv[0],
    messages: recent.map((m) => ({
      id: m.id,
      seq: m.seq,
      role: m.role as OpsChatMessageRole,
      status: m.status as OpsChatMessageStatus,
      content: m.content,
      question: m.question,
      createdAt: m.createdAt,
      proposals: byMessage.get(m.id) ?? [],
    })),
  };
}

/** A user's conversations, most-recently-updated first (the history list). */
export async function listConversations(
  tx: DbTx,
  userId: string,
  opts: { limit?: number } = {},
): Promise<Array<{ id: string; title: string | null; updatedAt: Date; createdAt: Date }>> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  return tx
    .select({ id: opsChatConversations.id, title: opsChatConversations.title, updatedAt: opsChatConversations.updatedAt, createdAt: opsChatConversations.createdAt })
    .from(opsChatConversations)
    .where(eq(opsChatConversations.userId, userId))
    .orderBy(desc(opsChatConversations.updatedAt), desc(opsChatConversations.id))
    .limit(limit);
}

/** The conversation to restore on a bare `/ops` load (no ?c=): the most recent. */
export async function mostRecentConversationId(tx: DbTx, userId: string): Promise<string | null> {
  const rows = await listConversations(tx, userId, { limit: 1 });
  return rows[0]?.id ?? null;
}
