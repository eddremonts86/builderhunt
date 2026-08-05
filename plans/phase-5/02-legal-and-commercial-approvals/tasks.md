# Legal and commercial approvals (tasks)

> **Status**: `blocked` — every task needs a person's judgement or a vendor's price
> **Depends on**: nothing in code
> **Blocks**: enrichment in production, the interview/voice features, the Solutions module
> **Provenance**: all four moved verbatim from phase-1 on 2026-08-05, on Edd's instruction — *the
> product launches when phase-5 finishes, so there is no point worrying about legal in phase-1.* The
> engineering behind each is complete; every artifact named below already exists.

An agent walking this file **skips every task, leaves the box unchecked, and reports it**. It may
improve a draft. It may not record an approval — see each `Operator:` line.

## Legal

- [ ] **Update legal and product copy for public-profile enrichment**
  - Files: `src/routes/_landing/legal/privacy.tsx`, `src/routes/_landing/legal/terms.tsx`,
    `src/routes/_landing/crawler.tsx`, `README.md`, `src/shared/lib/legal-versions.ts` (only if the
    approved review requires a consent-version bump),
    `docs/operations/public-enrichment-source-register.md`
  - Do: State on the privacy page the categories collected, the purpose, the lawful basis, the source,
    the retention period, the data-subject rights and the contact route. Publish the crawler page naming
    the exact user agent and how to request exclusion. Correct any README or product claim that implies
    more than public-data collection. Use the precise public-data wording from the approved review —
    never "stealth", evasion, or guaranteed access.
  - Verify: every legal page renders and its links resolve
    (`pnpm exec playwright test tests/e2e/public-content.spec.ts` covers the legal surface); the crawler
    page is reachable anonymously; and the written approval is recorded in
    `docs/operations/public-enrichment-source-register.md`.
  - Operator: the wording needs a legal review signed off by a person. An agent may draft it but must
    not record the approval.
  - **The draft is paste-ready**: `docs/operations/public-enrichment-privacy-copy-draft.md` (2026-08-05).
    It is a doc rather than an edit to the route on purpose — on this repository a commit to `master`
    deploys, so writing legal copy into the page **is** publishing it, and this task requires a signed
    human review first.
  - **The gap it fills is real, not cosmetic.** `/legal/privacy` §1 lists seven categories — account,
    workspace, claim, usage, device, interview, cookies — and every one is about a *user*. Nothing
    discloses the public developer profiles the product indexes, which are personal data belonging to
    people who never signed up and mostly do not know the product exists. That is the category a
    supervisory authority looks at first. `/crawler` covers it well already, but not in the document that
    carries legal weight. Two smaller findings are recorded in the draft: the policy has duplicate
    section numbers (two 9s, two 10s, so citing "section 9" is ambiguous), and the copy must stay
    tense-honest while `ENRICHMENT_ENABLED` is `false` — it describes a capability that is built and
    disabled.
  - **Still the maintainer's**: the legitimate-interests balancing test, whether to commit publicly to
    the 180/30-day retention numbers, and recording the approval in the source register.
  - Moved from `plans/phase-1/42-stealth-scraping` on 2026-08-05. It is the only item on this plan on
    the critical path out of Beta: it gates `ENRICHMENT_ENABLED`, which gates the seven-day canary in
    [`01-production-readiness-audit`](../01-production-readiness-audit/tasks.md).

