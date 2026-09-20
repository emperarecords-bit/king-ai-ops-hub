import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '@/domain/auth/guard';
import { signOut } from '@/app/login/actions';
import { buildPulse, openingMessage } from '@/domain/opschat/pulse';
import { OpsChatClient } from './ops-chat-client';

/**
 * Ops Chat — the chat-first front door (owner direction 2026-09-15). You land
 * in a conversation that opens with your full pulse, and you ask the hub
 * anything in plain language. The classic dashboards remain one click away.
 *
 * v1 is READ-ONLY: it reads, summarizes, and explains; it changes nothing.
 */
export default async function OpsChatPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const pulse = await buildPulse();
  const opening = openingMessage(pulse);
  const needsYou = pulse.totals.pendingApprovals + pulse.openQuestions.length;

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-5xl flex-col p-4 sm:p-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold">Ops Chat</h1>
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">
            read-only · v1
          </span>
        </div>
        <div className="flex items-center gap-2">
          {needsYou > 0 ? (
            <Link
              href="/inbox"
              className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--accent)] hover:opacity-80"
            >
              Inbox ({pulse.totals.pendingApprovals})
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

      <OpsChatClient opening={opening} />

      <p className="mt-3 text-center text-xs text-[var(--muted)]">
        Signed in as {user.email}. Ops Chat reads your live hub — it can explain and summarize, but
        doesn&apos;t change anything yet.
      </p>
    </main>
  );
}
