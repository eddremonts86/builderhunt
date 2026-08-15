# Rolling out segmented onboarding

Onboarding v2 — four routes through one framework, with an activation per route. Plan:
[`plans/phase-2/03-onboarding-segmentado`](../../plans/phase-2/03-onboarding-segmentado/spec.md).
The segment itself is a separate flag; see
[`user-segmentation-rollout.md`](./user-segmentation-rollout.md).

## The one thing to keep straight

**Both flows are live at once, so this is a choice of route rather than a deploy.**

v1 (`welcome → search → save → success`) and v2 (`welcome → goal → branch → success`) share the same
screens, the same `onboarding_progress` row and the same API. v2 added five nullable columns and a
new endpoint; it changed nothing v1 reads. That is what makes the ramp a percentage instead of a
release, and a rollback the same percentage moved back down — no deploy, no migration, and nobody
stranded halfway through a flow.

## Turning it on

```bash
ONBOARDING_V2_ROLLOUT_PERCENT=10
```

`0` by default, meaning everybody stays on v1. The value is a percentage of **accounts**, not of
requests: the bucket is `fnv1a("builderhunt:onboarding-v2:" + userId) % 100` and never moves, so

- the same person always gets the same flow, on any device and in any session, and
- **raising the number only ever adds people.** Everybody at 10 % is still in at 20 %. A ramp never
  takes the flow away from somebody standing in the middle of it.

Anything unparseable clamps to `0`. An unreadable percentage means off, never everybody.

The segmentation flag matters too: with `USER_SEGMENTATION_ENABLED=false` the goal step still works
— `/api/me/preferences` answers 404 and the step lets people through rather than stranding them —
but no segment is stored, so every account runs the `general` route. Turn both on to get the
branches.

| | `ONBOARDING_V2_ROLLOUT_PERCENT=0` | `=100` |
|---|---|---|
| `welcome`'s primary button | `/onboarding/search` (v1) | `/onboarding/goal` |
| `/api/onboarding/v2` | answers, `rollout.inCohort: false` | answers, `inCohort: true` |
| `/onboarding/goal` typed directly | works | works |
| existing `onboarding_progress` rows | untouched | untouched |

The v2 steps are **not** locked behind the ramp. Somebody outside the cohort who types the URL gets
a working step: the spec is explicit that onboarding never blocks, and a 404 there would strand
anybody mid-flow the moment the percentage was lowered.

## A suggested ramp

| Step | Percent | Wait | Stop if |
|---|---|---|---|
| 1 | `5` | 48 h | v2 completion below v1 by more than 5 points |
| 2 | `25` | 72 h | same, or any route's activation at zero |
| 3 | `50` | 1 week | same |
| 4 | `100` | — | — |

"Any route's activation at zero" is worth its own line because it fails differently: a route can
complete perfectly while activating nobody, and that is the failure v1 could not see at all — it
counted a finished flow as an activated user, so its activation rate described the flow rather than
the product.

## Reading the funnel

`GET /api/admin/metrics/conversion?start=YYYY-MM-DD&end=YYYY-MM-DD` (platform admin only) carries an
`onboarding` block:

- `rolloutPercent` — what the ramp is set to right now, so a reading is interpretable without a
  shell on the box;
- `completion` — keyed `<flowVersion>:<preset>`, `confirmation` viewed over `welcome` viewed;
- `steps` — every `(event, version, route, step)` cell, so a drop can be located rather than
  guessed at.

Split by flow version on purpose. "Completion fell" is not actionable; "completion fell on v2 while
v1 held" is the sentence that stops a ramp, and it cannot be written from a stream that does not
distinguish the two.

Activation is **not** read from this stream. It lives in `onboarding_progress.activation_type`,
written by the server after it counts the evidence itself, and is the number to trust — a client
that could assert "I saved three builders" could assert it having saved none.

### The events are only 30 days deep

`deleteExpiredConversionEvents` prunes raw events after 30 days, and the metrics endpoint refuses a
range wider than 90. A ramp compared against a baseline older than a month has no baseline.

## Rolling back

Set the percentage back down and redeploy. People who leave the cohort resume on v1 from the same
row: the v1 `step` column is kept in step with the v2 key on every advance, so they land where they
were rather than at the beginning. Nothing is deleted, and a segment somebody chose is still there
when the ramp comes back up.

## Health check

```bash
curl -s "$APP_URL/api/onboarding/v2" -H "cookie: $SESSION" | jq '{flowVersion, preset, currentStep, rollout, activationType}'
```

Three things worth reading in that output:

- `rollout.percent` is what the **running process** has, not what `.env` says — `env` is frozen at
  module load, so a changed file means nothing until a restart;
- `preset` is `general` for anybody without a stored segment, which is v1's flow and is not a
  failure;
- `activationType` is `null` until something real happened. Reaching the last step is not
  activation.

## What each route counts as activation

| Route | Activation | Evidence the server counts |
|---|---|---|
| `hiring` | three builders tracked, or a sourcing sprint | `onboarding_selected_builders` |
| `investing` | one saved search that is armed | an `alerts` row on the query, or a live `feed_capabilities` row |
| `building` | a claim started or verified | `builder_claims` in `pending` or `verified` |
| `general` / `other` | three builders tracked | `onboarding_selected_builders` |

Two of these are worth knowing before reading a number.

**Investing counts a feed link as armed.** Alerts are a paid feature and a new organization is on
`free`, so counting only alerts would have made this route's activation rate a measure of conversion
to Pro rather than of the route. A minted feed capability is a real, ungated delivery mechanism, and
the screen says which of the two happened rather than claiming an alert that is not there.

**Building activates on a *started* claim.** Verification is asynchronous — the claimant publishes a
challenge on the account being claimed — so waiting for it would measure how quickly people get
round to editing a profile somewhere else.

## Known gaps

**`flow_version` follows the cohort, not the path actually walked.** The screens are shared, so the
hook labels events with the version the person's cohort puts them on. Somebody in the cohort who
types a v1 URL directly is still counted as v2. Nobody arrives that way in normal use, and the
alternative — inferring the version from the screen — would mislabel the four screens both flows
share.

**A skip is recorded twice, under two names.** `onboarding_flow_exited` is the funnel's event and
`onboarding_progress.skipped_count` is v1's counter. They measure the same act with different
retention (30 days against forever), so a disagreement between them is expected rather than a bug.
