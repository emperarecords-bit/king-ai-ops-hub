import { execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyMigrationState, detectMigrationState } from '../../scripts/backup/migration-detector';
import { buildDbComparisonManifest } from '../support/db-migration-manifest';
import { assertDisposableDbForVerification } from '../support/require-disposable-db';
import {
  ActiveBundleError,
  computeActiveIndexSemanticDigest,
  isNonAuthoritativeDraftPath,
  loadActiveLegacyBundle,
  validateActiveRelPath,
} from '../../scripts/backup/legacy-active-bundle';
import { StrictJsonError, parseStrictJsonBuffer, parseStrictJsonText } from '../../scripts/backup/strict-json';
import { MigrateStageOrderError, assertMigrateStageOrder } from '../support/migrate-stage-order';
import { loadTrustBundle } from '../../scripts/backup/legacy-attestation-verify';
import { computeEvidenceManifestHash } from '../../scripts/backup/legacy-attestation-canonical';
import { legacyAttestationSchema } from '../../scripts/backup/legacy-attestation-schema';

const EXPECT = {
  keyId: 'empera-lma-001',
  fingerprint: 'ecd174572f5f80c45c29ff4186270711e3bb0ad8eb8d5cd00648b7c2b58b5803',
  attestationId: 'lma1_0d13d308cc76793c0836ad277467d1fac83bf513384259619dd5407b94193c7f',
  evidenceHash: '80535017ed9088dfe54f2e3b57b73ff96c502a4427fd099d480c07d8589a7252',
  payloadSha256: 'ffb936d893078719e1c1b98f8ab5794022e2f4801d410d6e6fb8975f8e5deaaa',
  payloadByteLength: 1500,
  appliedHash0004: 'c2c7463a277ae0c157775121b3c471fb99ce04f4f896334f070f2a8848830754',
};
const TAG = '0004_knowledge_k1';
const SCOPE = { repositoryId: 'emperarecords-bit/king-ai-ops-hub', applicationId: 'king-ai-ops-hub', migrationNamespace: 'drizzle' } as const;
const VTIME = new Date('2026-07-31T19:00:00.000Z');

const bundle = loadActiveLegacyBundle(process.cwd());

// ---------------------------------------------------------------------------
// Fixtures: a throwaway repo tree containing copies of the REAL active files, with one thing mutated.
const REAL = {
  index: 'legacy-attestations/active-index.json',
  keys: 'legacy-trust/legacy-migration-keys.json',
  att: 'legacy-attestations/0004_knowledge_k1.json',
  ev: 'legacy-evidence/0004_knowledge_k1.evidence.json',
} as const;
const realBuf = (rel: string) => readFileSync(join(process.cwd(), 'scripts', 'backup', rel));

interface FixtureCtx {
  root: string;
  base: string;
  index: { keyBundleFile: string; entries: Record<string, unknown>[]; [k: string]: unknown };
  writeRaw(rel: string, data: string | Buffer): void;
  addFile(rel: string, data: string | Buffer): void;
}
function makeFixture(mutate?: (c: FixtureCtx) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'gb-onboard-'));
  const base = join(root, 'scripts', 'backup');
  for (const d of ['legacy-trust', 'legacy-attestations', 'legacy-evidence']) mkdirSync(join(base, d), { recursive: true });
  const contents: Record<string, Buffer> = {
    [REAL.index]: realBuf(REAL.index), [REAL.keys]: realBuf(REAL.keys), [REAL.att]: realBuf(REAL.att), [REAL.ev]: realBuf(REAL.ev),
  };
  const raw = new Set<string>();
  const ctx: FixtureCtx = {
    root, base,
    index: JSON.parse(contents[REAL.index]!.toString('utf8')),
    writeRaw(rel, data) { contents[rel] = Buffer.isBuffer(data) ? data : Buffer.from(data); raw.add(rel); },
    addFile(rel, data) { mkdirSync(dirname(join(base, rel)), { recursive: true }); writeFileSync(join(base, rel), Buffer.isBuffer(data) ? data : Buffer.from(data)); },
  };
  mutate?.(ctx);
  if (!raw.has(REAL.index)) contents[REAL.index] = Buffer.from(JSON.stringify(ctx.index, null, 2) + '\n');
  for (const [rel, buf] of Object.entries(contents)) writeFileSync(join(base, rel), buf);
  return root;
}
const cleanup: string[] = [];
const fixture = (mutate?: (c: FixtureCtx) => void) => { const r = makeFixture(mutate); cleanup.push(r); return r; };

let symlinkCapable = false;
try {
  const d = mkdtempSync(join(tmpdir(), 'gb-sym-'));
  writeFileSync(join(d, 'real'), 'x');
  symlinkSync(join(d, 'real'), join(d, 'link'));
  symlinkCapable = true;
  cleanup.push(d);
} catch { symlinkCapable = false; }

