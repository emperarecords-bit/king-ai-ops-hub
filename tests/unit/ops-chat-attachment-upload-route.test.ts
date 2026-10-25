import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthenticatedError } from '@/lib/errors';
import type * as AttachmentsNs from '@/domain/opschat/attachments';

type AttachmentsModule = typeof AttachmentsNs;

/**
 * POST /api/ops-chat/attachments — the upload boundary. Fully mocked (no auth, DB, or store). Asserts:
 * auth first; type by content signature (declared MIME ignored); size limits (declared length refused
 * before buffering); another user's conversation → 404 with nothing stored; workspace association
 * requires ADMIN authority on that workspace; a valid upload stores the original under the caller's
 * private `opschat/{userId}/` prefix and records the bounded extracted text.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireTenant: vi.fn(),
  listMyProjectsWithOrgRoles: vi.fn(),
  consumeRateLimit: vi.fn(),
  createConversation: vi.fn(),
  conversationExists: vi.fn(),
  insertAttachment: vi.fn(),
  getAttachmentSummary: vi.fn(),
  put: vi.fn(),
}));

vi.mock('@/domain/auth/guard', () => ({
  requireUser: h.requireUser,
  requireTenant: h.requireTenant,
  listMyProjectsWithOrgRoles: h.listMyProjectsWithOrgRoles,
}));
vi.mock('@/domain/usage/rate-limit', () => ({ consumeRateLimit: h.consumeRateLimit }));
vi.mock('@/db/client', () => ({ getDb: () => ({ transaction: (fn: (tx: unknown) => unknown) => fn({}) }) }));
vi.mock('@/db/tenant', () => ({ withUser: (_s: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/domain/opschat/conversations', () => ({ createConversation: h.createConversation, conversationExists: h.conversationExists }));
vi.mock('@/domain/opschat/attachments', async (orig) => ({
  ...(await orig<AttachmentsModule>()),
  insertAttachment: h.insertAttachment,
  getAttachmentSummary: h.getAttachmentSummary,
}));
vi.mock('@/domain/documents/object-store', () => ({ getObjectStore: async () => ({ put: h.put }) }));
vi.mock('@/lib/env.server', () => ({ serverEnv: () => ({ RATE_LIMIT_RUNS_PER_MINUTE: 10 }) }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { POST } from '@/app/api/ops-chat/attachments/route';

const CONV = '11111111-1111-4111-8111-111111111111';

function upload(name: string, bytes: Uint8Array, opts: { type?: string; conversationId?: string; projectKey?: string; contentLength?: number } = {}): Promise<Response> {
  const form = new FormData();
  form.set('file', new File([Buffer.from(bytes)], name, { type: opts.type ?? '' }));
  form.set('conversationId', opts.conversationId ?? CONV);
  if (opts.projectKey) form.set('projectKey', opts.projectKey);
  const req = new Request('http://localhost/api/ops-chat/attachments', { method: 'POST', body: form });
  if (opts.contentLength !== undefined) {
    return POST(new Request(req, { headers: { 'content-length': String(opts.contentLength), 'content-type': req.headers.get('content-type')! } }));
  }
  return POST(req);
}

const CSV = new TextEncoder().encode('invoice,amount\nHI-413,1250.50\n');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: 'u1' });
  h.listMyProjectsWithOrgRoles.mockResolvedValue({ user: { id: 'u1' }, projects: [], orgRoles: new Map() });
  h.consumeRateLimit.mockResolvedValue(undefined);
  h.createConversation.mockResolvedValue({ id: CONV });
  h.conversationExists.mockResolvedValue(true);
  h.insertAttachment.mockResolvedValue(undefined);
  h.getAttachmentSummary.mockImplementation(async (_tx: unknown, _u: string, id: string) => ({ id, filename: 'x', kind: 'csv', sizeBytes: 1, status: 'ready' }));
  h.put.mockResolvedValue(undefined);
});

describe('POST /api/ops-chat/attachments', () => {
  it('unauthenticated → 401, nothing stored', async () => {
    h.requireUser.mockRejectedValue(new UnauthenticatedError());
    expect((await upload('a.csv', CSV)).status).toBe(401);
    expect(h.put).not.toHaveBeenCalled();
  });

  it('an unsupported type → 415, nothing stored', async () => {
    const res = await upload('run.exe', new Uint8Array([0x4d, 0x5a, 0x90]));
    expect(res.status).toBe(415);
    expect(h.put).not.toHaveBeenCalled();
    expect(h.insertAttachment).not.toHaveBeenCalled();
  });

  it('a declared image MIME on non-image bytes is refused (type is proven by signature) → 415', async () => {
    const res = await upload('photo.png', new TextEncoder().encode('<html><script>x</script>'), { type: 'image/png' });
    expect(res.status).toBe(415);
    expect(h.put).not.toHaveBeenCalled();
  });

  it('an oversized image → 413; an oversized declared body is refused before parsing → 413', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await upload('big.png', big)).status).toBe(413);
    expect((await upload('a.csv', CSV, { contentLength: 50 * 1024 * 1024 })).status).toBe(413);
    expect(h.put).not.toHaveBeenCalled();
  });

  it("another user's conversation id → 404, nothing stored", async () => {
    h.conversationExists.mockResolvedValue(false);
    const res = await upload('a.csv', CSV);
    expect(res.status).toBe(404);
    expect(h.put).not.toHaveBeenCalled();
    expect(h.insertAttachment).not.toHaveBeenCalled();
  });

  it('workspace association requires ADMIN on that workspace (member → 403, no access → 403)', async () => {
    h.requireTenant.mockResolvedValueOnce({ projectId: 'p1', projectRole: 'member' });
    expect((await upload('a.csv', CSV, { projectKey: 'acme' })).status).toBe(403);
    h.requireTenant.mockRejectedValueOnce(new ForbiddenError());
    expect((await upload('a.csv', CSV, { projectKey: 'other-tenant' })).status).toBe(403);
    expect(h.put).not.toHaveBeenCalled();
  });

  it('a valid upload stores the original under the private opschat/{user}/ prefix with extracted text', async () => {
    h.requireTenant.mockResolvedValueOnce({ projectId: 'p1', projectRole: 'admin' });
    const res = await upload('../../ledger.csv', CSV, { type: 'application/x-evil', projectKey: 'acme' });
    expect(res.status).toBe(201);
    expect(h.put).toHaveBeenCalledTimes(1);
    const [key, body, contentType] = h.put.mock.calls[0]!;
    expect(key).toMatch(/^opschat\/u1\/[0-9a-f-]{36}\/[0-9a-f]{64}$/);
    expect(Buffer.from(body).toString()).toBe('invoice,amount\nHI-413,1250.50\n');
    expect(contentType).toBe('text/csv'); // from the signature/extension, not the declared MIME
    const row = h.insertAttachment.mock.calls[0]![2];
    expect(row).toMatchObject({
      conversationId: CONV,
      projectId: 'p1',
      filename: 'ledger.csv', // path stripped
      kind: 'csv',
      status: 'ready',
      extractedText: 'invoice,amount\nHI-413,1250.50\n',
      objectKey: key,
    });
  });
});
