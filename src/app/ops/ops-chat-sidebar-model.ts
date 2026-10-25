/**
 * Ops Chat left panel (owner request 2026-10-25: "my chat screen is just the chat" — use the wide screen the way the
 * Claude app does). Pure helpers for the conversation list: search and date groups. No IO.
 */

export interface SidebarConversation {
  id: string;
  title: string | null;
  /** ISO time of the last message (the list is most-recent first). */
  updatedAt: string;
}

export interface ConversationGroup {
  label: 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';
  items: SidebarConversation[];
}

export const UNTITLED = 'Untitled conversation';

/** Case-insensitive match on the title; every word of the query must appear. Empty query → everything. */
export function filterConversations(list: readonly SidebarConversation[], query: string): SidebarConversation[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((c) => {
    const t = (c.title ?? UNTITLED).toLowerCase();
    return words.every((w) => t.includes(w));
  });
}

const DAY = 86_400_000;

/** Start of the local day of `d` in the viewer's time zone, as epoch ms. */
function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Groups in display order; empty groups are left out. Input order (most recent first) is kept inside each group. */
export function groupConversations(list: readonly SidebarConversation[], now: Date): ConversationGroup[] {
  const today = dayStart(now);
  const order: ConversationGroup['label'][] = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];
  const groups = new Map<ConversationGroup['label'], SidebarConversation[]>(order.map((l) => [l, []]));
  for (const c of list) {
    const t = new Date(c.updatedAt).getTime();
    const label: ConversationGroup['label'] =
      t >= today ? 'Today' : t >= today - DAY ? 'Yesterday' : t >= today - 7 * DAY ? 'Previous 7 days' : 'Older';
    groups.get(label)!.push(c);
  }
  return order.map((label) => ({ label, items: groups.get(label)! })).filter((g) => g.items.length > 0);
}
