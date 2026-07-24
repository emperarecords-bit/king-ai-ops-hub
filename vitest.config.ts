import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Playwright specs are driven by `npm run test:e2e`, not vitest.
    exclude: ['tests/e2e/**', 'node_modules/**'],
    setupFiles: ['tests/support/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/app/**', 'src/components/**', 'src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@tests': fileURLToPath(new URL('./tests', import.meta.url)),
      // `server-only` throws outside Next's server runtime. Tests exercise the
      // server layer by definition, so resolve it to the same empty module
      // Next uses under the react-server condition. The guard still protects
      // the real build — this only affects the test runner.
      'server-only': fileURLToPath(
        new URL('./node_modules/server-only/empty.js', import.meta.url),
      ),
    },
  },
});
