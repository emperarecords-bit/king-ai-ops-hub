import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Dedicated config for the LIVE S3 acceptance test (O-23). It requires a running
 * MinIO/S3 endpoint and drives the global document-job queue against a live
 * bucket, so it must run ALONE — never alongside the hermetic queue tests (which
 * is why the main vitest.config.ts excludes it). Run: `npm run test:s3`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/s3-live.test.ts'],
    setupFiles: ['tests/support/setup.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@tests': fileURLToPath(new URL('./tests', import.meta.url)),
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
});
