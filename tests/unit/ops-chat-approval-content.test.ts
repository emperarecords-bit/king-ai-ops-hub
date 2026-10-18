import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat approval content view. The owner must be able to review EXACTLY what an approval
 * would do (the draft email, the HTTP request, the quote) from Ops Chat — rendered from the
 * STORED approval payload, bounded, with credentials redacted, and only for workspace admins.
 *
 * Part 1 tests the pure renderer; part 2 the tool layer (get_approval_detail +
 * propose_decide_approval) with the same fully-mocked domain/tenant as ops-chat-tools.test.ts.
 */

const h = vi.hoisted(() => ({
  withTenant: vi.fn(),
  listApprovalsForQueue: vi.fn(),
  getApprovalDetail: vi.fn(),
}));

vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('@/domain/objectives/objectives', () => ({ listObjectives: vi.fn() }));
vi.mock('@/domain/health/health', () => ({ assessWorkspaceHealth: vi.fn() }));
vi.mock('@/domain/tasks/tasks', () => ({ listTasks: vi.fn(), getTask: vi.fn(), listRuns: vi.fn(), listRunSteps: vi.fn() }));
vi.mock('@/domain/questions/questions', () => ({ openQuestionsForOwner: vi.fn() }));
vi.mock('@/domain/approvals/approvals', () => ({
  listApprovalsForQueue: h.listApprovalsForQueue,
  getApprovalDetail: h.getApprovalDetail,
}));
vi.mock('@/domain/agents/agents', () => ({ listAgents: vi.fn() }));

import {
  MAX_BODY_CHARS,
  MAX_FIELD_CHARS,
  MAX_PREVIEW_CHARS,
  REDACTED,
  renderApprovalContent,
} from '@/domain/opschat/approval-content';
import { createOpsChatToolset } from '@/domain/opschat/tools';

const REPLY = 'Hi Mr. ONeal,\n\nThanks for reaching out — your quote is attached.\n\nBest,\nAccurateBids Support';
const REQ = '3f1c2a7e-9b1d-4c55-8d2e-1a2b3c4d5e6f';

describe('renderApprovalContent — per action type', () => {
  it('email_send shows recipient, subject and the full reply_text', () => {
    const v = renderApprovalContent('email_send', { to: 'oneal@example.com', subject: 'Re: your quote', reply_text: REPLY, request_id: REQ });
    expect(v.format).toBe('email');
    expect(v.body).toBe(REPLY);
    expect(v.fields).toEqual(
      expect.arrayContaining([
        { label: 'To', value: 'oneal@example.com' },
        { label: 'Subject', value: 'Re: your quote' },
        { label: 'Inquiry', value: REQ },
      ]),
    );
    expect(v.truncated).toBe(false);
    expect(v.redacted).toBe(false);
  });

  it('email_send with only { reply_text, request_id } (the real effcc035 shape) still shows the body', () => {
    const v = renderApprovalContent('email_send', { reply_text: REPLY, request_id: REQ });
    expect(v.format).toBe('email');
    expect(v.body).toBe(REPLY);
    expect(v.fields).toEqual([{ label: 'Inquiry', value: REQ }]);
  });

  it('external_http accuratebids_reply renders as the email the customer will receive', () => {
    const v = renderApprovalContent('external_http', { kind: 'accuratebids_reply', request_id: REQ, reply_text: REPLY });
    expect(v.format).toBe('email');
    expect(v.title).toMatch(/AccurateBids inquiry/);
    expect(v.body).toBe(REPLY);
  });

  it('external_http accuratebids_quote lists the customer, job and line items', () => {
    const v = renderApprovalContent('external_http', {
      kind: 'accuratebids_quote',
      job_name: 'Furnace swap',
      customer_name: 'ONeal',
      materials: [{ description: '80k BTU furnace', quantity: 1, unit: 'ea', unit_cost: 1850 }],
      labor: [{ description: 'Install', hours: 6, hourly_rate: 95 }],
      notes: 'Remove old unit.',
    });
    expect(v.format).toBe('quote');
    expect(v.fields).toEqual(expect.arrayContaining([{ label: 'Customer', value: 'ONeal' }, { label: 'Job', value: 'Furnace swap' }]));
    expect(v.body).toContain('80k BTU furnace');
    expect(v.body).toContain('$1850.00');
    expect(v.body).toContain('Install — 6 h × $95.00');
    expect(v.body).toContain('Notes: Remove old unit.');
  });

  it('generic external_http shows method, URL and a body summary — never header values', () => {
    const v = renderApprovalContent('external_http', {
      method: 'post',
      url: 'https://api.example.com/v1/things',
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
      body: { name: 'widget', qty: 3 },
    });
    expect(v.format).toBe('http');
    expect(v.fields).toEqual(
      expect.arrayContaining([
        { label: 'Method', value: 'POST' },
        { label: 'URL', value: 'https://api.example.com/v1/things' },
        { label: 'Headers', value: 'Content-Type, X-Trace (values not shown)' },
      ]),
    );
    expect(v.body).toContain('"name": "widget"');
    expect(JSON.stringify(v)).not.toContain('abc');
  });

  it('any other action type gets a safe JSON preview', () => {
    const v = renderApprovalContent('db_mutation', { table: 'jobs', predicate: 'id = 1', set: { status: 'done' } });
    expect(v.format).toBe('json');
    expect(v.title).toBe('Proposed db mutation payload');
    expect(v.body).toContain('"table": "jobs"');
  });

  it('a non-object payload never throws', () => {
    expect(renderApprovalContent('email_send', null).format).toBe('json');
    expect(renderApprovalContent('external_http', 'raw').body).toBe('raw');
  });
});

