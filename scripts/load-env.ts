import { config as loadEnv } from 'dotenv';

/**
 * Environment loading for every script under scripts/. Import it FIRST and for its side effect:
 *
 *   import './load-env';
 *
 * WHY A MODULE AND NOT THREE LINES IN EACH SCRIPT
 *
 * `import 'dotenv/config'` reads only `.env`, and this repo keeps local configuration in
 * `.env.local` (Next.js loads that automatically; plain `tsx` does not). Every script that used it
 * therefore died on "DATABASE_URL is not set" in a normal checkout, before running any of its own
 * logic.
 *
 * The obvious fix — calling `loadEnv()` inline between the imports — has a latent ordering bug. ESM
 * hoists and evaluates ALL of a module's imports before any of its top-level statements run, so an
 * inline `loadEnv()` executes AFTER every imported module has already been evaluated. That is
 * invisible today only because the modules these scripts import read `process.env` lazily (inside
 * `getPool()`, inside `serverEnv()`), and it would break the moment one of them read env at module
 * scope. A side-effect import does not have that problem: ESM evaluates imports in source order, so
 * placing this one first runs it before the rest — the same guarantee `dotenv/config` gave.
 *
 * PRECEDENCE
 *
 * `.env.local` wins over `.env` (Next.js semantics), and a real environment variable wins over both,
 * because dotenv never overwrites a value that is already set. That last part is what matters in the
 * cloud: on Fly these come from secrets, no file exists, and loading a missing file is a no-op.
 */

// `quiet` keeps dotenv's "injected env" banner out of operator output. Centralising the load is
// what makes that a one-line decision for every script instead of sixteen.
loadEnv({ path: '.env.local', quiet: true });
loadEnv({ quiet: true });
