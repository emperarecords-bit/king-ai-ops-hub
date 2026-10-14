import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, appSql, asUser, rlsAvailable } from '@tests/support/db';
import { withUser } from '@/db/tenant';
import {
  addProposal,
  appendAssistantMessage,
  appendOwnerMessage,
  canTransition,
  conversationExists,
  createConversation,
  earliestUnansweredOwnerId,
  earliestUnansweredOwnerTurn,
  deriveTitle,
  listConversations,
  loadConversation,
  loadProposal,
  loadPromptTurns,
  loadReplyForOwnerMessage,
  mostRecentConversationId,
  transitionProposal,
} from '@/domain/opschat/conversations';
import { tryClaimConversation, tryClaimTurn } from '@/domain/opschat/turn-claim';

/**
 * Ops Chat persistence (PR 1) — the owner-private, user-scoped conversation store.
 *
 * Proven against a real DB (RLS enforced as the app_server role): user A can neither
 * read nor write user B's conversations; reads fail closed with no app.user_id;
 * transcript ordering is deterministic by seq; proposal payloads are immutable; the
 * confirm CAS lets only one confirmer win; most-recent selection follows updated_at;
 * and transcript retrieval is bounded. Pure helpers (title derivation, the transition
 * state machine) are tested without a DB and always run. Skips the DB suites when the
 * disposable Postgres isn't reachable (local dev without `npm run db:up && db:migrate`).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

const available = await rlsAvailable('ops-chat-persistence.test');

const userA = randomUUID();
const userB = randomUUID();
let admin: postgres.Sql;
let app: postgres.Sql;

beforeAll(async () => {
  if (!available) return;
  admin = adminSql();
  app = appSql();
  await admin`insert into profiles (id, email, display_name) values
    (${userA}, ${`ocpa-${userA.slice(0, 8)}@t.local`}, 'OCP A'),
    (${userB}, ${`ocpb-${userB.slice(0, 8)}@t.local`}, 'OCP B')`;
});

afterAll(async () => {
  if (admin && available) {
    for (const u of [userA, userB]) {
      await admin`delete from ops_chat_proposals where user_id = ${u}`;
      await admin`delete from ops_chat_messages where user_id = ${u}`;
      await admin`delete from ops_chat_conversations where user_id = ${u}`;
    }
    await admin`delete from profiles where id in (${userA}, ${userB})`;
    await admin.end();
  }
  await app?.end();
});

// ── pure helpers (no DB — always run) ────────────────────────────────────────

describe('deriveTitle', () => {
  it('normalizes whitespace and keeps short titles intact', () => {
    expect(deriveTitle('  Finish   the\n AccurateBids release  ')).toBe('Finish the AccurateBids release');
  });
  it('truncates long titles with an ellipsis (~60 chars)', () => {
    const t = deriveTitle('x'.repeat(200));
    expect(t.length).toBe(60);
    expect(t.endsWith('…')).toBe(true);
  });
  it('an empty/whitespace message yields an empty title', () => {
    expect(deriveTitle('   \n  ')).toBe('');
  });
});

describe('canTransition — the proposal state machine', () => {
  it('allows only pending→confirming/cancelled and confirming→done/error/stale', () => {
    expect(canTransition('pending', 'confirming')).toBe(true);
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('confirming', 'done')).toBe(true);
    expect(canTransition('confirming', 'error')).toBe(true);
    expect(canTransition('confirming', 'stale')).toBe(true);
    // terminal states have no outgoing edges — a new proposal is required
    for (const term of ['done', 'error', 'cancelled', 'stale'] as const) {
      expect(canTransition(term, 'confirming')).toBe(false);
    }
    // not a shortcut
    expect(canTransition('pending', 'done')).toBe(false);
  });
});

describe('createConversation — idempotent by caller-provided id (first-turn retry recovery)', () => {
  it.runIf(available)('creating the same client id twice is a no-op; a full (conversationId, turnId, content) replay never forks', async () => {
    const convId = randomUUID();
    const turnId = randomUUID();
    const content = 'first message of a brand-new conversation';

    // First attempt: create by client id + append the owner turn.
    const first = await withUser({ userId: userA }, async (tx) => {
      await createConversation(tx, userA, { id: convId });
      return appendOwnerMessage(tx, userA, { conversationId: convId, content, id: turnId });
    });
    expect(first.inserted).toBe(true);

    // Total-failure retry: the EXACT same request (same ids + content) — must not fork a second
    // conversation and must not duplicate the owner message.
    const retry = await withUser({ userId: userA }, async (tx) => {
      await createConversation(tx, userA, { id: convId });
      return appendOwnerMessage(tx, userA, { conversationId: convId, content, id: turnId });
    });
    expect(retry.inserted).toBe(false);
    expect(retry.id).toBe(first.id);

    const convCount = await admin`select count(*)::int n from ops_chat_conversations where id = ${convId}`;
    expect(convCount[0]!.n).toBe(1);
    const msgCount = await admin`select count(*)::int n from ops_chat_messages where conversation_id = ${convId}`;
    expect(msgCount[0]!.n).toBe(1);
  });

  it.runIf(available)('a client id that already belongs to ANOTHER user is left untouched; conversationExists stays false for the intruder', async () => {
    const convId = randomUUID();
    // A owns it.
    await withUser({ userId: userA }, (tx) => createConversation(tx, userA, { id: convId }));
    // B tries the same id — onConflictDoNothing leaves A's row intact; B does not own it.
    await withUser({ userId: userB }, (tx) => createConversation(tx, userB, { id: convId }));
    expect(await withUser({ userId: userB }, (tx) => conversationExists(tx, userB, convId))).toBe(false);
    expect(await withUser({ userId: userA }, (tx) => conversationExists(tx, userA, convId))).toBe(true);
    // The row still belongs to A (never re-owned).
    const owner = await admin`select user_id from ops_chat_conversations where id = ${convId}`;
    expect(owner[0]!.user_id).toBe(userA);
  });
});

// ── RLS isolation + fail-closed (raw app_server; always enforced) ────────────

describe('RLS — owner-private isolation', () => {
  it.runIf(available)('user A cannot read or write user B\'s conversation or messages', async () => {
    // B's conversation + message, seeded as the migration role (bypasses RLS).
    const convB = randomUUID();
    await admin`insert into ops_chat_conversations (id, user_id, title) values (${convB}, ${userB}, 'B secret')`;
    await admin`insert into ops_chat_messages (conversation_id, user_id, role, content) values (${convB}, ${userB}, 'user', 'B secret body')`;

    // A cannot SEE B's rows.
    const seenConv = await asUser(app, userA, (tx) => tx`select count(*)::int n from ops_chat_conversations where id = ${convB}`);
    expect(seenConv[0]!.n).toBe(0);
    const seenMsg = await asUser(app, userA, (tx) => tx`select count(*)::int n from ops_chat_messages where conversation_id = ${convB}`);
    expect(seenMsg[0]!.n).toBe(0);

    // A cannot MODIFY B's conversation (RLS hides it → 0 rows affected, not an error).
    const upd = await asUser(app, userA, (tx) => tx`update ops_chat_conversations set title = 'hijacked' where id = ${convB} returning id`);
    expect(upd.length).toBe(0);
    // And the row is untouched when read back as the migration role.
    const still = await admin`select title from ops_chat_conversations where id = ${convB}`;
    expect(still[0]!.title).toBe('B secret');

    // A cannot INSERT a message into B's conversation (with-check / composite FK both bar it).
    await expect(
      asUser(app, userA, (tx) => tx`insert into ops_chat_messages (conversation_id, user_id, role, content) values (${convB}, ${userA}, 'user', 'intruder')`),
    ).rejects.toBeTruthy();
  });

  it.runIf(available)('fails closed with no app.user_id — a user cannot see even their own rows without identity', async () => {
    const convA = randomUUID();
    await admin`insert into ops_chat_conversations (id, user_id, title) values (${convA}, ${userA}, 'A thread')`;
    // app.user_id blank → app.current_user_id() is NULL → every policy denies.
    const rows = (await app.begin(async (tx) => {
      await tx`select set_config('app.user_id', '', true)`;
      return tx`select count(*)::int n from ops_chat_conversations where id = ${convA}`;
    })) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });
});

// ── domain behaviour (via withUser — exercises the module under app.user_id) ──

describe('conversations domain — ordering, title, CAS, immutability, bounds', () => {
  it.runIf(available)('persists a deterministic transcript ordered by seq, titled from the first owner message', async () => {
    const convId = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const o1 = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: '  First   owner question  ' });
      await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'assistant reply 1', question: 'First owner question', replyToMessageId: o1.id });
      const o2 = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'second owner question' });
      await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'assistant reply 2', replyToMessageId: o2.id });
      return c.id;
    });
    const loaded = await withUser({ userId: userA }, (tx) => loadConversation(tx, userA, convId));
    expect(loaded).not.toBeNull();
    expect(loaded!.conversation.title).toBe('First owner question'); // normalized, from the FIRST owner msg
    expect(loaded!.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:  First   owner question  ',
      'assistant:assistant reply 1',
      'user:second owner question',
      'assistant:assistant reply 2',
    ]);
    // seq strictly increasing in display order
    const seqs = loaded!.messages.map((m) => m.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! > seqs[i - 1]!).toBe(true);
  });

  it.runIf(available)('confirm CAS — only the first confirmer wins; payload stays immutable', async () => {
    const { convId, proposalId, payload } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const m = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'do the thing' });
      const a = await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'here is a proposal', replyToMessageId: m.id });
      const pl = { kind: 'answer_question', projectKey: 'ws', questionId: randomUUID(), answer: 'yes' };
      const p = await addProposal(tx, userA, { conversationId: c.id, messageId: a.id, kind: 'answer_question', proposal: pl });
      return { convId: c.id, proposalId: p.id, payload: pl };
    });

    // First confirmer grabs the lock; a concurrent second confirmer loses the CAS.
    const first = await withUser({ userId: userA }, (tx) => transitionProposal(tx, userA, { proposalId, from: 'pending', to: 'confirming' }));
    expect(first?.state).toBe('confirming');
    const second = await withUser({ userId: userA }, (tx) => transitionProposal(tx, userA, { proposalId, from: 'pending', to: 'confirming' }));
    expect(second).toBeNull();

    // Finish the win; a cancel attempt after it's done loses (wrong current state).
    const done = await withUser({ userId: userA }, (tx) => transitionProposal(tx, userA, { proposalId, from: 'confirming', to: 'done', result: { outcome: 'succeeded' } }));
    expect(done?.state).toBe('done');
    const lateCancel = await withUser({ userId: userA }, (tx) => transitionProposal(tx, userA, { proposalId, from: 'pending', to: 'cancelled' }));
    expect(lateCancel).toBeNull();

    // An illegal transition is a programmer error, not a silent no-op.
    await expect(
      withUser({ userId: userA }, (tx) => transitionProposal(tx, userA, { proposalId, from: 'done', to: 'error' })),
    ).rejects.toThrow(/illegal proposal transition/);

    // The payload was never mutated — only state/result changed.
    const reloaded = await withUser({ userId: userA }, (tx) => loadProposal(tx, userA, proposalId));
    expect(reloaded!.state).toBe('done');
    expect(reloaded!.proposal).toEqual(payload);
    const viaConv = await withUser({ userId: userA }, (tx) => loadConversation(tx, userA, convId));
    const card = viaConv!.messages.flatMap((m) => m.proposals).find((p) => p.id === proposalId)!;
    expect(card.state).toBe('done');
    expect((card.result as { outcome?: string }).outcome).toBe('succeeded');
    expect(card.proposal).toEqual(payload);
  });

  it.runIf(available)('most-recent selection follows updated_at as new messages land', async () => {
    const c1 = await withUser({ userId: userB }, async (tx) => {
      const c = await createConversation(tx, userB);
      await appendOwnerMessage(tx, userB, { conversationId: c.id, content: 'c1 first' });
      return c.id;
    });
    const c2 = await withUser({ userId: userB }, async (tx) => {
      const c = await createConversation(tx, userB);
      await appendOwnerMessage(tx, userB, { conversationId: c.id, content: 'c2 first' });
      return c.id;
    });
    expect(await withUser({ userId: userB }, (tx) => mostRecentConversationId(tx, userB))).toBe(c2);
    // A new message in c1 floats it back to the top.
    await withUser({ userId: userB }, (tx) => appendOwnerMessage(tx, userB, { conversationId: c1, content: 'c1 again' }));
    expect(await withUser({ userId: userB }, (tx) => mostRecentConversationId(tx, userB))).toBe(c1);
    // The history list is most-recent first and scoped to the user.
    const list = await withUser({ userId: userB }, (tx) => listConversations(tx, userB));
    expect(list[0]!.id).toBe(c1);
    expect(list.map((x) => x.id)).toEqual(expect.arrayContaining([c1, c2]));
  });

  it.runIf(available)('transcript retrieval is bounded to the last N messages (chronological)', async () => {
    const convId = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      for (let i = 0; i < 8; i++) await appendOwnerMessage(tx, userA, { conversationId: c.id, content: `m${i}` });
      return c.id;
    });
    const loaded = await withUser({ userId: userA }, (tx) => loadConversation(tx, userA, convId, { limit: 3 }));
    expect(loaded!.messages.map((m) => m.content)).toEqual(['m5', 'm6', 'm7']); // last 3, in order
  });
});

describe('DB-enforced immutability — column privileges (not just convention)', () => {
  it.runIf(available)('app_server cannot rewrite the proposal payload, message content, or relationship keys', async () => {
    const { msgId, propId } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const o = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'immutability test' });
      const a = await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'reply', replyToMessageId: o.id });
      const p = await addProposal(tx, userA, { conversationId: c.id, messageId: a.id, kind: 'answer_question', proposal: { kind: 'answer_question', answer: 'original' } });
      return { msgId: a.id, propId: p.id };
    });

    // The immutable proposal payload is not updatable — even on the owner's own row.
    await expect(asUser(app, userA, (tx) => tx`update ops_chat_proposals set proposal = '{"tampered":true}'::jsonb where id = ${propId}`)).rejects.toThrow();
    // Messages are append-only history — no UPDATE grant at all.
    await expect(asUser(app, userA, (tx) => tx`update ops_chat_messages set content = 'tampered' where id = ${msgId}`)).rejects.toThrow();
    await expect(asUser(app, userA, (tx) => tx`update ops_chat_messages set role = 'assistant' where id = ${msgId}`)).rejects.toThrow();
    // Relationship keys are not updatable (would re-parent a proposal).
    await expect(asUser(app, userA, (tx) => tx`update ops_chat_proposals set conversation_id = ${randomUUID()} where id = ${propId}`)).rejects.toThrow();

    // But the sanctioned mutable columns ARE updatable (the CAS path).
    const ok = await asUser(app, userA, (tx) => tx`update ops_chat_proposals set state = 'confirming' where id = ${propId} returning id`);
    expect(ok.length).toBe(1);

    // Read back as the migration role: payload + content survived every rejected write.
    const p = await admin`select proposal, state from ops_chat_proposals where id = ${propId}`;
    expect(p[0]!.proposal).toEqual({ kind: 'answer_question', answer: 'original' });
    expect(p[0]!.state).toBe('confirming');
    const m = await admin`select content, role from ops_chat_messages where id = ${msgId}`;
    expect(m[0]!.content).toBe('reply');
    expect(m[0]!.role).toBe('assistant');
  });
});

describe('loadConversation — the proposal query is bounded to the message window', () => {
  it.runIf(available)('does not load proposals attached to out-of-window messages', async () => {
    const { convId, pOld, pNew } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const first = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'old' });
      const oldP = await addProposal(tx, userA, { conversationId: c.id, messageId: first.id, kind: 'answer_question', proposal: { old: true } });
      for (let i = 0; i < 4; i++) await appendOwnerMessage(tx, userA, { conversationId: c.id, content: `mid${i}` });
      const last = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'new' });
      const newP = await addProposal(tx, userA, { conversationId: c.id, messageId: last.id, kind: 'answer_question', proposal: { new: true } });
      return { convId: c.id, pOld: oldP.id, pNew: newP.id };
    });
    const loaded = await withUser({ userId: userA }, (tx) => loadConversation(tx, userA, convId, { limit: 2 }));
    const ids = loaded!.messages.flatMap((m) => m.proposals.map((p) => p.id));
    expect(ids).toContain(pNew); // in-window proposal is loaded
    expect(ids).not.toContain(pOld); // out-of-window proposal is NOT loaded
    expect(ids.length).toBe(1);
  });
});

describe('appendOwnerMessage — strict idempotency on a caller-provided turn id', () => {
  it.runIf(available)('reuses the row only for an identical turn; a reused id with different content/conversation is a hard conflict', async () => {
    const turnId = randomUUID();
    const { convId, convId2 } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const c2 = await createConversation(tx, userA);
      return { convId: c.id, convId2: c2.id };
    });
    const first = await withUser({ userId: userA }, (tx) => appendOwnerMessage(tx, userA, { conversationId: convId, content: 'hello', id: turnId }));
    expect(first.inserted).toBe(true);
    expect(first.id).toBe(turnId);

    // Legitimate retry: same id + same conversation + same content.
    const retry = await withUser({ userId: userA }, (tx) => appendOwnerMessage(tx, userA, { conversationId: convId, content: 'hello', id: turnId }));
    expect(retry.inserted).toBe(false);
    expect(retry.id).toBe(turnId);
    expect(retry.seq).toBe(first.seq);

    // Same id, different content → hard conflict (never silently reused).
    await expect(withUser({ userId: userA }, (tx) => appendOwnerMessage(tx, userA, { conversationId: convId, content: 'DIFFERENT', id: turnId }))).rejects.toThrow();
    // Same id, different conversation → hard conflict.
    await expect(withUser({ userId: userA }, (tx) => appendOwnerMessage(tx, userA, { conversationId: convId2, content: 'hello', id: turnId }))).rejects.toThrow();
  });
});

describe('tryClaimTurn — serializes model execution per owner turn', () => {
  it.runIf(available)('only one holder at a time; reacquirable after release; independent per id', async () => {
    const id = randomUUID();
    const c1 = await tryClaimTurn(id);
    expect(c1.claimed).toBe(true);
    const c2 = await tryClaimTurn(id); // another request for the SAME turn loses
    expect(c2.claimed).toBe(false);
    await c1.release();
    const c3 = await tryClaimTurn(id); // reacquirable once the first releases
    expect(c3.claimed).toBe(true);
    await c3.release();
    const other = await tryClaimTurn(randomUUID()); // a different turn is independent
    expect(other.claimed).toBe(true);
    await other.release();
  });
});

describe('tryClaimConversation — serializes execution per conversation (distinct lock namespace)', () => {
  it.runIf(available)('only one turn executes in a conversation at a time; reacquirable; independent per id', async () => {
    const id = randomUUID();
    const c1 = await tryClaimConversation(id);
    expect(c1.claimed).toBe(true);
    const c2 = await tryClaimConversation(id); // a second turn in the SAME conversation loses
    expect(c2.claimed).toBe(false);
    await c1.release();
    const c3 = await tryClaimConversation(id); // reacquirable once released
    expect(c3.claimed).toBe(true);
    await c3.release();
    const other = await tryClaimConversation(randomUUID());
    expect(other.claimed).toBe(true);
    await other.release();
  });

  it.runIf(available)('turn and conversation locks do NOT collide even on the SAME uuid (namespaced keys)', async () => {
    const id = randomUUID();
    const turn = await tryClaimTurn(id);
    const conv = await tryClaimConversation(id);
    // Both acquire simultaneously — they live in different lock namespaces.
    expect(turn.claimed).toBe(true);
    expect(conv.claimed).toBe(true);
    await turn.release();
    await conv.release();
  });
});

describe('loadPromptTurns — turn-aware prompt reconstruction (owner order + linked complete replies)', () => {
  it.runIf(available)('reconstructs user A → assistant A → user B even when A\'s reply has a HIGHER seq than B', async () => {
    const { convId, a, b } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const ma = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'question A' });
      const mb = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'question B' }); // B persisted before A is answered
      await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'answer A', replyToMessageId: ma.id }); // reply A: seq > B
      return { convId: c.id, a: ma.id, b: mb.id };
    });

    // Prompt for turn B: A's reply is attached to A by the link, not dropped by a seq<=B filter,
    // and B is the final (current) turn with no trailing assistant.
    const forB = await withUser({ userId: userA }, (tx) => loadPromptTurns(tx, userA, convId, b, { maxOwnerTurns: 8 }));
    expect(forB).toEqual([
      { role: 'user', content: 'question A' },
      { role: 'assistant', content: 'answer A' },
      { role: 'user', content: 'question B' },
    ]);

    // Prompt for turn A (while A is the current turn): only up through A, and A's own reply is NOT
    // appended (we are generating it); B (higher seq) is excluded.
    const forA = await withUser({ userId: userA }, (tx) => loadPromptTurns(tx, userA, convId, a, { maxOwnerTurns: 8 }));
    expect(forA).toEqual([{ role: 'user', content: 'question A' }]);
  });

  it.runIf(available)('excludes an INTERRUPTED assistant reply from the prompt, but keeps it in the display transcript', async () => {
    const { convId, b } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const ma = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'q A' });
      await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'partial A', replyToMessageId: ma.id, status: 'interrupted' });
      const mb = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'q B' });
      return { convId: c.id, b: mb.id };
    });

    // The interrupted reply is NOT fed back as model history — A appears with no assistant turn.
    const forB = await withUser({ userId: userA }, (tx) => loadPromptTurns(tx, userA, convId, b, { maxOwnerTurns: 8 }));
    expect(forB).toEqual([
      { role: 'user', content: 'q A' },
      { role: 'user', content: 'q B' },
    ]);

    // ...but it remains in the persisted display transcript (UI/history evidence).
    const shown = await withUser({ userId: userA }, (tx) => loadConversation(tx, userA, convId));
    const interrupted = shown!.messages.find((m) => m.role === 'assistant' && m.status === 'interrupted');
    expect(interrupted?.content).toBe('partial A');
  });
});

describe('earliestUnansweredOwnerId — FIFO execution order within a conversation', () => {
  it.runIf(available)('A/B/C queued: only the earliest unanswered owner may run; a terminal reply (complete OR interrupted) advances the order', async () => {
    const { convId, a, b, c } = await withUser({ userId: userA }, async (tx) => {
      const conv = await createConversation(tx, userA);
      const ma = await appendOwnerMessage(tx, userA, { conversationId: conv.id, content: 'A' });
      const mb = await appendOwnerMessage(tx, userA, { conversationId: conv.id, content: 'B' });
      const mc = await appendOwnerMessage(tx, userA, { conversationId: conv.id, content: 'C' });
      return { convId: conv.id, a: ma.id, b: mb.id, c: mc.id };
    });

    // B and C queued behind A (nothing answered). Even if C retries first, the gate names A as the
    // only runnable turn — C (and B) must wait.
    expect(await withUser({ userId: userA }, (tx) => earliestUnansweredOwnerId(tx, userA, convId))).toBe(a);

    // A completes → B is next; C is still refused.
    await withUser({ userId: userA }, (tx) => appendAssistantMessage(tx, userA, { conversationId: convId, content: 'ans A', replyToMessageId: a }));
    expect(await withUser({ userId: userA }, (tx) => earliestUnansweredOwnerId(tx, userA, convId))).toBe(b);

    // B's reply is INTERRUPTED — not model history, but it CLOSES B's turn (terminal), so the
    // order advances to C rather than stalling forever.
    await withUser({ userId: userA }, (tx) => appendAssistantMessage(tx, userA, { conversationId: convId, content: 'partial B', replyToMessageId: b, status: 'interrupted' }));
    expect(await withUser({ userId: userA }, (tx) => earliestUnansweredOwnerId(tx, userA, convId))).toBe(c);

    // C answered → nothing left pending.
    await withUser({ userId: userA }, (tx) => appendAssistantMessage(tx, userA, { conversationId: convId, content: 'ans C', replyToMessageId: c }));
    expect(await withUser({ userId: userA }, (tx) => earliestUnansweredOwnerId(tx, userA, convId))).toBeNull();
  });

  it.runIf(available)('earliestUnansweredOwnerTurn gives the page the exact pending turn (id = turnId, original content); another user sees none', async () => {
    const turnB = randomUUID();
    const convId = await withUser({ userId: userA }, async (tx) => {
      const conv = await createConversation(tx, userA);
      const ma = await appendOwnerMessage(tx, userA, { conversationId: conv.id, content: 'first' });
      await appendOwnerMessage(tx, userA, { conversationId: conv.id, content: 'second, unanswered', id: turnB });
      await appendAssistantMessage(tx, userA, { conversationId: conv.id, content: 'ans first', replyToMessageId: ma.id });
      return conv.id;
    });
    expect(await withUser({ userId: userA }, (tx) => earliestUnansweredOwnerTurn(tx, userA, convId))).toEqual({ id: turnB, content: 'second, unanswered' });
    expect(await withUser({ userId: userB }, (tx) => earliestUnansweredOwnerTurn(tx, userB, convId))).toBeNull();

    // The display load carries the explicit reply linkage the client uses for turn-aware order.
    const loaded = await withUser({ userId: userA }, (tx) => loadConversation(tx, userA, convId));
    const reply = loaded!.messages.find((m) => m.role === 'assistant')!;
    const first = loaded!.messages.find((m) => m.content === 'first')!;
    expect(reply.replyToMessageId).toBe(first.id);
    expect(first.replyToMessageId).toBeNull();
  });
});

describe('loadReplyForOwnerMessage — explicit owner->assistant linkage (no seq misassociation)', () => {
  it.runIf(available)('associates a reply by reply_to_message_id, not by sequence adjacency', async () => {
    const { ownerA, ownerB } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const a = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'owner A' });
      const b = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'owner B' }); // interleaved: B submitted before A is answered
      await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'reply to A', replyToMessageId: a.id }); // reply to A lands AFTER B (higher seq)
      return { ownerA: a.id, ownerB: b.id };
    });
    const forA = await withUser({ userId: userA }, (tx) => loadReplyForOwnerMessage(tx, userA, ownerA));
    expect(forA?.content).toBe('reply to A');
    // B has no reply yet. seq-adjacency would wrongly hand it A's reply (higher seq); the
    // explicit link does not.
    const forB = await withUser({ userId: userA }, (tx) => loadReplyForOwnerMessage(tx, userA, ownerB));
    expect(forB).toBeNull();
  });

  it.runIf(available)('enforces at most one assistant reply per owner turn', async () => {
    const { convId, owner } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const o = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'owner' });
      await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'first reply', replyToMessageId: o.id });
      return { convId: c.id, owner: o.id };
    });
    await expect(
      withUser({ userId: userA }, (tx) => appendAssistantMessage(tx, userA, { conversationId: convId, content: 'second reply', replyToMessageId: owner })),
    ).rejects.toThrow();
  });

  it.runIf(available)('rejects an assistant reply that links to another assistant message (fail closed)', async () => {
    const { convId, assistantId } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const o = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'owner' });
      const a = await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'assistant reply', replyToMessageId: o.id });
      return { convId: c.id, assistantId: a.id };
    });
    // reply_to_message_id must point at an owner/user message. Linking to an assistant
    // row is rejected in the domain layer before any insert.
    await expect(
      withUser({ userId: userA }, (tx) => appendAssistantMessage(tx, userA, { conversationId: convId, content: 'reply to an assistant', replyToMessageId: assistantId })),
    ).rejects.toThrow(/owner message/);
  });

  it.runIf(available)('rejects an assistant reply whose target is in a different conversation', async () => {
    const { conv2Id, ownerInConv1 } = await withUser({ userId: userA }, async (tx) => {
      const c1 = await createConversation(tx, userA);
      const c2 = await createConversation(tx, userA);
      const o = await appendOwnerMessage(tx, userA, { conversationId: c1.id, content: 'owner in conv 1' });
      return { conv2Id: c2.id, ownerInConv1: o.id };
    });
    // Same user, but the owner message belongs to a different conversation: fail closed.
    await expect(
      withUser({ userId: userA }, (tx) => appendAssistantMessage(tx, userA, { conversationId: conv2Id, content: 'cross-conversation reply', replyToMessageId: ownerInConv1 })),
    ).rejects.toThrow(/owner message/);
  });
});
