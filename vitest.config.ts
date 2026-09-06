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
      '@adequacy/kb': fileURLToPath(new URL('./packages/kb-loader/src/index.ts', import.meta.url)),
      '@adequacy/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
});
