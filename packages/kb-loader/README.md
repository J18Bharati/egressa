# @egressa/kb

> Egressa detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

The Egressa vendor knowledge base, and the code that loads and indexes it. Each vendor entry records
where the vendor processes data, whether it documents an EU region, its transfer mechanisms, links
to its DPA and sub-processor list, and the sources behind each fact. `adequacy-status.json` records
the state of each EU adequacy decision, also sourced. Project overview: the
[main README](https://github.com/J18Bharati/egressa#readme).

<!-- Remove this note at the first npm release. -->
Until the first npm release, this package is available only from a checkout of that repository.

```js
import { loadKnowledgeBase } from '@egressa/kb';

const kb = loadKnowledgeBase(); // the copy bundled in this package
kb.version;                                // e.g. '2026.10.09'
kb.findVendor('@sentry/nextjs')?.id;       // 'sentry': id, npm or PyPI name, or host
kb.lookupHost('api.stripe.com')?.vendor.id; // 'stripe'
kb.lookupPackage('pypi', 'boto3')?.vendor.id; // 'aws'
kb.decisionFor('US')?.status;              // 'under-challenge'

// The same data, with a decision treated as withdrawn:
loadKnowledgeBase({ assumeAdequacyLapsed: ['US:DPF'] }).decisionFor('US')?.status; // 'withdrawn'
```

`kbPath` loads a different `kb/` directory. An ambiguous lookup, one that two vendors could both
claim, returns nothing rather than picking one. `staleEntries()` lists entries whose
`lastVerified` date is more than 180 days old.

The knowledge base version is a date, separate from the package version: a new knowledge base can
change what a scan reports with no code changing. The entries are facts with citations; ratings are
computed by `@egressa/core`, not stored here. To correct an entry, see
[KB_POLICY.md](https://github.com/J18Bharati/egressa/blob/main/kb/KB_POLICY.md).

## Licence

The loader code is MIT-licensed. The data in `kb/` is CC-BY-4.0, which requires attribution when you
reuse it; see `kb/LICENSE` and
[PROVENANCE.md](https://github.com/J18Bharati/egressa/blob/main/kb/PROVENANCE.md).
