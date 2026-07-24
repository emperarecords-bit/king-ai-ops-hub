/**
 * Vitest global setup. Provides a minimal env so modules with lazy env
 * validation can be imported; tests that need real values override locally.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
