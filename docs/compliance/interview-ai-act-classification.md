# EU AI Act classification — interview intelligence

**Status: assessment drafted, sign-off NOT obtained.** Written 2026-07-28. The conclusion below is an
engineering assessment of what the system does, prepared so a reviewer has something concrete to react to. It
is not legal advice and nobody has signed it.

**The launch stays behind `SENSITIVE_AI_ENABLED`, which defaults to `false`, until a dated sign-off is
recorded in the table at the end of this document.** That is not a formality: if the Article 6(3) reading
below is not accepted, the full high-risk provider and deployer obligations apply, and none of the conformity
assessment, technical documentation, or registration work has been done.

## The three systems

| Task id | What it does | Reads | Writes |
| --- | --- | --- | --- |
| `interview-brief-generate` | A preparation brief: what the sources say, what they do not, contradictions, and questions to ask | Candidate documents and approved imported pages | `interview_briefs` |
| `interview-followup-suggest` | Up to three follow-up questions during the interview | The last ~40 transcript segments | Nothing unless the organizer saves one |
| `interview-report-generate` | A written record of what was said and what is still open | The transcript, plus the organizer's own notes | `interview_reports` |

## Annex III context

This is employment. Annex III point 4 covers AI intended to be used for recruitment or selection, in
particular to place targeted job advertisements, analyse and filter applications, and evaluate candidates.
There is no argument that the context is out of scope, and this document does not attempt one.

## Article 6(3): the preparatory-task position

Article 6(3) removes an Annex III system from high-risk classification where it does not pose a significant
risk of harm, including because it performs a narrow procedural task, improves the result of a previously
completed human activity, or **performs a preparatory task to an assessment**. The exception does not apply
where the system performs profiling of natural persons.

The argument, and the evidence for each limb:

**It does not evaluate or filter.** There is no score, rating, ranking, recommendation, or status. This is
structural, not policy: the schema has no column for one anywhere in the interview or candidate tables, the
content schemas are `.strict()` so an added `overallScore` key is rejected, and `PROHIBITED_OUTPUT_PATTERNS`
refuses the vocabulary in free text. `tests/unit/shared/lib/ai/no-automated-decision.test.ts` asserts all
three by reading the schema and the source, because a prompt is advice and only the schema is a boundary.

**It cannot change anything about a candidate.** The three AI services write only their own artifact tables.
A static test parses every `transaction.insert/update/delete` in those modules and fails on any other target.

**Every claim cites its source.** A brief claim that cites no supplied document, or a report statement that
cites no transcript segment, fails validation before it is stored — so the human reviewing it can check each
one rather than accepting prose. `status: 'unanswered'` exists so a topic nobody reached is recorded as a gap
instead of filled with a plausible paraphrase.

**A human writes the outcome.** The report is a draft the organizer edits and finalizes; the decision is
theirs and is recorded nowhere in this system. Every AI output is labelled `AI draft` with its specific
failure modes named.

**Honest weaknesses in this position:**

- A report is the artifact a hiring decision is argued from weeks later. "Preparatory" is a defensible reading
  of *what it contains*, and a less comfortable one about *what it influences*. The mitigations above are what
  the argument rests on; without them the reading would not be available at all.
- The brief selects which questions get asked. Selection is influence, even without a score.
- `PROHIBITED_OUTPUT_PATTERNS` is **English-only**. "Recomiendo contratarlo" passes the filter today. The
  schema still has nowhere to put a conclusion and a human still reads every draft, so this is a weakened
  layer rather than an open door — but it is a real gap in a product that supports Spanish, and
  `tests/unit/shared/lib/ai/no-automated-decision.test.ts` asserts the *current* behaviour so it fails the day
  someone adds Spanish patterns, which is the reminder to revisit this paragraph.
- No profiling is performed, which the exception requires. Worth re-testing against any change that
  aggregates a candidate across interviews.

## Foreseeable misuse

| Misuse | What stops it |
| --- | --- |
| Treating the report as a decision | No score field, no status write, `AI draft` label, human finalization |
| Transcribing without consent | Consent re-read at every gate and on every 30-second provider grant; a withdrawal stops capture inside ten seconds |
| Sourcing material a platform forbids | `link-import-policy.ts` hard-blocks LinkedIn, X, Facebook and Instagram before the connector registry is consulted |
| Retaining material past its promise | Retention is stored per row and swept automatically; the sweep has no feature flag |
| Reading a colleague's interview | RLS on owner or explicitly granted participant; no organization-admin path |

## Supported languages and capture modes

English and Danish for transcription (`INTERVIEW_SUPPORTED_LANGUAGES`); the prohibited-output filter is
English-only, as noted above. Remote calls use two deterministic channels; in-person uses one microphone with
diarization, which guesses — the UI labels those speakers "Speaker A"/"Speaker B" rather than as roles, and an
organizer corrects them.

## Accuracy and limitations disclosed to users

Rendered by `AiDraftNotice` on every surface: misattributed speakers, mis-transcribed names and technical
terms, reading as more certain than the source supports, and for suggestions, only the last few minutes of
context.

## Traceability

Every artifact stores `provider`, `model`, `promptVersion`, `editedByUserId`, and its version. Reports and
briefs are append-only versions, never updates, so a model's draft and a human's correction stay
distinguishable. Security audit lines record generation, edit and finalize events with outcome codes only —
never content.

## Candidate disclosure and contest path

`/legal/privacy` section 9 states the processing, the processors and their regions, the retention periods, that
audio is never stored, that nothing trains a model, and that no decision is made solely by automated means. It
names the interviewing company as controller and gives a correction and human-review path.

## Sign-off

| Role | Name | Date | Notes |
| --- | --- | --- | --- |
| Engineering (author of this assessment) | — | 2026-07-28 | Assessment drafted; no legal review sought yet |
| Legal / compliance | **not obtained** | — | Required before `SENSITIVE_AI_ENABLED=true` |
| Product owner | **not obtained** | — | |

## Dates to track

- **2026-08-02** — Article 50 transparency obligations. The `AI draft` label and the privacy disclosure exist
  for this; confirm they are sufficient for the final guidance.
- Employment high-risk enforcement — confirm the then-current date before enabling, and re-run this assessment
  if the Article 6(3) guidance moves.
