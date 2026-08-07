import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('operational log leakage boundary', () => {
  it('does not send raw caught error text to job/run operational logs', () => {
    const jobs = readFileSync('src/domain/jobs/jobs.ts', 'utf8');
    const runner = readFileSync('src/domain/tasks/runner.ts', 'utf8');
    expect(jobs).not.toContain("taskId: job.taskId, reason });");
    expect(runner).not.toContain("err: err instanceof Error ? err.message : err");
    expect(runner).not.toContain("log.warn('Run failed', { runId, reason })");
    expect(jobs).toContain("errorClass: err instanceof Error ? err.name : 'unknown'");
  });
});
