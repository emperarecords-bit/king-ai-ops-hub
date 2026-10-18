import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '@/domain/auth/guard';
import { signOut } from '@/app/login/actions';
import { withUser } from '@/db/tenant';
import { buildPulse, needsYouCount, openingMessage } from '@/domain/opschat/pulse';
import {
  earliestUnansweredOwnerTurn,
  listConversations,
  loadConversation,
  mostRecentConversationId,
} from '@/domain/opschat/conversations';
import { OpsChatClient } from './ops-chat-client';
import { type PersistedMessage, type PendingTurn } from './ops-chat-transcript';

/**
 * Ops Chat — the chat-first front door (owner direction 2026-09-15). You land
 * in a conversation that opens with your full pulse, and you ask the hub
 * anything in plain language. The classic dashboards remain one click away.
 *
 * PERSISTENT (PR 2): the conversation is loaded from the user-scoped store, so it survives
 * refresh / restart / deploy and resumes on another device. `?c=<id>` opens a specific
 * conversation; a bare `/ops` restores the most recent one; `?new=1` starts a fresh one (its id
 * is minted by the client on the first send). The page also loads the conversation's EARLIEST
 * UNANSWERED owner turn — a first-class recovery state the client offers to resume explicitly
 * (never automatically: a resume can spend a model call). The opening pulse is deterministic,
 * free, and never persisted.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OpsChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const sp = await searchParams;
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
  const requested = one(sp.c);
  const startNew = one(sp.new) === '1';
  const parsedHistory = Number.parseInt(one(sp.history), 10);
  const historyLimit = Number.isFinite(parsedHistory) ? Math.max(200, Math.min(parsedHistory, 1000)) : 200;

  const [pulse, stored] = await Promise.all([
    buildPulse(),
    withUser({ userId: user.id }, async (tx) => {
      const conversations = await listConversations(tx, user.id, { limit: 20 });
      const id = startNew ? null : UUID_RE.test(requested) ? requested : await mostRecentConversationId(tx, user.id);
      // RLS + the explicit user filter scope this load: another user's id simply loads nothing.
      const loaded = id ? await loadConversation(tx, user.id, id, { limit: historyLimit }) : null;
      const pending = loaded ? await earliestUnansweredOwnerTurn(tx, user.id, loaded.conversation.id) : null;
      return { conversations, loaded, pending };
    }),
  ]);
  const opening = openingMessage(pulse);
  // Combined needs-you count (approvals + open questions) — the Inbox surfaces
  // both, so this never shows a misleading approvals-only "0" when only
  // questions are waiting.
  const needsYou = needsYouCount(pulse);

  // Plain, serializable props only (no bigint/Date) — the client never needs seq or timestamps.
  const persisted: PersistedMessage[] = (stored.loaded?.messages ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    status: m.status,
    content: m.content,
    question: m.question,
    replyToMessageId: m.replyToMessageId,
    proposals: m.proposals.map((p) => ({ id: p.id, proposal: p.proposal, state: p.state, result: p.result, error: p.error })),
  }));
  const pendingTurn: PendingTurn | null = stored.pending ? { turnId: stored.pending.id, content: stored.pending.content } : null;
  const notFound = requested !== '' && !startNew && !stored.loaded;

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-3xl flex-col p-4 sm:p-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold">Ops Chat</h1>
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">
            persistent · governed actions
          </span>
        </div>
        <div className="flex items-center gap-2">
          {needsYou > 0 ? (
            <Link
              href="/inbox"
              className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--accent)] hover:opacity-80"
            >
              Inbox ({needsYou})
            </Link>
          ) : null}
          <Link
            href="/projects"
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            Dashboard
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {notFound ? (
        <p className="mb-3 text-sm text-[var(--muted)]">That conversation was not found — starting a new one.</p>
      ) : null}

      <OpsChatClient
        key={stored.loaded?.conversation.id ?? 'new'}
        opening={opening}
        conversationId={stored.loaded?.conversation.id ?? null}
        persisted={persisted}
        pendingTurn={pendingTurn}
        conversations={stored.conversations.map((c) => ({ id: c.id, title: c.title }))}
      />

      {stored.loaded?.hasEarlier ? (
        <div className="mt-3 flex justify-center">
          <Link
            href={`/ops?c=${encodeURIComponent(stored.loaded.conversation.id)}&history=${Math.min(historyLimit + 200, 1000)}`}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            Load earlier messages
          </Link>
        </div>
      ) : null}

      <p className="mt-3 text-center text-xs text-[var(--muted)]">
        Signed in as {user.email}. Ops Chat can read your Hub and prepare governed actions. Nothing
        changes until you explicitly confirm an action. The pulse above is free; sending a question uses
        Anthropic.
      </p>
    </main>
  );
}
