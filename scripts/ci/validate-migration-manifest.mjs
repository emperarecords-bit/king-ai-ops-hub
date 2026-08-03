/* eslint-disable no-console -- CI orchestration script: progress + diagnostics go to stdout/stderr by design. */
// CI-only, branch-agnostic migration-manifest validation (works on main, which lacks the P1 test-support
// manifest helper). Reads the committed journal and asserts: sequential idx (0..N-1); monotonic non-decreasing
// `when` timestamps; every entry has both its `<tag>.sql` and its idx-named `meta/NNNN_snapshot.json`; and NO
// `.sql` file exists that is not in the journal (catches an unexpected/orphan generated migration). Fails on
// any reorder, gap, missing artifact, or unexpected file.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const idx4 = (n) => String(n).padStart(4, '0');

const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
const entries = journal.entries ?? [];
let ok = true;
const err = (m) => {
  console.error(`[manifest] ${m}`);
  ok = false;
};

const tags = new Set();
let lastWhen = -Infinity;
entries.forEach((e, i) => {
  if (e.idx !== i) err(`journal idx out of sequence at position ${i}: idx=${e.idx}`);
  if (typeof e.when === 'number' && e.when < lastWhen) err(`journal 'when' not monotonic at idx ${e.idx}`);
  lastWhen = e.when;
  tags.add(e.tag);
  if (!existsSync(`drizzle/${e.tag}.sql`)) err(`missing migration file drizzle/${e.tag}.sql (journal idx ${e.idx})`);
  // Drizzle names snapshots by 4-digit index (e.g. drizzle/meta/0056_snapshot.json), NOT by full tag.
  if (!existsSync(`drizzle/meta/${idx4(e.idx)}_snapshot.json`)) err(`missing snapshot drizzle/meta/${idx4(e.idx)}_snapshot.json (journal idx ${e.idx})`);
});

for (const f of readdirSync('drizzle').filter((f) => f.endsWith('.sql'))) {
  const tag = f.replace(/\.sql$/, '');
  if (!tags.has(tag)) err(`unexpected migration file not present in the journal: drizzle/${f}`);
}

console.log(`[manifest] ${entries.length} journal entries (0000..${entries[entries.length - 1]?.tag}); idx/when/order + files + snapshots checked.`);
if (!ok) process.exit(1);
console.log('[manifest] OK — no unexpected, reordered, gapped, or missing migration.');
