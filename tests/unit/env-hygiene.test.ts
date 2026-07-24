import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guardrails on the env contract itself (SECURITY.md T3).
 */
describe('.env.example hygiene', () => {
  const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
  const names = example
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=')[0]!);

  it('no NEXT_PUBLIC_ variable smells like a secret', () => {
    const offenders = names.filter(
      (n) => n.startsWith('NEXT_PUBLIC_') && /KEY_|_KEY$|SECRET|TOKEN|PASSWORD|PRIVATE/i.test(n.replace('NEXT_PUBLIC_', '').replace('ANON_KEY', '')),
    );
    // The Supabase anon key is publishable BY DESIGN; everything else must not
    // pair NEXT_PUBLIC_ with a secret-ish name.
    expect(offenders).toEqual([]);
  });

  it('provider keys are present and NOT public', () => {
    expect(names).toContain('OPENAI_API_KEY');
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(names).not.toContain('NEXT_PUBLIC_OPENAI_API_KEY');
    expect(names).not.toContain('NEXT_PUBLIC_ANTHROPIC_API_KEY');
  });

  it('encryption key is declared with a version', () => {
    expect(names).toContain('APP_ENCRYPTION_KEY');
    expect(names).toContain('APP_ENCRYPTION_KEY_VERSION');
  });
});

describe('client import hygiene', () => {
  it('env.server.ts is guarded by server-only', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'env.server.ts'), 'utf8');
    expect(source).toContain("import 'server-only'");
  });

  it('provider registry is guarded by server-only', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'providers', 'registry.ts'), 'utf8');
    expect(source).toContain("import 'server-only'");
  });

  it('no dangerouslySetInnerHTML anywhere in src', () => {
    // The ESLint rule enforces this too; this test makes it a hard failure
    // even if lint config drifts.
    let hits = '';
    try {
      hits = execSync('git grep -l dangerouslySetInnerHTML -- src', {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
    } catch {
      // git grep exits non-zero when nothing matches — that is the pass case.
    }
    expect(hits.trim()).toBe('');
  });
});
