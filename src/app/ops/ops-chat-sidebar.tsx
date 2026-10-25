'use client';

import { useMemo, useState } from 'react';
import { filterConversations, groupConversations, UNTITLED, type SidebarConversation } from './ops-chat-sidebar-model';

/**
 * Left panel on wide screens: New chat, search, the owner's conversations grouped by date, and workspace shortcuts.
 * Opening a conversation is a navigation (the page loads it server-side), blocked while a reply is streaming — the
 * same rule as the old conversation picker, which stays as the phone layout.
 */
export function OpsChatSidebar({
  conversations,
  currentId,
  streaming,
  workspaces,
  onOpen,
}: {
  conversations: readonly SidebarConversation[];
  currentId: string | null;
  streaming: boolean;
  workspaces: ReadonlyArray<{ key: string; name: string }>;
  onOpen: (id: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () => groupConversations(filterConversations(conversations, query), new Date()),
    [conversations, query],
  );

  return (
    <nav aria-label="Ops Chat conversations" className="flex h-full flex-col gap-3 text-sm">
      <button
        type="button"
        disabled={streaming}
        onClick={() => onOpen(null)}
        className="rounded-md border border-[var(--border)] px-3 py-2 text-left font-medium hover:border-[var(--accent)] disabled:opacity-40"
      >
        + New chat
      </button>
      <label className="sr-only" htmlFor="ops-chat-search">Search conversations</label>
      <input
        id="ops-chat-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search conversations"
        className="rounded-md border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-xs"
      />

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {groups.length === 0 ? (
          <p className="px-1 text-xs text-[var(--muted)]">{query ? 'No conversation matches.' : 'No conversations yet.'}</p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-3">
              <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{g.label}</p>
              <ul className="space-y-0.5">
                {g.items.map((c) => {
                  const active = c.id === currentId;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        disabled={streaming && !active}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => (active ? undefined : onOpen(c.id))}
                        title={c.title ?? UNTITLED}
                        className={
                          'w-full truncate rounded-md px-2 py-1.5 text-left text-xs disabled:opacity-40 ' +
                          (active
                            ? 'bg-[var(--surface)] font-medium text-[var(--foreground)]'
                            : 'text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]')
                        }
                      >
                        {c.title ?? UNTITLED}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {workspaces.length > 0 ? (
        <div className="border-t border-[var(--border)] pt-3">
          <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Workspaces</p>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto">
            {workspaces.map((w) => (
              <li key={w.key}>
                <a
                  href={`/p/${encodeURIComponent(w.key)}`}
                  className="block truncate rounded-md px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
                  title={w.name}
                >
                  {w.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}
