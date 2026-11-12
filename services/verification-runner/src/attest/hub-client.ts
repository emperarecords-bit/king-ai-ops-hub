/**
 * The Hub HTTP client — exactly the three runner-facing capabilities of design §6.2, and nothing
 * else. There is no method here that creates or amends a contract, because a runner credential
 * cannot: the omission is the enforcement, restated on the client so the shape of this file makes
 * the permission matrix obvious.
 *
 * IMPLEMENTED AGAINST WHAT IS BUILT, NOT WHAT IS DESIGNED. Design §4.1 chooses a presigned PUT
 * direct to S3; PR-4 as merged instead issues a grant whose uploadPath is a HUB endpoint that
 * streams the bytes through and enforces size/checksum/create-only server-side. This client targets
 * the as-built contract. If §4.1 direct-to-provider is ever realised (gated on PR-5 acceptance),
 * only redeemGrant changes.
 */
import type { SignedEnvelope, UploadGrantView, VerificationContract } from '../contract';

export type HubErrorKind =
  | 'unauthorized'
  | 'forbidden_or_disabled'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'payload_too_large'
  | 'unprocessable'
  | 'quota_exceeded'
  | 'unavailable'
  | 'rejected'
  | 'server_error'
  | 'malformed_response';

export class HubError extends Error {
  constructor(
    public readonly kind: HubErrorKind,
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HubError';
  }

  /**
   * Whether retrying the identical request could plausibly succeed. Deliberately conservative:
   * a 409 conflict is NOT retryable because it means our declaration differs from a grant that
   * already exists, and 507 is NOT retryable because the project is full until space is freed.
   */
  get retryable(): boolean {
    return this.kind === 'server_error' || this.kind === 'unavailable';
  }
}

/**
 * Map a status to a typed kind. 507 is singled out because the Hub chose it deliberately for an
 * aggregate-quota refusal (RFC 4918): the request is valid and the artifact is within the
 * per-artifact cap — the project simply has no room, so the runner must not alter its request.
 */
function kindFor(status: number): HubErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden_or_disabled';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 410) return 'gone';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'unprocessable';
  if (status === 507) return 'quota_exceeded';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'server_error';
  return 'rejected';
}

export interface HubClientOptions {
  readonly baseUrl: string;
  readonly projectKey: string;
  /** Authorization: Bearer keyId.secret — the machine credential of design §6.1. */
  readonly keyId: string;
  readonly keySecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class HubClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HubClientOptions) {
    if (!opts.keyId || !opts.keySecret) throw new Error('HubClient: keyId and keySecret are required');
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The bearer credential. Never logged, never placed in a URL, never put in the signed payload. */
  private authHeader(): string {
    return 'Bearer ' + this.opts.keyId + '.' + this.opts.keySecret;
  }

  private url(suffix: string): string {
    return this.base + '/api/p/' + encodeURIComponent(this.opts.projectKey) + '/verification' + suffix;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const signal = this.opts.timeoutMs ? AbortSignal.timeout(this.opts.timeoutMs) : undefined;
    const res = await this.fetchImpl(url, {
      ...init,
      ...(signal ? { signal } : {}),
      headers: { ...(init.headers ?? {}), authorization: this.authHeader() },
    });
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const err = (body as { error?: unknown } | undefined)?.error;
      const detail = typeof err === 'string' ? err : res.statusText;
      throw new HubError(kindFor(res.status), res.status, (init.method ?? 'GET') + ' ' + url + ' -> ' + res.status + ' ' + detail, body);
    }
    return res;
  }

  /** §6.2 row 2 — read the contracts this project may see. Read-only. */
  async listContracts(): Promise<readonly VerificationContract[]> {
    const res = await this.request(this.url('/requests'), { method: 'GET' });
    const body = (await res.json()) as { requests?: unknown };
    const rows = Array.isArray(body?.requests) ? body.requests : null;
    if (!rows) throw new HubError('malformed_response', res.status, 'listContracts: no requests array in response', body);
    return rows as readonly VerificationContract[];
  }

  async getContract(id: string): Promise<VerificationContract> {
    const res = await this.request(this.url('/requests/' + encodeURIComponent(id)), { method: 'GET' });
    const body = (await res.json()) as { request?: unknown };
    if (!body?.request) throw new HubError('malformed_response', res.status, 'getContract: no request in response', body);
    return body.request as VerificationContract;
  }

  /** §6.2 row 3 — runner-only. Size and digest are DECLARED here and bound into the grant. */
  async requestGrant(input: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly logicalPath: string;
    readonly declaredSize: number;
    readonly declaredSha256: string;
    readonly contentType?: string;
  }): Promise<UploadGrantView> {
    const res = await this.request(this.url('/uploads'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json()) as { grant?: unknown };
    if (!body?.grant) throw new HubError('malformed_response', res.status, 'requestGrant: no grant in response', body);
    return body.grant as UploadGrantView;
  }

  /**
   * Redeem a grant by sending the bytes. The Hub re-derives size and digest and refuses a mismatch,
   * so there is nothing to gain by recomputing here: send exactly what was declared and let the
   * server be the judge.
   */
  async redeemGrant(uploadPath: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.request(this.base + uploadPath, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: body as unknown as BodyInit,
    });
  }

  /** §6.2 row 4 — submit the signed envelope. The signature is required on every path. */
  async submitEvidence(envelope: SignedEnvelope): Promise<{ readonly accepted: boolean; readonly body: unknown }> {
    const res = await this.request(this.url(''), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const body = (await res.json()) as { accepted?: unknown };
    return { accepted: body?.accepted === true, body };
  }
}