- [ ] **Complete the interview DPIA and close the provider register**
  - Files: `docs/operations/interview-provider-register.md`,
    `docs/architecture/data-classification.md`, `docs/architecture/threat-model.md`
  - Do: Complete a DPIA before production voice enablement. Confirm each provider's regional endpoint
    from a test response or console, and that every provider can be disabled independently. Reference
    the billing platform's independent Stripe provider register; do not duplicate it. Store no secret
    values.
  - Verify: the DPIA exists, is dated, and names its author; the register records residency, retention,
    training opt-out, deletion, sub-processors, account owner and annual review date per provider; and
    each provider's independent kill switch is demonstrated.
  - Operator: the DPIA needs a data-protection advisor. The register's own "who does what" table already
    names its owner as the maintainer plus that advisor, which is why engineering cannot close it.
  - **Both halves of the original Verify line are already met** (reconciled 2026-08-04): the register
    exists — 38 KB, covering MinIO, ClamAV, Deepgram and Mistral with retention, residency,
    sub-processors and owners. Only the DPIA is outstanding.
  - **The provider set is not what the original task text said.** Storage is **MinIO, self-hosted**, not
    Cloudflare R2 (commit `cb642d5`). Sensitive AI is **Mistral (La Plateforme)**, not Azure: Azure was
    provisioned, hit a zero-quota wall, and was found to have a residency hole `env.ts` structurally
    cannot close — it validates the resource region but cannot see the *deployment type*, so a Global
    Standard deployment passes validation while processing outside the EU. Mistral processes in the EU by
    default, which is not a switch anyone can set wrong. The Azure resource is retained as a documented
    fallback.
  - **The reviewer signature is deliberately not part of this Verify line** (product-owner decision
    2026-07-28). It is a general-availability gate, recorded as such in the register's "Gates general
    availability only" table. A countersignature on an artifact does not change what the software does.
  - Moved from `plans/phase-1/44-calendar-scheduling-interview-intelligence` Phase 0 on 2026-08-05.

## Commercial facts

- [ ] **Verify interview unit economics in test and limited live mode**
  - Files: `docs/operations/interview-runtime-verification.md`,
    `plans/phase-1/44-calendar-scheduling-interview-intelligence/spec.md`
  - Do: Run representative 30/60/90-minute sessions and brief/report workloads; capture billed Deepgram
    minutes, sensitive-AI tokens, Stripe fees, object-storage bytes/operations, internal credits, revenue
    and gross margin. Adjust the configurable catalog before public launch; do not rewrite ledger
    history.
  - Verify: no uncovered provider session, ledger/provider variance below 1%, no negative-margin pack at
    the approved cost budget, and finance sign-off recorded in
    `docs/operations/interview-runtime-verification.md`.
  - Operator: needs real billed provider usage and a finance sign-off. Both are facts about money that
    an agent cannot produce, and a margin computed against placeholder cost constants is a number with a
    decimal point and no content.
  - Moved from `plans/phase-1/44-calendar-scheduling-interview-intelligence` Phase 12 on 2026-08-05.

- [ ] **Pass the Solutions quality, performance and cost gates**
  - Files: `docs/operations/solutions-evaluation.md`, `docs/operations/solutions-cost-certification.md`
  - Do: Execute the 60-brief suite, warm/cold load tests, source-outage drills, provider variance, and
    billing reconciliation against the exact release configuration.
  - Verify: every acceptance threshold in `plans/phase-1/43-solutions-intelligence/spec.md` passes with
    dated artifacts, and `citableAsQualityGate` is true because `solution_gold_briefs` holds
    human-authored records.
  - Operator: four missing inputs, none of them code. Real provider pricing (the `MINIMAX_COST_PER_*`
    constants are documented placeholders, so the cost certification is provisional by its own first
    line). Human-authored gold judgements. Warm/cold load tests and source-outage drills against the
    release configuration. And provider variance — the same brief run repeatedly against a live model.
  - **The evaluator, the corpus and the cost model all exist** and have produced a dated baseline
    (`docs/operations/solutions-evaluation.md`, 2026-08-01). Checking this box on the strength of a
    synthetic baseline is precisely the failure the authorship split exists to prevent: the same model
    cannot both answer and grade.
  - Moved from `plans/phase-1/43-solutions-intelligence` on 2026-08-05. That plan's own header says
    `Implementation authorized: no`, so this was never active work — it was a checklist for a future
    task, and a `- [ ]` in phase-1 read as pending engineering to everyone walking the file.
