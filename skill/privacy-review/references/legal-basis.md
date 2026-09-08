# Legal basis for each check

The provision each specialist may cite, the primary source, and the enforcement record where one
exists. **Cite only from this file.** If a finding needs a provision that is not here, say the
provision is outside what this review is set up to cite, and describe the pattern without a legal
label.

The reason for the constraint: privacy enforcement figures circulate in secondary sources with
mutations, and three claims that are widely repeated online turned out to be wrong when checked
against the authority's own decision page. Those three are recorded at the bottom of this file so
they cannot re-enter through a future edit.

## Citing an instrument rather than a decision

Most sections below cite an enforcement decision, because that is the stronger evidence. But a
finding often needs to cite only the provision itself. Use these, and do not leave `citation` empty
merely because no decision applies:

| Instrument | Citation URL |
|---|---|
| GDPR — Regulation (EU) 2016/679 | https://eur-lex.europa.eu/eli/reg/2016/679/oj |
| ePrivacy Directive 2002/58/EC | https://eur-lex.europa.eu/eli/dir/2002/58/oj |
| Directive 2009/136/EC, which amended Art 5(3) | https://eur-lex.europa.eu/eli/dir/2009/136/oj |
| EDPB Guidelines 2/2023, technical scope of Art 5(3) | https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf |
| CPRA regulations, Cal. Code Regs. tit. 11 § 7025 | https://law.cornell.edu/regulations/california/11-CCR-7025 |
| California Invasion of Privacy Act, Cal. Penal Code § 631 | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=631 |

Cite the instrument for the provision, and the decision when you are describing what an authority
actually did about it. Never cite a decision as though it were the text of the law.

## Consent before storage or access — the strongest ground

**Provision.** ePrivacy Directive 2002/58/EC Art 5(3), as amended by Directive 2009/136/EC. Storing
information on, or gaining access to information already stored on, a user's terminal equipment
requires prior consent — with a **strict-necessity exemption in the provision itself**.

**Scope.** EDPB Guidelines 2/2023 on the technical scope of Art 5(3), v2.0, adopted 7 October 2024:
https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf

Three cumulative criteria: the operation concerns *information* (broader than personal data), it
involves the user's terminal equipment, and it constitutes storage or gaining access. On that
basis the EDPB confirms the article reaches **tracking pixels** (the instruction to the terminal to
send back an identifier is itself gaining access), **local storage** where information is processed
locally then transmitted, **IP-based tracking** where the address singles out the terminal, and
**device fingerprinting**.

This is why the article bites on `localStorage` and on a 1x1 pixel, not only on cookies.

**The exemption is the part that matters for precision.** Storage strictly necessary to provide a
service the user explicitly requested does not require consent. A session cookie, a CSRF token, a
load-balancer affinity cookie and a language preference the user set are ordinarily exempt. A
finding that treats those as consent-requiring is wrong on the face of the provision.

**Enforcement.**
- CNIL fined Google €325,000,000 on 1 September 2025, in part for placing advertising cookies
  before consent: https://www.cnil.fr/en/cookies-and-advertisements-inserted-between-emails-google-fined-325-million-euros-cnil
- CNIL's 2025 record: 21 cookie sanctions totalling over €475,000,000, including €150,000,000
  against Shein: https://www.cnil.fr/en/sanctions-and-corrective-measures-cnils-actions-2025
- The Google Analytics decisions (Austrian DSB 13 January 2022, then CNIL, Garante and
  Datatilsynet) turned on Chapter V transfers rather than consent, though an analytics script
  running regardless of consent is what triggered them:
  https://noyb.eu/en/austrian-dsb-eu-us-data-transfers-google-analytics-illegal

**Weight.** Highest of any check here. Most fined, most litigated, and the most literal code
pattern of the set.

## Personal data in logs and telemetry

**Provision.** No logging-specific article. GDPR Art 5(1)(f) (integrity and confidentiality) and
Art 32 (security of processing). Credentials in plaintext are treated as a security-measures
failure.

