# Solutions Intelligence — cost certification

**Status: provisional, not signed.** Every figure below is computed from *declared* token budgets and the
*placeholder* provider pricing in `env.ts`. That is enough to show the fixed prices are not obviously
mispriced, and enough to fail loudly if a future change makes them so. It is not enough to sign a
certification, and plan 43's spec.md blocks launch on exactly that: "Public launch is blocked until the billing
platform is certified and a provider-cost benchmark validates the rate card." What is still missing is listed
under [Before this can be signed](#before-this-can-be-signed).

Last recomputed: 2026-08-01, against migration 0136 and rate-card version 1.

## What is charged

From spec.md's premium contract, and registered in `src/shared/lib/billing/rate-cards.ts`:

| Operation | Registry key | Price | Charged when |
| --- | --- | --- | --- |
| `solutions.generate.v1` | `solutions_generate` | **10 credits** | a usable result was produced |
| `solutions.regenerate.v1` | `solutions_regenerate` | **3 credits** | a usable result was produced **and** a provider ran |

These are prices, not ceilings. The credit boundary
(`src/modules/solutions/server/billing.ts`) meters no provider usage at all: it asks the run two questions —
was the result usable, did any provider run — and settles the fixed figure or releases the hold. A user is shown
that exact number and confirms it before anything is reserved.

An earlier draft of the rate cards read 12 and 5 and metered provider units against them. That would have
charged two users different amounts for the same product because one brief needed a clarification round, and it
would have made the confirmation prompt quote a maximum where spec.md promises a price.

Local view, filter, compare, reorder, and save cost nothing and never reach this boundary.

## What a run can cost us

A generate run is four stages, and only two of them touch a provider:

| Stage | Provider calls | Why |
| --- | --- | --- |
| Interpret the brief | 1, or 2 with one clarification round | spec.md requires clarification to stay *inside* the reservation |
| Retrieve | 0 | two SQL lanes over `builder_embeddings` and the catalog projections |
| Compose | 0 | `src/lib/solutions/composer/*` is pure arithmetic |
| Explain each offered route | up to 3 | `composeRoutes` returns exactly the AI, human, and hybrid lanes |

So five calls is the ceiling the code can emit, not an estimate of typical use — there is no path that produces
a fourth route or a second clarification round. A regenerate carries no interpretation: it reuses the stored
interpretation and retrieval and only re-explains.

### Declared per-call budgets

From `src/shared/lib/solutions/cost-model.ts`. Phase 7 must register these same output ceilings as the AI tasks'
`maxOutputTokens`; they live in one module so a prompt change cannot quietly double the cost of an operation
whose price is already fixed and already confirmed by users.

| Call | Max input tokens | Max output tokens | Cost per attempt | Worst case per call |
| --- | --- | --- | --- | --- |
| Interpret brief | 3,000 | 900 | 0.198¢ | 0.396¢ |
| Explain route | 2,500 | 600 | 0.147¢ | 0.294¢ |

Placeholder pricing is `MINIMAX_COST_PER_1K_INPUT_TOKENS_CENTS = 0.03` and
`MINIMAX_COST_PER_1K_OUTPUT_TOKENS_CENTS = 0.12`. `env.ts` documents both as rough order-of-magnitude
stand-ins, not confirmed MiniMax figures.

**One call is up to two billed requests.** `minimaxChat` retries once with a JSON-correction turn when the
first answer does not parse or validate, re-sending the whole prompt and allowing the whole output budget
again. The first version of this model counted logical calls and understated every figure below by exactly
half. The factor lives in `PROVIDER_ATTEMPTS_PER_CALL`, because it belongs to the client's retry policy rather
than to the budgets — a change there changes the cost of every operation.

Registered in `ai/tasks.ts` as `solutions-brief-interpret` (`maxOutputTokens: 900`) and
`solutions-route-explain` (`maxOutputTokens: 600`); a test asserts the registry and this table agree, so a
prompt change cannot quietly raise the cost of an operation whose price is already fixed.

## The per-scenario arithmetic

Revenue uses the **cheapest** credit anyone can buy — `scale_1000`, 1,000 credits for $45, so 4.5¢ each. An
organization spending its cheapest credits is the one the margin has to survive; certifying against the dearest
pack would certify a price nobody pays. Included plan credits are all dearer per credit (annual Team is the
closest, at 7.6¢), which the fixture asserts rather than assumes.

Every figure assumes the worst case twice over: every call uses its entire token budget, and every call needs
its correction retry.

| Scenario | Calls | Provider cost | Charged | Cost / revenue | Break-even multiple |
| --- | --- | --- | --- | --- | --- |
| Generate, both LLM flags off | 0 | 0¢ | 45¢ | 0 | unbounded |
| Generate, typical | 1 interpret + 2 explain | 0.984¢ | 45¢ | 0.022 | 46× |
| **Generate, worst case** | 2 interpret + 3 explain | **1.674¢** | **45¢** | **0.037** | **27×** |
| **Regenerate, worst case** | 3 explain | **0.882¢** | **13.5¢** | **0.065** | **15×** |
| Regenerate, no provider | 0 | 0¢ | 0¢ | — | — |

The break-even multiple is the number worth reading. The absolute cents are only as good as the placeholder
constants; the multiple says how wrong those constants can be before the conclusion changes. Provider prices
would have to rise about **15×** before the worst regenerate stops paying for itself, and about **27×** for
generate.

Recomputed by `tests/unit/shared/lib/solutions/cost-model.test.ts` on every run, including a case that drives
the same arithmetic past the point where it refuses — a test that can only pass is not evidence.

### Where the margin actually is

The headroom is enormous, and that is a finding rather than a reassurance: it says the credit price was set for a
much more expensive product. `interview_live_transcription` bills a credit per provider-billed minute, where a
credit maps to real per-minute vendor cost; a bounded text completion does not come close. Two consequences:

- The 10-credit price is a **product** decision — what solution advice is worth — not a cost-recovery
  calculation. This document can only certify that the cost does not exceed it.
- `CREDIT_MARGIN_ALERT_RATIO` (default 1) will never fire for these operations at these budgets. It is not the
  monitor that would catch a Solutions cost problem; a budget regression test is.

## Release, refund, and reconciliation rules

| Situation | Reservation ends as | Why |
| --- | --- | --- |
| Usable result | `settled` at the full price | what the user confirmed |
| No usable result (every route unavailable) | `released` | a completed computation that delivers no advice is not the product |
| The run threw | `released` | nothing was delivered |
| Regenerate that invoked no provider | `settled` at **0** | the user got a fresh answer; it cost nothing to serve |
| Run exceeded `maxDurationSeconds` | expired by the platform | a merely slow run must not be charged |
| Caller let the error escape its transaction | no row at all | the reservation rolls back with everything else |

The three terminal shapes are deliberately distinguishable: `settled` with the price, `settled` with zero, and
`released`. A reconciliation job that could not tell a free rerun from an abandoned run would have no way to
find genuine leaks. `settled`-with-zero is why a provider-free regenerate settles instead of releasing.

No usage refund path is defined for Solutions. `refundUsage` requires provider-side evidence and exists for
metered operations; a fixed-price operation that failed releases instead, before it ever settles.

## Historical runs keep their original price

`billing_credit_reservations.rate_card_version` records which version governed each reservation, and nothing
rewrites a settled row. A future price change therefore cannot reinterpret history: a run settled under version
1 keeps reporting 10 credits at version 1 after the card moves to version 2.

`getSolutionsRateCardKey` reads the registry on every call rather than snapshotting it at module load — a
snapshot would have let two servers mid-deploy quote different prices for the same operation, with the
reservation recording whichever version the process that served it happened to hold.

Both properties are asserted against a real disposable Postgres in
`tests/unit/modules/solutions/billing.test.ts` ("resolves a historical run against its own rate-card version
after a price change").

## Before this can be signed

1. **Real provider pricing.** Replace the placeholder `MINIMAX_COST_PER_*` constants with confirmed figures and
   recompute this table. Until then no number here is an actual cost.
2. **A measured benchmark, not a budget ceiling.** These figures assume every call uses its entire token budget.
   Real distributions are what spec.md means by "a provider-cost benchmark validates the rate card" — run the
   60-brief suite from Phase 9 with usage capture and record p50/p95 alongside the worst case.
3. **A billing reconciliation run** against the exact release configuration, per Phase 9's "Pass quality,
   performance, and cost gates".

Closed since the first draft: the registered budgets. `solutions-brief-interpret` and `solutions-route-explain`
now exist in `ai/tasks.ts`, and `tests/unit/lib/solutions/ai-tasks.test.ts` asserts their `maxOutputTokens`
equals `SOLUTIONS_CALL_BUDGETS` — without that, this arithmetic described budgets nothing enforced.
