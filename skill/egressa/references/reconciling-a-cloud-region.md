# Reconciling a declared region against a running account

A scan reads a repository. It can tell you that `main.tf` declares `eu-west-2`
and that an SDK client is constructed with `us-east-1`. It cannot tell you that
there is a bucket in `ap-southeast-1` that no file in the repository mentions.

That gap is the finding. A region a repository declares and a region an account
actually runs in are two different facts, and the interesting one is where they
disagree.

## When this applies, and when it does not

| Situation | Reconcile? |
|---|---|
| The scan reported regions and the user can read their own AWS account | **Yes.** That is the comparison this exists for. |
| The scan reported no regions and the user wants to know what is running | **Yes.** An empty declaration is a result, not a blocker. |
| The user has not asked, or has not opted in | **No.** |
| The account is not the user's, or is a customer's | **No. Never.** |
| A provider other than AWS | **Not yet.** Say so rather than approximating from a different CLI. |

The fourth row is the one to hold. This reads a live account, and reading
someone's infrastructure because it was reachable is not something a scanner
gets to decide on its own. Ask, and take silence as no.

## Before anything runs

Prefer the AWS MCP server when one is connected: it is sandboxed, observable
and audited, which a shell is not. Fall back to the CLI only when it is
unavailable, and say which one you used — a reader needs to know whether the
numbers came through an audited path.

Everything here is **read-only**. No call that creates, modifies, tags or
deletes, and no call whose purpose is to change state. If a question cannot be
answered by a read, it does not get answered.

## The procedure

```bash
EGRESSA_ALLOW_AWS=1 bash "${SKILL_DIR:?set SKILL_DIR to the skill base directory}/scripts/reconcile-aws.sh"   # SKILL_DIR: see SKILL.md
```

**1. Check that it ran at all.** Exit 3 means no CLI, 4 means not opted in, 5
means credentials did not resolve. In all three cases *nothing was read*, and
the correct report is that the reconciliation did not run. An account that was
never queried looks exactly like an account with nothing in it, and reporting
the second when you saw the first is the worst outcome available here.

**2. Read the gates, not conclusions.** The script emits `KEY: value` lines
between `AWS_PROTO: 1` and `AWS_END: ok`. A missing `AWS_END` means it died
part way and the list is partial — say so rather than treating a truncated
sweep as a complete one.

**3. Compare the two lists.** The regions in the scan, against
`AWS_RESOURCE_REGION` and `AWS_REGION_IN_USE`. Three outcomes, and all three
are worth reporting:

- **Running but not declared.** A region with resources that no configuration
  file mentions. This is the one nothing else reports, and the one most likely
  to be a surprise.
- **Declared but not running.** Configuration pointing somewhere with nothing
  in it. Often harmless — a region provisioned and never used, or a resource
  type the sweep does not see — so ask rather than report it as an error.
- **Both, and they agree.** Worth one line. A confirmed match is a real result
  and the user asked a question that deserves an answer either way.

**4. Resolve regions through the knowledge base, not from the identifier.**
`eu-west-2` is London and `eu-central-2` is Zurich; neither is in the EEA.
The script deliberately reports the region string and nothing else, and
`kb/vendors/aws.json` carries the map with its citation. If a region is not in
the map, say it is not in the map.

**5. Report what the sweep cannot see.** It reads S3 bucket locations and
tagged resources per enabled region. An untagged resource, a service the
tagging API does not cover, and a region the account has not enabled are all
invisible to it. A region that produced nothing is *not* evidence that nothing
is there.

## What this is not

It is not a scan, and its output is not a finding. `egressa scan` is offline,
reproducible and re-runnable by anyone with the repository; this is a snapshot
of one account at one moment, taken with one set of credentials. Label it as
such. Two readers running the scan get the same answer, and that is the
property being given up here.

It does not write to `kb/`. A region observed in an account is not a vendor
fact, and entries there are authored from vendor and regulator documentation
under `kb/PROVENANCE.md`.

And the claim scope is unchanged. Establishing that an account runs workloads
in a third country is a fact about that account. It is not a conclusion about
the user's position, it is not an assessment, and
`references/language-rules.md` governs the write-up exactly as it governs
everything else.