**Enforcement.** Irish DPC fined Meta €91,000,000 on 27 September 2024 after hundreds of millions
of Facebook and Instagram passwords were stored in plaintext and readable internally. Findings
under Art 33(1), 33(5) and Art 5(1)(f)/32:
https://www.dataprotection.ie/en/news-media/press-releases/DPC-announces-91-million-fine-of-Meta

**Weight.** High, and the detection is well understood — this is secret scanning plus field-name
matching on logging sinks.

## Opt-out preference signals

**Provision.** California: Cal. Civ. Code § 1798.120 with Cal. Code Regs. tit. 11 § 7025, which
requires a business that sells or shares personal information to honour an opt-out preference
signal. Global Privacy Control is the signal in practice. Since 1 January 2026, § 7025(c)(6) also
requires the site to show the user that the signal was recognised.
https://law.cornell.edu/regulations/california/11-CCR-7025

Colorado: the Colorado Privacy Act requires recognising a universal opt-out mechanism from
1 July 2024, and the Colorado Attorney General designated Global Privacy Control specifically.
Connecticut requires a qualifying mechanism but does not name GPC in statute.

**Enforcement.** California AG settled with Sephora for $1,200,000 on 24 August 2022 — the first
CCPA civil penalty, expressly for failing to process GPC opt-outs:
https://oag.ca.gov/news/press-releases/attorney-general-bonta-announces-settlement-sephora-part-ongoing-enforcement

California, Colorado and Connecticut ran a joint investigative sweep on GPC handling in 2025-26.

**Weight.** Medium-high, and unique in this file: these are the only provisions that demand a
machine-readable signal be read and acted on, which is why the check is clean.

## Session replay and input capture

**Provision.** In the EU, Art 5(3) ePrivacy as above, plus Art 6 and Art 9 where a recorded form
field captures special-category data. In the United States the litigation runs under the California
Invasion of Privacy Act, Cal. Penal Code § 631, as private class actions rather than regulator
enforcement.

**State of the US litigation, which is contested and moving.** *Javier v. Assurance IQ*, 9th Cir.,
31 May 2022, revived session-replay CIPA claims by holding that consent obtained *after* recording
began does not satisfy the statute's prior-consent requirement:
https://cdn.ca9.uscourts.gov/datastore/memoranda/2022/05/31/21-16351.pdf

Then *Torres v. Prudential Financial*, N.D. Cal., 17 April 2025, granted summary judgment for the
defendant, holding session-replay tools do not read communications "in transit" because keystroke
and mouse events are not readable content until stored and reassembled:
https://www.insideprivacy.com/data-privacy/court-grants-summary-judgment-website-vendor-cannot-read-session-replay-data-in-transit-under-cipa/

**Say it is unsettled.** The session-replay theory weakened after *Torres*; the newer front is chat
widgets. Never tell a user their session replay setup loses a CIPA motion — that turns on consent
timing and buffering facts not visible in client source.

**Weight.** The *pattern* is cleanly detectable. Its legal consequence is not settled. Report the
configuration fact; cite the dispute; predict nothing.

## Default settings

**Provision.** GDPR Art 25(2): by default, only personal data necessary for each specific purpose
is processed, without the individual having to intervene. Covers the amount collected, the extent
of processing, the storage period and accessibility.

**Enforcement.** Irish DPC fined Meta €265,000,000 on 25 November 2022 under Art 25(1) and 25(2)
over contact-import tools that could be abused to compile a dataset of more than 500 million
users: https://www.dataprotection.ie/en/dpc-guidance/decisions/inquiry-concerning-meta-dataset-november-2022

Quebec's Law 25 is the strictest analogue in North America: tracking technologies must default to
off.

**Weight.** Medium, and deliberately narrow. Only the **default value** is checkable — a marketing,
sharing or tracking field whose default is on. General data minimisation is not checkable and is on
the do-not-build list below.

## Storage limitation

**Provision.** GDPR Art 5(1)(e): kept no longer than necessary for the purpose. No prescribed
period. The controller must define, document and actually enforce a schedule.

