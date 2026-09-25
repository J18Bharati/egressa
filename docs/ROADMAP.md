# Roadmap

What v1 deliberately does not do. Listed so the scope is visibly a decision rather than an
omission, and so contributors know what is already planned.

## Next

**Python call sites and lockfiles.** Declared Python dependencies are read now —
`requirements*.txt` and `pyproject.toml` (PEP 621, PEP 735 groups, Poetry) — with `pypi` aliases for
the vendors whose Python SDK has been checked. What remains is `requests` and `httpx` call sites,
which need a Python parser and a sink table, and `poetry.lock` / `uv.lock` for
`--include-transitive`. Neither is a redesign: the knowledge base is keyed by vendor identity with
per-ecosystem aliases.

**Cross-module constant resolution.** Today `import { API_BASE } from './config'` is unresolved.
A whole-program constant table keyed on resolved relative specifiers would close the most common
remaining false negative without needing `node_modules` on disk.

**HTML `<script src>` extraction.** A GA or GTM tag in `index.html` is extremely common and is
about thirty lines of work. Deliberately deferred from v1 to keep the confidence model honest — it
ships as a distinct signal kind, and that mechanism now exists: `reference` landed for `new URL()`
and `new Request()`, with its own confidence ceiling and its own rendering, so what remains here is
the extractor rather than the concept. `html-script` is already in the enum.

## Later

- **Tag manager containers and CSP headers.** A GTM container can load vendors that appear nowhere
  in source; a CSP `connect-src` list is a declaration of intended destinations and a useful
  cross-check against what the scanner found.
- **PII data-flow analysis.** Determining that *personal data specifically* reaches a sink, rather
  than that a vendor is referenced. This is the largest single step up in both value and difficulty,
  and it is what would let the tool say something about Article 30 records.
- **Article 30 processing register generation.** Only meaningful once data-flow analysis exists;
  generating one from vendor references alone would overstate what the scan knows.

## Done since v1

**Infrastructure as code.** Shipped. `packages/core/src/infrastructure/` reads Terraform,
Serverless and Vercel configuration, and vendor SDK clients supply a region directly. A region is
resolved through the vendor's own map in `kb/`, never from its prefix, and narrows which
jurisdiction applies. Still open: TOML beyond `fly.toml`, CDK stacks, and regions under
dot-directories, which the walker does not collect.

## Covered by the review skills rather than the engine

Consent gating, retention, personal data in logs, session replay configuration and opt-out signals
are checked by `skill/privacy-review/`, not by engine rules. That split is deliberate: these
questions turn on reading surrounding control flow and on judgements a rule table cannot encode —
whether a cookie is strictly necessary, whether a logged object was redacted first — and a wrong
answer to any of them is worse than no answer.

Promoting any of them into an engine rule would mean it must be reproducible and hold up as a golden
test case. Two are close to that bar and are the candidates if it happens: the LogRocket masking
check, which is a literal option in a call's config object, and Redis `set` with no expiry argument.
The rest should stay agent-driven.

## Open decisions

**Whether to vendor the native parser binding into the skill bundle.** The bundled CLI in
`skill/privacy-review/bin/` runs without `oxc-parser`, so it reads dependency manifests only and
reports `engine.degraded`. Shipping the binding would give it full call-site analysis, at roughly
2 MB per platform committed to git — about 8 MB to cover Linux, macOS and Windows. The alternative is
to leave the bundle manifest-only and rely on a real build where one exists, which is what it does
today. Not decided.

## Not planned

- **Scanning arbitrary GitHub URLs as a service.** A hosted service that scans repositories the
  user does not own, and names vendors in the output, is a takedown magnet in exactly the way
  `kb/KB_POLICY.md` describes. Local paths only.
- **Telemetry.** The `unmatched` block plus the skill's issue-filing loop is a weaker recall signal
  than telemetry, and that trade is deliberate.
- **A compliance score or grade.** Reducing a transfer position to a number invites exactly the
  claim the tool refuses to make. This applies to the review skills too: they report findings and
  counts, never a grade, and never a per-category subscore that adds up to one in the reader's head.
- **Erasure not propagating to backups, logs, warehouses or sub-processors.** Article 17 is real and
  the gap is real, but establishing it needs runtime tracing across services that no single
  repository represents. Deletion may legitimately happen in another service, through a vendor API,
  or by backup expiry configured outside the repo, and authorities generally tolerate putting
  backups beyond use rather than purging them immediately. Nothing stronger than an informational
  "no in-repo deletion mechanism was found" is defensible.
- **General data minimisation, Article 5(1)(c), and privacy by design, Article 25(1).** Whether a
  column or a form field is necessary is a judgement against a purpose statement that does not exist
  in source. Every enforcement action here turned on facts a scanner cannot see: what a manager
  typed in a free-text note, what abuse pattern emerged in production, what a form asked a person.
  The one checkable slice is Article 25(2) default values — a tracking or marketing field whose
  literal default is on — and that is the only part built.
