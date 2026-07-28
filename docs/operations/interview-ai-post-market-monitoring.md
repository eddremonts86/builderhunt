# Post-market monitoring — interview AI

Written 2026-07-28. **No monitoring data exists yet**: nothing is deployed and `SENSITIVE_AI_ENABLED` has
never been `true` in any environment. This document defines what to watch and what counts as an incident, so
the first week of real use is measured rather than remembered.

## What is already measured, and what is not

Measured today, from the existing test and gate infrastructure:

- Schema-validation failure rate per AI task, visible as a `502 ai_parse_failed` on the AI routes.
- Reservation settle-versus-estimate variance, through the billing reconciliation contract.
- Provider error and timeout counts.

**Not measured today** — these need the metrics work in Phase 11 task 6 before this document is operable:

- Speaker-attribution corrections per interview, which is the single most useful accuracy signal available.
- Refused-output counts by pattern, which is how a protected-trait proxy attempt becomes visible.
- Template-fallback rate, which is the honest measure of how often the AI is not usable at all.

## Thresholds

Numbers chosen from what is known and marked where they are guesses. Every one of them should be revisited
after the first two weeks of real data — a threshold set from an estimate and never revisited is worse than
none, because it manufactures confidence.

| Signal | Threshold | Basis |
| --- | --- | --- |
| Schema-validation failure rate | > 10% over 24h | MiniMax measured ~25% on four live runs; Mistral is unmeasured. A rate this high means the task is not usable, not that a retry is needed. |
| Template-fallback rate | > 20% over 24h | Guess. Above this, organizers are being handed blank forms and told a feature exists. |
| Speaker corrections per in-person interview | > 30% of segments | Guess. Diarization that wrong makes attribution worse than absent. |
| Refused output containing a protected-trait proxy | **any occurrence** | Not a rate. One is an incident. |
| Billing variance versus provider-reported duration | > 1% | Matches the reconciliation policy already in the plan. |
| Withdrawal-to-capture-stop latency | > 10s | The stated guarantee. A breach is a consent breach. |

## What counts as an incident

1. **Any protected-trait proxy in output**, refused or not. Refused means the filter worked and the model
   tried; that is worth knowing.
2. **A score, rating, or hiring recommendation reaching a stored artifact.** Should be impossible — the schema
   has no field and the vocabulary is refused. If it happens, the Article 6(3) position in the classification
   document is void until it is understood.
3. **Transcription running without a current consent**, for any duration.
4. **Audio persisting anywhere** — a file, a log, a heap snapshot, a provider dashboard.
5. **Cross-tenant material in any output**, including a citation resolving to another organization's segment.

## Incident response

1. Set `SENSITIVE_AI_ENABLED=false`. The deterministic template path keeps the feature usable and stops model
   output immediately; it does not require a deploy.
2. For a consent or audio incident, also set `INTERVIEW_TRANSCRIPTION_ENABLED=false`. Retention keeps running —
   the sweep has no feature flag, deliberately, because turning a feature off must not turn its obligations
   off.
3. Record the affected interviews by id. Never copy content into an incident record; that recreates the
   exposure in a second place.
4. Notify the affected controllers — the interviewing companies, not the candidates. They are the controllers
   and the notification obligation is theirs.
5. Re-run the classification assessment before re-enabling.

## The drill

Not yet run. It needs `SENSITIVE_AI_ENABLED=true` in a non-production environment with synthetic data, and it
should confirm, with evidence:

- A planted protected-trait proxy is refused and counted.
- Flipping `SENSITIVE_AI_ENABLED=false` stops model calls within one request and the template path serves.
- Flipping `INTERVIEW_TRANSCRIPTION_ENABLED=false` refuses the next provider grant.
- Retention still runs with both flags off.

## Review cadence

Weekly for the first month of real use, then monthly. Each review updates the thresholds above with measured
values and deletes the word "guess" from any row that now has data behind it.
