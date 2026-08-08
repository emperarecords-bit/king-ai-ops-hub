import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExecutorFoundationStatus } from '@/app/p/[projectKey]/approvals/executor-status';

describe('executor preview/status UI boundary', () => {
  it('renders risk, confirmation, preview, and disabled-live status without a trigger', () => {
    const html = renderToStaticMarkup(<ExecutorFoundationStatus actionType="file_write" />);
    expect(html).toContain('Reversible internal write');
    expect(html).toContain('Disabled');
    expect(html).toContain('Required and payload-bound');
    expect(html).toContain('no side effect');
    expect(html).not.toMatch(/<button|<form/);
  });

  it('offers no preview for prohibited action classes', () => {
    const html = renderToStaticMarkup(<ExecutorFoundationStatus actionType="financial" />);
    expect(html).toContain('Financial or regulated action');
    expect(html).toContain('Not available');
    expect(html).toContain('No live executor capability is enabled');
  });

  it('no client component imports the trusted dispatch path', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } };
    walk(join(process.cwd(), 'src', 'app'));
    const offenders = files.filter((file) => { const src = readFileSync(file, 'utf8'); return /^\s*['"]use client['"]/.test(src) && src.includes('@/domain/execution/dispatch'); });
    expect(offenders).toEqual([]);
  });
});

