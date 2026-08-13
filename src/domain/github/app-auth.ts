import { createSign } from 'node:crypto';

/**
 * GitHub App authentication (Phase 6 live client). Two artifacts:
 *
 *  1. the short-lived RS256 **App JWT** (issuer = App ID, max 10 minutes) that authenticates AS THE APP, and
 *  2. the **installation access token** obtained by exchanging that JWT for one scoped to the installation —
 *     the only credential the REST calls ever carry.
 *
 * Everything is dependency-free (node:crypto) and clock-injectable so it is unit-testable against a locally
 * generated keypair with zero network. The private key value flows through parameters only — it is never
 * logged, thrown, or embedded in an error message.
 */

const b64url = (input: Buffer | string): string =>
  (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');

/** Max App JWT lifetime GitHub accepts is 10 minutes; stay under it and backdate iat for clock skew. */
const JWT_TTL_SECONDS = 9 * 60;
const JWT_BACKDATE_SECONDS = 30;

/** Build the RS256 App JWT. `nowSeconds` is injected for testability; production passes Date.now()/1000. */
export function buildAppJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iat: Math.floor(nowSeconds) - JWT_BACKDATE_SECONDS,
      exp: Math.floor(nowSeconds) + JWT_TTL_SECONDS,
      iss: appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

export interface InstallationToken {
  readonly token: string;
  /** Epoch ms after which the token must not be used. */
  readonly expiresAtMs: number;
}

/** Minimal fetch shape so tests inject a recorder and no test ever touches the network. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

/** Refresh when within this many ms of expiry — a token must never die mid-request sequence. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Exchange-and-cache of installation tokens. One instance per client; `now` is injectable for tests.
 * GitHub installation tokens live ~1 hour; the cache refreshes fail-closed inside the skew window.
 */
export class InstallationTokenSource {
  private cached: InstallationToken | null = null;

  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly installationId: bigint,
    private readonly fetchImpl: FetchLike,
    private readonly apiBase: string,
    private readonly now: () => number,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.now() > REFRESH_SKEW_MS) {
      return this.cached.token;
    }
    const jwt = buildAppJwt(this.appId, this.privateKeyPem, this.now() / 1000);
    const res = await this.fetchImpl(`${this.apiBase}/app/installations/${this.installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (res.status !== 201) {
      // Status only — never echo a response body that could carry request identifiers.
      throw new GitHubAuthError(`installation token exchange failed with HTTP ${res.status}`);
    }
    const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
      throw new GitHubAuthError('installation token exchange returned an unexpected shape');
    }
    const expiresAtMs = Date.parse(body.expires_at);
    if (Number.isNaN(expiresAtMs)) throw new GitHubAuthError('installation token carried an unparseable expiry');
    this.cached = { token: body.token, expiresAtMs };
    return body.token;
  }
}
