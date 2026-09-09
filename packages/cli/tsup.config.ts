import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
  // The native parser must stay external; everything else is bundled so the
  // published binary is self-contained.
  external: ['oxc-parser'],
  noExternal: [/@egressa\//],
  // No banner: the source entrypoint already carries the shebang.
});
