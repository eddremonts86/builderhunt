# Plan: Evidence-led conversion audit

> **Status**: `partially-implemented`
> **Depends on**: [`public-landing-pages`](../45-public-landing-pages/spec.md), [`legal-and-compliance`](../04-legal-and-compliance/spec.md)
> **Blocks**: nothing
> **Reality check**: Real screenshots, open signup, and guest `/explore` already ship in `src/modules/landing/components/HomePage.tsx`, `src/routes/auth/sign-up.tsx`, and `src/routes/_landing/explore/index.tsx`. The remaining work removes unsupported proof/dead capture UI, preserves guest intent, and adds consent-aware measurement before making an uplift claim.

## Delivery sequence

### Phase 1 — Lock truth and measurement contracts

1. Inventory every landing claim against real routes, source count, billing, and runtime behavior.
2. Define the closed event schema, eligible-session rules, metrics, minimum sample/time window,
   guardrails, retention, and experiment stop conditions in code and tests.
3. Update privacy/cookie disclosures before collecting any event.

Checkpoint: schema/metric tests pass; collection is still disabled in production.

### Phase 2 — Add data-minimized instrumentation

1. Add the `conversion_events` migration and a 30-day retention worker using the existing
   idempotent admin HTTP-cron pattern.
2. Add the rate-limited ingestion endpoint and client helper. Emit only after explicit analytics
   consent and never block navigation, signup, or explore on telemetry failure.
3. Add admin-only aggregate reporting with counts, rates, confidence intervals, and insufficient-
   sample states; do not expose raw session rows in UI.
4. Deploy instrumentation with every eligible session assigned `baseline`.

Checkpoint: production smoke demonstrates consent-on writes, essential-only zero writes,
idempotency, aggregate accuracy, and deletion of expired fixtures.

### Phase 3 — Establish baseline

Collect at least 14 full days and 1,000 eligible landing sessions. If traffic is lower, extend to
four weeks and label the baseline insufficient rather than inventing a rate. Freeze event semantics
during the measurement window.

Checkpoint: a dated baseline report records numerator, denominator, rate, 95% confidence interval,
consent eligibility, and known exclusions.

### Phase 4 — Ship the truthful treatment

1. Add hero `/explore` access while retaining one primary signup action.
2. Keep and optimize the real screenshots; correct stale or unsupported claims and structured data.
3. Remove the unverifiable testimonial and inert email capture; use only verifiable product proof.
4. Preserve the guest query through signup/onboarding to authenticated `/search`.
5. Add E2E coverage for baseline and treatment, accessibility, responsive layout, and performance
   guardrails.

Checkpoint: treatment passes CI and runtime smoke with collection disabled, baseline, and treatment
flags.

### Phase 5 — Controlled experiment and decision

1. Enable treatment for 10% of eligible sessions.
2. After 48 hours with no guardrail breach, raise to 50%; never change copy or event semantics during
   the run.
3. Run for at least two weeks and 1,000 eligible landing sessions per arm.
4. Ship the winner only if the predefined decision rule passes; otherwise report neutral,
   negative, or inconclusive and choose the simpler truthful experience.

Checkpoint: decision record contains raw counts, rates, confidence intervals, guardrails, dates,
revision, and final flag state.

## CI gate

Extend `.github/workflows/quality.yml` so each pull request runs:

- `pnpm lint`, `pnpm type-check`, `pnpm test`, and `pnpm build`;
- migration compatibility against PostgreSQL;
- `pnpm test:conversion` against a production preview with fixture event data;
- accessibility scans for `/`, `/explore`, and `/auth/sign-up` in both variants;
- assertions that essential-only produces no event and telemetry failure never blocks navigation.

## Runtime smoke gate

Run on staging against the built image:

1. essential-only: visit `/`, click both hero paths, search `/explore`, and sign up; assert zero
   conversion rows and successful product navigation;
2. analytics opt-in: repeat both paths; assert idempotent closed-schema events and accurate aggregate
   counts without email/query/user data;
3. confirm `/explore?q=rust` signup returns to the intended authenticated search after onboarding;
4. render baseline and treatment at 375x812 and 1440x900; verify CTA order, keyboard focus, screenshot
   sizing, and no unsupported proof;
5. set collection and treatment kill switches off independently and repeat the journeys.

## Risks and mitigations

| Risk                                         | Likelihood | Impact | Mitigation                                                                                                         |
| -------------------------------------------- | ---------: | -----: | ------------------------------------------------------------------------------------------------------------------ |
| Low traffic produces misleading uplift       |       High |   High | Minimum time/sample gates, confidence intervals, raw counts, and an explicit inconclusive outcome.                 |
| Analytics collection violates stated privacy |     Medium |   High | Opt-in only, first-party closed schema, no identity/content fields, 30-day deletion, disclosure before enablement. |
| Event loss biases results                    |     Medium | Medium | Non-blocking sendBeacon/fetch, idempotency, ingestion health metric, and equal code path across variants.          |
| Variant changes accessibility or performance |     Medium |   High | Both variants pass the same browser, axe, responsive, and performance gates before rollout.                        |
| Marketing copy outruns product reality       |     Medium |   High | Claim inventory with evidence/review date; remove unsupported rating and quote.                                    |
| Preserved `next` becomes an open redirect    |     Medium |   High | Accept only an allowlisted internal pathname/query shape and test external/protocol-relative rejection.            |

## Rollout

- `CONVERSION_EVENTS_ENABLED=false` and `VITE_LANDING_CONVERSION_VARIANT=baseline` are safe defaults.
- Enable collection only after legal copy, retention worker, and opt-out smoke pass.
- Separate the instrumentation release from the treatment by at least the full baseline window.
- Roll treatment 10% → 50% → 100% only at declared checkpoints. No individual user targeting.
- Monitor ingestion error rate, signup errors, guest search completion, and accessibility/performance
  gates throughout.

## Rollback

- Set `VITE_LANDING_CONVERSION_VARIANT=baseline` to restore the original CTA layout without touching
  data.
- Set `CONVERSION_EVENTS_ENABLED=false` to stop ingestion; clients continue all journeys even when
  the endpoint returns disabled/unavailable.
- Keep the additive table during code rollback. The old application does not reference it; the
  retention worker or privacy deletion path removes rows later.
- If preserved-next routing fails, disable it independently and fall back to `/onboarding/welcome`.
- Never restore the inert email form, fabricated/unsupported proof, or a public `/search` link as
  part of rollback.

## Definition of done

The baseline is real, the experiment follows its declared decision rule, both product journeys and
privacy modes pass runtime smoke, all CI gates pass, no dark pattern or unsupported proof remains,
and the final decision/flag state is recorded.
