import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('operational HTTP surfaces', () => {
  it('keeps liveness dependency-free and distinct from readiness', () => {
    const live = read('src/app/api/live/route.ts');
    expect(live).toContain("{ status: 'alive' }");
    expect(live).not.toMatch(/getDb|object-store|run_jobs|DATABASE/);
    expect(read('src/middleware.ts')).toContain("pathname === '/api/live'");
  });

  it('middleware passes /api/mcp through to its own bearer gate (no session requirement)', () => {
    // The MCP route is bearer-token-only by design (Phase 5): no cookie/session
    // path exists, so a Supabase-session requirement in middleware would 401
    // every legitimate MCP client. Regression pin for the 2026-08-15 fix.
    expect(read('src/middleware.ts')).toContain("pathname === '/api/mcp'");
  });

  it('never returns caught exception messages from the public readiness route', () => {
    const readiness = read('src/app/api/health/route.ts');
    expect(readiness).not.toMatch(/err\.message/);
    expect(readiness).toContain("detail: 'unreachable'");
    expect(readiness).toContain("detail: 'check_failed'");
  });
});

describe('worker log contract', () => {
  it('uses the redacting structured logger with stable event names and correlation ids', () => {
    const worker = read('scripts/worker.ts');
    expect(worker).not.toMatch(/console\.(log|error)/);
    expect(worker).toContain("log.info('worker.run_job.claimed'");
    expect(worker).toContain('jobId: job.jobId');
    expect(worker).toContain('taskId: job.taskId');
    expect(worker).toContain("log.error('worker.fatal'");
    expect(worker).toContain('recoverable: false');
  });
});
