import { describe, expect, it } from 'vitest';
import { type Sql } from 'postgres';
import { committedBlobIdentity, eolVariant, hashBuffer } from '../../scripts/backup/migration-hash';
import { type SourceManifestEntry } from '../../scripts/backup/source-manifest';
import {
  type AppliedMigration,
  type ClassifyInput,
  classifyMigrationState,
  detectMigrationState,
} from '../../scripts/backup/migration-detector';

function srcEntry(idx: number, tag: string, when: number, buf: Buffer): SourceManifestEntry {
  const id = committedBlobIdentity(buf);
  return { idx, tag, when, ...id };
}
const BUF = (i: number) => Buffer.from(`create table m${i} (a int);\n`, 'utf8'); // LF committed

function base(over: Partial<ClassifyInput> = {}): ClassifyInput {
  const source = [0, 1, 2].map((i) => srcEntry(i, `000${i}_m`, 1000 + i, BUF(i)));
  const applied: AppliedMigration[] = source.map((s, i) => ({ hash: s.committedBlobSha256, createdAt: s.when, id: i + 1 }));
  const runtime = source.map((s) => ({ when: s.when, tag: s.tag, rawHash: s.committedBlobSha256 }));
  return { source, sourceMigrationSetHash: 'a'.repeat(64), applied, runtime, migrationsTableMissing: false, declaredBootstrap: false, hasUnexplainedUserObjects: false, databaseIdentityMatches: true, ...over };
}

describe('G-Backup-A classifier — exact + recognized EOL variants', () => {
  it('all exact → NO_PENDING', () => {
    const r = classifyMigrationState(base());
    expect(r.state).toBe('NO_PENDING');
    expect(r.exactExecutionMatches).toBe(3);
    expect(r.lineEndingVariantMatches).toBe(0);
  });

  it('LF committed + CRLF-applied → recognized variant, still NO_PENDING', () => {
    const source = [0, 1, 2].map((i) => srcEntry(i, `000${i}_m`, 1000 + i, BUF(i)));
    const applied = source.map((s, i) => ({ hash: i === 1 ? s.recognizedVariantSha256! : s.committedBlobSha256, createdAt: s.when, id: i + 1 }));
    const r = classifyMigrationState(base({ source, applied }));
    expect(r.state).toBe('NO_PENDING');
    expect(r.lineEndingVariantMatches).toBe(1);
    expect(r.variantDetails[0]!.recognizedVariantType).toBe('LF_committed_CRLF_applied');
  });

  it('CRLF committed + LF-applied → recognized variant', () => {
    const crlf = Buffer.from('create table z (a int);\r\n', 'utf8');
    const source = [srcEntry(0, '0000_m', 1000, crlf)];
    const lfHash = hashBuffer(eolVariant(crlf, 'CRLF')!);
    const applied = [{ hash: lfHash, createdAt: 1000, id: 1 }];
    const runtime = [{ when: 1000, tag: '0000_m', rawHash: lfHash }];
    const r = classifyMigrationState(base({ source, applied, runtime }));
    expect(r.state).toBe('NO_PENDING');
    expect(r.variantDetails[0]!.recognizedVariantType).toBe('CRLF_committed_LF_applied');
  });

  it.each([
    ['space', (s: string) => s.replace('int', 'int '), ],
    ['trailing whitespace', (s: string) => s.replace(';\n', '; \n')],
    ['blank line', (s: string) => s.replace('\n', '\n\n')],
    ['sql comment', (s: string) => s.replace('create', '-- c\ncreate')],
  ])('non-newline content change (%s) → HISTORICAL_HASH_MISMATCH', (_label, mutate) => {
    const source = [srcEntry(0, '0000_m', 1000, BUF(0))];
    const changed = hashBuffer(Buffer.from(mutate(BUF(0).toString('utf8')), 'utf8'));
    const applied = [{ hash: changed, createdAt: 1000, id: 1 }];
    const r = classifyMigrationState(base({ source, applied, runtime: [{ when: 1000, tag: '0000_m', rawHash: changed }] }));
    expect(r.state).toBe('HISTORICAL_HASH_MISMATCH');
    expect(r.unknownHistoricalMismatches).toBe(1);
  });

  it('unicode-normalization change → HISTORICAL_HASH_MISMATCH', () => {
    const composed = Buffer.from("caf\u00e9;\n", "utf8"); // U+00E9 (NFC)
    const decomposed = Buffer.from("cafe\u0301;\n", "utf8"); // e + U+0301 (NFD)
    const source = [srcEntry(0, '0000_m', 1000, composed)];
    const applied = [{ hash: hashBuffer(decomposed), createdAt: 1000, id: 1 }];
    const r = classifyMigrationState(base({ source, applied, runtime: [{ when: 1000, tag: '0000_m', rawHash: hashBuffer(decomposed) }] }));
    expect(r.state).toBe('HISTORICAL_HASH_MISMATCH');
  });

  it('applied variant + no pending → NO_PENDING WITH runtime-mismatch warning metadata', () => {
    const source = [srcEntry(0, '0000_m', 1000, BUF(0))];
    const applied = [{ hash: source[0]!.recognizedVariantSha256!, createdAt: 1000, id: 1 }]; // CRLF applied
    const runtime = [{ when: 1000, tag: '0000_m', rawHash: source[0]!.committedBlobSha256 }]; // LF working tree ≠ applied
    const r = classifyMigrationState(base({ source, applied, runtime }));
    expect(r.state).toBe('NO_PENDING');
    expect(r.lineEndingVariantMatches).toBe(1);
    expect(r.runtimeMismatchWarnings.length).toBe(1);
    expect(r.variantDetails[0]!.runtimeEqualsApplied).toBe(false);
  });
});

