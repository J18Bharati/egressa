import { defineConfig } from 'tsup';

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
  // The banner carries two things that must precede all bundled code.
  //
  // The shebang, which used to live in cli.ts -- it cannot stay there now,
  // because a banner is emitted above the entry's own first line and a shebang
  // is only honoured as the very first bytes of the file.
  //
  // And a real `require`. Inlining citty and yaml pulls in CommonJS that calls
  // require() at run time; esbuild replaces those with a __require shim whose
  // first branch is `typeof require !== "undefined" ? require : <throw>`. In an
  // ESM bundle nothing defines it, so the shim threw "Dynamic require of
  // \"process\" is not supported" on the first call. Defining require here, above
  // the shim, is the supported fix.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __egressaCreateRequire } from 'node:module';",
      'const require = __egressaCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
