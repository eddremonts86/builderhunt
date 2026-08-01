# Solutions Intelligence — evaluation

How the product's output is measured, what the numbers mean, and — the part that matters most — what they do
not mean.

## The corpus is two populations that never mix

| Population | Where it lives | Count | May be cited as a quality gate |
| --- | --- | --- | --- |
| Synthetic | `tests/fixtures/solutions/gold-set.json` | 60 | **No** |
| Human | `solution_gold_briefs` (platform-admin CRUD) | 0 today | Yes |

The 60 seeded briefs are machine-authored. The generator and the grader share assumptions, so a score measured
against them is circular: it detects regressions and proves nothing about quality. `scripts/evaluate-solutions.ts`
enforces that rather than trusting a reader to remember it — the two populations are summarised separately, no
combined figure is ever produced, and `citableAsQualityGate` stays `false` until a human-authored record exists.

Human records are added through `POST /api/admin/solutions/gold-briefs`, which forces `authorship: 'human'`. A
synthetic record cannot be created through that route, because a synthetic judgment that entered the human
population would be indistinguishable from a curated one a week later.

## Running it

```bash
pnpm solutions:evaluate
```

`--include-human` pulls the human records in; `--json` emits a machine-readable report for a dated artifact.
Exit code is non-zero when any brief surfaced an excluded component kind.

## What is measured

| Metric | Meaning | Why it is shaped this way |
| --- | --- | --- |
| capability recall | fraction of expected capabilities the interpretation found | Recall, not precision — an extra capability widens retrieval rather than breaking it |
| domain accuracy | exact match on the brief's domain | Wrong domain means wrong market-rate band and wrong candidates |
| lane recall | fraction of expected lanes actually offered | Measures whether an option existed, not whether it was ranked first |
| constraint retention | fraction of expected hard constraints that survived interpretation | The one that matters most: a dropped `max_budget` means every route was composed without the user's limit |
| exclusion failures | **count**, not a rate | One job posting surfaced as a person fails the brief outright; averaging would make it look like 98% clean |
| latency p50 / p95 | nearest-rank | A reported p95 is always a latency some run actually had |
| provider calls | total | The cost side; cross-checked against `docs/operations/solutions-cost-certification.md` |

Every mean carries a 95% normal-approximation interval, so a 12-brief segment is visibly less certain than a
60-brief one.

## Baseline, 2026-08-01

Run against the local development database with `SOLUTIONS_INTERPRETATION_ENABLED=false` and
`SOLUTIONS_EXPLANATION_ENABLED=false` — the deterministic path only.

```
SYNTHETIC (60 briefs)
  capability recall     55.0% ±12.0
  domain accuracy       0.0%  ±0.0
  lane recall           44.4% ±10.4
  constraint retention  0.0%  ±0.0
  exclusion failures    0
  latency p50 / p95     6ms / 10ms
  provider calls        0
```

**Read the two zeros correctly.** With interpretation off, the deterministic fallback matches capability
keywords and nothing else: it cannot infer a domain (it returns `other` by design rather than guessing) and it
extracts no constraints at all. So domain accuracy and constraint retention are measuring the *fallback*, and
0% is the correct score for a path that deliberately does not attempt them. They become meaningful the moment
`SOLUTIONS_INTERPRETATION_ENABLED` is on, and that comparison — same corpus, flag off versus on — is the first
thing worth running when it is.

Capability recall of 55% is a real measurement of the keyword matcher, and the number to beat. Latency at 6ms
p50 is the whole pipeline minus providers: two SQL lanes and arithmetic.

## What this baseline is not

- Not a quality measurement. See the top of this document.
- Not a measure of the LLM path. Both AI flags were off.
- Not a load test. One process, sequential, against a local database.

## Before the acceptance thresholds in spec.md can be checked

1. **Human-authored judgments.** Until `solution_gold_briefs` holds some, no run is citable.
2. **The LLM path measured.** Re-run with interpretation and explanation on and record both figures side by
   side; the delta is what the paid path buys.
3. **Warm/cold load and source-outage drills**, per Phase 9's "Pass quality, performance, and cost gates".
4. **Provider variance** — the same brief run repeatedly with a live model, to see how much the interpretation
   moves. The composer is deterministic, so any variance in the final routes comes from interpretation alone,
   which makes this a clean measurement.