describe('G-Backup-A classifier — pending binding', () => {
  it('pending runtime bytes = recognized EOL variant → PENDING_FORWARD, pendingBindable true', () => {
    const source = [0, 1, 2].map((i) => srcEntry(i, `000${i}_m`, 1000 + i, BUF(i)));
    const applied = [{ hash: source[0]!.committedBlobSha256, createdAt: 1000, id: 1 }];
    const runtime = source.map((s, i) => ({ when: s.when, tag: s.tag, rawHash: i === 2 ? s.recognizedVariantSha256! : s.committedBlobSha256 }));
    const r = classifyMigrationState(base({ source, applied, runtime }));
    expect(r.state).toBe('PENDING_FORWARD');
    expect(r.pendingTags).toEqual(['0001_m', '0002_m']);
    expect(r.pendingBindable).toBe(true);
  });

  it('pending runtime bytes match neither source nor variant → PENDING_FORWARD, pendingBindable false', () => {
    const source = [0, 1].map((i) => srcEntry(i, `000${i}_m`, 1000 + i, BUF(i)));
    const applied = [{ hash: source[0]!.committedBlobSha256, createdAt: 1000, id: 1 }];
    const runtime = [{ when: 1000, tag: '0000_m', rawHash: source[0]!.committedBlobSha256 }, { when: 1001, tag: '0001_m', rawHash: 'b'.repeat(64) }];
    const r = classifyMigrationState(base({ source, applied, runtime }));
    expect(r.state).toBe('PENDING_FORWARD');
    expect(r.pendingBindable).toBe(false);
  });
});

