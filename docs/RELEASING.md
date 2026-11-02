# Releasing

Four packages share one version: `egressa`, `@egressa/core`, `@egressa/kb`, `@egressa/mcp`. The CLI and
the MCP server bundle core and the knowledge base loader, so each installs on its own; the shared version
is so that `egressa@x` and `@egressa/kb@x` always mean the same knowledge base and engine. Changesets
treats the four as a `fixed` group (`.changeset/config.json`), and `.github/workflows/release.yml`
publishes them in one run.

## How a release works once the setup below is done

1. A change that should reach npm carries a changeset: `pnpm changeset` (pick any one package, the group
   moves together), commit the generated file.
2. Merging to `main` makes `release.yml` open or update a **Version Packages** pull request. Its commit
   runs `changeset version`, then `scripts/sync-version.mjs` (copies the new version into `VERSION` and
   the two `TOOL_VERSION` literals, which `scripts/version-consistency.test.ts` pins), then rebuilds the
   committed skill bundle.
3. Merging that pull request makes the next `release.yml` run publish. Before it does, a `verify` job runs
   `pnpm verify`, `pnpm build` and `pnpm smoke:pack` (the four tarballs installed together in a clean
   `node:20-slim` container). Publishing is `changeset publish`, which in a pnpm workspace calls
   `pnpm publish`, so `workspace:` ranges are rewritten to real versions.
4. Authentication is OIDC trusted publishing. There is no `NPM_TOKEN` secret anywhere. Provenance is
   attached automatically for a public repository.

`CHANGELOG.md` stays hand-written. Move `[Unreleased]` into a dated section in the version pull request.

A pull request opened with the default `GITHUB_TOKEN` does not trigger `ci.yml`. If branch protection
requires CI on the version pull request, close and reopen it, or switch the action to a GitHub App token.
The `verify` job above is the backstop either way.

## First publish (human-gated, in this order)

Trusted publishing cannot be configured for a package that does not exist on npm
(`npm trust` lists "Package must exist" as a prerequisite). So each package needs one manual publish of a
placeholder first. The real `0.2.0` then goes out from CI with provenance. Requirements: npm 11.15 or
later locally, 2FA on your npm account.

1. **Reserve the names on npm.** Create the npm organisation `egressa` (this owns the `@egressa` scope),
   then confirm the bare name is free:
   ```bash
   npm view egressa        # expect E404
   npm org ls egressa      # after creating the org on npmjs.com
   ```
2. **Publish a placeholder for each of the four names.** A first publish sets `latest` whatever `--tag`
   says, so from here until step 8 `npx egressa` resolves to this placeholder, which has no binary. Keep
   that window short, and remove the `bootstrap` tag after the real release
   (`npm dist-tag rm <name> bootstrap`).
   ```bash
   for n in egressa @egressa/core @egressa/kb @egressa/mcp; do
     d=$(mktemp -d) && (cd "$d" && npm init -y >/dev/null \
       && npm pkg set name="$n" version=0.0.1 license=Apache-2.0 \
            description="Placeholder. Releases are published from GitHub Actions." \
       && npm publish --access public --tag bootstrap)
   done
   ```
3. **Create the GitHub organisation `egressa-dev` and a public repository `egressa`.** It must be public:
   npm generates provenance only for public repositories. Confirm `repository.url` in all four
   `packages/*/package.json` is exactly `git+https://github.com/egressa-dev/egressa.git`; npm rejects a
   trusted publish from any other value.
4. **Push, without triggering a publish.** Anything pushed to `main` that contains `release.yml` runs it, so
   push `main` at the initial commit (which predates it), then the working branch:
   ```bash
   git remote add origin git@github.com:egressa-dev/egressa.git
   git push origin "$(git rev-list --max-parents=0 HEAD)":refs/heads/main
   git push origin v1-build
   ```
5. **Repository settings** (none of these can be set from the repository):
   - Settings > Actions > General > Workflow permissions: enable "Allow GitHub Actions to create and approve pull requests".
   - Settings > Advanced Security: enable private vulnerability reporting. `SECURITY.md` relies on it.
   - Branch protection on `main`: require the `CI` checks and pull requests.
   - `.github/CODEOWNERS` names `@egressa-dev/kb-maintainers`; create that team.
6. **M3 check, before publishing.** Open a pull request from `v1-build` to `main`. The `self-scan` job in
   `ci.yml` uploads SARIF to code scanning. Confirm, on the pull request and under Security > Code
   scanning, that annotations appear on the right lines and that each rule's `help.markdown` renders with
   the disclaimer. If it does not render, fix it before step 7. This has never been verified live.
7. **Configure the trusted publisher, once per package (four passes).** A new configuration must complete
   its first publish within 2 days, so do this immediately before step 8. On npmjs.com, for each package:
   Settings > Trusted publisher > GitHub Actions, then enter:
   - Organization or user: `egressa-dev`
   - Repository: `egressa`
   - Workflow filename: `release.yml` (filename only, with extension, case-sensitive)
   - Environment: leave empty
   - Allowed actions: allow `npm publish`

   Or from a terminal, per package (re-run with `egressa`, `@egressa/core`, `@egressa/kb`, `@egressa/mcp`):
   ```bash
   npm trust github egressa --repo egressa-dev/egressa --file release.yml --allow-publish
   npm trust list egressa
   ```
   npm does not check the values when you save them; a typo only shows up as `ENEEDAUTH` at publish time.
8. **Merge the pull request from step 6.** The merge runs `release.yml`. There are no pending changesets
   and the tree is at `0.2.0`, which is not on npm, so it goes straight to publish. If a package fails,
   fix the cause and re-run the failed job; `changeset publish` skips versions already on npm.
9. **Verify from a clean environment, ideally another machine.**
   ```bash
   docker run --rm -v "$PWD/fixtures/repos/express-stripe-sendgrid:/repo:ro" node:20-slim \
     npx -y egressa@0.2.0 scan /repo
   mkdir /tmp/verify && cd /tmp/verify && npm init -y >/dev/null \
     && npm install egressa@0.2.0 && npm audit signatures
   ```
   Expect one Stripe finding, `engine.degraded` false, and a verified provenance attestation for every package.
10. **After the first success:**
    - On each package: Settings > Publishing access > "Require two-factor authentication and disallow tokens".
    - Update `SECURITY.md`, which still describes provenance verification as future.
    - Optionally restrict `release.yml` to a GitHub environment with a required reviewer, and add that
      environment name to each trusted publisher.
    - Create the moving action tag the README refers to (nothing creates it): after checking the release,
      `git tag -f v1 && git push -f origin v1`. Decide first whether `v1` is the right name while the
      packages are `0.x`.

## Pinned third-party actions

Every action in `.github/workflows/` and `action.yml` is pinned to a full commit SHA with the version in a
comment. Update them together, and re-resolve the SHA from the tag rather than copying one from elsewhere.
`@changesets/cli` is held on 2.x because `changesets/action` v1 matches it; `changesets/action` v2 needs
`@changesets/cli` 3, which requires Node 22.11 and pnpm 10.