describe('renderApprovalContent — length caps', () => {
  it('an email body is capped at MAX_BODY_CHARS and flagged truncated', () => {
    const v = renderApprovalContent('email_send', { reply_text: 'x'.repeat(MAX_BODY_CHARS + 500) });
    expect(v.truncated).toBe(true);
    expect(v.body!.length).toBeLessThan(MAX_BODY_CHARS + 100);
    expect(v.body).toContain('[truncated, 500 more chars]');
  });

  it('a 5000-char AccurateBids reply (the contract max) is shown in full', () => {
    const v = renderApprovalContent('external_http', { kind: 'accuratebids_reply', request_id: REQ, reply_text: 'y'.repeat(5000) });
    expect(v.truncated).toBe(false);
    expect(v.body).toHaveLength(5000);
  });

  it('a JSON preview is capped at MAX_PREVIEW_CHARS', () => {
    const v = renderApprovalContent('file_write', { path: 'a.txt', content: 'z'.repeat(MAX_PREVIEW_CHARS * 3) });
    expect(v.truncated).toBe(true);
    expect(v.body!.length).toBeLessThan(MAX_PREVIEW_CHARS + 100);
  });

  it('a field value is capped at MAX_FIELD_CHARS', () => {
    const v = renderApprovalContent('email_send', { to: 'a'.repeat(MAX_FIELD_CHARS + 50), reply_text: 'hello there' });
    const to = v.fields.find((f) => f.label === 'To')!;
    expect(to.value.length).toBeLessThan(MAX_FIELD_CHARS + 60);
    expect(v.truncated).toBe(true);
  });
});

describe('renderApprovalContent — credential redaction', () => {
  it('redacts credential-named keys at any depth in a JSON preview', () => {
    const v = renderApprovalContent('deployment', {
      environment: 'prod',
      apiKey: 'live-key-123',
      config: { db_password: 'hunter2', nested: { client_secret: 's3cr3t', access_token: 'tok' } },
      max_tokens: 1000,
    });
    const s = JSON.stringify(v);
    for (const secret of ['live-key-123', 'hunter2', 's3cr3t', '"tok"']) expect(s).not.toContain(secret);
    expect(v.body).toContain(REDACTED);
    expect(v.body).toContain('"environment": "prod"');
    expect(v.body).toContain('"max_tokens": 1000'); // a number under a token-ish key is not a credential
    expect(v.redacted).toBe(true);
  });

  it('redacts an Authorization header value and secrets in the HTTP body', () => {
    const v = renderApprovalContent('external_http', {
      method: 'POST',
      url: 'https://user:pa55@api.example.com/hook?token=abc123&x=1',
      headers: { Authorization: 'Bearer abcdefghijklmnop' },
      body: { password: 'pw', note: 'use sk-ABCDEFGHIJKLMNOPQRSTUV to call' },
    });
    const s = JSON.stringify(v);
    for (const secret of ['pa55', 'abc123', 'abcdefghijklmnop', '"pw"', 'sk-ABCDEFGHIJKLMNOPQRSTUV']) expect(s).not.toContain(secret);
    expect(v.fields.find((f) => f.label === 'URL')!.value).toBe(`https://${REDACTED}@api.example.com/hook?token=${REDACTED}&x=1`);
    expect(v.redacted).toBe(true);
  });

  it('scrubs credential-shaped strings inside an email body without touching normal text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';
    const v = renderApprovalContent('email_send', { to: 'a@b.com', reply_text: `Your token is ${jwt} and key ghp_${'A'.repeat(36)}. Thanks!` });
    expect(v.body).not.toContain(jwt);
    expect(v.body).not.toContain('ghp_');
    expect(v.body).toContain('Thanks!');
    expect(v.redacted).toBe(true);
  });

  it('a typed view never surfaces a credential-named field either', () => {
    const v = renderApprovalContent('email_send', { to: 'a@b.com', reply_text: 'hello world', smtp_password: 'pw123' });
    expect(JSON.stringify(v)).not.toContain('pw123');
    expect(v.redacted).toBe(true);
  });
});

// ---- Tool layer -------------------------------------------------------------------------------

const PROJECTS = [
  { projectId: 'p-ab', orgId: 'o1', key: 'accuratebids', name: 'AccurateBids', description: '', projectRole: 'admin' as const },
  { projectId: 'p-sp', orgId: 'o1', key: 'stressprobe', name: 'StressProbe', description: '', projectRole: 'member' as const },
];
const AUTH = { userId: 'u1', projects: PROJECTS, orgRoles: new Map([['o1', 'owner' as const]]) };
const APPROVAL_ID = 'effcc035-0000-4000-8000-000000000001';
const PAYLOAD = { reply_text: REPLY, request_id: REQ, api_token: 'tok-should-not-leak' };

