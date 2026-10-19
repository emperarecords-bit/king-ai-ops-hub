import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, appSql, asUser, rlsAvailable } from '@tests/support/db';
import { withUser } from '@/db/tenant';
import { appendAssistantMessage, appendOwnerMessage, createConversation, loadPromptTurns } from '@/domain/opschat/conversations';
import {
  attachmentObjectKey,
  attachmentsForMessages,
  getAttachmentObject,
  getAttachmentSummary,
  getPromptAttachment,
  insertAttachment,
  linkAttachmentsToMessage,
  promptAttachmentsForMessages,
  type NewAttachment,
} from '@/domain/opschat/attachments';
import { decoratePromptTurns } from '@/domain/opschat/attachment-policy';

/**
 * Ops Chat attachments — the owner-private, user-scoped attachment store, proven against a real DB with
 * RLS enforced as the app_server role: another user can neither see nor link nor read an attachment;
 * linking is once-only, same-conversation, owner-message-only, and idempotent on retry; rows are
 * immutable except the link; there is no delete; the DB caps extracted text; and attachments persist
 * across reload with the prompt carrying full text only for the turn that sent them.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

const available = await rlsAvailable('ops-chat-attachments.test');

const userA = randomUUID();
const userB = randomUUID();
let admin: postgres.Sql;
let app: postgres.Sql;

beforeAll(async () => {
  if (!available) return;
  admin = adminSql();
  app = appSql();
  await admin`insert into profiles (id, email, display_name) values
    (${userA}, ${`ocaa-${userA.slice(0, 8)}@t.local`}, 'OCA A'),
    (${userB}, ${`ocab-${userB.slice(0, 8)}@t.local`}, 'OCA B')`;
});

afterAll(async () => {
  if (admin && available) {
    for (const u of [userA, userB]) {
      await admin`delete from ops_chat_attachments where user_id = ${u}`;
      await admin`delete from ops_chat_proposals where user_id = ${u}`;
      await admin`delete from ops_chat_messages where user_id = ${u}`;
      await admin`delete from ops_chat_conversations where user_id = ${u}`;
    }
    await admin`delete from profiles where id in (${userA}, ${userB})`;
    await admin.end();
  }
  await app?.end();
});

function newAttachment(userId: string, conversationId: string, over: Partial<NewAttachment> = {}): NewAttachment {
  const id = randomUUID();
  const sha256 = 'a'.repeat(64);
  return {
    id,
    conversationId,
    projectId: null,
    filename: 'ledger.pdf',
    mimeType: 'application/pdf',
    kind: 'pdf',
    sizeBytes: 1234,
    sha256,
    objectKey: attachmentObjectKey(userId, id, sha256),
    status: 'ready',
    error: null,
    extractedText: 'Invoice HI-413 total 1250.50',
    meta: { pages: 1 },
    ...over,
  };
}

async function setup(userId: string) {
  return withUser({ userId }, async (tx) => {
    const c = await createConversation(tx, userId);
    const att = newAttachment(userId, c.id);
    await insertAttachment(tx, userId, att);
    return { convId: c.id, att };
  });
}

describe('ops_chat_attachments — owner-private (RLS)', () => {
  it.runIf(available)('another user cannot see, read, or link my attachment', async () => {
    const { convId, att } = await setup(userA);

    // B sees nothing through any read path.
    expect(await withUser({ userId: userB }, (tx) => getAttachmentSummary(tx, userB, att.id))).toBeNull();
    expect(await withUser({ userId: userB }, (tx) => getAttachmentObject(tx, userB, att.id))).toBeNull();
    const raw = await asUser(app, userB, (tx) => tx`select count(*)::int n from ops_chat_attachments where id = ${att.id}`);
    expect(raw[0]!.n).toBe(0);

    // B cannot link A's attachment to B's own message (invisible under RLS → not found).
    await expect(
      withUser({ userId: userB }, async (tx) => {
        const cb = await createConversation(tx, userB);
        const mb = await appendOwnerMessage(tx, userB, { conversationId: cb.id, content: 'steal' });
        await linkAttachmentsToMessage(tx, userB, { conversationId: cb.id, messageId: mb.id, attachmentIds: [att.id] });
      }),
    ).rejects.toThrow(/not found/);

    // B cannot hijack it with a raw UPDATE (0 rows) — and cannot insert a row claiming A's conversation.
    const upd = await asUser(app, userB, (tx) => tx`update ops_chat_attachments set message_id = null where id = ${att.id} returning id`);
    expect(upd.length).toBe(0);
    await expect(
      asUser(app, userB, (tx) => tx`insert into ops_chat_attachments (user_id, conversation_id, filename, mime_type, kind, size_bytes, sha256, object_key, status)
        values (${userB}, ${convId}, 'x.txt', 'text/plain', 'text', 1, ${'b'.repeat(64)}, 'opschat/x', 'ready')`),
    ).rejects.toBeTruthy();
  });

  it.runIf(available)('fails closed with no app.user_id', async () => {
    const { att } = await setup(userA);
    const rows = await app.begin((tx) => tx`select count(*)::int n from ops_chat_attachments where id = ${att.id}`);
    expect(rows[0]!.n).toBe(0);
  });

  it.runIf(available)('rows are immutable except the one link; there is no delete', async () => {
    const { att } = await setup(userA);
    await expect(asUser(app, userA, (tx) => tx`update ops_chat_attachments set extracted_text = 'tampered' where id = ${att.id}`)).rejects.toThrow();
    await expect(asUser(app, userA, (tx) => tx`update ops_chat_attachments set object_key = 'opschat/other' where id = ${att.id}`)).rejects.toThrow();
    await expect(asUser(app, userA, (tx) => tx`update ops_chat_attachments set conversation_id = ${randomUUID()} where id = ${att.id}`)).rejects.toThrow();
    await expect(asUser(app, userA, (tx) => tx`delete from ops_chat_attachments where id = ${att.id}`)).rejects.toThrow();
  });

  it.runIf(available)('the DB caps extracted text and file size and rejects unknown kinds/statuses', async () => {
    const convId = await withUser({ userId: userA }, async (tx) => (await createConversation(tx, userA)).id);
    for (const over of [
      { extractedText: 'x'.repeat(100_001) },
      { sizeBytes: 10 * 1024 * 1024 + 1 },
      { sizeBytes: 0 },
      { kind: 'exe' as never },
      { status: 'processing' as never },
    ]) {
      await expect(withUser({ userId: userA }, (tx) => insertAttachment(tx, userA, newAttachment(userA, convId, over)))).rejects.toBeTruthy();
    }
  });
});

describe('linkAttachmentsToMessage — once, same conversation, owner message only, idempotent', () => {
  it.runIf(available)('links to the sending owner message; a retry is a no-op; re-linking elsewhere is refused', async () => {
    const { convId, att } = await setup(userA);
    const m1 = await withUser({ userId: userA }, async (tx) => {
      const m = await appendOwnerMessage(tx, userA, { conversationId: convId, content: 'see attached' });
      await linkAttachmentsToMessage(tx, userA, { conversationId: convId, messageId: m.id, attachmentIds: [att.id] });
      // Idempotent retry of the same send.
      await linkAttachmentsToMessage(tx, userA, { conversationId: convId, messageId: m.id, attachmentIds: [att.id] });
      return m.id;
    });
    expect((await withUser({ userId: userA }, (tx) => getAttachmentSummary(tx, userA, att.id)))!.messageId).toBe(m1);

    // A second message cannot take it.
    await expect(
      withUser({ userId: userA }, async (tx) => {
        const m2 = await appendOwnerMessage(tx, userA, { conversationId: convId, content: 'again' });
        await linkAttachmentsToMessage(tx, userA, { conversationId: convId, messageId: m2.id, attachmentIds: [att.id] });
      }),
    ).rejects.toThrow(/already sent/);
  });

  it.runIf(available)('refuses another conversation, an assistant message, and too many files — and links nothing', async () => {
    const { convId, att } = await setup(userA);
    // Another conversation of the same user.
    await expect(
      withUser({ userId: userA }, async (tx) => {
        const c2 = await createConversation(tx, userA);
        const m = await appendOwnerMessage(tx, userA, { conversationId: c2.id, content: 'wrong thread' });
        await linkAttachmentsToMessage(tx, userA, { conversationId: c2.id, messageId: m.id, attachmentIds: [att.id] });
      }),
    ).rejects.toThrow(/not found/);
    // An assistant message.
    await expect(
      withUser({ userId: userA }, async (tx) => {
        const o = await appendOwnerMessage(tx, userA, { conversationId: convId, content: 'q' });
        const a = await appendAssistantMessage(tx, userA, { conversationId: convId, content: 'a', replyToMessageId: o.id });
        await linkAttachmentsToMessage(tx, userA, { conversationId: convId, messageId: a.id, attachmentIds: [att.id] });
      }),
    ).rejects.toThrow(/not found/);
    // More than the per-message limit.
    await expect(
      withUser({ userId: userA }, async (tx) => {
        const o = await appendOwnerMessage(tx, userA, { conversationId: convId, content: 'many' });
        await linkAttachmentsToMessage(tx, userA, { conversationId: convId, messageId: o.id, attachmentIds: Array.from({ length: 6 }, () => randomUUID()) });
      }),
    ).rejects.toThrow(/at most 5/);
    // Still unlinked after every refusal.
    expect((await withUser({ userId: userA }, (tx) => getAttachmentSummary(tx, userA, att.id)))!.messageId).toBeNull();
  });
});

describe('persistence + prompt construction across reload', () => {
  it.runIf(available)('chips survive reload; the prompt carries file text only for the turn that sent it', async () => {
    const { convId, ids } = await withUser({ userId: userA }, async (tx) => {
      const c = await createConversation(tx, userA);
      const early = newAttachment(userA, c.id, { filename: 'q3.xlsx', kind: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText: 'Q3-ROWS-SECRET', meta: { sheets: 2 } });
      const late = newAttachment(userA, c.id, { filename: 'q4.pdf', extractedText: 'Q4-REPORT-TEXT' });
      await insertAttachment(tx, userA, early);
      await insertAttachment(tx, userA, late);
      const m1 = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'summarize Q3' });
      await linkAttachmentsToMessage(tx, userA, { conversationId: c.id, messageId: m1.id, attachmentIds: [early.id] });
      await appendAssistantMessage(tx, userA, { conversationId: c.id, content: 'Q3 summary', replyToMessageId: m1.id });
      const m2 = await appendOwnerMessage(tx, userA, { conversationId: c.id, content: 'now Q4' });
      await linkAttachmentsToMessage(tx, userA, { conversationId: c.id, messageId: m2.id, attachmentIds: [late.id] });
      return { convId: c.id, ids: { m1: m1.id, m2: m2.id, early: early.id, late: late.id } };
    });

    // "Reload": a fresh transaction reads the chips back, grouped by message, metadata only.
    const chips = await withUser({ userId: userA }, (tx) => attachmentsForMessages(tx, userA, convId, [ids.m1, ids.m2]));
    expect(chips.get(ids.m1)!.map((c) => c.filename)).toEqual(['q3.xlsx']);
    expect(chips.get(ids.m2)!.map((c) => c.filename)).toEqual(['q4.pdf']);
    expect(JSON.stringify([...chips.values()])).not.toContain('Q3-ROWS-SECRET'); // no text in display payload

    // The prompt for turn m2: Q4 text present, Q3 only as a reference.
    const turns = await withUser({ userId: userA }, (tx) => loadPromptTurns(tx, userA, convId, ids.m2));
    const byOwner = await withUser({ userId: userA }, (tx) => promptAttachmentsForMessages(tx, userA, convId, [ids.m1, ids.m2]));
    const prompt = decoratePromptTurns(turns, byOwner, ids.m2);
    const all = prompt.map((t) => t.content).join('\n');
    expect(all).toContain('Q4-REPORT-TEXT');
    expect(all).not.toContain('Q3-ROWS-SECRET');
    expect(prompt[0]!.content).toContain(`[attachment ${ids.early}: "q3.xlsx"`);

    // read_attachment's loader: only SENT files, only in this conversation, only this user.
    expect((await withUser({ userId: userA }, (tx) => getPromptAttachment(tx, userA, ids.early, convId)))?.extractedText).toBe('Q3-ROWS-SECRET');
    expect(await withUser({ userId: userA }, (tx) => getPromptAttachment(tx, userA, ids.early, randomUUID()))).toBeNull();
    expect(await withUser({ userId: userB }, (tx) => getPromptAttachment(tx, userB, ids.early))).toBeNull();
  });

  it.runIf(available)('an unsent upload is not readable by the model', async () => {
    const { convId, att } = await setup(userA);
    expect(await withUser({ userId: userA }, (tx) => getPromptAttachment(tx, userA, att.id, convId))).toBeNull();
  });
});
