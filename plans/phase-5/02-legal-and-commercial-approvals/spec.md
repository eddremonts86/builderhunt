# Legal and commercial approvals (spec)

> **Status**: `blocked` — every item needs a signature, a licensed opinion, or a commercial fact that
> does not exist yet
> **Depends on**: nothing in code. The engineering behind each item is complete and shipped disabled.
> **Blocks**: enabling public-profile enrichment, the interview/voice features, and the Solutions
> module for customers

## Why this plan exists

Created 2026-08-05, on the maintainer's instruction: *the product launches when phase-5 finishes, so
there is no point worrying about legal in phase-1.*

Four tasks sat in phase-1 waiting for a human to sign something or for a vendor to quote a price. None
of them is code, and none can be closed by writing any. Keeping them in the build phase had a specific
cost: it made phase-1 permanently unfinishable, and it put a legal review on the critical path of work
that has nothing to do with it — a storage adapter stalling on a countersignature.

They are gathered here so the answer to "what is left to build?" and the answer to "what is left to
approve?" stop being the same list.

## What belongs here

An item belongs in this plan when the missing input is a **judgement or a commitment**, not an
artifact:

- a legal review signed by a person, or a lawful-basis balancing test;
- a DPIA, which needs a data-protection advisor and cannot be produced by whoever wrote the code;
- a price a provider charges, which is a fact about the world;
- a quality bar set by human judgement, such as gold-standard records a model cannot author for itself
  without the exercise becoming circular.

It does **not** belong here if an engineer could close it by shipping something. That is the phase-1
rule and it has not changed.

## The shape every item shares

Each one already has its artifact drafted or its mechanism built, and stops one step short of the
approval:

- the enrichment privacy copy exists as a draft, deliberately not committed to the live page, because
  on this repository a commit to `master` deploys — writing legal copy into the route **is** publishing
  it;
- the interview provider register exists (MinIO, ClamAV, Deepgram, Mistral) with retention, residency,
  sub-processors and owners recorded; only the DPIA is outstanding, and the register's own "who does
  what" table already names its owner;
- the cost model and evaluator exist and have produced a dated baseline, marked provisional by its own
  first line because `MINIMAX_COST_PER_*` are documented placeholders;
- every scraping and AI surface ships behind a flag that is off.

So the risk this plan manages is not "will it work". It is "was it allowed", and that is the one
question an agent must never answer on its own behalf.

## Acceptance

- Every item carries a dated approval recorded in the artifact it names, attributable to a person.
- No flag this plan gates is enabled before its own item is approved.
- No approval is recorded by an agent. An agent may draft the document and prepare the evidence; the
  signature is the maintainer's, and a countersignature invented to close a checkbox is worse than an
  open one.