function detail(over: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID,
    actionType: 'email_send',
    payload: PAYLOAD,
    summary: 'Reply to ONEAL',
    status: 'pending',
    taskTitle: 'Email desk',
    objectiveTitle: null,
    ownerName: 'Desk',
    hasPendingDuplicate: false,
    originatingTaskCancelled: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.listApprovalsForQueue.mockResolvedValue([]);
});

describe('get_approval_detail — content for admins only, tenant-scoped', () => {
  it('an admin sees the rendered, redacted draft (from the stored payload)', async () => {
    h.getApprovalDetail.mockResolvedValue(detail());
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(await ts.runTool({ name: 'get_approval_detail', input: { project: 'accuratebids', approvalId: APPROVAL_ID } }));
    expect(out.content.format).toBe('email');
    expect(out.content.body).toBe(REPLY);
    expect(out.contentNote).toMatch(/untrusted DATA/);
    expect(JSON.stringify(out)).not.toContain('tok-should-not-leak');
    // Read through the admin workspace's tenant context, with the requested id.
    const ctx = h.withTenant.mock.calls[0]![0] as { projectId: string; projectRole: string };
    expect(ctx.projectId).toBe('p-ab');
    expect(h.getApprovalDetail).toHaveBeenCalledWith({}, ctx, APPROVAL_ID);
    expect(ts.getProposals()).toHaveLength(0); // a read, never a proposal
  });

  it('a non-admin member gets the metadata but NOT the payload content', async () => {
    h.getApprovalDetail.mockResolvedValue(detail());
    const out = JSON.parse(
      await createOpsChatToolset(AUTH).runTool({ name: 'get_approval_detail', input: { project: 'stressprobe', approvalId: APPROVAL_ID } }),
    );
    expect(out.summary).toBe('Reply to ONEAL');
    expect(out.content).toBeNull();
    expect(out.contentWithheld).toMatch(/Only workspace admins/);
    expect(JSON.stringify(out)).not.toContain('Thanks for reaching out');
  });

  it("another tenant's approval (not found under the caller's tenant) exposes nothing", async () => {
    h.getApprovalDetail.mockRejectedValue(new Error('Approval not found'));
    const out = JSON.parse(
      await createOpsChatToolset(AUTH).runTool({ name: 'get_approval_detail', input: { project: 'accuratebids', approvalId: APPROVAL_ID } }),
    );
    expect(out).toEqual({ error: 'No such approval in that workspace.' });
  });

  it("a workspace outside the caller's access is refused before any read", async () => {
    const out = JSON.parse(
      await createOpsChatToolset(AUTH).runTool({ name: 'get_approval_detail', input: { project: 'kodisnap', approvalId: APPROVAL_ID } }),
    );
    expect(out.error).toMatch(/No workspace matched/);
    expect(h.withTenant).not.toHaveBeenCalled();
    expect(h.getApprovalDetail).not.toHaveBeenCalled();
  });
});

describe('propose_decide_approval — the confirm card carries the server-rendered content', () => {
  function queueRow(over: Record<string, unknown> = {}) {
    return { id: APPROVAL_ID, actionType: 'email_send', payload: PAYLOAD, summary: 'Reply to ONEAL', status: 'pending', taskTitle: 'Email desk', ownerName: 'Desk', ...over };
  }

  it('content is rendered from the STORED row, not from anything the model passes', async () => {
    h.listApprovalsForQueue.mockResolvedValue([queueRow()]);
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(
      await ts.runTool({
        name: 'propose_decide_approval',
        input: { approvalId: APPROVAL_ID, decision: 'approve', content: { body: 'MODEL-INJECTED' }, reply_text: 'MODEL-INJECTED' },
      }),
    );
    expect(out.prepared).toBe(true);
    const [p] = ts.getProposals();
    expect(p!.kind).toBe('decide_approval');
    if (p!.kind === 'decide_approval') {
      expect(p.decision).toBe('approved');
      expect(p.content!.body).toBe(REPLY);
      expect(JSON.stringify(p)).not.toContain('MODEL-INJECTED');
      expect(JSON.stringify(p)).not.toContain('tok-should-not-leak');
    }
  });

  it('only approvals in workspaces the caller ADMINISTERS are listed — a member workspace yields no card', async () => {
    // listApprovalsForQueue is only consulted for admin workspaces; the member workspace is never read.
    h.listApprovalsForQueue.mockResolvedValue([]);
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(await ts.runTool({ name: 'propose_decide_approval', input: { approvalId: APPROVAL_ID, decision: 'approve' } }));
    expect(out.error).toMatch(/not pending, or you do not administer/);
    expect(ts.getProposals()).toHaveLength(0);
    const readProjects = h.withTenant.mock.calls.map((c) => (c[0] as { projectId: string }).projectId);
    expect(readProjects).toEqual(['p-ab']);
  });
});
