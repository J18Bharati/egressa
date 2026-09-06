# Roadmap

What v1 deliberately does not do. Listed so the scope is visibly a decision rather than an
omission, and so contributors know what is already planned.

## Next

**Python ecosystem.** `requirements.txt`, `pyproject.toml`, `poetry.lock`, plus `requests` and
`httpx` call sites. The knowledge base is already keyed by vendor identity with per-ecosystem
package aliases and the schema already has a `pypi` slot, so this is a manifest parser, a sink
table and alias entries — not a redesign.

**Cross-module constant resolution.** Today `import { API_BASE } from './config'` is unresolved.
A whole-program constant table keyed on resolved relative specifiers would close the most common
remaining false negative without needing `node_modules` on disk.

**HTML `<script src>` extraction.** A GA or GTM tag in `index.html` is extremely common and is
about thirty lines of work. Deliberately deferred from v1 to keep the confidence model honest —
it would ship as a distinct low-confidence signal kind.

## Later

- **Tag manager containers and CSP headers.** A GTM container can load vendors that appear nowhere
  in source; a CSP `connect-src` list is a declaration of intended destinations and a useful
  cross-check against what the scanner found.
- **Infrastructure as code.** A US-region database or bucket is itself a processing location. This
  is a different analyzer over Terraform, CDK and `vercel.json`.
- **PII data-flow analysis.** Determining that *personal data specifically* reaches a sink, rather
  than that a vendor is referenced. This is the largest single step up in both value and difficulty,
  and it is what would let the tool say something about Article 30 records.
- **Article 30 processing register generation.** Only meaningful once data-flow analysis exists;
  generating one from vendor references alone would overstate what the scan knows.

## Not planned

- **Scanning arbitrary GitHub URLs as a service.** A hosted service that scans repositories the
  user does not own, and names vendors in the output, is a takedown magnet in exactly the way
  `kb/KB_POLICY.md` describes. Local paths only.
- **Telemetry.** The `unmatched` block plus the skill's issue-filing loop is a weaker recall signal
  than telemetry, and that trade is deliberate.
- **A compliance score or grade.** Reducing a transfer position to a number invites exactly the
  claim the tool refuses to make.
