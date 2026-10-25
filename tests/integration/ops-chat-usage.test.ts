import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, appSql, asUser, rlsAvailable } from '@tests/support/db';
import { withUser } from '@/db/tenant';
import { appendOwnerMessage, createConversation } from '@/domain/opschat/conversations';
import { opsChatTurnCostMicros, opsChatUsageSince, recordOpsChatUsage, type OpsChatTurnUsage } from '@/domain/opschat/usage';

/**
 * Ops Chat usage — one row per completed turn in ops_chat_usage, proven against a real DB with RLS enforced as the
 * app_server role: the owner sees only their own rows; another user can neither read nor write them; rows are
 * append-only (no update, no delete); and nothing lands in usage_events (Ops Chat never counts toward a
 * workspace's spend limit).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

const available = await rlsAvailable('ops-chat-usage.test');

const userA = randomUUID();
const userB = randomUUID();
let admin: postgres.Sql;
let app: postgres.Sql;

beforeAll(async () => {
  if (!available) return;
  admin = adminSql();
  app = appSql();
  await admin`insert into profiles (id, email, display_name) values
    (${userA}, ${`ocua-${userA.slice(0, 8)}@t.local`}, 'OCU A'),
    (${userB}, ${`ocub-${userB.slice(0, 8)}@t.local`}, 'OCU B')`;
});

afterAll(async () => {
  if (admin && available) {
    for (const u of [userA, userB]) {
      await admin`delete from ops_chat_usage where user_id = ${u}`;
      await admin`delete from ops_chat_messages where user_id = ${u}`;
      await admin`delete from ops_chat_conversations where user_id = ${u}`;
    }
    await admin`delete from profiles where id in (${userA}, ${userB})`;
    await admin.end();
  }
  await app?.end();
});

async function turnFor(userId: string, over: Partial<OpsChatTurnUsage> = {}): Promise<OpsChatTurnUsage> {
  const { convId, msgId } = await withUser({ userId }, async (tx) => {
    const c = await createConversation(tx, userId);
    const m = await appendOwnerMessage(tx, userId, { conversationId: c.id, content: 'what does a 3-ton heat pump cost?' });
    return { convId: c.id, msgId: m.id };
  });
  return {
    userId,
    conversationId: convId,
    ownerMessageId: msgId,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    usage: { inputTokens: 32_172, outputTokens: 1_112 },
    webSearches: 1,
    stopReason: 'end_turn',
    cutOff: false,
    ...over,
  };
}

describe('ops_chat_usage — recorded per turn, owner-private (RLS)', () => {
  it.runIf(available)('records the turn with tokens, searches and cost; totals add up', async () => {
    const t1 = await turnFor(userA);
    const t2 = await turnFor(userA, { usage: { inputTokens: 1_000, outputTokens: 200 }, webSearches: 0, cutOff: true, stopReason: 'max_tokens' });
    const since = new Date(Date.now() - 60_000);
    const r1 = await withUser({ userId: userA }, (tx) => recordOpsChatUsage(tx, t1));
    const r2 = await withUser({ userId: userA }, (tx) => recordOpsChatUsage(tx, t2));
    expect(r1.costMicros).toBe(opsChatTurnCostMicros('anthropic', 'claude-sonnet-5', t1.usage, 1));

    const totals = await withUser({ userId: userA }, (tx) => opsChatUsageSince(tx, userA, since));
    expect(totals).toMatchObject({ turns: 2, inputTokens: 33_172, outputTokens: 1_312, webSearches: 1 });
    expect(totals.costMicros).toBe(r1.costMicros + r2.costMicros);

    const row = await admin`select cut_off, stop_reason, pricing_version from ops_chat_usage where id = ${r2.id}`;
    expect(row[0]).toMatchObject({ cut_off: true, stop_reason: 'max_tokens' });
    expect(row[0]!.pricing_version).toBeTruthy();
  });

  it.runIf(available)('another user can neither see nor write my usage', async () => {
    const t = await turnFor(userA);
    const { id } = await withUser({ userId: userA }, (tx) => recordOpsChatUsage(tx, t));

    const raw = await asUser(app, userB, (tx) => tx`select count(*)::int n from ops_chat_usage where id = ${id}`);
    expect(raw[0]!.n).toBe(0);
    const bTotals = await withUser({ userId: userB }, (tx) => opsChatUsageSince(tx, userA, new Date(0)));
    expect(bTotals.turns).toBe(0);

    // B cannot insert a row claiming A (RLS with-check), nor attach a row to A's conversation as B (composite FK).
    await expect(withUser({ userId: userB }, (tx) => recordOpsChatUsage(tx, t))).rejects.toThrow();
    await expect(withUser({ userId: userB }, (tx) => recordOpsChatUsage(tx, { ...t, userId: userB }))).rejects.toThrow();
  });

  it.runIf(available)('rows are append-only and never reach usage_events', async () => {
    const t = await turnFor(userA);
    const { id } = await withUser({ userId: userA }, (tx) => recordOpsChatUsage(tx, t));
    await expect(asUser(app, userA, (tx) => tx`update ops_chat_usage set cost_micros = 0 where id = ${id}`)).rejects.toThrow();
    await expect(asUser(app, userA, (tx) => tx`delete from ops_chat_usage where id = ${id}`)).rejects.toThrow();
    const ue = await admin`select count(*)::int n from usage_events where created_at > now() - interval '5 minutes' and model = 'claude-sonnet-5' and task_id is null and run_id is null`;
    expect(ue[0]!.n).toBe(0);
  });
});
