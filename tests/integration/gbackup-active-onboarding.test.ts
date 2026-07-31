import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSourceManifestFromGit } from '../../scripts/backup/source-manifest';
import { classifyMigrationState, detectMigrationState } from '../../scripts/backup/migration-detector';
import {
  ActiveBundleError,
  isNonAuthoritativeDraftPath,
  loadActiveLegacyBundle,
  validateActiveRelPath,
} from '../../scripts/backup/legacy-active-bundle';
import { StrictJsonError, parseStrictJsonBuffer, parseStrictJsonText } from '../../scripts/backup/strict-json';
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
    try { out = execSync(`git grep -lF ${JSON.stringify(marker)} -- . ':(exclude)tests/'`, { encoding: 'utf8' }); } catch { out = ''; }
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
  it('loader + strict-json do not import the signer; migrate.ts unchanged', () => {
    for (const f of ['legacy-active-bundle.ts', 'strict-json.ts']) {
      expect(readFileSync(join('scripts', 'backup', f), 'utf8').includes('legacy-attestation-sign')).toBe(false);
    }
    expect(execSync('git diff --name-only main..HEAD -- scripts/migrate.ts', { encoding: 'utf8' }).trim()).toBe('');
    const migrate = readFileSync(join('scripts', 'migrate.ts'), 'utf8');
    expect(migrate.includes('legacy-active-bundle')).toBe(false);
    expect(migrate.includes('preMigrationBackup')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
const URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
const sql = postgres(URL, { max: 2, prepare: false });
const MANIFEST = buildSourceManifestFromGit('HEAD', 'drizzle');
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
    expect(r.exactExecutionMatches + r.lineEndingVariantMatches + r.legacyAttestedMatches).toBe(54);
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
    expect(r.exactExecutionMatches).toBe(52);
    expect(r.variantDetails.every((v) => v.tag !== TAG)).toBe(true);
  });
});