**Enforcement.**
- Berlin DPA fined Deutsche Wohnen €14,500,000 on 30 October 2019 — the leading case tying
  retention failure to the *absence of a technical means to delete*, cited under Art 5 and Art
  25(1): https://www.edpb.europa.eu/news/national-news/2019/berlin-commissioner-data-protection-imposes-fine-real-estate-company_en
  **Cite it with the caveat:** a German court later set the fine aside on a procedural ground about
  whether it could be imposed on the legal entity directly. The substantive retention and design
  findings were not what was overturned. State both halves or neither.
- CNIL sanctioned Free Mobile and Free on 13 January 2026, €27,000,000 and €15,000,000, citing
  Art 5(1)(e) over records of former subscribers including IBANs kept with no purge process:
  https://www.cnil.fr/fr/sanction-free-2026
- The EDPB's Coordinated Enforcement Framework report on the right to erasure, published
  February 2026, covering 32 authorities and 764 controllers, found inconsistent retention periods
  and undefined approaches to backup erasure among the most common gaps:
  https://www.edpb.europa.eu/news/news/2026/edpb-identifies-challenges-hindering-full-implementation-right-erasure_en

**Weight.** High as law, weak as a code signal. See `specialists/retention.md` for the three
signals that survive and the long list that does not.

## Erasure

**Provision.** GDPR Art 17, subject to the Art 17(3) exemptions.

**Position on backups.** Authorities generally tolerate putting backup data beyond use rather than
purging it immediately, provided restoration is actually restricted in the interim. That is a
tolerance, not an exemption.

**No named sanction was found** for erasure failing to propagate to backups specifically. The
February 2026 EDPB report is a coordinated investigation, not a sanction. Do not imply a fine
exists here.

## Do not build these

Both come from the research and both would generate confident, wrong accusations.

1. **Erasure not propagating to backups, logs, warehouses or sub-processors.** Requires runtime,
   cross-service data-flow tracing that no single repository represents. Deletion may legitimately
   happen in another service, through a vendor API, or by backup expiry configured outside the
   repo. Nothing stronger than an informational "no in-repo deletion job was found for X" is
   defensible, and it must never be phrased as erasure failing to reach backups.
2. **General data minimisation under Art 5(1)(c), and privacy by design under Art 25(1).** Whether
   a column or a form field is necessary is a judgment against a purpose statement that does not
   exist in source. Every real enforcement action here turned on facts a scanner cannot see: what a
   manager typed in a free-text note, what abuse pattern emerged in production, what a form asked a
   person. The only defensible slice is the Art 25(2) default-value check above.

## Claims that did not survive checking — never cite these

Recorded because each is repeated confidently in secondary sources.

| Circulating claim | What checking found |
|---|---|
| CNIL SAN-2023-025, €600,000 against SAF Logistics for 7-year retention with no automated deletion | No such decision. The real one is SAN-2023-013, 18 September 2023, €200,000, and it is a **data minimisation** case about excessive employee-form fields, not retention: https://www.cnil.fr/fr/collecte-excessive-de-donnees-et-manque-de-cooperation-la-cnil-sanctionne-la-societe-saf-logistics |
| Twitter was fined under the GDPR for logging passwords in plaintext | Not found. The Irish DPC's €450,000 Twitter fine of December 2020 was for a different defect exposing protected tweets, under Art 33(1) and 33(5): https://www.edpb.europa.eu/news/national-news/2020/irish-data-protection-commission-announces-decision-twitter-inquiry_en |
| A May 2026 California ruling held CIPA reaches only telephone communications | No case name or docket located. Cite *Torres v. Prudential* instead |
| Brazil's ANPD has issued cookie-tracking fines of a specific amount | Not confirmed against any ANPD decision. Only the general LGPD opt-in requirement is solidly sourced |
| A Swedish pharmacy was fined roughly €700,000 over Meta Pixel transmitting health data | Plausible but the IMY decision text was not located. Do not quote the figure |

## When a user asks about the risk to them specifically

Give the decision, the authority, the date and the amount, and then say who it was against. Every
figure in this file is against a very large organisation. A €325,000,000 fine against Google is not
evidence about what happens to a four-person startup, and presenting it as though it were is
fear-selling. Where the honest sentence is "authorities act on this pattern, but the published
cases are all against large organisations", write that sentence.
