/**
 * The banner both published binaries need, `egressa` and `egressa-mcp`. It
 * carries two things that must come before all bundled code.
 *
 * The shebang. Neither entry file carries one of its own, because a banner is
 * emitted above the entry's first line and a shebang is honoured only as the
 * very first bytes of the file.
 *
 * And a real `require`. Both bundles inline @egressa/core, and through it the
 * CommonJS in yaml (and, for the CLI, citty) that calls require() at run time.
 * esbuild replaces those calls with a __require shim whose first branch is
 * `typeof require !== "undefined" ? require : <throw>`. In an ESM bundle nothing
 * defines `require`, so the shim threw "Dynamic require of \"process\" is not
 * supported" on the first call. Defining `require` here, above the shim, is the
 * supported fix.
 *
 * This lives in one file because the MCP server once shipped without the second
 * half: its config dropped the banner on the assumption that it carried only the
 * shebang, and the server threw at import. `scripts/smoke-dist.mjs` boots both
 * binaries at the end of `pnpm build`, so a missing banner now fails the build.
 */
export const binaryBanner = [
  '#!/usr/bin/env node',
  "import { createRequire as __egressaCreateRequire } from 'node:module';",
  'const require = __egressaCreateRequire(import.meta.url);',
].join('\n');
