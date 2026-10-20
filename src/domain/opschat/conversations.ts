import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { opsChatConversations, opsChatMessages, opsChatProposals } from '@/db/schema';
import { cardStateLines, type StoredCard } from '@/domain/opschat/card-state';
import { type LinkedRunView } from '@/domain/opschat/linked-run-view';
import { RUN_STARTING_KINDS, type LinkableCard } from '@/domain/opschat/linked-runs';

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

/** One prompt turn. Owner turns carry their message id so the route can attach that turn's files. */
export interface PromptTurn {
  role: OpsChatMessageRole;
  content: string;
  ownerMessageId?: string;
}

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

/**
 * Create a conversation. With a caller-provided `id` the insert is IDEMPOTENT
 * (onConflictDoNothing) so the exact same request — `(conversationId, turnId, content)` — can be
 * replayed after a total network failure without forking a second conversation; the caller then
 * verifies ownership separately (an id that already belongs to another user is left untouched and
 * `conversationExists` returns false → the route rejects it). Without an `id` a fresh random id is
 * minted and always returned.
 */
export async function createConversation(tx: DbTx, userId: string, opts: { id?: string } = {}): Promise<{ id: string }> {
  if (opts.id) {
    await tx.insert(opsChatConversations).values({ id: opts.id, userId }).onConflictDoNothing();
    return { id: opts.id };
  }
  const [row] = await tx.insert(opsChatConversations).values({ userId }).returning({ id: opsChatConversations.id });
  return row!;
}

/** Does this conversation exist AND belong to this user? (RLS already scopes to the user;
 *  this gives the route a clean not-found instead of a downstream FK violation when a
 *  client sends a conversation id that isn't theirs.) */
export async function conversationExists(tx: DbTx, userId: string, conversationId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: opsChatConversations.id })
    .from(opsChatConversations)
    .where(and(eq(opsChatConversations.id, conversationId), eq(opsChatConversations.userId, userId)))
    .limit(1);
  return !!rows[0];
}

/**
 * The bounded, TURN-AWARE prompt history the server sends to the provider for `ownerMessageId`.
 *
 * Built from OWNER turns in owner-message order (by seq), up to and including the current owner
 * message, each followed by its COMPLETE linked assistant reply (via reply_to_message_id) — NEVER
 * by raw message seq. This is deliberate: a second owner message can be persisted while the first
 * turn is still executing, so the first turn's assistant reply can end up with a HIGHER seq than
 * the second owner message. A naive `seq <= owner.seq` window would then drop that reply from the
 * later turn's prompt (or, worse, let a turn see a later owner message as the "latest" user turn).
 * Reconstructing by the explicit owner→reply link attaches every reply to its own turn regardless
 * of seq interleaving.
 *
 * INTERRUPTED assistant output is EXCLUDED — it is historical/UI evidence, not a completed answer,
 * and must never be fed back as model history. The current owner message is always the final turn
 * and never carries a trailing assistant (its reply is what we are about to generate). Bounded to
 * the last `maxOwnerTurns` owner turns (≤ ~2× messages).
 */
