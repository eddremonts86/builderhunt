---
title: Team fit analysis — what it compares, what it doesn't, and why the result is ephemeral
description: A walk-through of BuilderHunt's candidate-vs-team analysis — what the AI looks at, what the schema forbids it to say, and why the result is computed on demand instead of stored.
slug: team-fit-analysis
date: 2026-08-06
tags: [ai, hiring, teams, product, guide]
author: edd
---

You do not hire against a search query. You hire against the team you
already have, and the question you are actually asking is: "how does
this candidate change the group?" Not "is this candidate good" — that
is the persona card's question, and a different one.

Team fit analysis is the feature that answers the group question. It
runs on the shared AI platform, costs a credit per analysis, and is
deliberately designed to produce a description rather than a verdict.
This post is about the shape of that description, the design choice
that makes it ephemeral, and the rule the model is told to break
output if it tries to break.

## What it does, in one sentence

You open a candidate's profile, hit "Analyze team fit", and within
a few seconds get a card with a synergy score, a one-sentence
summary, a list of complementary strengths the candidate would add,
a list of overlap with the people you already track, and a list of
possible friction points — all relative to the candidates your
organization is already tracking, not to a generic "ideal engineer"
the model has in its head.

The card has four states, in this order of preference, and the UI
renders something concrete in every one of them:

1. **AI result.** The full card. Synergy score, summary, three lists,
   a confidence badge. The path you want.
2. **Baseline estimate.** A rule-based score plus a short notes list,
   served when the AI is unavailable or the budget is spent. The
   page does not pretend it is the AI answer — the copy says
   "rule-based estimate" and the lists are deterministic.
3. **Team too small.** A nudge that explains the analysis needs
   at least three tracked builders to mean anything. There is no
   fake card with a low-confidence warning.
4. **Plan upgrade prompt.** A card that says the feature is on
   Team, with the link to pricing. Free and Pro users see this;
   the page never renders a half-broken card with "you could see
   this if you upgraded" text floating on a blank surface.

That last decision matters. A button labeled "Analyze team fit" on
a free plan that opens a paywall modal is a worse user experience
than a card that says so up front.

## What "the team" means in v1

In v1, the team is your organization's tracked builders, capped at
the 50 most recent. When `team-accounts` landed and the
`shared-resources` work added org-shared builder lists, the team
source became pluggable: a `teamSource: { orgListId }` parameter
selects one of your org's shared lists as the comparison set. The
task only ever sees the aggregate — a digest of languages, topics,
paradigms, fingerprints, and recent activity across the selected
builders. It does not know who is in the team, which is the
correct privacy posture for a task that might be re-run as part
of a larger analysis.

The cap at 50 is a real limit. A team of 200 is a different
analysis than a team of 50, and the v1 task is not built to handle
the larger one honestly. If you need analysis on a list larger
than 50, the current answer is "curate a list of the 50 most
relevant people", and that is a reasonable answer for the
sourcing-shaped use case this feature serves.

## What the AI looks at

The input is a digest, not the raw records. The task receives:

- The candidate's fingerprint (the same `CodeStyleFingerprint`
  shape from the code-fingerprinting post — paradigm, five metrics,
  language) and a recent-activity summary.
- An aggregate of the team's fingerprints: the distribution of
  paradigms, the average metrics, the language mix, the activity
  recency distribution.
- A list of the team's primary topics, with how many team members
  cover each.
- A list of the team's primary languages, with the same count.

What it does not receive: individual team-member identities, your
organization's name, your hiring plan, your saved searches, the
candidate's contact information, anything from any other
organization, or anything from the candidate's notes. The input
is a description of the candidate and a description of the team,
and the task is told to compare the two.

The output is a strict schema:

```ts
interface SynergyAnalysis {
  synergyScore: number            // 0-100, not a percentile
  summary: string                 // one sentence
  complementaryStrengths: string[]  // 1-5 short bullets
  overlaps: string[]              // 1-5 short bullets
  frictionPoints: string[]        // 1-5 short bullets
  confidence: 'low' | 'medium' | 'high'
}
```

