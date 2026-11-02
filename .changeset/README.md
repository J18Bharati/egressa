# Changesets

Run `pnpm changeset` to describe a change that should reach npm. Pick any one of the four packages:
they are a `fixed` group, so all four are versioned and published together. The full procedure,
including the one-time human steps, is in `docs/RELEASING.md`.

`CHANGELOG.md` at the repository root stays hand-written. Changesets writes a `CHANGELOG.md` into each
package it bumps: `changesets/action` reads those to build the release pull request, and fails
without them.
