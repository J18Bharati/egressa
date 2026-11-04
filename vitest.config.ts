import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Workspace packages are aliased to their source rather than their build
 * output, so tests run against what is being edited and no build step is
 * required before `pnpm test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@egressa/kb': fileURLToPath(new URL('./packages/kb-loader/src/index.ts', import.meta.url)),
      '@egressa/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // In CI, a line per test as it finishes rather than per file, so a stalled
    // run shows how far it got. Setting this replaces the defaults, so the
    // annotations from github-actions have to be named too.
    reporters: process.env.CI ? ['verbose', 'github-actions'] : ['default'],
  },
});