export async function loadPromptTurns(
  tx: DbTx,
  userId: string,
  conversationId: string,
  ownerMessageId: string,
  opts: {
    maxOwnerTurns?: number;
    /** P5a: each confirmed dispatch/re-run card's linked run (from loadLinkedRunViews), keyed by card id. */
    linkedRuns?: ReadonlyMap<string, LinkedRunView>;
  } = {},
): Promise<PromptTurn[]> {
  const maxTurns = Math.max(1, Math.min(opts.maxOwnerTurns ?? 8, 50));

  // The current owner message fixes the upper bound (its seq). It is always persisted first.
  const cur = await tx
    .select({ seq: opsChatMessages.seq })
    .from(opsChatMessages)
    .where(and(eq(opsChatMessages.id, ownerMessageId), eq(opsChatMessages.userId, userId), eq(opsChatMessages.conversationId, conversationId), eq(opsChatMessages.role, 'user')))
    .limit(1);
  if (!cur[0]) throw new AppError('not_found', 'The owner message for this turn was not found.');
  const curSeq = cur[0].seq;

  // The last `maxTurns` OWNER messages with seq ≤ the current one, newest first → chronological.
  const owners = await tx
    .select({ id: opsChatMessages.id, content: opsChatMessages.content })
    .from(opsChatMessages)
    .where(and(eq(opsChatMessages.conversationId, conversationId), eq(opsChatMessages.userId, userId), eq(opsChatMessages.role, 'user'), lte(opsChatMessages.seq, curSeq)))
    .orderBy(desc(opsChatMessages.seq))
    .limit(maxTurns);
  owners.reverse();

  // Their COMPLETE assistant replies, resolved by the explicit owner→reply link (not seq).
  const ownerIds = owners.map((o) => o.id);
  const replies = ownerIds.length
    ? await tx
        .select({ id: opsChatMessages.id, replyTo: opsChatMessages.replyToMessageId, content: opsChatMessages.content })
        .from(opsChatMessages)
        .where(
          and(
            eq(opsChatMessages.conversationId, conversationId),
            eq(opsChatMessages.userId, userId),
            eq(opsChatMessages.role, 'assistant'),
            eq(opsChatMessages.status, 'complete'),
            inArray(opsChatMessages.replyToMessageId, ownerIds),
          ),
        )
    : [];
  // Each reply's cards, with their CURRENT stored state (card-state.ts): history text never overrides
  // what actually happened to a card after it was shown.
  const replyIds = replies.map((r) => r.id);
  const cards = replyIds.length
    ? await tx
        .select({
          id: opsChatProposals.id,
          messageId: opsChatProposals.messageId,
          kind: opsChatProposals.kind,
          state: opsChatProposals.state,
          proposal: opsChatProposals.proposal,
          result: opsChatProposals.result,
          error: opsChatProposals.error,
          updatedAt: opsChatProposals.updatedAt,
        })
        .from(opsChatProposals)
        .where(and(eq(opsChatProposals.userId, userId), eq(opsChatProposals.conversationId, conversationId), inArray(opsChatProposals.messageId, replyIds)))
        .orderBy(asc(opsChatProposals.createdAt))
    : [];
  const cardsByMessage = new Map<string, StoredCard[]>();
  for (const c of cards) {
    const list = cardsByMessage.get(c.messageId) ?? [];
    list.push({
      id: c.id,
      kind: c.kind,
      state: c.state,
      proposal: (c.proposal ?? {}) as Record<string, unknown>,
      result: c.result,
      error: c.error,
      updatedAt: c.updatedAt,
      linkedRun: opts.linkedRuns?.get(c.id) ?? null,
    });
    cardsByMessage.set(c.messageId, list);
  }
  const replyByOwner = new Map<string, string>();
  for (const r of replies) if (r.replyTo) replyByOwner.set(r.replyTo, r.content + cardStateLines(cardsByMessage.get(r.id) ?? []));

  const turns: PromptTurn[] = [];
  for (const o of owners) {
    turns.push({ role: 'user', content: o.content, ownerMessageId: o.id });
    // The current owner message is the turn we are answering now — never attach a trailing reply.
    if (o.id !== ownerMessageId) {
      const reply = replyByOwner.get(o.id);
      if (reply !== undefined) turns.push({ role: 'assistant', content: reply });
    }
  }
  return turns;
}

/**
 * Append the owner's message, IDEMPOTENTLY on a caller-provided `id` (the turn id the
 * client mints once per send). A browser/network retry re-sends the same id; the insert
 * is onConflictDoNothing, so a retry neither duplicates the turn nor lets the route run
 * the model twice (the route checks `inserted`). Only on a genuine first insert do we set
 * the conversation title (coalesce — first owner message wins) and bump updated_at.
 * Without an `id` a fresh UUID is generated and `inserted` is always true.
 */
export async function appendOwnerMessage(
  tx: DbTx,
  userId: string,
  args: { conversationId: string; content: string; id?: string },
): Promise<{ id: string; seq: bigint; inserted: boolean }> {
  const inserted = await tx
    .insert(opsChatMessages)
    .values({ ...(args.id ? { id: args.id } : {}), conversationId: args.conversationId, userId, role: 'user', status: 'complete', content: args.content })
    .onConflictDoNothing()
    .returning({ id: opsChatMessages.id, seq: opsChatMessages.seq });
  if (inserted[0]) {
    await tx
      .update(opsChatConversations)
      .set({ title: sql`coalesce(${opsChatConversations.title}, ${deriveTitle(args.content)})`, updatedAt: sql`now()` })
      .where(and(eq(opsChatConversations.id, args.conversationId), eq(opsChatConversations.userId, userId)));
    return { ...inserted[0], inserted: true };
  }
  // Retry path — a conflict is only a LEGITIMATE retry when the existing row is THE SAME
  // turn: same id + same user + same conversation + same content + role=user. Anything else
  // (a client reusing one of its ids with a different conversation or different text) is a
  // hard conflict and is never silently reinterpreted as a retry.
  const existing = await tx
    .select({ id: opsChatMessages.id, seq: opsChatMessages.seq, conversationId: opsChatMessages.conversationId, content: opsChatMessages.content, role: opsChatMessages.role })
    .from(opsChatMessages)
    .where(and(eq(opsChatMessages.id, args.id!), eq(opsChatMessages.userId, userId)))
    .limit(1);
  const e = existing[0];
  if (!e || e.conversationId !== args.conversationId || e.content !== args.content || e.role !== 'user') {
    throw new AppError('conflict', 'This turn id does not match its original message.');
  }
  return { id: e.id, seq: e.seq, inserted: false };
}

