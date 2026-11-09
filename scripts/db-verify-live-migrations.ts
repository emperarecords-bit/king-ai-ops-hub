import './load-env';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * Read-only migration-state verifier for a LIVE database (staging or production).
 *
 * WHY THIS EXISTS
 *
 * Before enabling a write-capable connector we need to know, as fact rather than as inference, which
 * migrations the target database has actually applied. `npm run db:migrate` reports what it did on the
 * day it ran, and a deploy log is not the database.
 *
 * WHAT THE LEDGER ACTUALLY CONTAINS
 *
 * Drizzle's ledger is `drizzle.__drizzle_migrations` and it holds only (id, hash, created_at). It does
 * NOT store a migration number or a filename, so "the highest applied migration number" cannot be read
 * out of the database alone - it has to be recovered by joining the ledger to the committed journal at
 * `drizzle/meta/_journal.json`. `created_at` is the journal entry's `when` (folderMillis), and that is
 * the key Drizzle itself uses to decide what is already applied, so this script joins on `when` rather
 * than on row order. A row whose `created_at` matches no journal entry therefore means the database was
 * migrated by a revision this checkout does not contain - which positional comparison would miss.
 *
 * THE TRAP THIS SCRIPT IS WRITTEN AROUND
 *
 * Drizzle's hash is sha256 over the migration file's RAW BYTES as read from disk. On this Windows
 * checkout, 10 of the 84 migration files currently sit on disk with CRLF endings even though
 * .gitattributes pins the migration SQL to `eol=lf` and `git status` is clean - with `text eol=lf` Git
 * normalises on commit, so a CRLF working file compares equal to its LF blob and never shows as dirty.
 * The hashes genuinely differ (0052_classification_guard: 5d611a0a... raw vs 3b0e223e... LF-normalised),
 * so a verifier comparing raw hashes alone would report ~10 migrations as "edited after being applied"
 * against any database migrated from an LF checkout - that is, against CI, Fly, staging and production.
 * That false alarm is exactly the kind that stops a release for the wrong reason, so every mismatch is
 * re-checked against the LF-normalised bytes and reported as `eol-only` (informational) when that
 * matches. Only a hash matching NEITHER form is a content change.
 *
 * SAFETY
 *
 * Read-only by construction and by server-side enforcement: no DDL, no migrate(), no sql.unsafe, and the
 * connection is opened with `default_transaction_read_only=on`, so the server itself rejects a write even
 * if this file is later edited carelessly. It will not create the `drizzle` schema or the ledger table -
 * an absent ledger is reported, never provisioned. Safe to point at production.
 *
 * USAGE
 *
 *   npm run db:verify-live                 # resolves the connection from the environment (below)
 *   npm run db:verify-live -- --json       # machine-readable, for a pre-flight gate
 *
 * Connection resolution, first match wins, and the one used is always printed:
 *   1. DATABASE_VERIFY_URL   - preferred: point this at prod without disturbing DATABASE_URL
 *   2. DATABASE_URL
 *   3. DATABASE_MIGRATION_URL
 *   4. libpq-style PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
 * Shell-exported variables win over `.env`, since dotenv does not overwrite what is already set.
 *
 * EXIT CODES
 *   0  in sync (possibly with eol-only notes)
 *   1  drift: pending migrations, rows this checkout cannot explain, a content change, or no ledger
 *   2  could not run: no connection details, connection refused, insufficient privilege, bad journal
 */

const MIGRATIONS_FOLDER = 'drizzle';
const LEDGER = 'drizzle.__drizzle_migrations';
const APP_NAME = 'hub-db-verify-live';
const STATEMENT_TIMEOUT_MS = 15_000;

export type MatchKind = 'exact' | 'eol-only' | 'content-mismatch';

export interface AppliedRow {
  /** 1-based position in (created_at, id) order - a read-order label, not a migration number. */
  readonly ordinal: number;
  readonly id: number | null;
  readonly hash: string;
  readonly createdAtMs: number;
}

export interface JournalMigration {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
  /** sha256 of the exact file bytes - what Drizzle stores. */
  readonly rawHash: string;
  /** sha256 after CRLF -> LF: what an LF checkout of the same content would have stored. */
  readonly lfHash: string;
  readonly hasCrlf: boolean;
}

export interface PairedMigration {
  readonly applied: AppliedRow;
  readonly journal: JournalMigration;
  readonly match: MatchKind;
}

