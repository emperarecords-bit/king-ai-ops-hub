import postgres from 'postgres';

/**
 * Test database handles for the RLS-enforcement suite (O-22).
 *
 * TWO roles, deliberately:
 *   * adminUrl / adminSql — the MIGRATION role (superuser `king` locally, or the
 *     managed-PG owner). Used ONLY to seed fixtures and tear them down, exactly
 *     as a deployment's migration role would. It bypasses RLS by design.
 *   * appUrl / appSql — the runtime `app_server` role (NOSUPERUSER, NOBYPASSRLS).
 *     Everything UNDER TEST — every assertion about what a tenant can see or
 *     write — must go through this handle, so RLS is actually exercised.
 *
 * The sprint's contract: "Migration setup may use the migration role, but the
 * application tests must not." adminSql is setup; appSql is the code under test.
 */

export function adminUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://king:king@localhost:5433/king_ai_hub'
  );
}

/** Derive the app_server URL from the admin URL by swapping credentials.
 *  The dev password is created by rls.sql and is local-only. */
export function appUrl(): string {
  const pw = process.env.APP_SERVER_TEST_PASSWORD ?? 'app_server_dev_only';
  return adminUrl().replace(/\/\/[^@]+@/, `//app_server:${pw}@`);
}

export function adminSql(): postgres.Sql {
  return postgres(adminUrl(), { max: 1, connect_timeout: 5, onnotice: () => {} });
}

export function appSql(): postgres.Sql {
  return postgres(appUrl(), { max: 2, connect_timeout: 5, onnotice: () => {} });
}

/**
 * Probe that the local DB is reachable AND has RLS applied. Returns false (with
 * a warning) otherwise, so the suite skips cleanly on a machine without the
 * Docker database instead of failing the unit run.
 */
export async function rlsAvailable(label: string): Promise<boolean> {
  const probe = postgres(adminUrl(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const rls = await probe`select relrowsecurity from pg_class where relname = 'tasks'`;
    if (!rls[0]?.relrowsecurity) {
      console.warn(`[${label}] SKIPPING — RLS not applied. Run: npm run db:up && npm run db:migrate`);
      return false;
    }
    // Confirm the app_server role exists and can connect, and MAKE THE ACTIVE
    // ROLE VISIBLE — an accidental superuser run must be obvious in output.
    const app = postgres(appUrl(), { max: 1, connect_timeout: 3, onnotice: () => {} });
    try {
      const who = await app`select current_user as u,
        (select rolsuper from pg_roles where rolname = current_user) as super,
        (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
      const role = who[0]!;
      console.warn(
        `[${label}] app role = ${role.u} (superuser=${role.super}, bypassrls=${role.bypass})`,
      );
      if (role.super || role.bypass) {
        console.warn(
          `[${label}] WARNING — the app connection is a superuser/bypassrls role; RLS is NOT being exercised.`,
        );
      }
    } finally {
      await app.end();
    }
    return true;
  } catch (err) {
    console.warn(
      `[${label}] SKIPPING — database/app_server not reachable: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  } finally {
    await probe.end();
  }
}

/** Run fn inside an app_server transaction scoped to (user, org, project). */
export async function asTenant<T>(
  app: postgres.Sql,
  ids: { userId: string; orgId: string; projectId: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${ids.userId}, true),
                    set_config('app.org_id', ${ids.orgId}, true),
                    set_config('app.project_id', ${ids.projectId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Run fn inside an app_server transaction with ONLY the user identity set
 *  (the pre-tenant bootstrap boundary). */
export async function asUser<T>(
  app: postgres.Sql,
  userId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