/**
 * The assistant reply that followed an owner message (for an idempotent retry replay):
 * the first assistant message after the owner message in the same conversation, with its
 * proposals. Returns null if the turn produced no reply yet (the prior attempt didn't
 * finish) — the route may then run the model, since the owner message is already persisted.
 */
export async function loadReplyForOwnerMessage(
  tx: DbTx,
  userId: string,
  ownerMessageId: string,
): Promise<{ conversationId: string; messageId: string; content: string; status: OpsChatMessageStatus; question: string | null; proposals: Array<{ id: string; kind: string; proposal: unknown; state: OpsChatProposalState; result: unknown; error: string | null }> } | null> {
  // Explicit linkage: the assistant message whose reply_to_message_id IS this owner message.
  // (Never seq-adjacency, which would misassociate two interleaved owner turns.)
  const reply = await tx
    .select({ id: opsChatMessages.id, conversationId: opsChatMessages.conversationId, content: opsChatMessages.content, status: opsChatMessages.status, question: opsChatMessages.question })
    .from(opsChatMessages)
    .where(
      and(
        eq(opsChatMessages.replyToMessageId, ownerMessageId),
        eq(opsChatMessages.userId, userId),
        eq(opsChatMessages.role, 'assistant'),
      ),
    )
    .limit(1);
  if (!reply[0]) return null;
  const props = await tx
    .select({ id: opsChatProposals.id, kind: opsChatProposals.kind, proposal: opsChatProposals.proposal, state: opsChatProposals.state, result: opsChatProposals.result, error: opsChatProposals.error })
    .from(opsChatProposals)
    .where(and(eq(opsChatProposals.messageId, reply[0].id), eq(opsChatProposals.userId, userId)))
    .orderBy(asc(opsChatProposals.seq));
  return {
    conversationId: reply[0].conversationId,
    messageId: reply[0].id,
    content: reply[0].content,
    status: reply[0].status as OpsChatMessageStatus,
    question: reply[0].question,
    proposals: props.map((p) => ({ id: p.id, kind: p.kind, proposal: p.proposal, state: p.state as OpsChatProposalState, result: p.result, error: p.error })),
  };
}

/**
 * The EARLIEST owner message in a conversation (by seq) that has no TERMINAL assistant reply —
 * i.e. the next owner turn that must be answered. A reply is terminal whether it is 'complete' or
 * 'interrupted': an interrupted turn is not model history, but it DOES close that owner turn (the
 * user must send a new message to continue), so it must not block later turns forever.
 *
 * The route uses this to enforce FIFO execution within a conversation: the conversation lock only
 * guarantees one execution at a time, not ORDER — if B and C both queued behind a running A and C
 * retries first, C must not execute before B. The route runs a turn only when THIS owner message is
 * the earliest unanswered one; otherwise it returns a retry and lets the earlier turn go first.
 * Returns null only if the conversation has no owner messages at all (never, in the route path).
 */
export async function earliestUnansweredOwnerId(tx: DbTx, userId: string, conversationId: string): Promise<string | null> {
  return (await earliestUnansweredOwnerTurn(tx, userId, conversationId))?.id ?? null;
}

/**
 * The same earliest-unanswered owner turn as `earliestUnansweredOwnerId`, with its ORIGINAL content —
 * what the page needs to offer an explicit "Resume message" that re-sends the exact
 * `(conversationId, turnId, content)`. The owner message id IS the client-minted turnId.
 *
 * A pending turn can mean several things (rate-limited before the provider ran, a setup failure, a
 * reply generated but not persisted, …); the UI recovers from this DATABASE FACT rather than guessing
 * why — and never auto-retries it, since a retry can spend a new model call.
 */
export async function earliestUnansweredOwnerTurn(
  tx: DbTx,
  userId: string,
  conversationId: string,
): Promise<{ id: string; content: string } | null> {
  const reply = alias(opsChatMessages, 'reply');
  const rows = await tx
    .select({ id: opsChatMessages.id, content: opsChatMessages.content })
    .from(opsChatMessages)
    // Anti-join: owner messages whose (at-most-one) assistant reply with a terminal status is absent.
    .leftJoin(
      reply,
      and(
        eq(reply.replyToMessageId, opsChatMessages.id),
        eq(reply.userId, userId),
        eq(reply.role, 'assistant'),
        inArray(reply.status, ['complete', 'interrupted']),
      ),
    )
    .where(
      and(
        eq(opsChatMessages.conversationId, conversationId),
        eq(opsChatMessages.userId, userId),
        eq(opsChatMessages.role, 'user'),
        isNull(reply.id),
      ),
    )
    .orderBy(asc(opsChatMessages.seq))
    .limit(1);
  return rows[0] ?? null;
}

