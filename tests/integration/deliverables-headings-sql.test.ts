import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, rlsAvailable } from '@tests/support/db';
import { RESULT_HEADING_SQL_PATTERN, resultHeadings } from '@/domain/opschat/deliverables';

/**
 * The linked-run check reads only the result's HEADING lines out of Postgres (regexp_matches, 'gn'); the in-memory
 * check uses resultHeadings. Both must pick exactly the same lines, or the two paths would judge a result differently.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

const available = await rlsAvailable('deliverables-headings-sql.test');
let admin: postgres.Sql;

beforeAll(() => {
  if (available) admin = adminSql();
});
afterAll(async () => {
  await admin?.end();
});

const SAMPLES = [
  `# Title (Finalized)\n## 3. CFM Calculation & Duct Sizing Options\n**Load:** 20 kW\n| Option | CFM |\n## 7. Vendor Material List (Quantities)\nbody **bold** text\n**Whole bold line**\n## 8. Open Items`,
  `**Bold heading**\r\nbody **not** a heading\r\n### Crlf heading\r\n`,
  `no headings at all\njust text`,
  `#NotAHeading (no space)\n####### seven hashes\n## ${'x'.repeat(250)}`,
];

describe('result headings — Postgres and TypeScript agree', () => {
  it.runIf(available)('regexp_matches(…, RESULT_HEADING_SQL_PATTERN, gn) == resultHeadings', async () => {
    for (const text of SAMPLES) {
      const rows = await admin`select coalesce(array_agg(m[1]), '{}') as h from regexp_matches(${text}, ${RESULT_HEADING_SQL_PATTERN}, 'gn') as m`;
      expect(rows[0]!.h as string[]).toEqual(resultHeadings(text));
    }
  });
});
