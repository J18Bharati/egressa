# Contributing

Egressa has two halves under two licences, and they take contributions differently.

| | Code | Knowledge base (`kb/`) |
|---|---|---|
| Licence | MIT | CC-BY-4.0 |
| What it is | The engine, CLI, MCP server, skills and scripts | Sourced facts about vendors |
| Start with | An issue describing the problem | The [knowledge base contribution](.github/ISSUE_TEMPLATE/kb-contribution.yml) issue, or a [vendor request](.github/ISSUE_TEMPLATE/vendor-request.yml) |
| Before a pull request | `pnpm verify` | `pnpm kb:validate`, then `pnpm verify` |

A contribution is made under the licence of the half it changes. There is no contributor licence
agreement.

**Issue first, then a pull request.** A short issue saves rework on both sides, especially for a
change to detection or to the findings schema, which other tools consume. A pull request without
one is still welcome for a small fix.

## Code

```bash
pnpm install
pnpm verify        # lint, typecheck, kb:validate, schema:check and every test
pnpm build         # bundles both binaries and boots them
```

`CLAUDE.md` lists the invariants that are easy to break, and `docs/LIMITATIONS.md` the deliberate
gaps. Each documented limitation has a test that fails if it starts to resolve: lifting one is a
change to both, not a side effect. No output may claim to assess compliance; the claims contract
test enforces the wording.

## Knowledge base

Facts only, each cited to a page the vendor or a regulator publishes, and authored from those pages
rather than copied from another database. `kb/PROVENANCE.md` lists the sources that must never be
incorporated, and `kb/KB_POLICY.md` the rest of the rules, including how to cite a DPF record.

The easiest route starts in your own repository. When the transfer triage skill, or you, has
checked a fact into `.egressa/facts.json`:

```bash
egressa facts contribute <vendorId> --root path/to/your/repo
```

prints a draft: the entry with your change and its sources, a checklist and an issue body. It
contains one vendor's entry and nothing from your code, but posting it does say publicly that a
codebase you work on uses that vendor. **Egressa never sends it anywhere.** You open the issue or
pull request yourself, if you choose to.

A maintainer re-reads every cited page before merging, and sets `lastVerified` to the date of that
reading, not the date of the draft. A fact that contradicts an entry is handled under the
corrections section of `kb/KB_POLICY.md`, and the entry is marked `disputed` while it is reviewed.

## Conduct and security

Participation is governed by the [code of conduct](CODE_OF_CONDUCT.md). Report security problems
privately as [SECURITY.md](SECURITY.md) describes, never in a public issue.
