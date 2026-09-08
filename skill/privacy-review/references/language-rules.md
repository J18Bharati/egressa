# Language rules for the privacy review

Load this before writing any finding, any summary, or any reply to a developer who disagrees
with a finding. This is the only file in this skill permitted to quote the forbidden words.

## What this review is entitled to say

It reports **patterns present in source code**, the **provision each pattern engages**, and the
**question a human must answer** to know whether anything is wrong. It does not assess or certify
GDPR compliance, and it never concludes that law was broken.

The reason is not modesty. Lawfulness under the GDPR turns on facts that are nowhere in a
repository: the controller's legal basis, what the data subject was actually shown and when, the
retention schedule, the records of processing, the contracts with each processor, and whether the
processing is even in scope. A tool that reads code and announces a breach is asserting things it
cannot see. It is also, in this category specifically, asserting them in a market where a funded
competitor was expelled from an accelerator over fabricated compliance evidence. Precision here
is the product.

## Never write

| Forbidden | Why | Say instead |
|---|---|---|
| "This is a violation" / "this violates Art 5" | Lawfulness is not determinable from a code reference | "This pattern engages Art 5(1)(e). Whether it is lawful depends on the retention schedule, which is not in the code" |
| "This is illegal" / "unlawful" | Same | "A lawful basis and a defined retention period would be required for this to be in order" |
| "You are GDPR compliant" / "fully compliant" | Compliance is a conclusion about an organisation, not a property of a file | "The checks that ran found no instances of the patterns they look for" |
| "This is non-compliant" | Same in the other direction, and worse — it is an accusation | "This is the pattern regulators have acted on in the decisions cited. Here is what to check" |
| "You are audit-ready" | Not a claim any static tool can support | Say nothing of the kind |
| "This guarantees consent is collected" | Nothing here guarantees anything | "This records that a consent check precedes the call in this file" |
| "Personal data is being sent to X" | Static analysis sees a reference, not traffic | "This code path references X. Confirm the path is live and what it carries" |
| "You must delete this data" | Legal advice, and probably wrong | "Art 17 would require this to be reachable by a deletion path. I could not find one" |
| "Fined up to 4% of turnover" | Fear-selling, and the arithmetic is almost never real at this scale | Cite the actual decision, its authority, its date and its amount, or cite nothing |

## What counts as code under review

A pattern has to be able to *run* against a real person before it is a finding. Several kinds of file
contain the exact text a checklist looks for and are not findings, and the distinction is not
cosmetic — a repository that writes about privacy patterns will match every detector aimed at them.

Not findings:

- **Documentation and prose.** A guide, a changelog, a README or a checklist that shows
  `fbq('init', ...)` in a code fence is describing the pattern, not executing it.
- **Reference data.** A knowledge base entry recording that a vendor's product category is session
  recording is a sourced fact about that vendor. It says nothing about the reviewed project.
- **Test fixtures and golden cases.** A snippet that exists so a test can assert an analyzer's
  behaviour has no data subject. The same goes for seeds, examples and demos.
- **A detector's own pattern list.** A tool that searches for `document.cookie` necessarily contains
  the string `document.cookie`. Reporting it is the tool reviewing itself.

Findings, despite looking similar:

- A fixture, seed or demo that **ships to production** or runs against a real database. "Fixture" is
  a claim about intent; check where it actually runs.
- A documentation **site** that loads a real tracker to measure its own traffic. Docs are prose; a
  docs app is an app.
- A test that sends real personal data to a live third-party endpoint rather than a stub.

When you cannot tell which side a file falls on, open it and decide from what it does, not from the
directory it sits in. If it is still unclear, that is a `config` finding with a question — not a
silent skip, and not a `code` finding.

## Distinctions to preserve

- **Engages a provision vs. breaches it.** A cookie set before a consent check *engages* Art 5(3)
  ePrivacy. Whether it breaches it depends on whether the cookie is strictly necessary for a
  service the user requested — an exemption in the provision itself, which the code may well
  satisfy. Report the engagement; ask the exemption question.
- **Reference vs. execution.** An import is not a data flow. A resolved call site is not proof the
  branch runs. Say which you have.
- **Detected vs. exists.** Every clean result means the checks that ran found nothing. Name what
  was not checked. Server-side collection, anything behind an env var, anything in a
  language the analysis does not read, and anything a human configured in a vendor dashboard are
  all invisible here.
- **Default vs. configured.** "LogRocket's default masks nothing" is a fact about the library.
  "This project masks nothing" requires reading this project's config. These are different
  sentences and the second one is the one that matters.
- **The vendor's documentation vs. the account's reality.** A vendor offering an EU region tells
  you nothing about which region this account uses. Only the developer can answer that.
- **Fact vs. rating.** "Art 5(1)(e) requires a defined period" is the provision. "severity: high"
  is this tool's own rule table. Attribute each accordingly.

## Citing law

Cite the instrument and the article, and link a primary source: the instrument's own text, a
regulator's published guidance, or a published decision. Never a compliance vendor's summary
page, never a blog post, never a law-firm marketing article.

When citing an enforcement decision, give authority, date and amount. A decision against a
120,000-employee bank is not evidence about a four-person startup, and presenting it as though
it were is the fear-selling this project exists in opposition to. If the honest position is
"regulators have acted on this pattern, but the published cases are all against large
organisations", write that sentence.

Where the law is unsettled — and several of the checks here sit on unsettled ground, notably
session replay under US interception statutes — say it is unsettled and name what is contested.
Do not resolve a live legal dispute in a code comment.

## Talking to a developer who pushes back

If a developer says a finding is wrong, they are usually right about the facts of their own
system, because they can see the deployment and this review cannot. Take the correction, record
it as a suppression with their reason and their name, and move on. Do not re-argue a `config`
finding — by its own classification the code could not settle it.
