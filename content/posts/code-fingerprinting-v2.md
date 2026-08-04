---
title: Code fingerprinting v1 vs v2 — what changed, and why the heuristic stayed
description: An engineering walk-through of BuilderHunt's code-style fingerprint — the per-language heuristic that v1 used, the AI-analyzed v2 that ships alongside it, and the fallback chain that keeps the card from ever going blank.
slug: code-fingerprinting-v2
date: 2026-08-05
tags: [engineering, ai, product, architecture]
author: edd
---

Code fingerprinting is the feature on the Pro plan that I have rewritten
twice and am most honest about why. The first version was a per-language
lookup table. The second version is an AI pass on real source files. Both
are live at the same time, with a clear upgrade path between them, and a
fallback chain that makes sure you never see a blank card.

This post is about how the two work, why both exist, and what the
fallback chain looks like in practice. It is the most engineering-heavy
post in the run; if you just want to know whether the feature is useful,
the changelog entry is shorter. If you want to know how the two versions
talk to each other, read on.

## What "fingerprint" means here

A fingerprint is a five-metric record plus a paradigm label, and it
describes how someone writes code, not what they have built. The five
metrics:

- `modularityScore` — how the code is broken into units
- `testIntensity` — how much of the public surface has tests
- `documentationRatio` — how much of the public surface is documented
- `complexityControl` — how the code handles hard cases
- `namingConsistency` — whether the names follow a pattern

The paradigm is one of `functional`, `oop`, or `pragmatic`. The shape is
small on purpose. It is the smallest record that lets `similarity()`
compute a useful comparison between two fingerprints without inventing
numbers it cannot defend.

## What v1 actually was

A lookup table keyed by primary language:

```ts
const FP_LANGS: Record<string, Partial<CodeStyleFingerprint>> = {
  rust:       { paradigm: 'functional', modularityScore: 88, complexityControl: 90, documentationRatio: 75, namingConsistency: 92, testIntensity: 78 },
  haskell:    { paradigm: 'functional', modularityScore: 90, complexityControl: 85, documentationRatio: 70, namingConsistency: 88, testIntensity: 80 },
  typescript: { paradigm: 'pragmatic',  modularityScore: 78, complexityControl: 75, documentationRatio: 70, namingConsistency: 82, testIntensity: 72 },
  python:     { paradigm: 'pragmatic',  modularityScore: 72, complexityControl: 70, documentationRatio: 65, namingConsistency: 75, testIntensity: 68 },
  // ... 14 languages, with the same shape.
}
```

v1 was honest and shallow. It could tell you someone writes a lot of
TypeScript, not how they write it. Every Rust builder got a high
modularity score because the table said so, not because anyone read their
code. Two engineers whose work was nothing alike — one shipping a
production observability library, one dumping prototype scripts — got the
same fingerprint if their primary language matched.

That is the version that was sold as "Code fingerprinting" on the Pro
plan for the first year, and the reason I rewrote it was not that the
heuristic was wrong but that it was a stereotype. The Pro tier promise
deserves a signal, not a language lookup.

## What v2 adds

A separate rung. v2 lives at the same field
(`builders.metadata.codeStyleFingerprint`) but is wrapped in a versioned
envelope:

```ts
{
  version: 2,
  paradigm: 'functional',
  modularityScore: 84,        // not the 88 of the Rust lookup table
  testIntensity: 71,          // measured from the actual repos
  documentationRatio: 68,     // measured from docstrings + READMEs
  complexityControl: 82,
  namingConsistency: 88,
  language: 'rust',
  generatedAt: 1722345678901,
  source: { task: 'fingerprint-v2', repos: 3, files: 7 }
}
```

The `source` field is the part that makes the v2 result defensible: a
reader can see exactly which task produced it, how many repos the
fetcher sampled from, and how many files made it into the model's input.
A v1 result has no such field, because the v1 lookup table has no such
provenance. A v2 result without that field is invalid, and the schema
enforces it.

The task itself runs through the shared AI platform. It receives a
handful of representative files chosen by the shared sample-selection
helpers — files from public repos that look like the builder's actual
work, not the first hit on a search — plus the cheap pre-computed
structural stats (line counts, function counts, public-vs-private
balance) and produces the five metrics plus the paradigm label. The
output is validated against the same `CodeStyleFingerprint` shape v1
used, so `similarity()` and the profile card do not need to know whether
they are looking at a v1 or a v2 record.

## The fallback chain

