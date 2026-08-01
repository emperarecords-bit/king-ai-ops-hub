/**
 * G-Backup-B1 — deterministic, non-circular receipt locator.
 *
 * The locator is derived only from values the release Machine already knows BEFORE fetching (environment, target
 * application, deployment nonce). It intentionally does NOT include the receipt canonical hash (which is unknown
 * pre-fetch). The locator is a pointer, NOT a trust anchor — Ed25519 is the trust anchor. The URL is fully
 * constrained: HTTPS only, exact approved host, no userinfo, no query, no fragment, no traversal, no alternate
 * encodings; the path is exactly `/v2/<environment>/<targetApplication>/<deploymentNonce>.json`.
 */

import { isValidDeploymentNonce } from './receipt-v2-canonical';

export class ReceiptLocatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptLocatorError';
  }
}

const SAFE_ENV = /^(?:staging|production)$/;
const SAFE_APP = /^[A-Za-z0-9._-]+$/;

export interface LocatorInput {
  /** Exact approved base URL, HTTPS, no trailing slash, no path/query/fragment, e.g. `https://receipts.example.com`. */
  readonly baseUrl: string;
  readonly environment: string;
  readonly targetApplication: string;
  readonly deploymentNonce: string;
  /** The set of exact hostnames permitted (the base URL host must be one of these). */
  readonly hostAllowlist: ReadonlySet<string>;
}

function parseHttpsBase(baseUrl: string, hostAllowlist: ReadonlySet<string>): URL {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new ReceiptLocatorError('base URL is not a valid absolute URL');
  }
  if (u.protocol !== 'https:') throw new ReceiptLocatorError('base URL must be https');
  if (u.username || u.password) throw new ReceiptLocatorError('base URL must not contain userinfo');
  if (u.search) throw new ReceiptLocatorError('base URL must not contain a query string');
  if (u.hash) throw new ReceiptLocatorError('base URL must not contain a fragment');
  if (u.pathname && u.pathname !== '/') throw new ReceiptLocatorError('base URL must not contain a path');
  if (!u.hostname || u.hostname.includes('*')) throw new ReceiptLocatorError('base URL host must be an exact hostname');
  if (!hostAllowlist.has(u.hostname)) throw new ReceiptLocatorError(`host ${u.hostname} is not in the allowlist`);
  return u;
}

/** Build the exact receipt locator URL. Throws {@link ReceiptLocatorError} on any unsafe input. */
export function buildReceiptLocator(input: LocatorInput): string {
  if (!SAFE_ENV.test(input.environment)) throw new ReceiptLocatorError('unsafe environment segment');
  if (!SAFE_APP.test(input.targetApplication)) throw new ReceiptLocatorError('unsafe application segment');
  if (!isValidDeploymentNonce(input.deploymentNonce)) throw new ReceiptLocatorError('invalid deployment nonce');
  const base = parseHttpsBase(input.baseUrl, input.hostAllowlist);
  // Segments are already restricted to safe characters; assemble explicitly (no user-controlled separators).
  return `https://${base.hostname}${base.port ? `:${base.port}` : ''}/v2/${input.environment}/${input.targetApplication}/${input.deploymentNonce}.json`;
}

/**
 * Validate that a fetched-from URL is exactly the locator we intended: HTTPS, allowlisted host, no userinfo/query/
 * fragment, and the exact `/v2/<env>/<app>/<nonce>.json` path with no traversal or extra segments.
 */
export function validateReceiptUrl(url: string, input: LocatorInput): void {
  const expected = buildReceiptLocator(input);
  if (url !== expected) throw new ReceiptLocatorError('URL does not equal the deterministic locator');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ReceiptLocatorError('not a valid URL');
  }
  if (u.protocol !== 'https:') throw new ReceiptLocatorError('must be https');
  if (u.username || u.password) throw new ReceiptLocatorError('must not contain userinfo');
  if (u.search) throw new ReceiptLocatorError('must not contain a query string');
  if (u.hash) throw new ReceiptLocatorError('must not contain a fragment');
  if (!input.hostAllowlist.has(u.hostname)) throw new ReceiptLocatorError('host not allowlisted');
  if (u.pathname.includes('..') || u.pathname.includes('//') || u.pathname.includes('%')) throw new ReceiptLocatorError('unsafe path');
}
