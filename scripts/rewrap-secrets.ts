import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { decryptSecret, encryptSecret, parseKeyVersion } from '../src/lib/crypto';
import * as schema from '../src/db/schema';

/**
 * Key rotation (SECURITY.md §6): re-encrypts every integration secret stored
 * under a previous key version with the current APP_ENCRYPTION_KEY.
 *
 * Old keys are supplied as APP_ENCRYPTION_KEY_V<version>. Runs on the
 * migration connection; each rewrap is logged (names only, never values).
 */
async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');

  const currentVersion = Number(process.env.APP_ENCRYPTION_KEY_VERSION ?? '1');
  const currentKeyB64 = process.env.APP_ENCRYPTION_KEY;
  if (!currentKeyB64) throw new Error('APP_ENCRYPTION_KEY must be set.');
  const currentKey = Buffer.from(currentKeyB64, 'base64');
  if (currentKey.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes base64.');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });

  const rows = await db.select().from(schema.integrationSecrets);
  let rewrapped = 0;
  let skipped = 0;

  for (const row of rows) {
    const version = parseKeyVersion(row.ciphertext);
    if (version === currentVersion) {
      skipped += 1;
      continue;
    }
    const oldKeyB64 = process.env[`APP_ENCRYPTION_KEY_V${version}`];
    if (!oldKeyB64) {
      console.error(`Secret '${row.name}' uses key v${version}; APP_ENCRYPTION_KEY_V${version} not provided. Skipping.`);
      continue;
    }
    const plaintext = decryptSecret(row.ciphertext, Buffer.from(oldKeyB64, 'base64'));
    const { serialized } = encryptSecret(plaintext, currentKey, currentVersion);
    await db
      .update(schema.integrationSecrets)
      .set({ ciphertext: serialized, keyVersion: currentVersion, updatedAt: new Date() })
      .where(eq(schema.integrationSecrets.id, row.id));
    console.log(`Rewrapped '${row.name}' v${version} → v${currentVersion}`);
    rewrapped += 1;
  }

  console.log(`Done. Rewrapped ${rewrapped}, already current ${skipped}, total ${rows.length}.`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
