import next from 'eslint-config-next';

/**
 * Flat config, using eslint-config-next directly.
 *
 * Next 16 ships this as a flat config array. The previous `FlatCompat` shim is
 * not merely unnecessary against it — it fails, trying to serialise a config
 * that now holds circular plugin references.
 */
const config = [
  {
    ignores: [
      '.next/**',
      '.next-build/**',
      'node_modules/**',
      'next-env.d.ts',
      // Throwaway scripts for poking at a provider's API — "which models does
      // this key actually serve?" and the like. Useful to keep, not part of the
      // application, and not worth holding to the app's type strictness.
      'scratch/**',
    ],
  },
  ...next,
  {
    // Scoped to TypeScript, because the @typescript-eslint plugin is only in
    // scope for the files next/typescript applies to. Left unscoped, these
    // rules are looked up against .mjs and .js files too — where the plugin
    // does not exist, and ESLint fails to start rather than skipping them.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];

export default config;
