import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * HUB-009 Gate 3C — regression lock. The authenticated staging UI pass found the Work/Execution page was
 * showing demo/seed rows WITHOUT a classification chip (the row data carried `classification`, but no render
 * site used it). These source assertions keep the chip wired into every row-render location on the page so
 * the "visible AND labeled" contract cannot silently regress.
 */

const root = process.cwd();
const page = readFileSync(join(root, 'src/app/p/[projectKey]/work/page.tsx'), 'utf8');
const row = readFileSync(join(root, 'src/app/p/[projectKey]/work/work-item-row.tsx'), 'utf8');

describe('Work/Execution page labels every non-live row', () => {
  it('imports ClassificationChip', () => {
    expect(page).toMatch(/import\s*\{[^}]*ClassificationChip[^}]*\}\s*from\s*'\.\.\/non-live-controls'/);
  });
  it('renders the chip in the two inline row lists (Requires-you + Recent)', () => {
    const inline = page.match(/<ClassificationChip classification=\{r\.classification\} \/>/g) ?? [];
    expect(inline.length).toBeGreaterThanOrEqual(2);
  });
  it('renders the chip inside the TaskRow (ai_task) component', () => {
    expect(page).toMatch(/<ClassificationChip classification=\{classification\} \/>/);
    // and the ai_task call site passes it down
    expect(page).toMatch(/<TaskRow[^>]*classification=\{r\.classification\}/);
  });
  it('passes classification into WorkItemRow, which renders the chip', () => {
    expect(page).toMatch(/<WorkItemRow[\s\S]*?classification=\{r\.classification\}/);
    expect(row).toMatch(/<ClassificationChip classification=\{classification\} \/>/);
  });
});
