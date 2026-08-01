# Solutions Intelligence — rollout

**Nothing here has been executed.** Every flag is off and no stage has started. This is the plan and the abort
criteria, written before the first switch is thrown so the thresholds are not negotiated during an incident.

## What the flags actually do

Each one is independent, and that independence is the rollout mechanism — there is no single "Solutions on"
switch, on purpose.

| Flag | Turning it on means |
| --- | --- |
| `SOLUTIONS_CATALOG_INGESTION_ENABLED` | Official-API and feed catalog ingestion runs |
| `SOLUTIONS_PUBLIC_SCRAPE_ENABLED` | Compliant public crawling runs, per-source toggles still apply |
| `SOLUTIONS_LIVE_ENRICHMENT_ENABLED` | Per-run freshness lookups, beyond the durable catalog |
| `SOLUTIONS_INTERPRETATION_ENABLED` | Briefs reach a model instead of the keyword fallback |
| `SOLUTIONS_EXPLANATION_ENABLED` | Route prose is model-written instead of the composer's |
| `SOLUTIONS_EXTERNAL_HUMAN_ENABLED` | Real external people appear as Human-lane candidates |
| `SOLUTIONS_PAID_GENERATION_ENABLED` | Credits are reserved and charged |

## Stages

### 0 — Preconditions (none of these are engineering tasks)

- [ ] Source register legal/privacy sign-off (`plans/phase-5/01-production-readiness-audit`)
- [ ] EU AI Act classification read — see `docs/operations/solutions-security-review.md` open item 2
- [ ] Real provider pricing provisioned, cost certification re-run and signed
      (`docs/operations/solutions-cost-certification.md`)
- [ ] At least a handful of human-authored gold-set records, so an evaluation run is citable
      (`docs/operations/solutions-evaluation.md`)

### 1 — Staff only, deterministic

Flags: catalog ingestion on, everything else off. Paid generation **off** — staff run the deterministic path,
which costs nothing and touches no provider.

- Watch: `solutions_composed` statuses, retrieval health, `solutions_retrieval` durations.
- Abort if: any route recommends a `human_role` component as a person, or p95 composition exceeds 2s.
- Window: one week of daily use by at least two people.

### 2 — Staff only, with the model

Add `SOLUTIONS_INTERPRETATION_ENABLED` and `SOLUTIONS_EXPLANATION_ENABLED`. Still no credits.

- Watch: `solutions_explain_ungrounded` and `solutions_interpret_fallback` rates — both are logged with a
  reason, and a high ungrounded rate means the prompt or the checks need work before anyone pays for this.
- Abort if: ungrounded explanations exceed 10% of routes, or any explanation reaches a user with a figure the
  composer did not produce (which would mean the check has a hole, not a threshold).
- Window: one week, plus an evaluation run with both flags on compared against the deterministic baseline.

### 3 — Closed beta, operator-granted credits

Turn on `SOLUTIONS_PAID_GENERATION_ENABLED` for a named set of organizations with promotional grants. No real
money changes hands, but the whole reservation path runs.

- Watch: `billing_credit_reservations` for `reserved` rows older than the grace window (a leaked hold), the
  settled-versus-released ratio, and `solutions_credits_released_unusable`.
- Abort if: any reservation is charged for a run with no offerable route, or a duplicate request produces two
  settlements.
- Window: two weeks or 100 runs, whichever is longer.

### 4 — Paid beta

Same flags, real balances, open to any Pro organization.

- Watch: margin against the certification's break-even multiple; feedback `chosen` rates by lane; support
  volume mentioning charges.
- Abort if: provider cost exceeds 20% of credits charged on any day (the certification's worst case is ~4%), or
  more than 2% of runs are disputed.
- Window: one month.

### 5 — General availability

No flag change beyond removing the organization allowlist.

## Rollback

Disabling `SOLUTIONS_PAID_GENERATION_ENABLED` stops new paid operations immediately and **preserves everything
already stored**: saved briefs and runs stay readable, historical settlements stay settled, and no reservation
is retroactively touched. That property is what makes the rollback safe to use without deliberation — it is not
a data decision.

Ordinary builder search shares the retrieval foundations but not the flags, so no Solutions rollback affects it.
The one shared piece is `builder_embeddings`; if a rollback ever needs to touch it, that is a search incident,
not a Solutions one.

## Escalation

| Situation | Owner | First action |
| --- | --- | --- |
| Ungrounded explanation reaching users | Whoever is on call | `SOLUTIONS_EXPLANATION_ENABLED=false` |
| A source's data is wrong or unlicensed | On call | Per-source toggle off, then delete its components |
| Credits charged for an unusable result | On call, then billing owner | Refund through the billing platform's refund path — never by editing a reservation |
| Suspected tenant crossover | P1, wake someone | Capture the query, check `app.organization_id`; see the security review's runbook |
| Provider outage | Nobody | Both AI paths already fall back deterministically and the credit boundary releases on failure |

## What a maintainer has to decide, not this document

Which organizations are in stage 3, when a window has been observed long enough, and whether the abort
thresholds above are the right ones for this business. They are engineering's best guess at where "something is
wrong" starts.
