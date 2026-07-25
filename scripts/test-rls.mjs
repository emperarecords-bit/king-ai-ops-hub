// Runs the full test suite with the application connection set to the
// non-superuser `app_server` role (O-22, acceptance Test 8). Migration setup
// still uses the migration role via DATABASE_MIGRATION_URL. Dependency-free and
// cross-platform: sets env, prints the active role, then spawns vitest.
import { spawn } from 'node:child_process';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

const appPassword = process.env.APP_SERVER_TEST_PASSWORD ?? 'app_server_dev_only';
const appUrl = migrationUrl.replace(/\/\/[^@]+@/, `//app_server:${appPassword}@`);

const env = {
  ...process.env,
  DATABASE_URL: appUrl, // the code under test connects as app_server
  DATABASE_MIGRATION_URL: migrationUrl, // fixtures/getSetupDb use the migration role
};

// Never expose the password; show only the role + host.
const safe = appUrl.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@');
console.warn(`[test:rls] application DB connection = ${safe}`);
console.warn('[test:rls] migration/setup connection uses DATABASE_MIGRATION_URL');
console.warn('[test:rls] the RLS suites also print the resolved current_user at runtime.\n');

const child = spawn('npx', ['vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 1));
