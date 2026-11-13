import { describe, expect, it } from 'vitest';
import {
  defaultTokenKeys,
  hasServiceToken,
  resolveServiceToken,
  serviceTokenEnvVar,
} from '@/domain/integrations/accuratebids-tokens';
import { sightDepsFromEnv } from '@/domain/integrations/accuratebids-sight';
import { accurateBidsDepsFromEnv } from '@/domain/execution/accuratebids-quote-executor';

/**
 * Per-workspace AccurateBids routing (owner direction 2026-11-13).
 *
 * AccurateBids identifies the contractor from the bearer token alone, so the token IS the account.
 * Hill Street Construction (`empera-home-improvement`) billing Roosevelt Island work to Empera Air
 * Conditioning's account is the bug being fixed; a SILENT fallback to the shared token would
 * reintroduce it invisibly, which is why 'none' exists and why these cases must not soften.
 */

const EMPERA = 'empera-air-conditioning-and-heating';
const HILL = 'empera-home-improvement';
const HILL_VAR = 'ACCURATEBIDS_SERVICE_TOKEN__EMPERA_HOME_IMPROVEMENT';

describe('serviceTokenEnvVar — key to variable name', () => {
  it('uppercases and swaps hyphens, the name the owner sets in Fly', () => {
    expect(serviceTokenEnvVar(HILL)).toBe(HILL_VAR);
    expect(serviceTokenEnvVar(EMPERA)).toBe('ACCURATEBIDS_SERVICE_TOKEN__EMPERA_AIR_CONDITIONING_AND_HEATING');
    expect(serviceTokenEnvVar('accuratebids-com')).toBe('ACCURATEBIDS_SERVICE_TOKEN__ACCURATEBIDS_COM');
  });

  it('REFUSES a key outside the slug charset, so two keys can never share one variable', () => {
    // 'a_b' and 'a-b' would both map to ..._A_B. Mapping no name at all is the only safe answer:
    // a collision here hands one workspace another workspace's contractor account.
    expect(serviceTokenEnvVar('a_b')).toBeNull();
    expect(serviceTokenEnvVar('Empera-Home')).toBeNull();
    expect(serviceTokenEnvVar('has space')).toBeNull();
    expect(serviceTokenEnvVar('')).toBeNull();
  });
});

describe('resolveServiceToken', () => {
  it('prefers the workspace own token over the shared one', () => {
    const r = resolveServiceToken(HILL, { ACCURATEBIDS_SERVICE_TOKEN: 'empera-tok', [HILL_VAR]: 'hill-tok' });
    expect(r).toEqual({ token: 'hill-tok', source: 'per-project' });
  });

  it('falls back to the shared token while no allowlist is set — todays behaviour, unchanged', () => {
    const r = resolveServiceToken(HILL, { ACCURATEBIDS_SERVICE_TOKEN: 'empera-tok' });
    expect(r).toEqual({ token: 'empera-tok', source: 'default' });
  });

  it('allows the shared token only to the workspaces named in the allowlist', () => {
    const env = { ACCURATEBIDS_SERVICE_TOKEN: 'empera-tok', ACCURATEBIDS_DEFAULT_TOKEN_KEYS: ` ${EMPERA} , accuratebids-com ` };
    expect(resolveServiceToken(EMPERA, env)).toEqual({ token: 'empera-tok', source: 'default' });
    expect(resolveServiceToken('accuratebids-com', env)).toEqual({ token: 'empera-tok', source: 'default' });
  });

  it('REFUSES rather than misroutes: allowlisted elsewhere and no token of its own', () => {
    // The whole point. A typo in the Hill Street secret must stop the action, not bill Empera.
    const env = { ACCURATEBIDS_SERVICE_TOKEN: 'empera-tok', ACCURATEBIDS_DEFAULT_TOKEN_KEYS: EMPERA };
    expect(resolveServiceToken(HILL, env)).toEqual({ token: undefined, source: 'none' });
    expect(hasServiceToken(HILL, env)).toBe(false);
    // ...and the same workspace is fine the moment its own secret is set.
    expect(resolveServiceToken(HILL, { ...env, [HILL_VAR]: 'hill-tok' })).toEqual({
      token: 'hill-tok',
      source: 'per-project',
    });
  });

  it('a workspace own token works even when it is NOT on the shared allowlist', () => {
    const env = { ACCURATEBIDS_SERVICE_TOKEN: 'empera-tok', ACCURATEBIDS_DEFAULT_TOKEN_KEYS: EMPERA, [HILL_VAR]: 'hill-tok' };
    expect(resolveServiceToken(HILL, env).token).toBe('hill-tok');
    expect(hasServiceToken(HILL, env)).toBe(true);
  });

  it('a key that maps to no variable never silently takes the shared token when restricted', () => {
    const env = { ACCURATEBIDS_SERVICE_TOKEN: 'empera-tok', ACCURATEBIDS_DEFAULT_TOKEN_KEYS: EMPERA, ACCURATEBIDS_SERVICE_TOKEN__A_B: 'x' };
    expect(resolveServiceToken('a_b', env)).toEqual({ token: undefined, source: 'none' });
  });

  it('no key in hand keeps the shared token, so untouched call sites do not regress', () => {
    expect(resolveServiceToken(undefined, { ACCURATEBIDS_SERVICE_TOKEN: 'empera-tok' })).toEqual({
      token: 'empera-tok',
      source: 'default',
    });
  });

  it('unconfigured is "default with nothing", never "none" — the callers existing not-configured message still fires', () => {
    expect(resolveServiceToken(EMPERA, {})).toEqual({ token: undefined, source: 'default' });
    expect(resolveServiceToken(EMPERA, { ACCURATEBIDS_SERVICE_TOKEN: '' })).toEqual({ token: undefined, source: 'default' });
    expect(hasServiceToken(EMPERA, {})).toBe(false);
  });

  it('an empty or whitespace allowlist means unset, not "nobody"', () => {
    expect(defaultTokenKeys({ ACCURATEBIDS_DEFAULT_TOKEN_KEYS: ' , ' })).toEqual([]);
    expect(resolveServiceToken(HILL, { ACCURATEBIDS_SERVICE_TOKEN: 't', ACCURATEBIDS_DEFAULT_TOKEN_KEYS: ' , ' }).token).toBe('t');
  });
});

describe('both dep factories route by workspace', () => {
  const env = {
    ACCURATEBIDS_SNAPSHOT_URL: 'https://x/hub-snapshot',
    ACCURATEBIDS_QUOTE_URL: 'https://x/hub-quote',
    ACCURATEBIDS_SERVICE_TOKEN: 'empera-tok',
    ACCURATEBIDS_DEFAULT_TOKEN_KEYS: EMPERA,
    [HILL_VAR]: 'hill-tok',
  };

  it('the read path (sight) carries the workspace own token', () => {
    expect(sightDepsFromEnv(HILL, env).serviceToken).toBe('hill-tok');
    expect(sightDepsFromEnv(EMPERA, env).serviceToken).toBe('empera-tok');
  });

  it('the write path (quotes/invoices/sends) carries the workspace own token', () => {
    expect(accurateBidsDepsFromEnv(HILL, env).serviceToken).toBe('hill-tok');
    expect(accurateBidsDepsFromEnv(EMPERA, env).serviceToken).toBe('empera-tok');
  });

  it('an unentitled workspace gets no token from either path', () => {
    const bare = { ...env, [HILL_VAR]: undefined };
    expect(sightDepsFromEnv(HILL, bare).serviceToken).toBeUndefined();
    expect(accurateBidsDepsFromEnv(HILL, bare).serviceToken).toBeUndefined();
  });
});
