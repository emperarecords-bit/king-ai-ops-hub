import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Applies Drizzle migrations, then the hand-written RLS/trigger layer.
 * Uses the MIGRATION connection (DDL rights), never the app role.
 */
async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql);

  console.log('Applying Drizzle migrations…');
  await migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') });

  console.log('Applying RLS, roles, and append-only triggers…');
  const rls = readFileSync(join(process.cwd(), 'src', 'db', 'rls.sql'), 'utf8');
  await sql.unsafe(rls);

  console.log('Migration complete.');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