afterAll(() => { for (const r of cleanup) try { rmSync(r, { recursive: true, force: true }); } catch { /* noop */ } });

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — active bundle load + integrity diagnostics', () => {
  it('exact current bundle validates; key is Ed25519; not revoked', () => {
    const tk = bundle.store.keyring.get(EXPECT.keyId);
    expect(tk!.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(bundle.store.revoked.has(EXPECT.keyId)).toBe(false);
    expect(bundle.activeTags).toEqual([TAG]);
  });
  it('public-key fingerprint + DER-SPKI diagnostics', () => {
    expect(bundle.keyFingerprints[EXPECT.keyId]).toBe(EXPECT.fingerprint);
    expect(bundle.diagnostics.keys[EXPECT.keyId]!.fingerprintSha256).toBe(EXPECT.fingerprint);
    expect(bundle.diagnostics.keys[EXPECT.keyId]!.derSpkiByteLength).toBe(44);
  });
  it('canonical payload remains 1500 bytes / sha256 / derived id; signature verified', () => {
    const f = bundle.signingFacts[TAG]!;
    expect(f.byteLength).toBe(EXPECT.payloadByteLength);
    expect(f.sha256).toBe(EXPECT.payloadSha256);
    expect(f.attestationId).toBe(EXPECT.attestationId);
    expect(f.signatureVerified).toBe(true);
  });
  it('evidence-manifest hash matches', () => {
    expect(computeEvidenceManifestHash(bundle.evidenceManifests[TAG]!)).toBe(EXPECT.evidenceHash);
  });
  it('per-file raw diagnostics are exposed (path, byte length, sha256, schema)', () => {
    expect(bundle.diagnostics.files).toHaveLength(4);
    for (const f of bundle.diagnostics.files) {
      expect(f.rawByteLength).toBeGreaterThan(0);
      expect(f.rawSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.path.startsWith('scripts/backup/')).toBe(true);
    }
  });
  it('active attestation excludes production', () => {
    expect(bundle.attestations[0]!.allowedEnvironments).toEqual(['development', 'staging']);
  });
});

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — path validation and containment', () => {
  it('valid canonical relative path accepted', () => {
    expect(validateActiveRelPath('legacy-trust/legacy-migration-keys.json', 'legacy-trust')).toBe('legacy-trust/legacy-migration-keys.json');
  });
  const rejects: [string, string][] = [
    ['absolute POSIX', '/etc/passwd'],
    ['Windows drive', 'C:/Windows/System32/x.json'],
    ['UNC path', '//server/share/x.json'],
    ['../ traversal', 'legacy-trust/../legacy-drafts/x.json'],
    ['embedded ./', 'legacy-trust/./x.json'],
    ['backslash', 'legacy-trust\\x.json'],
    ['repeated separator', 'legacy-trust//x.json'],
    ['draft directory', 'legacy-drafts/x.json'],
    ['percent-encoded traversal', 'legacy-trust/%2e%2e/x.json'],
    ['url scheme', 'file:///etc/passwd'],
    ['case-variant root', 'Legacy-Trust/x.json'],
    ['wrong root', 'legacy-evidence/x.json'],
    ['root with no file', 'legacy-trust'],
  ];
  for (const [label, p] of rejects) {
    it(`rejects ${label}`, () => {
      expect(() => validateActiveRelPath(p, 'legacy-trust')).toThrow(ActiveBundleError);
    });
  }
  it('rejects a control character in the path', () => {
    expect(() => validateActiveRelPath('legacy-trust/x\u0000.json', 'legacy-trust')).toThrow(ActiveBundleError);
  });
  it('non-regular file (directory in place of file) rejected', () => {
    const root = fixture();
    const attAbs = join(root, 'scripts', 'backup', REAL.att);
    rmSync(attAbs); mkdirSync(attAbs);
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it.runIf(symlinkCapable)('symlink as the final file rejected', () => {
    const root = fixture();
    const attAbs = join(root, 'scripts', 'backup', REAL.att);
    rmSync(attAbs); symlinkSync(join(process.cwd(), 'scripts', 'backup', REAL.att), attAbs);
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it.runIf(symlinkCapable)('symlink as a parent directory rejected', () => {
    const root = fixture();
    const evDir = join(root, 'scripts', 'backup', 'legacy-evidence');
    rmSync(evDir, { recursive: true });
    symlinkSync(join(process.cwd(), 'scripts', 'backup', 'legacy-evidence'), evDir);
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
});

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — strict duplicate-key-safe JSON parsing', () => {
  it('duplicate top-level key rejected', () => expect(() => parseStrictJsonText('{"a":1,"a":2}')).toThrow(StrictJsonError));
  it('duplicate nested key rejected', () => expect(() => parseStrictJsonText('{"o":{"a":1,"a":2}}')).toThrow(StrictJsonError));
  it('UTF-8 BOM rejected', () => expect(() => parseStrictJsonBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]))).toThrow(StrictJsonError));
  it('invalid UTF-8 rejected', () => expect(() => parseStrictJsonBuffer(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]))).toThrow(StrictJsonError));
  it('trailing data rejected', () => expect(() => parseStrictJsonText('{"a":1} garbage')).toThrow(StrictJsonError));
  it('JSON comment rejected', () => expect(() => parseStrictJsonText('{"a":1 /* c */}')).toThrow(StrictJsonError));
  it('multiple top-level values rejected', () => expect(() => parseStrictJsonText('{"a":1}{"b":2}')).toThrow(StrictJsonError));
  it('valid JSON parses', () => expect(parseStrictJsonText('{"a":[1,2],"b":"x"}')).toEqual({ a: [1, 2], b: 'x' }));
  it('the loader rejects an index file with a duplicate key', () => {
    const root = fixture((c) => c.writeRaw(REAL.index, '{"bundleVersion":"1","bundleVersion":"1","keyBundleFile":"legacy-trust/legacy-migration-keys.json","entries":[]}'));
    expect(() => loadActiveLegacyBundle(root)).toThrow(StrictJsonError);
  });
});

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — active-index binding cross-checks (fail closed)', () => {
  it('wrong key ID rejected', () => {
    const root = fixture((c) => { c.index.entries[0]!.keyId = 'other-key'; });
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('wrong attestation ID rejected', () => {
    const root = fixture((c) => { c.index.entries[0]!.attestationId = `lma1_${'a'.repeat(64)}`; });
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('wrong migration index rejected', () => {
    const root = fixture((c) => { c.index.entries[0]!.migrationIndex = 9; });
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('wrong migration tag rejected', () => {
    const root = fixture((c) => { c.index.entries[0]!.migrationTag = 'wrong_tag'; });
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('wrong evidence hash rejected', () => {
    const root = fixture((c) => { c.index.entries[0]!.expectedEvidenceManifestHash = 'b'.repeat(64); });
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('wrong key fingerprint rejected', () => {
    const root = fixture((c) => { c.index.entries[0]!.expectedPublicKeyFingerprintSha256 = 'c'.repeat(64); });
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('environment mismatch rejected', () => {
    const root = fixture((c) => { c.index.entries[0]!.allowedEnvironments = ['development']; });
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('production authorization flag rejected', () => {
    const root = fixture((c) => { c.index.entries[0]!.productionAuthorized = true; });
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('duplicate file reference rejected', () => {
    const root = fixture((c) => {
      const e0 = c.index.entries[0]! as Record<string, unknown>;
      c.index.entries.push({ ...e0, tag: 'dup_tag', migrationTag: 'dup_tag', attestationId: `lma1_${'d'.repeat(64)}` });
    });
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
});

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — directory ambiguity policy (fail closed)', () => {
  it('unreferenced active attestation JSON rejected', () => {
    const root = fixture((c) => c.addFile('legacy-attestations/shadow.json', '{"x":1}'));
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('unreferenced active evidence JSON rejected', () => {
    const root = fixture((c) => c.addFile('legacy-evidence/shadow.evidence.json', '{"x":1}'));
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('additional trust-bundle JSON rejected', () => {
    const root = fixture((c) => c.addFile('legacy-trust/second-keys.json', '{"x":1}'));
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('a non-JSON README in an active directory is ignored', () => {
    const root = fixture((c) => c.addFile('legacy-trust/README.md', '# notes'));
    expect(() => loadActiveLegacyBundle(root)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — draft exclusion + repository hygiene', () => {
  it('draft-path predicate + unsigned draft does not validate as active', () => {
    expect(isNonAuthoritativeDraftPath('legacy-drafts/x.json')).toBe(true);
    const draft = JSON.parse(readFileSync(join('scripts', 'backup', 'legacy-drafts', '0004_knowledge_k1.attestation.draft.json'), 'utf8'));
    expect(legacyAttestationSchema.safeParse(draft.signedPayload).success).toBe(false);
  });
  it('no private-key PEM in tracked non-test files; data files carry only PUBLIC keys', () => {
    const marker = ['PRIVATE', 'KEY' + '-'.repeat(5)].join(' ');
    let out = '';
    try { out = execSync(`git grep -lF ${JSON.stringify(marker)} -- . ":(exclude)tests/**"`, { encoding: 'utf8' }); } catch { out = ''; }
    expect(out.trim()).toBe('');
    const keysFile = readFileSync(join('scripts', 'backup', 'legacy-trust', 'legacy-migration-keys.json'), 'utf8');
    expect(keysFile.includes('PUBLIC KEY' + '-'.repeat(5))).toBe(true);
  });
  it('the private ceremony workspace artifacts are NOT tracked', () => {
    const tracked = execSync('git ls-files', { encoding: 'utf8' });
    for (const forbidden of ['attestation.canonical.bin', 'attestation.sig.bin', 'attestation.sig.b64url', 'ceremony_ed25519.py', 'ceremony_openssl_ed25519.ps1', '.private.pem']) {
      expect(tracked.includes(forbidden), `${forbidden} must not be tracked`).toBe(false);
    }
  });
  it('loader + strict-json do not import the signer; migrate.ts preserves its safety-stage ordering', () => {
    for (const f of ['legacy-active-bundle.ts', 'strict-json.ts']) {
      expect(readFileSync(join('scripts', 'backup', f), 'utf8').includes('legacy-attestation-sign')).toBe(false);
    }
    // SEMANTIC invariant (was: a `git diff --name-only main..HEAD -- scripts/migrate.ts` byte-identity check).
    // That byte-identity assertion is now permanently false — P1c LEGITIMATELY changed migrate.ts (added the
    // `ensureAppSchema` bootstrap prerequisite + `--verify` wiring, commit bf4f897) — and it never proved SAFETY.
    // Instead, read the real deployment-path source and verify the required safety-stage ORDER and properties:
    // backup boundary → ensureAppSchema → migrate → RLS → verify, advisory lock/cleanup present, failures fatal,
    // and the backup seam not bypassed. This PERMITS P1c's authorized change and REJECTS unsafe reorderings.
    const migrate = readFileSync(join('scripts', 'migrate.ts'), 'utf8');
    expect(() => assertMigrateStageOrder(migrate)).not.toThrow();
    expect(migrate.includes('legacy-active-bundle')).toBe(false);
    expect(migrate.includes('preMigrationBackup')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The safety-stage invariant of the deployment path, exercised positively (the real, authorized P1c migrate.ts
// passes) AND negatively (synthetic unsafe migrate sources are each rejected). This is the substance behind the
// replaced byte-identity assertion: it is what B1/B2a actually care about — the DEPLOYMENT PATH keeps its
// safety-stage ordering and does not bypass the backup integration seam.
describe('Phase 10 hardened — migrate.ts safety-stage ordering invariant (semantic)', () => {
  const NL = '\n';
  // A well-formed synthetic migrate command with every stage in the required order. The checker must accept it;
  // each mutation below moves exactly one stage out of order (or drops a required property) and must be rejected.
  const GOOD = [
    'async function main() {',
    '  preMigrationBackup();',
    '  await sql`select pg_advisory_lock(1)`;',
    '  await ensureAppSchema(sql);',
    '  await migrate(db, { migrationsFolder: "drizzle" });',
    '  const rls = readFileSync("src/db/rls.sql");',
    '  await sql.unsafe(rls);',
    '  if (process.argv.includes("--verify")) await verifyBootstrap(sql);',
    '  await sql`select pg_advisory_unlock(1)`;',
    '  await sql.end();',
    '}',
    'main().catch((err) => { console.error(err); process.exit(1); });',
  ].join(NL);

  it('ACCEPTS the real, authorized P1c scripts/migrate.ts (positive)', () => {
    const real = readFileSync(join('scripts', 'migrate.ts'), 'utf8');
    const idx = assertMigrateStageOrder(real);
    // The located stages are in the required order (proves it read real call sites, not comments).
    expect(idx.backupCall).toBeLessThan(idx.ensureAppSchema);
    expect(idx.ensureAppSchema).toBeLessThan(idx.migrate);
    expect(idx.migrate).toBeLessThan(idx.rlsApply);
    expect(idx.rlsApply).toBeLessThan(idx.verify);
    expect(idx.advisoryLock).toBeLessThan(idx.ensureAppSchema);
    expect(idx.advisoryUnlock).toBeLessThan(idx.sqlEnd);
  });

  it('ACCEPTS a well-formed synthetic migrate source (positive control)', () => {
    expect(() => assertMigrateStageOrder(GOOD)).not.toThrow();
  });

  // Each negative feeds a SYNTHETIC bad-ordered migrate source; the checker must REJECT it.
  const negatives: { label: string; code: string; src: string }[] = [
    {
      label: 'backup AFTER schema creation',
      code: 'backup_after_schema',
      src: GOOD.replace('  preMigrationBackup();' + NL, '').replace('await ensureAppSchema(sql);', 'await ensureAppSchema(sql); preMigrationBackup();'),
    },
    {
      label: 'backup AFTER migrate',
      code: 'backup_after_schema', // (backup after migrate is necessarily after schema too; the ordering check fires here)
      src: GOOD.replace('  preMigrationBackup();' + NL, '').replace('await migrate(db, { migrationsFolder: "drizzle" });', 'await migrate(db, { migrationsFolder: "drizzle" }); preMigrationBackup();'),
    },
    {
      label: 'RLS BEFORE migrate',
      code: 'rls_before_migrate',
      src: GOOD.replace('  await sql.unsafe(rls);' + NL, '').replace('await migrate(db, { migrationsFolder: "drizzle" });', 'await sql.unsafe(rls); await migrate(db, { migrationsFolder: "drizzle" });'),
    },
    {
      label: 'verify BEFORE RLS',
      code: 'verify_before_rls',
      src: GOOD.replace('  if (process.argv.includes("--verify")) await verifyBootstrap(sql);' + NL, '').replace('const rls = readFileSync("src/db/rls.sql");', 'await verifyBootstrap(sql); const rls = readFileSync("src/db/rls.sql");'),
    },
    {
      label: 'swallowed (non-fatal) migration/RLS error',
      code: 'failure_not_fatal',
      src: GOOD.replace('main().catch((err) => { console.error(err); process.exit(1); });', 'main().catch((err) => { console.error(err); });'),
    },
    {
      label: 'removed advisory lock + cleanup',
      code: 'advisory_lock_missing',
      src: GOOD.replace('  await sql`select pg_advisory_lock(1)`;' + NL, '').replace('  await sql`select pg_advisory_unlock(1)`;' + NL, ''),
    },
    {
      label: 'backup seam removed / short-circuited',
      code: 'backup_call_missing',
      src: GOOD.replace('  preMigrationBackup();' + NL, ''),
    },
  ];
  for (const { label, code, src } of negatives) {
    it(`REJECTS: ${label}`, () => {
      let thrown: unknown;
      try { assertMigrateStageOrder(src); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(MigrateStageOrderError);
      expect((thrown as MigrateStageOrderError).code).toBe(code);
    });
  }

  it('does NOT bless every migrate.ts change: mutating the REAL source into an unsafe order is rejected', () => {
    // Take the real source and move the RLS apply before migrate — an unsafe change the OLD byte-identity check
    // could only catch as "changed", and the semantic checker rejects for the RIGHT reason.
    const real = readFileSync(join('scripts', 'migrate.ts'), 'utf8');
    const unsafe = real
      .replace('await sql.unsafe(rls);', '')
      .replace('await migrate(db, { migrationsFolder: join(process.cwd(), \'drizzle\') });', 'await sql.unsafe(rls); await migrate(db, { migrationsFolder: join(process.cwd(), \'drizzle\') });');
    expect(() => assertMigrateStageOrder(unsafe)).toThrow(MigrateStageOrderError);
  });
});

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — strict JSON: semantic duplicate keys + surrogates + numbers', () => {
  it('literal and \\u-escaped equivalent key is a duplicate', () => expect(() => parseStrictJsonText('{"key":1,"\\u006bey":2}')).toThrow(StrictJsonError));
  it('two different escape forms decoding to the same key rejected', () => expect(() => parseStrictJsonText('{"\\u0041":1,"A":2}')).toThrow(StrictJsonError));
  it('NFC-equivalent top-level keys rejected (é vs e+combining)', () => expect(() => parseStrictJsonText('{"\\u00e9":1,"e\\u0301":2}')).toThrow(StrictJsonError));
  it('nested NFC-equivalent duplicate keys rejected', () => expect(() => parseStrictJsonText('{"o":{"\\u00e9":1,"e\\u0301":2}}')).toThrow(StrictJsonError));
  it('valid surrogate pair decodes (accepted)', () => expect(parseStrictJsonText('{"k":"\\uD83D\\uDE00"}')).toEqual({ k: '\u{1F600}' }));
  it('unpaired high surrogate rejected', () => expect(() => parseStrictJsonText('{"k":"\\uD83D"}')).toThrow(StrictJsonError));
  it('unpaired low surrogate rejected', () => expect(() => parseStrictJsonText('{"k":"\\uDE00x"}')).toThrow(StrictJsonError));

  it('max/min safe integer accepted; journalTimestamp accepted', () => {
    expect(parseStrictJsonText(`{"n":${Number.MAX_SAFE_INTEGER}}`)).toEqual({ n: Number.MAX_SAFE_INTEGER });
    expect(parseStrictJsonText(`{"n":${Number.MIN_SAFE_INTEGER}}`)).toEqual({ n: Number.MIN_SAFE_INTEGER });
    expect(parseStrictJsonText('{"t":1784873208836}')).toEqual({ t: 1784873208836 });
  });
  it('unsafe positive / negative integers rejected', () => {
    expect(() => parseStrictJsonText('{"n":9007199254740993}')).toThrow(StrictJsonError);
    expect(() => parseStrictJsonText('{"n":-9007199254740993}')).toThrow(StrictJsonError);
  });
  it('overflow to non-finite rejected', () => expect(() => parseStrictJsonText('{"n":1e400}')).toThrow(StrictJsonError));
  it('nonzero underflow to zero rejected', () => expect(() => parseStrictJsonText('{"n":1e-400}')).toThrow(StrictJsonError));
  it('invalid leading zero rejected', () => expect(() => parseStrictJsonText('{"n":01}')).toThrow(StrictJsonError));
});

// ---------------------------------------------------------------------------
let junctionCapable = false;
try {
  const d = mkdtempSync(join(tmpdir(), 'gb-jct-'));
  mkdirSync(join(d, 'target'));
  symlinkSync(join(d, 'target'), join(d, 'jct'), 'junction');
  junctionCapable = true;
  cleanup.push(d);
} catch { junctionCapable = false; }

describe('Phase 10 hardened — real link/junction escape rejection', () => {
  it.runIf(junctionCapable)('parent junction escaping the active root rejected', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gb-out-')); cleanup.push(outside);
    mkdirSync(join(outside, 'legacy-evidence'), { recursive: true });
    writeFileSync(join(outside, 'legacy-evidence', '0004_knowledge_k1.evidence.json'), realBuf(REAL.ev));
    const root = fixture();
    const evDir = join(root, 'scripts', 'backup', 'legacy-evidence');
    rmSync(evDir, { recursive: true });
    symlinkSync(join(outside, 'legacy-evidence'), evDir, 'junction');
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it.runIf(junctionCapable)('junction to a repo path OUTSIDE the active root rejected', () => {
    const root = fixture();
    const evDir = join(root, 'scripts', 'backup', 'legacy-evidence');
    rmSync(evDir, { recursive: true });
    symlinkSync(join(root, 'scripts', 'backup', 'legacy-trust'), evDir, 'junction'); // points at a different active root
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it.runIf(junctionCapable)('broken junction rejected', () => {
    const target = mkdtempSync(join(tmpdir(), 'gb-brk-'));
    mkdirSync(join(target, 'legacy-evidence'), { recursive: true });
    const root = fixture();
    const evDir = join(root, 'scripts', 'backup', 'legacy-evidence');
    rmSync(evDir, { recursive: true });
    symlinkSync(join(target, 'legacy-evidence'), evDir, 'junction');
    rmSync(target, { recursive: true, force: true }); // break it
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it.runIf(symlinkCapable)('final-file symlink rejected', () => {
    const root = fixture();
    const attAbs = join(root, 'scripts', 'backup', REAL.att);
    rmSync(attAbs); symlinkSync(join(process.cwd(), 'scripts', 'backup', REAL.att), attAbs);
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it.runIf(symlinkCapable)('parent-directory symlink rejected', () => {
    const root = fixture();
    const evDir = join(root, 'scripts', 'backup', 'legacy-evidence');
    rmSync(evDir, { recursive: true });
    symlinkSync(join(process.cwd(), 'scripts', 'backup', 'legacy-evidence'), evDir);
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it.runIf(symlinkCapable)('symlink resolving to a repo path OUTSIDE the active dir rejected', () => {
    const root = fixture();
    const attAbs = join(root, 'scripts', 'backup', REAL.att);
    rmSync(attAbs);
    // points inside the repo but outside legacy-attestations/
    symlinkSync(join(root, 'scripts', 'backup', 'legacy-trust', 'legacy-migration-keys.json'), attAbs);
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it.runIf(symlinkCapable)('broken symlink rejected', () => {
    const root = fixture();
    const attAbs = join(root, 'scripts', 'backup', REAL.att);
    rmSync(attAbs);
    symlinkSync(join(root, 'scripts', 'backup', 'legacy-attestations', 'nonexistent-target.json'), attAbs);
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it.runIf(symlinkCapable)('symlink loop rejected', () => {
    const root = fixture();
    const evDir = join(root, 'scripts', 'backup', 'legacy-evidence');
    rmSync(evDir, { recursive: true });
    const a = evDir;
    const b = join(root, 'scripts', 'backup', 'legacy-evidence-loop-b');
    symlinkSync(b, a); // a -> b
    symlinkSync(a, b); // b -> a  (loop); the loader rejects at the symlink component before any resolution
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
});

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — active-directory allowlist (only indexed + README.md)', () => {
  it('exact README.md accepted', () => {
    expect(() => loadActiveLegacyBundle(fixture((c) => c.addFile('legacy-trust/README.md', '# notes')))).not.toThrow();
  });
  const reject: [string, string][] = [
    ['.json.bak', 'legacy-attestations/0004_knowledge_k1.json.bak'],
    ['.json.old', 'legacy-evidence/0004_knowledge_k1.evidence.json.old'],
    ['hidden file', 'legacy-trust/.secret'],
    ['editor swap file', 'legacy-attestations/.0004.json.swp'],
    ['shadow PEM', 'legacy-trust/shadow.pem'],
    ['unindexed YAML', 'legacy-evidence/policy.yaml'],
    ['arbitrary text', 'legacy-evidence/notes.txt'],
  ];
  for (const [label, rel] of reject) {
    it(`rejects an unindexed ${label}`, () => {
      expect(() => loadActiveLegacyBundle(fixture((c) => c.addFile(rel, 'x')))).toThrow(ActiveBundleError);
    });
  }
});

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — unreferenced trust-key rejection', () => {
  const realKeys = JSON.parse(realBuf(REAL.keys).toString('utf8')) as { keys: Record<string, unknown>[] };
  const realPem = realKeys.keys[0]!.publicKeyPem as string;
  const genPem = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keysWith = (extra: Record<string, unknown>) => JSON.stringify({ ...realKeys, keys: [...realKeys.keys, extra] }, null, 2);

  it('exact current single key accepted', () => expect(() => loadActiveLegacyBundle(fixture())).not.toThrow());
  it('additional ACTIVE key rejected', () => {
    const root = fixture((c) => c.writeRaw(REAL.keys, keysWith({ keyId: 'extra-key', algorithm: 'ed25519', publicKeyPem: genPem(), purpose: 'legacy_migration_attestation', status: 'active' })));
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('additional REVOKED key rejected', () => {
    const root = fixture((c) => c.writeRaw(REAL.keys, keysWith({ keyId: 'extra-key', algorithm: 'ed25519', publicKeyPem: genPem(), purpose: 'legacy_migration_attestation', status: 'revoked' })));
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('same public key under another key ID rejected', () => {
    const root = fixture((c) => c.writeRaw(REAL.keys, keysWith({ keyId: 'clone-id', algorithm: 'ed25519', publicKeyPem: realPem, purpose: 'legacy_migration_attestation', status: 'active' })));
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
  it('wrong-purpose key rejected', () => {
    const root = fixture((c) => c.writeRaw(REAL.keys, keysWith({ keyId: 'extra-key', algorithm: 'ed25519', publicKeyPem: genPem(), purpose: 'receipt_signing', status: 'active' })));
    expect(() => loadActiveLegacyBundle(root)).toThrow(ActiveBundleError);
  });
});

// ---------------------------------------------------------------------------
describe('Phase 10 hardened — active-index version + self-integrity digest', () => {
  const realIndex = JSON.parse(realBuf(REAL.index).toString('utf8')) as { bundleVersion: string; keyBundleFile: string; entries: Record<string, unknown>[]; note?: string };
  it('supported index version accepted', () => expect(() => loadActiveLegacyBundle(fixture())).not.toThrow());
  it('missing version rejected', () => {
    const root = fixture((c) => { delete (c.index as Record<string, unknown>).bundleVersion; });
    expect(() => loadActiveLegacyBundle(root)).toThrow();
  });
  it('unsupported version rejected', () => {
    const root = fixture((c) => { c.index.bundleVersion = '2'; });
    expect(() => loadActiveLegacyBundle(root)).toThrow();
  });
  it('index diagnostics are stable across loads', () => {
    const a = loadActiveLegacyBundle(process.cwd());
    const b = loadActiveLegacyBundle(process.cwd());
    const da = a.diagnostics.files.find((f) => f.path.endsWith('active-index.json'))!;
    const db = b.diagnostics.files.find((f) => f.path.endsWith('active-index.json'))!;
    expect(da.semanticDigest).toBe(db.semanticDigest);
    expect(da.rawSha256).toBe(db.rawSha256);
  });
  it('semantic digest changes iff BINDING metadata changes (note is excluded)', () => {
    const base = computeActiveIndexSemanticDigest(realIndex);
    const withNote = computeActiveIndexSemanticDigest({ ...realIndex, note: 'a totally different note' });
    const changedBinding = computeActiveIndexSemanticDigest({ ...realIndex, entries: realIndex.entries.map((e) => ({ ...e, migrationIndex: 99 })) });
    expect(withNote).toBe(base);
    expect(changedBinding).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Refuse this G-Backup DB test against the shared `king_ai_hub` when REQUIRE_DISPOSABLE_DB=1 — before the
// pool below is constructed. No-op without the flag.
assertDisposableDbForVerification('gbackup-active-onboarding.test');

const URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
const sql = postgres(URL, { max: 2, prepare: false });
const MANIFEST = buildDbComparisonManifest('drizzle');
let dbReady = false;
try {
  await sql`select 1 as ok`;
  const e0004 = MANIFEST.entries.find((e) => e.tag === TAG)!;
  const row = await sql<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations where created_at = ${e0004.when}`;
  dbReady = (row[0]?.hash ?? '') === EXPECT.appliedHash0004;
} catch { dbReady = false; }
afterAll(async () => { await sql.end(); });

function detect(over: Partial<{ attestations: unknown[]; store: ReturnType<typeof loadTrustBundle>; environment: 'development' | 'staging' | 'production'; evidenceManifests: Record<string, unknown> }> = {}) {
  const store = over.store && over.store.ok ? over.store.store : bundle.store;
  return detectMigrationState(sql, {
    sourceManifest: MANIFEST, migrationsFolder: 'drizzle',
    legacyAttestationBundle: { attestations: over.attestations ?? bundle.rawAttestations, store, evidenceManifests: (over.evidenceManifests as never) ?? bundle.evidenceManifests, scope: { ...SCOPE, environment: over.environment ?? 'staging' }, verificationTime: VTIME },
  });
}

describe('Phase 10 hardened — local-DB detector with the ACTIVE bundle', () => {
  it('0004 → LEGACY_ATTESTED_MATCH; NO_PENDING with the active bundle (fail-closed without it)', async () => {
    if (!dbReady) return;
    const bare = await detectMigrationState(sql, { sourceManifest: MANIFEST, migrationsFolder: 'drizzle' });
    expect(bare.state).toBe('HISTORICAL_HASH_MISMATCH');
    const r = await detect({ environment: 'staging' });
    expect(r.state).toBe('NO_PENDING');
    expect(r.legacyAttestedMatches).toBe(1);
    expect(r.legacyAttestedDetails[0]!.tag).toBe(TAG);
    expect(r.unknownHistoricalMismatches).toBe(0);
    expect(r.unknownDatabaseDivergences).toBe(0);
    // Migration-count independent: every applied migration is accounted for as exact / EOL-variant / legacy-attested,
    // so the total equals the committed source manifest's length (no absolute-count edit when a migration is added).
    expect(r.exactExecutionMatches + r.lineEndingVariantMatches + r.legacyAttestedMatches).toBe(MANIFEST.entries.length);
  });
  it('production rejected; missing key / revoked key / tampered signature all fail closed', async () => {
    if (!dbReady) return;
    expect((await detect({ environment: 'production' })).invalidLegacyAttestations.some((i) => i.reasonCode === 'scope_mismatch')).toBe(true);
    expect((await detect({ store: loadTrustBundle([]) })).invalidLegacyAttestations.some((i) => i.reasonCode === 'unknown_key')).toBe(true);
    const keys = JSON.parse(readFileSync(join('scripts', 'backup', 'legacy-trust', 'legacy-migration-keys.json'), 'utf8')).keys as Record<string, unknown>[];
    expect((await detect({ store: loadTrustBundle([{ ...keys[0]!, status: 'revoked' }]) })).invalidLegacyAttestations.some((i) => i.reasonCode === 'revoked_key')).toBe(true);
    const raw = JSON.parse(readFileSync(join('scripts', 'backup', 'legacy-attestations', `${TAG}.json`), 'utf8'));
    const tampered = { ...raw, signature: raw.signature.slice(0, -1) + (raw.signature.slice(-1) === 'A' ? 'B' : 'A') };
    expect((await detect({ attestations: [tampered] })).invalidLegacyAttestations.some((i) => i.reasonCode === 'invalid_signature')).toBe(true);
  });
  it('staging-shape (pure): 0053 recognized EOL variant and 0004 attested — distinct categories', () => {
    const applied = MANIFEST.entries.map((e) => ({
      hash: e.idx === 53 && e.recognizedVariantSha256 ? e.recognizedVariantSha256 : e.idx === 4 ? EXPECT.appliedHash0004 : e.committedBlobSha256,
      createdAt: e.when, id: e.idx + 1,
    }));
    const e4 = MANIFEST.entries.find((e) => e.idx === 4)!;
    const r = classifyMigrationState({
      source: MANIFEST.entries, sourceMigrationSetHash: MANIFEST.sourceMigrationSetHash, applied,
      runtime: MANIFEST.entries.map((e) => ({ when: e.when, tag: e.tag, rawHash: e.committedBlobSha256 })),
      legacyAttestedKeys: new Set([String(e4.when)]), migrationsTableMissing: false, declaredBootstrap: false, hasUnexplainedUserObjects: false, databaseIdentityMatches: true,
    });
    expect(r.state).toBe('NO_PENDING');
    expect(r.lineEndingVariantMatches).toBe(1);
    expect(r.variantDetails[0]!.tag).toBe('0053_pricing_foundations');
    expect(r.legacyAttestedMatches).toBe(1);
    // Migration-count independent: 0053 is the sole EOL variant and 0004 the sole attested; every OTHER entry
    // (including any uncommitted tail such as 0055) is an exact committed-blob match. Derive from the manifest
    // length so adding a migration never needs an absolute-count edit here.
    expect(r.exactExecutionMatches).toBe(MANIFEST.entries.length - 2);
    expect(r.variantDetails.every((v) => v.tag !== TAG)).toBe(true);
  });
});
