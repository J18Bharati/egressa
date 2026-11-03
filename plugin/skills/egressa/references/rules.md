# Rule reference

Full text is available offline with `npx egressa explain <ruleId>`.

| Rule | Level | Means |
|---|---|---|
| `transfer/third-country-egress` | warning | Vendor processes outside the EEA, not covered by a decision that applies to it, and no EU region is documented |
| `transfer/third-country-egress-eu-region-available` | warning | Same, but the vendor documents an EU region. The scanner cannot see which region the account uses |
| `transfer/adequate-country-egress` | note | Covered by an in-force adequacy decision that applies to this vendor. `adequacyDependent` is set |
| `transfer/eu-processing` | note | Processing within the EEA. A processor agreement is still required under Article 28 |
| `transfer/unknown-vendor-egress` | note | Host or package matched no knowledge base entry. A coverage gap, not a claim about the vendor |
| `transfer/unresolved-egress` | note | An outbound call whose destination is supplied at runtime. The variable is named; the host is never guessed |
| `kb/stale-entry` | note | The matched entry has not been re-verified recently |
| `config/expired-suppression` | note | A suppression passed its expiry date and its finding is active again |

**Nothing defaults to `error`.** The tool detects; it does not adjudicate. CI failure is expressed
through `--fail-on`, which the user opts into.

## How the rating is derived

Country-level adequacy decisions cover every recipient in that country. The EU-US Data Privacy
Framework does not — it covers only organisations that self-certified and appear on the DPF list.
So a US vendor is treated as covered only when its entry records `dpfCertified: true` from a primary
source. This is why two US vendors in the same repository can carry different rules.

`exposure.inputs` records the exact fact tuple behind any rating, including `dpfCertified:true|false`.
