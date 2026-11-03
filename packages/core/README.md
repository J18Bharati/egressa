# @egressa/core

> Egressa detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

The engine behind the [`egressa`](https://www.npmjs.com/package/egressa) CLI and the
[`@egressa/mcp`](https://www.npmjs.com/package/@egressa/mcp) server. Use it to run a scan from your
own code. For the command line, install `egressa` instead. Project overview, limitations and
install status: the [main README](https://github.com/J18Bharati/egressa#readme).

<!-- Remove this note at the first npm release. -->
Until the first npm release, this package is available only from a checkout of that repository.

```js
import { DISCLAIMER, loadConfig, scan, toSarif } from '@egressa/core';

const root = '/path/to/repo';
const result = scan({
  root,
  toolVersion: '0.2.0',
  config: loadConfig(root), // the repository's .egressa.yml, if any
  includeCallsites: true,   // off by default in scan(); the CLI turns it on
});

for (const finding of result.findings) {
  console.log(finding.ruleId, finding.vendor?.id, finding.severity, finding.confidence);
}
console.log(result.unmatched.packages); // dependencies with no knowledge base entry
const sarif = toSarif(result, { toolVersion: '0.2.0' });
```

`scan()` reads files under `root` and nothing outside it. It does not follow symlinks, read
`node_modules`, write to the console, call the network or exit the process. It returns a findings
document in the published findings schema (`result.schemaVersion`). If you show that document to a
person, show `DISCLAIMER` with it: it is the claim scope every Egressa surface carries.

Options worth knowing: `kbPath` (a knowledge base directory; the default is the one bundled
with [`@egressa/kb`](https://www.npmjs.com/package/@egressa/kb)), `exclude` (globs, added to the
config's), `assumeAdequacyLapsed` (for example `['US:DPF']`), `minConfidence`, `onlyVendor`. `loadConfig`
throws a `ConfigError` for a file it cannot honour.

Call-site analysis needs the native `oxc-parser` binding. When it cannot load, `scan()` still runs
on manifests and sets `scan.engine.degraded: true` in the result.

Versions below 1.0 make no promise of API stability. MIT.