export interface LedgerComparison {
  readonly verdict: 'in-sync' | 'pending' | 'unexplained' | 'content-drift';
  readonly paired: readonly PairedMigration[];
  /** Applied rows whose created_at matches no journal entry: the DB ran code this checkout lacks. */
  readonly unexplained: readonly AppliedRow[];
  /** Journal entries with no applied row: not yet deployed here. */
  readonly pending: readonly JournalMigration[];
  readonly contentMismatches: readonly PairedMigration[];
  readonly eolOnly: readonly PairedMigration[];
  /** Highest applied by created_at, resolved to its journal entry where this checkout knows it. */
  readonly highest:
    | {
        readonly kind: 'known';
        readonly applied: AppliedRow;
        readonly journal: JournalMigration;
        readonly match: MatchKind;
      }
    | { readonly kind: 'unknown-to-checkout'; readonly applied: AppliedRow }
    | { readonly kind: 'none' };
  /** True when applied rows are not in ascending created_at order (a rebased or hand-edited ledger). */
  readonly outOfOrder: boolean;
}

class UsageError extends Error {}

/** Reads the committed journal and hashes each migration's bytes both ways. */
export function readJournal(baseDir: string, folderName = MIGRATIONS_FOLDER): JournalMigration[] {
  const journalPath = join(baseDir, folderName, 'meta', '_journal.json');
  let parsed: { entries?: unknown };
  try {
    parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: unknown };
  } catch (e) {
    throw new UsageError(`cannot read ${journalPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed.entries)) throw new UsageError(`${journalPath}: entries missing or not an array`);

  const out: JournalMigration[] = [];
  for (const raw of parsed.entries as readonly unknown[]) {
    const e = raw as { idx?: unknown; tag?: unknown; when?: unknown };
    if (typeof e.tag !== 'string' || typeof e.idx !== 'number' || typeof e.when !== 'number') {
      throw new UsageError(`${journalPath}: malformed entry ${JSON.stringify(raw)}`);
    }
    const file = join(baseDir, folderName, `${e.tag}.sql`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (err) {
      throw new UsageError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = bytes.toString('utf8');
    out.push({
      idx: e.idx,
      tag: e.tag,
      when: e.when,
      rawHash: createHash('sha256').update(bytes).digest('hex'),
      lfHash: createHash('sha256').update(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')).digest('hex'),
      hasCrlf: text.includes('\r\n'),
    });
  }
  return out;
}

function classify(appliedHash: string, j: JournalMigration): MatchKind {
  if (appliedHash === j.rawHash) return 'exact';
  // See the header: a CRLF working tree hashes differently from the LF checkout that did the migrating.
  if (appliedHash === j.lfHash) return 'eol-only';
  return 'content-mismatch';
}

/**
 * Joins the ledger to the journal on created_at == when - the same key Drizzle uses - and classifies every
 * difference. Pure: no I/O, so the verdict logic can be exercised on synthetic input.
 */
export function compareLedger(
  applied: readonly AppliedRow[],
  journal: readonly JournalMigration[],
): LedgerComparison {
  const byWhen = new Map<number, JournalMigration>();
  for (const j of journal) byWhen.set(j.when, j);

  const paired: PairedMigration[] = [];
  const unexplained: AppliedRow[] = [];
  const matchedWhens = new Set<number>();

  for (const row of applied) {
    const j = byWhen.get(row.createdAtMs);
    if (!j) {
      unexplained.push(row);
      continue;
    }
    matchedWhens.add(j.when);
    paired.push({ applied: row, journal: j, match: classify(row.hash, j) });
  }

  const pending = journal.filter((j) => !matchedWhens.has(j.when));
  const contentMismatches = paired.filter((p) => p.match === 'content-mismatch');
  const eolOnly = paired.filter((p) => p.match === 'eol-only');

  let outOfOrder = false;
  for (let i = 1; i < applied.length; i++) {
    if (applied[i]!.createdAtMs < applied[i - 1]!.createdAtMs) outOfOrder = true;
  }

  const last = applied.length > 0 ? applied[applied.length - 1]! : null;
  const highest: LedgerComparison['highest'] = (() => {
    if (!last) return { kind: 'none' };
    const j = byWhen.get(last.createdAtMs);
    if (!j) return { kind: 'unknown-to-checkout', applied: last };
    return { kind: 'known', applied: last, journal: j, match: classify(last.hash, j) };
  })();

  // Severity order: a changed migration outranks an unexplained row, which outranks merely-pending work.
  const verdict: LedgerComparison['verdict'] =
    contentMismatches.length > 0
      ? 'content-drift'
      : unexplained.length > 0 || outOfOrder
        ? 'unexplained'
        : pending.length > 0
          ? 'pending'
          : 'in-sync';

  return { verdict, paired, unexplained, pending, contentMismatches, eolOnly, highest, outOfOrder };
}

interface Resolved {
  readonly source: string;
  readonly url: string | undefined;
}

function resolveConnection(env: NodeJS.ProcessEnv): Resolved {
  for (const name of ['DATABASE_VERIFY_URL', 'DATABASE_URL', 'DATABASE_MIGRATION_URL'] as const) {
    const v = env[name];
    if (v !== undefined && v !== '') return { source: name, url: v };
  }
  if (env.PGHOST !== undefined && env.PGHOST !== '') return { source: 'PGHOST/PG* (libpq)', url: undefined };
  throw new UsageError(
    'no connection details. Set DATABASE_VERIFY_URL (preferred), DATABASE_URL or DATABASE_MIGRATION_URL, ' +
      'or the libpq variables PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.',
  );
}

/** Host and database for the banner. The password is never read and never printed. */
function describeTarget(url: string | undefined, env: NodeJS.ProcessEnv): string {
  if (url === undefined) {
    const host = env.PGHOST ?? '?';
    const port = env.PGPORT ?? '5432';
    const db = env.PGDATABASE ?? env.PGUSER ?? '?';
    return `${host}:${port}/${db}`;
  }
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

function report(cmp: LedgerComparison, appliedCount: number, journalCount: number): void {
  console.log(`\nApplied:  ${appliedCount} row(s) in ${LEDGER}`);

  if (cmp.highest.kind === 'none') {
    console.log('Highest:  - the ledger table exists but is empty');
  } else if (cmp.highest.kind === 'unknown-to-checkout') {
    const a = cmp.highest.applied;
    console.log(`Highest:  created_at=${a.createdAtMs} hash=${a.hash}`);
    console.log('          NOT in this checkout journal - the database is ahead of this revision');
  } else {
    const { applied, journal, match } = cmp.highest;
    console.log(`Highest:  ${String(journal.idx).padStart(4, '0')}  ${journal.tag}`);
    console.log(`          hash       ${applied.hash}`);
    console.log(`          created_at ${applied.createdAtMs}  (${new Date(applied.createdAtMs).toISOString()})`);
    const fileState =
      match === 'exact' ? 'matches' : match === 'eol-only' ? 'matches after CRLF->LF' : 'DOES NOT MATCH';
    console.log(`          file       ${fileState}`);
  }

  if (cmp.eolOnly.length > 0) {
    console.log(`\nNote: ${cmp.eolOnly.length} applied migration(s) match only after CRLF->LF normalisation.`);
    console.log('      Content is identical; this checkout has CRLF where the migrating checkout had LF.');
    console.log('      Not drift. (.gitattributes pins the migration SQL to eol=lf, and git status stays');
    console.log('      clean because Git normalises on commit - so the working tree can still disagree');
    console.log('      byte-for-byte with what was hashed at migrate time.)');
    for (const p of cmp.eolOnly) console.log(`      - ${p.journal.tag}`);
  }

  if (cmp.pending.length > 0) {
    console.log(`\nPENDING: ${cmp.pending.length} committed migration(s) not applied to this database:`);
    for (const j of cmp.pending) console.log(`      - ${j.tag}  (when=${j.when})`);
  }

  if (cmp.unexplained.length > 0) {
    console.log(`\nUNEXPLAINED: ${cmp.unexplained.length} applied row(s) absent from this checkout journal.`);
    console.log('      The database was migrated by a revision this checkout does not contain.');
    for (const a of cmp.unexplained) console.log(`      - created_at=${a.createdAtMs} hash=${a.hash}`);
  }

  if (cmp.outOfOrder) {
    console.log('\nUNEXPLAINED: applied rows are not in ascending created_at order (rebased or edited ledger).');
  }

  if (cmp.contentMismatches.length > 0) {
    console.log(`\nCONTENT DRIFT: ${cmp.contentMismatches.length} applied migration(s) whose file no longer hashes`);
    console.log('      to the recorded value in either raw or LF-normalised form. The file changed after it');
    console.log('      ran, or this is a different migration lineage. Do not deploy on this basis.');
    for (const p of cmp.contentMismatches) {
      console.log(`      - ${p.journal.tag}`);
      console.log(`          recorded ${p.applied.hash}`);
      console.log(`          raw      ${p.journal.rawHash}`);
      console.log(`          lf       ${p.journal.lfHash}`);
    }
  }

  const verdictLine: Record<LedgerComparison['verdict'], string> = {
    'in-sync': `IN SYNC: ${appliedCount}/${journalCount} applied, every hash accounted for.`,
    pending: `DRIFT: ${appliedCount}/${journalCount} applied - migrations are pending.`,
    unexplained: 'DRIFT: the database holds migration rows this checkout cannot explain.',
    'content-drift': "DRIFT: an applied migration's file no longer matches what was recorded.",
  };
  console.log(`\n${verdictLine[cmp.verdict]}`);
}

async function main(): Promise<void> {
  const wantJson = process.argv.includes('--json');
  const resolved = resolveConnection(process.env);
  const journal = readJournal(process.cwd());

  if (!wantJson) {
    console.log(`Target:   ${describeTarget(resolved.url, process.env)}  (from ${resolved.source})`);
    console.log(`Checkout: ${journal.length} migration(s) in ${MIGRATIONS_FOLDER}/meta/_journal.json`);
  }

  // Read-only is enforced by the SERVER via a startup parameter, not merely by this file's good intentions.
  const options = {
    max: 1,
    onnotice: () => {},
    connection: {
      application_name: APP_NAME,
      default_transaction_read_only: true,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    },
  };
  const sql = resolved.url !== undefined ? postgres(resolved.url, options) : postgres(options);

  try {
    const ctx = (
      await sql<{ db: string; usr: string; ro: string; ver: string }[]>`
        select current_database() as db,
               current_user       as usr,
               current_setting('default_transaction_read_only') as ro,
               version()          as ver`
    )[0]!;
    if (!wantJson) {
      console.log(`Connected: db=${ctx.db} user=${ctx.usr} read_only=${ctx.ro}`);
      console.log(`           ${ctx.ver.split(' ').slice(0, 2).join(' ')}`);
    }
    if (ctx.ro !== 'on') {
      // Fail rather than proceed with a session that could write: the server did not honour the parameter.
      throw new Error(`refusing to continue: default_transaction_read_only is ${ctx.ro}, expected on`);
    }

    const present = (await sql<{ t: string | null }[]>`select to_regclass(${LEDGER})::text as t`)[0]!.t != null;
    if (!present) {
      const msg = `no migration ledger: ${LEDGER} does not exist on this database (no Drizzle migration has ever run here)`;
      if (wantJson) console.log(JSON.stringify({ ok: false, verdict: 'ledger-absent', detail: msg }, null, 2));
      else console.error(`\nDRIFT: ${msg}`);
      process.exitCode = 1;
      return;
    }

    // created_at is bigint; cast to text so no value passes through a JS number on the wire.
    const rows = await sql<{ id: number | null; hash: string; created_at: string }[]>`
      select id, hash, created_at::text as created_at
        from drizzle.__drizzle_migrations
       order by created_at asc, id asc`;

    const applied: AppliedRow[] = rows.map((r, i) => ({
      ordinal: i + 1,
      id: r.id ?? null,
      hash: r.hash,
      createdAtMs: Number(r.created_at),
    }));

    const cmp = compareLedger(applied, journal);
    if (wantJson) {
      console.log(
        JSON.stringify(
          {
            ok: cmp.verdict === 'in-sync',
            target: describeTarget(resolved.url, process.env),
            source: resolved.source,
            appliedCount: applied.length,
            journalCount: journal.length,
            ...cmp,
          },
          null,
          2,
        ),
      );
    } else {
      report(cmp, applied.length, journal.length);
    }
    process.exitCode = cmp.verdict === 'in-sync' ? 0 : 1;
  } finally {
    await sql.end();
  }
}

/**
 * Only dial a database when this file is the entrypoint. Without this guard, importing `compareLedger` or
 * `readJournal` - from a test, or from a pre-flight gate that wants the verdict logic without the network -
 * would open a connection to whatever the environment happens to point at as a side effect of the import.
 * Basename rather than import.meta.url, because this package is not "type": "module".
 */
const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
if (entry.endsWith('/db-verify-live-migrations.ts') || entry.endsWith('/db-verify-live-migrations.js')) {
  main().catch((err: unknown) => {
    if (err instanceof UsageError) {
      console.error(`db-verify-live-migrations: ${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(2);
  });
}
