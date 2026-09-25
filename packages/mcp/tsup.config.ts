import { defineConfig } from 'tsup';
import { binaryBanner } from '../../tsup.banner.js';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
  // The native parser must stay external; everything else is bundled so the
  // published binary is self-contained.
  external: ['oxc-parser'],
  noExternal: [/@egressa\//],
  // Shebang plus a real `require`; see tsup.banner.ts for why both are needed.
  banner: { js: binaryBanner },
});
