import coreWebVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

/**
 * Layer boundaries (see ARCHITECTURE.md §4). Dependencies point strictly
 * downward. These rules are the enforcement — without them the layering is a
 * comment, not a constraint.
 */
const layerRules = [
  {
    // db and lib are the floor: they may not reach upward for anything.
    files: ['src/db/**/*.ts', 'src/lib/**/*.ts', 'src/types/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@/app/*', '@/components/*'], message: 'db/lib/types must not import UI.' },
            { group: ['@/domain/*'], message: 'db/lib/types must not import domain logic.' },
            { group: ['@/orchestration/*'], message: 'db/lib/types must not import the engine.' },
            { group: ['@/providers/*'], message: 'db/lib/types must not import provider adapters.' },
          ],
        },
      ],
    },
  },
  {
    // Provider adapters are the ONLY place an SDK may be imported.
    files: ['src/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@/app/*', '@/components/*'], message: 'Providers must not import UI.' },
            { group: ['@/domain/*'], message: 'Providers must not import domain logic.' },
            { group: ['@/orchestration/*'], message: 'Providers must not import the engine.' },
            { group: ['@/db/*'], message: 'Providers must not touch the database.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/orchestration/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@/app/*', '@/components/*'], message: 'The engine must not import UI.' },
            { group: ['openai', 'openai/*'], message: 'Use the AIProvider interface, not the SDK.' },
            {
              group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
              message: 'Use the AIProvider interface, not the SDK.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@/app/*', '@/components/*'], message: 'Domain must not import UI.' },
            { group: ['openai', 'openai/*'], message: 'Use the AIProvider interface, not the SDK.' },
            {
              group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
              message: 'Use the AIProvider interface, not the SDK.',
            },
          ],
        },
      ],
    },
  },
  {
    // No component may reach a provider SDK or the raw DB client.
    files: ['src/components/**/*.tsx', 'src/components/**/*.ts', 'src/app/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['openai', 'openai/*'], message: 'UI must never import a provider SDK.' },
            {
              group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
              message: 'UI must never import a provider SDK.',
            },
            { group: ['@/db/client*'], message: 'UI must go through a domain service.' },
            { group: ['@/lib/env.server*'], message: 'UI must never read server env directly.' },
          ],
        },
      ],
    },
  },
];

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'drizzle/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
      // Standalone deployables (own runtime, own style — CommonJS Node services deployed to
      // their own Fly apps). They are not part of the Next.js app this config governs.
      'services/**',
    ],
  },
  ...coreWebVitals,
  ...tseslint.configs.recommended,
  {
    // `react/no-danger` needs the react plugin, which eslint-config-next registers only for
    // {js,jsx,mjs,ts,tsx,mts,cts} — NOT .cjs. Scoping the rule to that same set keeps it enforced
    // everywhere React/JSX can exist while letting eslint lint a plain .cjs helper without failing to
    // resolve the plugin. No weakening: a .cjs file cannot contain JSX dangerouslySetInnerHTML, and the
    // no-restricted-syntax guard below still applies to every file.
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      // Model output is rendered as text, always. See SECURITY.md T2.
      'react/no-danger': 'error',
    },
  },
  {
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'Model output is untrusted. Render as text nodes only (SECURITY.md T2).',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  ...layerRules,
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', '*.config.ts', '*.config.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    // Standalone CommonJS helper scripts (e.g. scripts/int-verify/*.cjs): require() is the native
    // module system for .cjs, and they log progress to stdout. Scoped to .cjs ONLY — TypeScript
    // tests, scripts and config files still enforce no-require-imports.
    files: ['scripts/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },
);
