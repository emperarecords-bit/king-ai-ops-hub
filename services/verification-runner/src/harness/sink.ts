/**
 * The authoritative result sink (design §2.2).
 *
 * Everything the signer trusts is read from here, and nothing the checked-out code can write ever
 * lands here. The two assertions below are the load-bearing ones:
 *
 *  1. The sink MUST NOT be inside the checkout. A sink under the working tree is writable by the
 *     code under test by construction, so a forged `results.json` would become "authoritative".
 *  2. The sink is created 0700 and owned by the collector. Note the honest caveat from §2.3: mode
 *     bits only protect against a DIFFERENT uid, so this is necessary but not sufficient on its
 *     own — `isolation.ts` is what establishes the uid barrier that gives 0700 meaning.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { HarnessRecord } from './records';

export class SinkError extends Error {}

/**
 * True when `child` is inside `parent`. Uses path `relative()` rather than a `startsWith` string
 * test, because `startsWith` reports `/srv/checkout-sink` as inside `/srv/checkout` — a false
 * positive that would reject a perfectly good sink, and whose mirror image (a crafted path that
 * slips past a naive check) is exactly what we must not get wrong.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Create (or adopt) the sink and assert it is a legitimate authoritative location.
 *
 * Refuses rather than repairs: if the sink exists with the wrong mode or owner, something other
 * than this harness made it, and silently chmod-ing someone else's directory is how you turn a
 * misconfiguration into a security hole you cannot see.
 */
export function prepareSink(sinkDir: string, checkoutDir: string): string {
  const sink = resolve(sinkDir);
  const checkout = resolve(checkoutDir);

  if (isInside(checkout, sink)) {
    throw new SinkError(
      `result sink ${sink} is inside the checkout ${checkout}: the code under test could forge its own results (design §2.2)`,
    );
  }

  mkdirSync(sink, { recursive: true, mode: 0o700 });

  const st = statSync(sink);
  if (!st.isDirectory()) throw new SinkError(`result sink ${sink} is not a directory`);

  // Mode/ownership are POSIX concepts; on win32 they are meaningless and `isolation.ts` has
  // already refused to call this path enforced, so do not pretend to check them.
  if (process.platform !== 'win32') {
    const mode = st.mode & 0o777;
    if (mode !== 0o700) throw new SinkError(`result sink ${sink} has mode ${mode.toString(8)}, expected 700`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) {
      throw new SinkError(`result sink ${sink} is owned by uid ${st.uid}, not the collector uid ${uid}`);
    }
  }
  return sink;
}

/** One file per check, named by the check so a rerun of one check cannot clobber another's record. */
function recordPath(sink: string, checkName: string): string {
  // The catalog's own VERSION_RE-style discipline does not apply to check names, so sanitize here:
  // a check name is used as a FILENAME, and `../x` would write outside the sink.
  if (!/^[A-Za-z0-9._:-]+$/.test(checkName)) throw new SinkError(`unsafe check name for a record file: ${JSON.stringify(checkName)}`);
  return join(sink, `${checkName}.json`);
}

export function writeRecord(sink: string, record: HarnessRecord): string {
  const p = recordPath(sink, record.name);
  writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return p;
}

/**
 * Read every record back from the sink. The attestation stage calls ONLY this — it never reads the
 * checkout — which is the mechanical expression of §2.2's guarantee.
 */
export function readRecords(sink: string): readonly HarnessRecord[] {
  const out: HarnessRecord[] = [];
  for (const entry of readdirSync(sink).sort()) {
    if (!entry.endsWith('.json')) continue;
    const raw = readFileSync(join(sink, entry), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SinkError(`record ${entry} is not valid JSON`);
    }
    out.push(parsed as HarnessRecord);
  }
  return out;
}