describe('G-Backup-A classifier — ordering, duplicates, divergence (correction 6)', () => {
  it('duplicate applied created_at → UNKNOWN_DATABASE_DIVERGENCE', () => {
    const b = base();
    const applied = [...b.applied!]; applied[2] = { ...applied[1]!, hash: 'c'.repeat(64) };
    expect(classifyMigrationState({ ...b, applied }).state).toBe('UNKNOWN_DATABASE_DIVERGENCE');
  });
  it('duplicate applied hash → UNKNOWN_DATABASE_DIVERGENCE', () => {
    const b = base();
    const applied = [...b.applied!]; applied[2] = { ...applied[2]!, hash: applied[1]!.hash };
    expect(classifyMigrationState({ ...b, applied }).state).toBe('UNKNOWN_DATABASE_DIVERGENCE');
  });
  it('applied out of order → UNKNOWN_DATABASE_DIVERGENCE', () => {
    const b = base();
    const applied = [b.applied![0]!, { ...b.applied![2]! }, { ...b.applied![1]! }];
    expect(classifyMigrationState({ ...b, applied }).state).toBe('UNKNOWN_DATABASE_DIVERGENCE');
  });
  it('extra applied beyond source → UNKNOWN_DATABASE_DIVERGENCE', () => {
    const b = base();
    const applied = [...b.applied!, { hash: 'd'.repeat(64), createdAt: 99999, id: 9 }];
    expect(classifyMigrationState({ ...b, applied }).state).toBe('UNKNOWN_DATABASE_DIVERGENCE');
  });
  it('duplicated/unordered journal timestamps → DETECTOR_FAILURE', () => {
    const b = base();
    const source = [b.source[0]!, { ...b.source[1]!, when: b.source[0]!.when }, b.source[2]!]; // duplicate when
    expect(classifyMigrationState({ ...b, source }).state).toBe('DETECTOR_FAILURE');
  });
});

describe('G-Backup-A classifier — catalog-complete BOOTSTRAP_EMPTY (correction 3)', () => {
  const missing = (over: Partial<ClassifyInput>) => base({ migrationsTableMissing: true, applied: null, ...over });
  it('table missing + declared + identity ok + no user objects → BOOTSTRAP_EMPTY', () => {
    expect(classifyMigrationState(missing({ declaredBootstrap: true, databaseIdentityMatches: true, hasUnexplainedUserObjects: false })).state).toBe('BOOTSTRAP_EMPTY');
  });
  it('unexplained user objects (table/seq/view/func) → MIGRATION_TABLE_MISSING_NONEMPTY', () => {
    expect(classifyMigrationState(missing({ declaredBootstrap: true, hasUnexplainedUserObjects: true })).state).toBe('MIGRATION_TABLE_MISSING_NONEMPTY');
  });
  it('missing bootstrap declaration → MIGRATION_TABLE_MISSING_NONEMPTY', () => {
    expect(classifyMigrationState(missing({ declaredBootstrap: false, hasUnexplainedUserObjects: false })).state).toBe('MIGRATION_TABLE_MISSING_NONEMPTY');
  });
  it('database identity mismatch → MIGRATION_TABLE_MISSING_NONEMPTY', () => {
    expect(classifyMigrationState(missing({ declaredBootstrap: true, databaseIdentityMatches: false })).state).toBe('MIGRATION_TABLE_MISSING_NONEMPTY');
  });
});

describe('G-Backup-A detector reader (fail-closed)', () => {
  const manifest = { manifestVersion: '1', sourceCommit: 'a'.repeat(40), folder: 'drizzle', entries: [], sourceMigrationSetHash: 'a'.repeat(64) };
  it('drizzle version drift → DETECTOR_FAILURE', async () => {
    const sql = (() => { throw new Error('x'); }) as unknown as Sql;
    const r = await detectMigrationState(sql, { sourceManifest: manifest as never, migrationsFolder: 'drizzle', nodeModulesDir: 'nope' });
    expect(r.state).toBe('DETECTOR_FAILURE');
  });
  it('missing trusted source manifest → DETECTOR_FAILURE', async () => {
    const sql = (() => { throw new Error('x'); }) as unknown as Sql;
    const r = await detectMigrationState(sql, { sourceManifest: null, migrationsFolder: 'drizzle' });
    expect(r.state).toBe('DETECTOR_FAILURE');
    expect(r.detail).toContain('source manifest');
  });
  it('database query failure → DETECTOR_FAILURE', async () => {
    const sql = (() => { throw new Error('connection refused'); }) as unknown as Sql;
    const r = await detectMigrationState(sql, { sourceManifest: manifest as never, migrationsFolder: 'drizzle' });
    expect(r.state).toBe('DETECTOR_FAILURE');
  });
});
