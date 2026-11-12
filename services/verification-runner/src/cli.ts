/**
 * CLI for the two stages. Deliberately thin: it parses flags, reads secrets from the environment
 * (never from argv, where they would land in the process table and CI logs), and calls the two
 * library entry points.
 *
 * Usage:
 *   king-verification-runner harness --contract <id> --checkout <dir> --sink <dir> [...]
 *   king-verification-runner attest  --contract <id> --checkout <dir> --sink <dir> [...]
 *
 * Secrets, from the environment only:
 *   HUB_RUNNER_KEY_ID, HUB_RUNNER_KEY_SECRET   bearer credential (§6.1)
 *   HUB_RUNNER_SIGNING_SECRET                  HMAC signing key  (§6.3)
 */
import { runHarness } from './harness';
import { runAttestation } from './attest';
import { HubError } from './attest/hub-client';

interface Flags {
  readonly [k: string]: string | boolean | undefined;
}

function parseFlags(argv: readonly string[]): Flags {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function str(f: Flags, name: string, fallback?: string): string {
  const v = f[name];
  if (typeof v === 'string' && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error('missing required flag --' + name);
}

function num(f: Flags, name: string, fallback: number): number {
  const v = f[name];
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('flag --' + name + ' is not a number: ' + v);
  return n;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error('missing required environment variable ' + name);
  return v;
}

async function main(): Promise<number> {
  const [stage, ...rest] = process.argv.slice(2);
  const f = parseFlags(rest);

  if (stage === 'harness') {
    const result = await runHarness({
      // The harness needs only the contract's identity fields, which the operator supplies so that
      // stage 1 can run with NO Hub credential at all — keeping the bearer token out of the stage
      // that touches untrusted code (§2.3).
      contract: {
        id: str(f, 'contract'),
        orgId: str(f, 'org', ''),
        projectId: str(f, 'project', ''),
        taskId: str(f, 'task', ''),
        repoFullName: str(f, 'repo', ''),
        expectedCommitSha: str(f, 'commit', ''),
        requiredChecks: str(f, 'checks').split(',').map((s) => s.trim()).filter(Boolean),
        requiredArtifacts: [],
        catalogVersion: str(f, 'catalog-version'),
        catalogDigest: str(f, 'catalog-digest'),
      },
      checkoutDir: str(f, 'checkout'),
      sinkDir: str(f, 'sink'),
      catalogDir: str(f, 'catalog-dir'),
      timeoutMs: num(f, 'timeout-ms', 15 * 60 * 1000),
      isolation: {
        ...(typeof f['execution-uid'] === 'string' ? { executionUid: Number(f['execution-uid']) } : {}),
        sandboxed: f['sandboxed'] === true,
        egressDenied: f['egress-denied'] === true,
      },
      allowUnisolated: f['allow-unisolated'] === true,
      ...(typeof f['run-id'] === 'string' ? { runId: f['run-id'] } : {}),
    });
    process.stdout.write(
      JSON.stringify(
        {
          runId: result.runId,
          sink: result.sinkDir,
          catalog: { version: result.catalog.version, digest: result.catalog.digest },
          isolationEnforced: result.isolation.enforced,
          isolationGaps: result.isolation.gaps,
          checks: result.records.map((r) => ({ name: r.name, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs })),
        },
        null,
        2,
      ) + '\n',
    );
    return result.records.every((r) => r.status === 'passed') ? 0 : 1;
  }

  if (stage === 'attest') {
    const artifacts = (typeof f['artifact'] === 'string' ? [f['artifact']] : []).map((spec) => {
      const [logicalPath, filePath] = spec.split('=');
      if (!logicalPath || !filePath) throw new Error('--artifact expects logicalPath=filePath');
      return { logicalPath, filePath };
    });
    const result = await runAttestation({
      hub: {
        baseUrl: str(f, 'hub'),
        projectKey: str(f, 'project-key'),
        keyId: env('HUB_RUNNER_KEY_ID'),
        keySecret: env('HUB_RUNNER_KEY_SECRET'),
        timeoutMs: num(f, 'http-timeout-ms', 30_000),
      },
      contractId: str(f, 'contract'),
      checkoutDir: str(f, 'checkout'),
      sinkDir: str(f, 'sink'),
      catalogDir: str(f, 'catalog-dir'),
      runnerId: str(f, 'runner-id'),
      runId: str(f, 'run-id'),
      attemptId: str(f, 'attempt-id'),
      environment: str(f, 'environment', 'ci'),
      signingSecret: env('HUB_RUNNER_SIGNING_SECRET'),
      artifacts,
      acknowledgeUnisolated: f['acknowledge-unisolated'] === true,
      dryRun: f['dry-run'] === true,
    });
    process.stdout.write(
      JSON.stringify(
        {
          submitted: result.submitted,
          accepted: result.accepted,
          idempotencyKey: result.payload.idempotencyKey,
          checks: result.payload.checks.map((c) => ({ name: c.name, status: c.status })),
          artifacts: result.payload.artifacts.map((a) => a.logicalPath),
        },
        null,
        2,
      ) + '\n',
    );
    return result.submitted && result.accepted !== true ? 1 : 0;
  }

  process.stderr.write('usage: king-verification-runner <harness|attest> [flags]\n');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // HubError messages already carry method/url/status. Never print the credential or the payload.
    const msg = err instanceof HubError ? err.kind + ': ' + err.message : err instanceof Error ? err.message : String(err);
    process.stderr.write(msg + '\n');
    process.exit(1);
  },
);
