# Human oversight of interview AI

Written 2026-07-28. Companion to `docs/compliance/interview-ai-act-classification.md`, which explains why
oversight is the load-bearing control rather than an extra.

## What the system does and does not decide

It drafts text. It does not score, rank, rate, recommend, or change anything about a candidate — there is no
column for any of those and the content schemas reject an added one. Whoever reads the draft makes the
decision, and that decision is recorded outside this system.

## What a reviewer is actually being asked to do

Not "approve". The three drafts fail in specific, knowable ways, and a review that does not look for them is a
rubber stamp that makes the oversight claim false.

**A brief.** Every claim cites a document. Open at least the ones you are going to act on: a model asked to
summarise a CV will attribute a plausible claim to a source that does not support it, and a tidy citation is
indistinguishable from a checked one. `informationGaps` is where the model says what it could not find —
read it, because a brief with no gaps listed is more suspicious than one with several.

**A follow-up suggestion.** It has seen the last few minutes and nothing else. Check that the thing it is
responding to is a thing that was actually said, and by the person it thinks.

**A report.** Two failure modes matter most:

- **Speaker attribution.** In-person interviews are diarized, which guesses. Labels read "Speaker A" and
  "Speaker B" precisely because they are guesses; if you have not corrected them, the report may attribute
  your own question to the candidate.
- **Certainty.** A transcript of someone thinking aloud becomes a sentence that reads as settled. Follow the
  timestamps on anything that matters.

A topic marked `unanswered` is information, not an omission to fix. Filling it in from memory is the one edit
that turns a record into a fabrication.

## What you cannot do, by design

- You cannot make the AI produce a score. The schema has nowhere to put one and the vocabulary is refused.
- You cannot finalize a report over unsaved edits — the UI refuses, because finalizing a version that does not
  include what you just typed freezes the wrong record.
- You cannot edit a finalized report. It is the record; a correction is a new interview or an appended note.
- You cannot cite a transcript line that is not in the report's evidence list, in a generated draft or a
  hand-edited one.

## AI literacy: what to tell an interviewer before they use this

1. Every output is a draft with your name on the outcome.
2. It cites its sources because you are expected to open them.
3. It cannot rate anyone, and if you find yourself reading a rating into it, that is you.
4. It is wrong about who said what more often than it is wrong about what was said.
5. Transcription happens only with the candidate's recorded consent, and they can stop it mid-interview. If
   they do, capture stops within ten seconds and the interview carries on without it.

## Escalation

| Situation | Action |
| --- | --- |
| A draft states something no source supports | Edit it out and save. If it recurs, record it in the post-market log. |
| A draft mentions a protected characteristic | It should have been refused before storage. Treat as an incident — see the monitoring document. |
| A candidate disputes a record | The interviewing company is the controller and corrects it. A human reviews any conclusion drawn from it. |
| Speaker attribution is wrong throughout | Use the per-voice mapper rather than correcting line by line; diarization is usually consistently wrong rather than randomly wrong. |
