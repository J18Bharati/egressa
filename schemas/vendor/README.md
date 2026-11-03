# Vendored schemas

`sarif-schema-2.1.0.json` is the SARIF 2.1.0 JSON schema published by OASIS, copied unmodified from
<https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json>
(the address in its own `id`). It is Copyright (c) OASIS Open and is provided under the OASIS
Intellectual Property Rights Policy and the notices in the specification it belongs to,
<https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html>.

It is used only by `packages/core/src/output/sarif.test.ts`, to validate Egressa's SARIF output
offline, and it is not part of any published package. It is not covered by this repository's MIT
License.
