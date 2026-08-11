# Legal and commercial approvals (plan)

No engineering sequence: nothing here depends on anything else here. The order below is by what it
unblocks, so the maintainer can spend one afternoon on the item with the most behind it.

## 1. The enrichment privacy copy — most leverage

It gates `ENRICHMENT_ENABLED` in production, which gates the seven-day canary in
[`01-production-readiness-audit`](../01-production-readiness-audit/tasks.md), which gates dropping the
Beta label. It is the only item on this plan that sits on the critical path out of Beta.

The draft is paste-ready. What is genuinely the maintainer's: the legitimate-interests balancing test,
whether to commit publicly to the 180/30-day retention numbers, and recording the approval.

## 2. The interview DPIA

Gates voice transcription and candidate document handling — the features that touch the most sensitive
data in the product. It needs a data-protection advisor, not an engineer, and the provider register
already names that pairing as its owner.

## 3. Provider pricing, then unit economics

These two are one chain: real `MINIMAX_COST_PER_*` and Deepgram/Mistral numbers turn the provisional
cost certification into a real one, and only then can the margin check mean anything. Running the
margin check against placeholder constants would produce a number with a decimal point and no content.

## 4. The Solutions gold set

The last one, and the least urgent: the module ships disabled and its evaluator already produces a
dated baseline. What it cannot do is certify its own quality — `citableAsQualityGate` stays false until
`solution_gold_briefs` holds human-authored judgements, which is the authorship split working as
designed rather than a gap to close quickly.

## Verification

There is nothing to run. Each item's `Verify` line names the artifact that must carry a dated,
attributable approval, and the check is that the artifact says so — not that a test passes.

The one mechanical check worth keeping: no flag named in this plan may be `true` in the production
environment while its item is unchecked. That failed once already — `ENRICHMENT_ENABLED` was `true` in
production for nine days while both of its gating tasks were open (found 2026-08-05, recorded in
`plans/implemented/42-stealth-scraping/task.md`). Measure the environment, do not trust the plan.