/** Append the assistant turn. `status` is 'complete' for a finished answer or
 *  'interrupted' for a stream that never reached its terminal event — an interrupted
 *  turn is kept for history but must never be presented as a completed answer. */
export async function appendAssistantMessage(
  tx: DbTx,
  userId: string,
  args: { conversationId: string; content: string; replyToMessageId: string; question?: string | null; status?: OpsChatMessageStatus },
): Promise<{ id: string; seq: bigint }> {
  // The reply target MUST be an owner (role='user') message in the same conversation/user.
  // The composite FK enforces "same conversation" and RLS enforces "same user", but neither
  // can enforce role — so verify it here and fail closed, otherwise a bug could permanently
  // (messages are append-only) link an assistant reply to another assistant message.
  const target = await tx
    .select({ role: opsChatMessages.role })
    .from(opsChatMessages)
    .where(and(eq(opsChatMessages.id, args.replyToMessageId), eq(opsChatMessages.userId, userId), eq(opsChatMessages.conversationId, args.conversationId)))
    .limit(1);
  if (!target[0] || target[0].role !== 'user') {
    throw new AppError('conflict', 'An assistant reply must link to an owner message in the same conversation.');
  }
  const [msg] = await tx
    .insert(opsChatMessages)
    .values({
      conversationId: args.conversationId,
      userId,
      role: 'assistant',
      status: args.status ?? 'complete',
      content: args.content,
      question: args.question ?? null,
      replyToMessageId: args.replyToMessageId,
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
  /** For an assistant message: the owner message it answers (explicit linkage). Null for owner rows. */
  replyToMessageId: string | null;
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
): Promise<{ conversation: { id: string; title: string | null; createdAt: Date; updatedAt: Date }; messages: LoadedMessage[]; hasEarlier: boolean } | null> {
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
      replyToMessageId: opsChatMessages.replyToMessageId,
      createdAt: opsChatMessages.createdAt,
    })
    .from(opsChatMessages)
    .where(and(eq(opsChatMessages.conversationId, conversationId), eq(opsChatMessages.userId, userId)))
    .orderBy(desc(opsChatMessages.seq))
    .limit(limit + 1);
  const hasEarlier = recent.length > limit;
  if (hasEarlier) recent.pop(); // drop the one older sentinel row; keep exactly the requested display window
  recent.reverse();

  // Bound the proposal load to the message WINDOW — not every card ever created in the
  // conversation — so a long thread with many cards never loads unbounded JSONB. Skip the
  // query entirely when the window is empty.
  const windowIds = recent.map((m) => m.id);
  const props = windowIds.length === 0
    ? []
    : await tx
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
        .where(
          and(
            eq(opsChatProposals.conversationId, conversationId),
            eq(opsChatProposals.userId, userId),
            inArray(opsChatProposals.messageId, windowIds),
          ),
        )
        .orderBy(asc(opsChatProposals.seq));

  const byMessage = new Map<string, LoadedMessage['proposals']>();
  for (const p of props) {
    const list = byMessage.get(p.messageId) ?? [];
    list.push({ id: p.id, seq: p.seq, kind: p.kind, proposal: p.proposal, state: p.state as OpsChatProposalState, result: p.result, error: p.error });
    byMessage.set(p.messageId, list);
  }

  return {
    conversation: conv[0],
    hasEarlier,
    messages: recent.map((m) => ({
      id: m.id,
      seq: m.seq,
      role: m.role as OpsChatMessageRole,
      status: m.status as OpsChatMessageStatus,
      content: m.content,
      question: m.question,
      replyToMessageId: m.replyToMessageId,
      createdAt: m.createdAt,
      proposals: byMessage.get(m.id) ?? [],
    })),
  };
}

/**
 * P5a: the conversation's newest CONFIRMED run-starting cards (dispatch / re-run), for loadLinkedRunViews before
 * a prompt is built. Bounded; owner-private (RLS + explicit user filter).
 */
export async function listRunStartingCards(tx: DbTx, userId: string, conversationId: string, opts: { limit?: number } = {}): Promise<LinkableCard[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  return tx
    .select({ id: opsChatProposals.id, kind: opsChatProposals.kind, state: opsChatProposals.state, proposal: opsChatProposals.proposal })
    .from(opsChatProposals)
    .where(
      and(
        eq(opsChatProposals.userId, userId),
        eq(opsChatProposals.conversationId, conversationId),
        eq(opsChatProposals.state, 'done'),
        inArray(opsChatProposals.kind, [...RUN_STARTING_KINDS]),
      ),
    )
    .orderBy(desc(opsChatProposals.seq))
    .limit(limit);
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
