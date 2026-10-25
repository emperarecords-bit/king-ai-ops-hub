import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { filterConversations, groupConversations, type SidebarConversation } from '@/app/ops/ops-chat-sidebar-model';
import { OpsChatSidebar } from '@/app/ops/ops-chat-sidebar';

// Owner request 2026-10-25: "my chat screen is just the chat" — conversations in a left panel on wide screens.
const now = new Date(2026, 9, 25, 15, 0, 0); // local time
const at = (daysAgo: number, hour = 10) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour).toISOString();
const list: SidebarConversation[] = [
  { id: 'a', title: 'Server cabinet cooling punch list', updatedAt: at(0, 9) },
  { id: 'b', title: '3-ton Carrier heat pump price', updatedAt: at(1) },
  { id: 'c', title: null, updatedAt: at(3) },
  { id: 'd', title: 'Bookkeeper questions', updatedAt: at(30) },
];

describe('conversation search', () => {
  it('matches every word of the query, case-insensitively, and keeps the order', () => {
    expect(filterConversations(list, '').map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterConversations(list, 'COOLING').map((c) => c.id)).toEqual(['a']);
    expect(filterConversations(list, 'heat price').map((c) => c.id)).toEqual(['b']);
    expect(filterConversations(list, 'heat cooling')).toEqual([]);
    expect(filterConversations(list, 'untitled').map((c) => c.id)).toEqual(['c']);
  });
});

describe('date groups', () => {
  it('Today / Yesterday / Previous 7 days / Older, empty groups left out', () => {
    expect(groupConversations(list, now).map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['b']],
      ['Previous 7 days', ['c']],
      ['Older', ['d']],
    ]);
    expect(groupConversations([list[3]!], now).map((g) => g.label)).toEqual(['Older']);
  });
});

describe('the left panel', () => {
  const render = (over: Partial<Parameters<typeof OpsChatSidebar>[0]> = {}) =>
    renderToStaticMarkup(
      <OpsChatSidebar conversations={list} currentId="b" streaming={false} workspaces={[{ key: 'empera-air-conditioning-and-heating', name: 'Empera Air Conditioning and Heating' }]} onOpen={() => {}} {...over} />,
    );

  it('shows New chat, search, every conversation and the workspace shortcuts', () => {
    const html = render();
    expect(html).toContain('+ New chat');
    expect(html).toContain('Search conversations');
    for (const t of ['Server cabinet cooling punch list', '3-ton Carrier heat pump price', 'Untitled conversation', 'Bookkeeper questions']) expect(html).toContain(t);
    expect(html).toContain('href="/p/empera-air-conditioning-and-heating"');
  });

  it('marks the open conversation', () => {
    expect(render()).toMatch(/aria-current="page"[^>]*title="3-ton Carrier heat pump price"/);
  });

  it('while a reply streams, New chat and other conversations are disabled (same rule as the old picker)', () => {
    const html = render({ streaming: true });
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>\+ New chat/);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1 + 3); // New chat + the three not-open conversations
  });
});
