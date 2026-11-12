/**
 * Execute ONE approved command and record what actually happened (design §2.2).
 *
 * The collector — this process — owns every authoritative fact: it reads the clock before and
 * after, it receives the exit code from the OS, and it digests the output it captured over pipes.
 * The child is given no way to influence any of that. In particular the child's stdio is piped
 * rather than inherited, so the command cannot write onto the collector's own stdout and forge
 * harness-looking output.
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { IsolationReport } from './isolation';
import { statusFor, type HarnessRecord } from './records';

export interface RunCheckOptions {
  readonly name: string;
  readonly command: string;
  readonly checkoutDir: string;
  readonly runId: string;
  readonly isolation: IsolationReport;
  /** Hard wall-clock cap. A check that exceeds it is `errored`, never `failed` (see records.ts). */
  readonly timeoutMs: number;
  /** POSIX uid for the child. Required for real isolation; absent on an unisolated dry run. */
  readonly executionUid?: number;
  /** Environment for the child. Defaults to a MINIMAL env, never the collector's own. */
  readonly env?: Readonly<Record<string, string>>;
  /** Cap on captured output held in memory, so a runaway check cannot exhaust the collector. */
  readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * A deliberately minimal child environment.
 *
 * The collector's environment holds the bearer credential and the signing secret (§2.3: "secrets
 * are never mounted into the execution sandbox"). Passing `process.env` through would hand both to
 * every untrusted command, so the default is to pass almost nothing and let the caller add back
 * what a check genuinely needs.
 */
export function minimalEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
    CI: '1',
  };
  return { ...base, ...extra };
}

/**
 * Kill the command and everything it spawned.
 *
 * With `shell: true` the direct child is a shell, so killing just that pid routinely leaves the real
 * command (and its children) alive — the deadline would be advisory rather than a bound. On POSIX
 * the child leads its own group, so a negative pid signals the whole group. On win32 there are no
 * process groups to signal, so `taskkill /T` walks the tree instead.
 */
function killTree(pid: number | undefined, posix: boolean): void {
  if (pid === undefined) return;
  try {
    if (posix) {
      process.kill(-pid, 'SIGKILL');
      return;
    }
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone, or the group vanished between the deadline firing and the signal. Either way the
    // record is about to be written with timedOut: true; a failed kill must not mask that.
  }
}

export async function runCheck(opts: RunCheckOptions): Promise<HarnessRecord> {
  const maxOut = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const hash = createHash('sha256');
  let outputBytes = 0;
  let captured = false;

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const posix = process.platform !== 'win32';

  // Built as an explicitly typed object rather than with conditional spreads: spreading into the
  // call site defeats spawn's overload resolution (TS cannot tell the options object from an args
  // array) and silently degrades `child` to `never`.
  const spawnOptions: SpawnOptions = {
    shell: true,
    cwd: opts.checkoutDir,
    // Next augments NodeJS.ProcessEnv to REQUIRE NODE_ENV. That augmentation describes the Next
    // app's own environment, not the environment handed to an unrelated child, and a deliberately
    // minimal child env may legitimately omit it (see minimalEnv). Narrowed here, at the one place
    // the two type worlds meet, rather than by polluting minimalEnv with a value the operator did
    // not choose.
    env: (opts.env ? { ...opts.env } : minimalEnv()) as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  // Lead a new process GROUP so the deadline can reap the whole tree. With shell: true the direct
  // child is a shell, and killing only the shell leaves the real command running — the deadline
  // would then be advisory, which is not what a hard timeout means.
  if (posix) spawnOptions.detached = true;
  // uid is POSIX-only; passing it on win32 throws, and isolation.ts has already refused to call
  // win32 enforced, so it is simply omitted there.
  if (posix && opts.executionUid !== undefined) spawnOptions.uid = opts.executionUid;

  const child = spawn(opts.command, spawnOptions);

  const absorb = (chunk: Buffer): void => {
    captured = true;
    if (outputBytes >= maxOut) return;
    const room = maxOut - outputBytes;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    hash.update(slice);
    outputBytes += slice.length;
  };
  child.stdout?.on('data', absorb);
  child.stderr?.on('data', absorb);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // SIGKILL, not SIGTERM: a hostile or wedged check must not be able to ignore the deadline or
    // run a handler after it. The record says timedOut, so the kill is never silent.
    killTree(child.pid, posix);
  }, opts.timeoutMs);

  // Wait on 'exit' (the process ended), NOT 'close' (its stdio closed). They differ precisely in
  // the case this deadline exists for: a killed shell's grandchild can inherit the pipes and hold
  // them open indefinitely, so 'close' may never fire and the "timeout" would hang forever.
  // Trailing output written after exit is lost; outputBytes records what was actually captured.
  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once('error', () => resolveExit(null)); // spawn failure ⇒ no code ⇒ errored
    child.once('exit', (code: number | null) => resolveExit(code));
  }).finally(() => clearTimeout(timer));

  const finishedAtMs = Date.now();

  return {
    schema: 'king-verification-harness/v1',
    name: opts.name,
    command: opts.command,
    status: statusFor(exitCode, timedOut),
    exitCode,
    timedOut,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    outputDigest: captured ? hash.digest('hex') : null,
    outputBytes,
    isolation: opts.isolation,
    runId: opts.runId,
  };
}
