/* eslint-disable no-console -- CI orchestration script: progress + diagnostics go to stdout/stderr by design. */
// CI-only, branch-agnostic accepted-legacy `0004` bootstrap (works on main, which lacks the P1 helper, and
// does NOT copy P1c/P1d production code). Reconstructs the accepted historical `0004` execution identity from
// the committed git blob — insert ONE 0x0D before the FINAL 0x0A -> 3806 bytes -> sha256 c2c7463a… — WITHOUT
// editing any committed migration file or journal row, then migrates a fresh disposable DB from a temp folder
// so Drizzle records the legacy `0004` hash naturally, applies RLS, and asserts the recorded identity.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const TAG_0004 = '0004_knowledge_k1';
const LEGACY_0004_SHA256 = 'c2c7463a277ae0c157775121b3c471fb99ce04f4f896334f070f2a8848830754';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('[legacy-0004] DATABASE_MIGRATION_URL is unset.');
  process.exit(1);
}

// The exact committed (git HEAD) bytes of a migration — LF, independent of the runner's autocrlf setting.
const gitBlob = (tag) =>
  execFileSync('git', ['show', `HEAD:drizzle/${tag}.sql`], { maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });

function reconstructLegacy0004(committed) {
  let lastLf = -1;
  for (let i = committed.length - 1; i >= 0; i--) {
    if (committed[i] === 0x0a) { lastLf = i; break; }
  }
  if (lastLf < 0) throw new Error('committed 0004 blob has no trailing LF to reconstruct from');
  return Buffer.concat([committed.subarray(0, lastLf), Buffer.from([0x0d]), committed.subarray(lastLf)]);
}

const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'ci-legacy-0004-'));
cpSync('drizzle/meta', join(dir, 'meta'), { recursive: true });

const committed0004 = gitBlob(TAG_0004);
const legacyBytes = reconstructLegacy0004(committed0004);
const legacyHash = createHash('sha256').update(legacyBytes).digest('hex');
if (legacyHash !== LEGACY_0004_SHA256) {
  console.error(`[legacy-0004] reconstructed 0004 hash ${legacyHash.slice(0, 16)}… != accepted legacy c2c7463a…`);
  process.exit(1);
}
for (const e of journal.entries) {
  writeFileSync(join(dir, `${e.tag}.sql`), e.tag === TAG_0004 ? legacyBytes : gitBlob(e.tag));
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(sql);
try {
  await sql.unsafe('create schema if not exists app'); // prerequisite (idempotent across all branch endpoints)
  await migrate(db, { migrationsFolder: dir });
  await sql.unsafe(readFileSync(join(process.cwd(), 'src', 'db', 'rls.sql'), 'utf8'));
  const rows = await sql`select hash from drizzle.__drizzle_migrations order by id limit 1 offset 4`;
  const recorded = rows[0]?.hash;
  console.log(`[legacy-0004] recorded 0004 identity = ${String(recorded).slice(0, 16)}… (expected c2c7463a…)`);
  if (recorded !== LEGACY_0004_SHA256) {
    console.error('[legacy-0004] recorded 0004 identity is NOT the accepted legacy hash.');
    process.exit(1);
  }
  console.log('[legacy-0004] OK — accepted-legacy 0004 identity bootstrapped; no committed file or journal row edited.');
} finally {
  await sql.end();
  rmSync(dir, { recursive: true, force: true });
}
