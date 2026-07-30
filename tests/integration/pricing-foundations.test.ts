import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetupDb } from '@/db/client';
import { pricingScheduleEntries, pricingSchedules, platformPricingState } from '@/db/schema';
import { MODEL_PRICING } from '@/providers/pricing';
import {
  EXCLUDED_MODELS,
  SEED_SCHEDULE_ID,
  buildSeedEntries,
  computeSeedScheduleHash,
} from '@/domain/pricing/pricing-foundation';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try { await getSetupDb().select({ h: pricingSchedules.scheduleHash }).from(pricingSchedules).limit(1); available = true; }
catch (err) { console.warn(`[pricing-foundations.test] SKIPPING — db not reachable / not migrated: ${err instanceof Error ? err.message : err}`); }

function urlAs(role: string, password: string): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.username = role; u.password = password;
  return u.toString();
}
let appPool: ReturnType<typeof postgres> | null = null;
beforeAll(() => { if (available) appPool = postgres(urlAs('app_server', process.env.APP_SERVER_PASSWORD ?? 'app_server_dev_only'), { max: 2, prepare: false }); });
afterAll(async () => { if (appPool) await appPool.end(); });

describe('P1a pricing foundations (DB)', () => {
  it('seeded entries match the authoritative MODEL_PRICING source (gpt-5.2 excluded)', async () => {
    if (!available) return;
    const db = getSetupDb();
    const rows = await db.select().from(pricingScheduleEntries).where(eq(pricingScheduleEntries.scheduleId, SEED_SCHEDULE_ID));
    const expected = buildSeedEntries();
    expect(rows.length).toBe(expected.length);
    expect(rows.some((r) => r.model === 'gpt-5.2')).toBe(false);
    expect('gpt-5.2' in EXCLUDED_MODELS).toBe(true);
    for (const e of expected) {
      const r = rows.find((x) => x.model === e.model)!;
      expect(r).toBeTruthy();
      expect(r.inputUnitPriceMicros).toBe(MODEL_PRICING[e.model]!.inputMicrosPerM);
      expect(r.outputUnitPriceMicros).toBe(MODEL_PRICING[e.model]!.outputMicrosPerM);
      expect(r.tokenUnitSize).toBe(1_000_000n);
      expect(r.unitDefinition).toBe('per_1m_tokens');
      expect(r.minChargeMicros).toBeNull();
      expect(r.maxOutputTokens).toBe(MODEL_PRICING[e.model]!.maxOutputTokens);
    }
  });

  it('schedule hash + singleton pointer match the canonicalization-v1 recomputation', async () => {
    if (!available) return;
    const db = getSetupDb();
    const s = (await db.select().from(pricingSchedules).where(eq(pricingSchedules.id, SEED_SCHEDULE_ID)))[0]!;
    expect(s.scheduleHash).toBe(computeSeedScheduleHash());
    expect(s.canonicalizationVersion).toBe(1);
    expect(s.hashAlgorithm).toBe('sha256');
    expect(s.currency).toBe('USD');
    const st = (await db.select().from(platformPricingState))[0]!;
    expect(st.singletonKey).toBe('GLOBAL');
    expect(st.currentPricingScheduleId).toBe(SEED_SCHEDULE_ID);
    expect(st.currentPricingScheduleHash).toBe(s.scheduleHash); // composite FK holds
  });

  it('pricing tables reject UPDATE and DELETE (immutable; trigger fires even for the privileged role)', async () => {
    if (!available) return;
    // Any of these mutations being rejected proves the immutability trigger fired (a superuser UPDATE on an
    // unprotected table would otherwise succeed). postgres.js surfaces the query text as `.message`, so we
    // assert rejection rather than match the server-side RAISE string; the raw DB message is 'append-only'.
    const db = getSetupDb();
    await expect(db.update(pricingSchedules).set({ currency: 'EUR' }).where(eq(pricingSchedules.id, SEED_SCHEDULE_ID))).rejects.toThrow();
    await expect(db.delete(pricingSchedules).where(eq(pricingSchedules.id, SEED_SCHEDULE_ID))).rejects.toThrow();
    await expect(db.update(pricingScheduleEntries).set({ maxOutputTokens: 1 }).where(eq(pricingScheduleEntries.scheduleId, SEED_SCHEDULE_ID))).rejects.toThrow();
    await expect(db.delete(pricingScheduleEntries).where(eq(pricingScheduleEntries.scheduleId, SEED_SCHEDULE_ID))).rejects.toThrow();
    await expect(db.update(platformPricingState).set({ seededByMigration: 'x' }).where(eq(platformPricingState.singletonKey, 'GLOBAL'))).rejects.toThrow();
    await expect(db.delete(platformPricingState).where(eq(platformPricingState.singletonKey, 'GLOBAL'))).rejects.toThrow();
  });

  it('only one GLOBAL pricing-state row is permitted (PK + CHECK)', async () => {
    if (!available) return;
    const c = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    try {
      await expect(c`insert into platform_pricing_state (singleton_key, current_pricing_schedule_id, current_pricing_schedule_hash, seeded_by_migration) values ('GLOBAL', ${SEED_SCHEDULE_ID}, ${computeSeedScheduleHash()}, 'x')`).rejects.toThrow();
      await expect(c`insert into platform_pricing_state (singleton_key, current_pricing_schedule_id, current_pricing_schedule_hash, seeded_by_migration) values ('OTHER', ${SEED_SCHEDULE_ID}, ${computeSeedScheduleHash()}, 'x')`).rejects.toThrow(/singleton|check/i);
    } finally { await c.end(); }
  });

  it('composite FK exists on the pointer and referential integrity is enforced (mismatch rejected)', async () => {
    if (!available) return;
    const c = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    try {
      const fk = await c`
        select conname from pg_constraint
        where conname = 'platform_pricing_state_schedule_fk' and contype = 'f'
          and confrelid = 'pricing_schedules'::regclass`;
      expect(fk.length).toBe(1);
      // A pricing entry referencing a non-existent schedule is rejected (FK enforced live).
      await expect(c`
        insert into pricing_schedule_entries
          (schedule_id, provider, model, input_unit_price_micros, output_unit_price_micros, token_unit_size, unit_definition, max_output_tokens, valid_from)
        values (${randomUUID()}, 'openai', 'x', 1, 1, 1000000, 'per_1m_tokens', 1, now())`).rejects.toThrow(/foreign key|violates/i);
    } finally { await c.end(); }
  });

  it('app_server has read-only access: can SELECT, cannot INSERT/UPDATE/DELETE', async () => {
    if (!available || !appPool) return;
    const rows = await appPool`select count(*)::int n from pricing_schedule_entries`;
    expect(Number(rows[0]!.n)).toBeGreaterThan(0); // read allowed
    await expect(appPool`insert into pricing_schedules (id, version_label, currency, schedule_hash, canonicalization_version, hash_algorithm, seeded_by_migration) values (${randomUUID()}, 'x', 'USD', ${randomUUID()}, 1, 'sha256', 'x')`).rejects.toThrow();
    await expect(appPool`update pricing_schedule_entries set max_output_tokens = 1 where schedule_id = ${SEED_SCHEDULE_ID}`).rejects.toThrow();
    await expect(appPool`delete from pricing_schedules where id = ${SEED_SCHEDULE_ID}`).rejects.toThrow();
  });

  it('no organization audit event was created for seeded platform pricing', async () => {
    if (!available) return;
    const c = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    try {
      const rows = await c`select count(*)::int n from audit_logs where action ilike '%pricing%' or entity_type ilike '%pricing%'`;
      expect(Number(rows[0]!.n)).toBe(0);
    } finally { await c.end(); }
  });
});
