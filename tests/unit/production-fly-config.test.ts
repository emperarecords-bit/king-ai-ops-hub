import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static pins on the PRODUCTION Fly configuration (release-rehearsal prep). The production config must target the
 * Gate-1 identity, keep the receipt-gated release command, and must NEVER inherit staging's shortened acceptance
 * windows — those two overrides existing in fly.production.toml would silently weaken production's cleanup/purge
 * safety timing. CRLF-normalized so the pins hold on Windows checkouts.
 */

const prod = readFileSync(join('fly.production.toml'), 'utf8').replaceAll('\r\n', '\n');
const staging = readFileSync(join('fly.toml'), 'utf8').replaceAll('\r\n', '\n');

describe('fly.production.toml — Gate-1 production identity and safety pins', () => {
  it('targets the production app and region', () => {
    expect(prod).toMatch(/^app = 'king-ai-ops-hub-prod'$/m);
    expect(prod).toMatch(/^primary_region = 'iad'$/m);
  });

  it('keeps the receipt-gated release command (migrations run ONLY through the gate)', () => {
    expect(prod).toMatch(/release_command = 'npm run db:migrate'/);
  });

  it('does NOT carry staging acceptance shortenings (production timing defaults apply)', () => {
    // Match ASSIGNMENTS, not prose — the config's comment legitimately names the vars it excludes.
    expect(prod).not.toMatch(/^\s*CLEANUP_QUIET_MS\s*=/m);
    expect(prod).not.toMatch(/^\s*PURGE_RETENTION_MS\s*=/m);
    // …while staging deliberately does carry them (sanity that the assertion is meaningful):
    expect(staging).toMatch(/^\s*CLEANUP_QUIET_MS\s*=/m);
  });

  it('pins the production origin and Gate-1 D3 sizing', () => {
    expect(prod).toContain("APP_URL = 'https://king-ai-ops-hub-prod.fly.dev'");
    expect(prod).toMatch(/memory = '1gb'/);
    expect(prod).toMatch(/min_machines_running = 2/);
    expect(prod).toMatch(/auto_stop_machines = 'off'/);
  });

  it('the default fly.toml still targets staging (production never deploys implicitly)', () => {
    expect(staging).toMatch(/^app = 'king-ai-ops-hub-staging'$/m);
  });
});