The whole point of keeping v1 was that the card cannot go blank. Three
rungs, in order:

1. **v2 exists and is fresh.** The card renders the v2 metrics with
   the "AI-analyzed from N files across M repos" subtitle. This is
   the path a tracked GitHub builder gets if you have run the analyze
   action at least once.
2. **v2 does not exist, or the AI task is unavailable.** The card
   renders the v1 heuristic with the "estimated from language"
   subtitle. This is the default state for any builder the system has
   not analyzed yet, and for any source that is not GitHub (GitLab and
   Codeberg adapters do not yet produce v2 samples).
3. **The card has nothing to anchor on.** A builder with no detected
   language and no analyzed repos. The card collapses to a small
   notice — "not enough public activity for a fingerprint" — and
   does not show the metric row at all. The card is not decorated
   with zeros.

The chain is enforced by the card component, not by the data layer:
the same `CodeStyleFingerprint` type is the source of truth for all
three rungs, and the card decides which rung to show based on the
`version` and `source` fields.

## What v2 deliberately does not do

- **It does not compile or execute the code.** The model reads. It
  never runs. The fetcher returns source files, and the AI task has
  no path to a sandbox. The v2 spec was written to make this
  non-negotiable, because the moment the system runs a candidate's
  code, the consent story for analyzing it changes.
- **It does not analyze non-GitHub sources.** GitLab and Codeberg
  have similar APIs, and a future plan will add them. For now, a
  builder whose only signal is GitLab gets the v1 estimate. The
  card is honest about it.
- **It does not write a "fit verdict".** Same prohibition as the
  persona and team-fit tasks: a fingerprint is a description, not
  a recommendation. The model can say "this code is more functional
  than the heuristic suggested"; it cannot say "this engineer is a
  good fit for your team".

## How the upgrade happens in the UI

The v2 path is opt-in. The card shows the v1 estimate by default,
with a button labeled "Analyze real code" on the Pro plan. The click
spends one credit from the organization's monthly grant, dispatches
the task, and on completion the card swaps the v1 estimate for the v2
analysis without a page reload. If the task fails — provider down,
budget spent, builder has no analyzable repos — the card stays on the
v1 estimate and shows the failure reason inline. The user is never
left with a card that used to say something and now says nothing.

There is also a "match against my codebase" path on Phase 4 of the
plan that lets a Pro recruiter paste a source file from their own
codebase and rank their tracked builders by style match. That is the
feature that turns the fingerprint from a description into a tool,
and it is the one I am most interested in seeing whether people
actually use.

## What the metric numbers do and do not mean

A `modularityScore: 84` is not a percentile. It is a per-fingerprint
point in a five-metric space. Two builders with the same `modularityScore`
are not necessarily similar in any way that matters; they are similar
in the one dimension the score measures, and the other four dimensions
are also part of the comparison. A v2 result with `modularityScore: 84`
and a v1 estimate with `modularityScore: 88` are not the same number
either — the v1 number is a table lookup, the v2 number is a model
judgement, and the `version` field is the only thing that tells you
which is which.

If you sort your shortlist by a single metric, you are using the
feature wrong. The whole point of five metrics is that the interesting
differences live in the *combination* — a high modularity / low
documentation builder and a high documentation / low modularity builder
are not the same person, and a single-score sort hides that.

## Why both versions ship

A common question is why I did not just replace v1 with v2. Three
reasons.

1. **The v1 estimate is computed client-side on every render and
   costs nothing.** Replacing it with an always-on AI call would
   spend a credit on every profile view, which is a per-view cost
   the free tier cannot absorb.
2. **The v1 estimate is a sensible default for non-GitHub builders.**
   A plan that says "you cannot see a fingerprint for this candidate
   because their work is on GitLab" is a worse plan than one that
   shows a labelled estimate.
3. **v2 is opt-in because v1 is good enough for triage.** Most
   profile views do not need a real analysis. The point of v2 is to
   help you decide between two short-listed candidates, and a
   button that says "spend a credit to see the real version" is the
   right shape for that.

The fallback chain is not a permanent compromise. It is the design.
v1 will not disappear; v2 will not become the default. Both will
keep evolving, and the card will keep showing whichever rung makes
sense for the data in front of it.

[Open a profile](/search) and look at the style card. If you see
"estimated from language", that is v1. If you see
"AI-analyzed from N files across M repos", that is v2. Both are
honest; both are useful; both are deliberately part of the same
feature.
