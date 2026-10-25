import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, tenantForUser } from '@/domain/auth/guard';
import { currentBuildId } from '@/lib/build-id';
import { signOut } from '@/app/login/actions';
import { withUser } from '@/db/tenant';
import { buildPulse, needsYouCount, openingMessage } from '@/domain/opschat/pulse';
import {
  earliestUnansweredOwnerTurn,
  listConversations,
  loadConversation,
  mostRecentConversationId,
} from '@/domain/opschat/conversations';
import { attachmentsForMessages, type AttachmentSummary } from '@/domain/opschat/attachments';
import { cardLabelOf } from '@/domain/opschat/card-state';
import { loadLinkedRunViews } from '@/domain/opschat/linked-runs';
import { type LinkedRunView } from '@/domain/opschat/linked-run-view';
import { anchorEntries, completionEntries, LEADING, type CompletionEntry } from '@/domain/opschat/conversation-continuity';
import { log } from '@/lib/log';
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
      // Attachment chips for the owner messages in the display window (metadata only).
      const attachments = loaded
        ? await attachmentsForMessages(tx, user.id, loaded.conversation.id, loaded.messages.filter((m) => m.role === 'user').map((m) => m.id))
        : new Map<string, AttachmentSummary[]>();
      return { conversations, loaded, pending, attachments };
    }),
  ]);
  // P5a: what each confirmed dispatch / re-run card's run actually did, read from the P4 links (never chat text).
  // Read per project under that project's tenant RLS, AFTER the owner-private load (no nested transactions).
  // Best-effort: a failure shows the cards exactly as before.
  const allCards = (stored.loaded?.messages ?? []).flatMap((m) => m.proposals);
  const linkedRuns: Map<string, LinkedRunView> = await loadLinkedRunViews(allCards, (key) => tenantForUser(user.id, key)).catch((err: unknown) => {
    log.warn('ops page linked-run lookup failed (cards shown without run outcome)', { errorClass: err instanceof Error ? err.name : 'unknown' });
    return new Map<string, LinkedRunView>();
  });
  // P5c-3: one COMPLETION ENTRY per finished linked run, placed in the transcript at its finish time (after the last
  // message created before it finished). Derived from the run rows on every load — exactly one per run, nothing stored.
  const entries: CompletionEntry[] = completionEntries(
    allCards.map((c) => {
      const p = c.proposal && typeof c.proposal === 'object' ? (c.proposal as Record<string, unknown>) : {};
      return {
        proposalId: c.id,
        kind: c.kind,
        label: cardLabelOf(c.kind, p),
        projectKey: typeof p.projectKey === 'string' ? p.projectKey : null,
        view: linkedRuns.get(c.id) ?? null,
      };
    }),
  );
  const anchored = anchorEntries(stored.loaded?.messages ?? [], entries);
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
    proposals: m.proposals.map((p) => ({ id: p.id, proposal: p.proposal, state: p.state, result: p.result, error: p.error, linkedRun: linkedRuns.get(p.id) ?? null })),
    completionsAfter: anchored.get(m.id) ?? [],
    attachments: (stored.attachments.get(m.id) ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      kind: a.kind,
      sizeBytes: a.sizeBytes,
      status: a.status,
      error: a.error,
    })),
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
        leadingCompletions={anchored.get(LEADING) ?? []}
        buildId={currentBuildId()}
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
