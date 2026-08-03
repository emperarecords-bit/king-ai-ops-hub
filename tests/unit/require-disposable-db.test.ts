import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDisposableDbForVerification,
  parseDbName,
  SHARED_DB_NAME,
} from '@tests/support/require-disposable-db';

/**
 * Unit proof for the disposable-DB verification guard. Confirms it:
 *   - THROWS when REQUIRE_DISPOSABLE_DB=1 and either url points at the shared `king_ai_hub`;
 *   - THROWS when DATABASE_MIGRATION_URL is unset while the flag is on (the exact fallback bug);
 *   - PASSES for a disposable `.../king_ai_hub_p1a_verify3` (which merely shares the prefix);
 *   - is a strict NO-OP when the flag is unset (default suite unchanged).
 */

const DISPOSABLE = 'postgresql://king:king@localhost:5433/king_ai_hub_p1a_verify3';
const SHARED = 'postgresql://king:king@localhost:5433/king_ai_hub';

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    REQUIRE_DISPOSABLE_DB: process.env.REQUIRE_DISPOSABLE_DB,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL,
  };
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function setEnv(flag: string | undefined, appUrl: string | undefined, migUrl: string | undefined): void {
  if (flag === undefined) delete process.env.REQUIRE_DISPOSABLE_DB;
  else process.env.REQUIRE_DISPOSABLE_DB = flag;
  if (appUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = appUrl;
  if (migUrl === undefined) delete process.env.DATABASE_MIGRATION_URL;
  else process.env.DATABASE_MIGRATION_URL = migUrl;
}

describe('parseDbName', () => {
  it('extracts the last path segment and strips the query', () => {
    expect(parseDbName(SHARED)).toBe('king_ai_hub');
    expect(parseDbName(DISPOSABLE)).toBe('king_ai_hub_p1a_verify3');
    expect(parseDbName('postgresql://u:p@h:5433/king_ai_hub?sslmode=require')).toBe('king_ai_hub');
    expect(parseDbName(undefined)).toBe('');
    expect(parseDbName('')).toBe('');
  });

  it('distinguishes the shared DB from a disposable one that shares its prefix (exact match, not substring)', () => {
    expect(parseDbName(SHARED)).toBe(SHARED_DB_NAME);
    expect(parseDbName(DISPOSABLE)).not.toBe(SHARED_DB_NAME);
    expect(parseDbName(DISPOSABLE).startsWith(SHARED_DB_NAME)).toBe(true); // the trap the guard must avoid
  });
});

describe('assertDisposableDbForVerification', () => {
  it('THROWS when DATABASE_URL is the shared king_ai_hub (flag on)', () => {
    setEnv('1', SHARED, DISPOSABLE);
    expect(() => assertDisposableDbForVerification('t')).toThrow(/king_ai_hub/);
  });

  it('THROWS when DATABASE_MIGRATION_URL is the shared king_ai_hub (flag on)', () => {
    setEnv('1', DISPOSABLE, SHARED);
    expect(() => assertDisposableDbForVerification('t')).toThrow(/king_ai_hub/);
  });

  it('THROWS when DATABASE_MIGRATION_URL is unset while the flag is on (the fallback bug)', () => {
    setEnv('1', DISPOSABLE, undefined);
    expect(() => assertDisposableDbForVerification('t')).toThrow(/DATABASE_MIGRATION_URL/);
  });

  it('THROWS when DATABASE_URL is unset while the flag is on', () => {
    setEnv('1', undefined, DISPOSABLE);
    expect(() => assertDisposableDbForVerification('t')).toThrow(/DATABASE_URL/);
  });

  it('PASSES for a disposable king_ai_hub_p1a_verify3 on BOTH urls (flag on)', () => {
    setEnv('1', DISPOSABLE, DISPOSABLE);
    expect(() => assertDisposableDbForVerification('t')).not.toThrow();
  });

  it('is a strict NO-OP when the flag is unset, even against the shared DB', () => {
    setEnv(undefined, SHARED, undefined);
    expect(() => assertDisposableDbForVerification('t')).not.toThrow();
  });

  it('is a strict NO-OP when the flag is set to something other than "1"', () => {
    setEnv('0', SHARED, SHARED);
    expect(() => assertDisposableDbForVerification('t')).not.toThrow();
  });
});
