import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthenticatedError } from '@/lib/errors';

/**
 * P5c-3 — GET /api/ops-chat/linked-runs: the live-refresh boundary. Fully mocked (no DB): auth required; only the
 * caller's OWN conversation; malformed ids refused; read-only output = views + completion entries; never cached.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  tenantForUser: vi.fn(),
  conversationExists: vi.fn(),
  listRunStartingCards: vi.fn(),
  loadContinuityCards: vi.fn(),
}));
vi.mock('@/domain/auth/guard', () => ({ requireUser: h.requireUser, tenantForUser: h.tenantForUser }));
vi.mock('@/db/tenant', () => ({ withUser: (_s: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/domain/opschat/conversations', () => ({ conversationExists: h.conversationExists, listRunStartingCards: h.listRunStartingCards }));
vi.mock('@/domain/opschat/continuity', () => ({ loadContinuityCards: h.loadContinuityCards }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { GET } from '@/app/api/ops-chat/linked-runs/route';

const CONV = '7cc10bc8-0000-4000-8000-000000000001';
const get = (q: string) => GET(new Request(`http://localhost/api/ops-chat/linked-runs${q}`));

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: 'u1' });
  h.conversationExists.mockResolvedValue(true);
  h.listRunStartingCards.mockResolvedValue([{ id: 'card1', kind: 'dispatch_task', state: 'done', proposal: { projectKey: 'hvac' } }]);
  h.loadContinuityCards.mockResolvedValue([
    {
      proposalId: 'card1',
      kind: 'dispatch_task',
      label: 'dispatch "Duct"',
      projectKey: 'hvac',
      view: { taskId: 't1', runId: 'r1', state: 'ready', finishedAt: '2026-10-20T10:42:00.000Z', activeAt: '2026-10-20T10:42:00.000Z', text: 'Finished.' },
    },
  ]);
});

describe('GET /api/ops-chat/linked-runs', () => {
  it('returns the views and one completion entry per finished run, never cached', async () => {
    const res = await get(`?conversationId=${CONV}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const j = await res.json();
    expect(j.views.card1).toMatchObject({ state: 'ready', runId: 'r1' });
    expect(j.entries).toEqual([
      { proposalId: 'card1', runId: 'r1', taskId: 't1', label: 'dispatch "Duct"', resultLabel: 'FINAL', finishedAt: '2026-10-20T10:42:00.000Z', text: 'Finished.', taskPath: '/p/hvac/tasks/t1' },
    ]);
    expect(h.conversationExists).toHaveBeenCalledWith(expect.anything(), 'u1', CONV);
  });

  it('401 without a session; 400 for a malformed id; 404 for a conversation that is not the caller`s (no hint it exists)', async () => {
    h.requireUser.mockRejectedValueOnce(new UnauthenticatedError());
    expect((await get(`?conversationId=${CONV}`)).status).toBe(401);
    expect((await get('?conversationId=not-a-uuid')).status).toBe(400);
    expect((await get('')).status).toBe(400);
    h.conversationExists.mockResolvedValue(false);
    const res = await get(`?conversationId=${CONV}`);
    expect(res.status).toBe(404);
    expect(h.listRunStartingCards).not.toHaveBeenCalled();
    expect(h.loadContinuityCards).not.toHaveBeenCalled();
  });

  it('a lookup failure is a plain 500 (the browser backs off), never a partial or fabricated state', async () => {
    h.loadContinuityCards.mockRejectedValue(new Error('db down'));
    const res = await get(`?conversationId=${CONV}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong.' });
  });
});
