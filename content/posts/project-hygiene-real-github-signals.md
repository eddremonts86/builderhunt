---
title: Project hygiene used to be a vibe. Now it is GitHub data.
description: A walk-through of the rebuilt project-hygiene card — what the metrics actually measure, where the data comes from, and why the deterministic "not enough data" path is the better answer than a guess.
slug: project-hygiene-real-github-signals
date: 2026-08-07
tags: [engineering, trust, product, guide]
author: edd
---

There is a category of feature on every developer-tools site that
shows a number on a profile and gives you no way to verify it. The
number is usually a percentage, usually in green, and usually
indistinguishable from a guess. Project-hygiene scores on
developer profiles were exactly that, and the rebuild is what
this post is about.

The new card is built on real GitHub signals. The old one was
not. The transition between them is the interesting part, and
the honest version of the story is the part that explains why a
card that used to always have a number now sometimes says
"not enough data" instead.

## What the card used to show

The pre-rebuild card took the builder's primary language, the
follower count, the public-repo count, and a couple of
ad-hoc heuristics, and produced a 0-100 score that mostly
reflected "this person has a lot of repos". The score did
not measure project hygiene in any meaningful sense. It
measured "is the indexer confident enough to render a
number". Those are not the same thing, and the difference
is exactly the failure mode.

The "show a number rather than admit ignorance" pattern is
common in tools that compete on visual richness. A profile
with a number ranks higher in a recruiter's eye than a
profile with "we don't have enough data", even when the
number is meaningless. The product's incentive is to
render the number, and the recruiter's incentive is to
trust it, and the result is a feature that is worse than
no feature.

I would rather be honest. The rebuild is the honest version.

## What the new card measures

Five things, all from real GitHub data for GitHub-source
builders, with a deterministic fallback for everyone else:

- **Issue close rate.** The ratio of closed issues to total
  issues across the builder's public repos that have an
  issues tab. Computed from the upstream, not estimated.
- **Average resolution days.** The mean number of days
  between an issue opening and its closing, for the same
  set of repos. A long average is a signal about how the
  project triages, not a judgement about the maintainer.
- **Documentation score.** A simple proportion: does the
  repo have a README, a CONTRIBUTING file, a LICENSE file,
  and a /docs directory? Scored 0-100 from the four
  booleans.
- **CI/CD presence.** Does the repo have a
  `.github/workflows` directory (or the GitLab/Codeberg
  equivalent, where supported)? Boolean; rendered as a
  separate badge, not folded into the global score.
- **Recency.** A decay-weighted contribution to the global
  score: a repo that has not seen a commit in 18 months
  counts less than a repo that has seen one this week.

The global score is a weighted combination: 30% issue close
rate, 30% resolution speed, 20% documentation, 20% CI/CD
presence. The weights are documented in the source
(`src/shared/lib/hygiene.ts`) and the unit test asserts the
weights are exactly what the spec says, because the moment
they drift the score silently changes meaning.

## Where the data comes from

GitHub data, fetched per-repo, on a per-builder basis. The
fetch happens the first time a tracked builder's profile is
opened and the cached repo list is stale. The fetcher
respects GitHub's rate limits, caches the response in Redis
for 24 hours, and falls back to the cached version if the
upstream is unavailable. The fallback is silent — the card
does not surface "the data is 23 hours old" — but the
"last analyzed" timestamp is rendered in the card's detail
view so a curious reader can check.

For non-GitHub builders — GitLab, Codeberg, SourceHut — the
adapter-specific fetcher is not yet wired, and the card
collapses to the "not enough data" state with a small note
explaining why. This is the deterministic fallback. The
"deterministic" part matters: the fallback is the same for
every non-GitHub builder, not a per-source guess that
produces a different "approximately right" number for each
adapter.

For a builder whose GitHub repos exist but are all forks
with no issues, no docs, and no CI, the card also
collapses to "not enough data". The threshold is the
spec's: at least two of the four boolean signals
(README, CONTRIBUTING, LICENSE, CI) must be present for
the card to render a number. Below the threshold, the
card says so.

## What the card deliberately does not do

- **It does not compare across builders.** The score is
  per-builder, not a percentile. A 78 for one builder and
  a 62 for another do not mean the first builder's repos
  are 16% better; they mean the first builder's repos
  close issues at a higher rate and have more docs, full
  stop. The card is a description of the work, not a
  ranking.
- **It does not aggregate across repos without weighting.**
  The global score weights by recency, so a single
  long-dormant repo with hundreds of closed issues does
  not dominate a builder's score. The weighting is in
  the spec, the spec is in the source, and the unit test
  asserts the weighting.
- **It does not predict code quality.** Hygiene is a
  property of the public repos: how they are maintained,
  how issues are handled, how documentation is kept. It
  is not a property of the code itself, and it is not a
  property of the maintainer's engineering skill. A
  maintainer can keep immaculate issues tabs on a small
  library and still write mediocre code, and a maintainer
  can write excellent code on a project with an
  unmaintained issues tab. The card is a description of
  the former, not a judgement about the latter.
- **It does not show fake data when the source is
  unavailable.** This is the rule that the rebuild was
  built around. The previous version showed a number
  every time, because the heuristic always produced one.
  The new version collapses to "not enough data" when
  the data is missing. The card looks emptier in those
  cases. That is the cost of being honest.

## The honest trade-off

A profile with a number on it ranks higher in a recruiter's
eye than a profile with "not enough data" on it, and the
rebuild makes that trade-off consciously. I would rather
recruiters see a 78 that is real than a 91 that is a guess,
and I would rather they see "not enough data" than a 78
that was computed from a name lookup. The trade is the
product's position on the "always show a number" pattern,
and the position is: the number is a property of the data,
not a property of the profile.

This means a few real profiles will look less complete than
they did before. A maintainer of a small library with no
issues tab will see a card with "not enough data" instead
of the 91 they had last year. That is the right outcome,
and it is worth the small loss in visual completeness to
stop putting numbers on profiles that do not earn them.

## How the rebuild went, in one paragraph

The old version was a pure function over builder metadata.
The new version is a fetcher + a pure function over the
fetched repo signals. The fetcher lives in
`src/lib/github/repo-signals.ts`; the pure function lives
in `src/shared/lib/hygiene.ts`; the card component lives
in `src/shared/components/HygieneCard.tsx`. The split is
deliberate: the pure function is unit-tested against a
fixture of repo signals and the card is a thin renderer
on top. The fetcher has its own tests for rate-limit
handling and Redis caching, and the whole chain is
exercised end-to-end in the Playwright suite. None of
that is novel; the only novel part is the discipline of
collapsing the card to "not enough data" when the fetcher
returns nothing useful, which is the rule the rebuild was
written to enforce.

## What the card looks like

For a builder with enough data: a global score, the four
component metrics, a small "last analyzed" timestamp, and
a per-repo list with the same four booleans for each. A
click on a per-repo row opens the repo on GitHub, not a
detour through BuilderHunt. The whole point of the card
is to make the data checkable, and a card that requires
trusting a third-party rendering of the data is not
worth the number it shows.

For a builder without enough data: a small card with
"not enough public activity to compute a project
hygiene score" and a link to the builder's public
GitHub profile. The link is the answer; the card is
honest about not having one of its own.

[Open a profile](/search) — find a builder with real
public repos and look at the card. The number you see
should be traceable to a specific repo's issue close
rate, and a click on the per-repo row should take you
to that repo. If either of those is not true, the card
has a bug, and I want to know.
