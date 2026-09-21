/**
 * The reported tool version.
 *
 * A literal, not a read of `package.json`: this module is inlined into a single
 * bundled binary that is copied outside its own tree -- `skill/privacy-review/bin/`
 * holds one such copy -- so resolving a sibling file at run time is exactly the
 * assumption that breaks there. `VERSION` at the repository root is the source of
 * truth and `scripts/version-consistency.test.ts` asserts every copy agrees with
 * it, which is the enforcement a comment promising a build-time stamp was not.
 */
export const TOOL_VERSION = '0.2.0';