No hire verdict, no fit percentage, no culture-match decimal, no
recommendation. The schema has no field for those, and the model's
output is validated against the schema before anything renders.
A model that wants to say "this is a strong fit" has to encode
that in the `summary` field, with the words "summary" and
"complementary" doing the heavy lifting, and the lack of a
numeric "should I hire" field is a feature.

## Why the result is ephemeral

The analysis is computed on demand. It is not persisted. The
reason is in the spec and it is honest: team composition changes
constantly. Every track and every untrack changes the aggregate.
A persisted result would be stale the moment it was written, and
the only way to invalidate it would be to add a "did the team
change?" check before every read, which is more complex than
re-running the analysis.

Instead, the result is cached in Redis for an hour, keyed by
`(organizationId, candidateId, teamHash, modelVersion)`. The team
hash is a content hash of the aggregate input, so the moment the
team changes, the hash changes, and the next request computes a
fresh result. The cache exists to absorb the obvious case — two
recruiters in the same hour asking the same question — without
spending two credits.

The "ephemeral" decision is the one that lets the feature be
correct. A persisted result would be wrong more often than it
would be useful, and the wrong result is the dangerous one: a
recruiter reading a stale "they complement the team" card is
making a hiring decision on a lie.

## What the model is told it cannot say

The prohibited outputs for the synergy task mirror the persona
task, with one addition:

- No "hire / don't hire" verdict.
- No "this person will succeed" claim.
- No numeric probability of success.
- **No "team fit percentage" or "culture match" score.** The
  `synergyScore` is an ordering aid, not a probability.

These are in the task contract as prohibited outputs, not
prompt suggestions. The model can attempt to produce a draft
that breaks them, the output validator will reject it, and the
user sees a clear error explaining that the model tried to say
something it should not have.

The reason "culture match" is on the list: a model that has
read the public work of 50 people and the public work of one
candidate is not qualified to make a judgement about culture,
which is a property of the working relationships between people,
not a property of their public GitHub. The closest the model
can get to the question is "what would this person add to the
group's existing public-work profile", which is a useful
question and a different one.

## The credit cost and the budget

One credit per analysis. Cached for an hour on the same key. On
the Team plan, credits are pooled across the organization, so
the recruiter who runs ten analyses in a week is not consuming
their seat's share — they are consuming from the team's pool.
That is the design point: a hiring push is usually one person
doing all the sourcing for a stretch, and per-seat credit
accounting would punish the exact behaviour the plan is meant
to enable.

When the budget is spent, the card does not disappear. It
collapses to the baseline estimate, with a note that the AI
pass was skipped because the budget is gone. Free and Pro users
see the upgrade prompt instead. Either way, the page renders
something that explains itself, not a dead button.

## When the feature is and is not useful

It is useful when you have a real shortlist and a real team, and
you want to know which candidate changes the group in a useful
way. The classic case: you already have three backend engineers
all strong on the JVM, and you are trying to decide between a
fourth JVM generalist and a Go specialist who also writes Rust.
The team-fit card tells you the Go/Rust person adds two
languages nobody on the team works in, and the JVM generalist
duplicates the JVM depth. That is a useful observation.

It is less useful when your shortlist is one candidate and your
team is two people, because the analysis has too little to
compare against. The "team too small" state catches that case
and tells you so, instead of producing a low-confidence
analysis that is more noise than signal.

It is not useful as a screening tool. The card cannot tell you
whether someone can do the job. It can tell you how they would
change the group relative to the people already in it, and that
is the only thing it can tell you.

## How to use the card

Read the lists, not the score. The `synergyScore` is a useful
ordering aid when you have two candidates who are both strong
fits for the role and you are trying to decide between them,
and the score is not useful in any other case. The
`complementaryStrengths` list is the actionable part — it tells
you what this candidate would add, and you can decide whether
that is what your team needs.

If the lists are vague ("they would bring strong engineering
skills"), the analysis is not useful. The schema enforces that
the bullets are specific phrases, not generic praise, but a
model can still produce a list that is technically specific and
practically empty. The right response is to refresh — the team
hash will be unchanged, but the model version is a different
key, and a different run might surface a different angle.

[Try it on a real profile](/search) — open someone, hit
"Analyze team fit", and read the lists. If the lists are not
useful, the feature has failed, and I want to know.
