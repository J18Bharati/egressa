import { defineConfig } from 'tsup';
import { binaryBanner } from '../../tsup.banner.js';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
  // One file, no chunks. tsup splits ESM output by default, and the dynamic
  // `import('oxc-parser')` gave it a split point -- which broke the skill's
  // bundled copy, since a lone cli.js then referenced sibling chunks that were
  // not copied with it. A CLI gains nothing from code splitting.
  splitting: false,
  // The native parser must stay external: it is a platform-specific .node addon
  // and cannot be inlined. Everything else IS bundled -- but tsup externalises
  // the package's own `dependencies` by default, so citty and yaml have to be
  // named here. Without them the "self-contained" binary had three unmet
  // imports rather than one, and could not run outside a node_modules tree.
  external: ['oxc-parser'],
  noExternal: [/@egressa\//, 'citty', 'yaml'],
  // Shebang plus a real `require`; see tsup.banner.ts for why both are needed.
  banner: { js: binaryBanner },
});
