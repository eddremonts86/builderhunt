---
title: How the BuilderHunt activity score works
description: The exact heuristics behind the 0-100 number on every search result, what each part is worth, and the four things it cannot tell you.
slug: how-activity-score-works
date: 2026-08-04
tags: [product, transparency, how-to]
author: edd
---

<!--
  DRAFT — not published. The `_` filename prefix is what keeps it out of /blog and the Atom feed:
  `src/shared/lib/blog.ts` filters `_`-prefixed files and **ignores a `draft:` frontmatter key entirely**,
  so `draft: true` would have published this. To publish: review the text, then rename the file to
  `how-activity-score-works.md`.
-->

# How the BuilderHunt activity score works

Every search result on BuilderHunt carries a number between 0 and 100. People reasonably want to know what it means before they act on it, so here is the whole thing.

The short version: **it measures how recently and visibly someone has been shipping in public.** It does not measure how good they are. Those are different things, and conflating them is the main way a number like this gets misused — including by me, when I am tired and skimming a list.

## The five parts, and what each is worth

The score is a sum of five components, each capped, then clamped to 0-100 and rounded.

### Popularity — up to 30 points

Followers, or stargazers for a repository result. It is logarithmic: `log1p(followers) * 3`.

That shape matters more than the cap. A developer with 100,000 followers does not score a hundred times higher than one with 1,000 — they score roughly 1.7× on this component. The log is there specifically so that reach does not drown out everything else, because reach is the weakest of the five signals for the question "is this person building right now".

### Recency — up to 30 points

The most heavily weighted signal, and deliberately a cliff rather than a curve:

| Last activity | Points |
| --- | --- |
| Under 1 day | 30 |
| Under 7 days | 22 |
| Under 30 days | 12 |
| Under 90 days | 5 |
| Under a year | 1 |
| Over a year | 0 |

Someone who pushed yesterday scores 30. Someone who pushed five weeks ago scores 12. That gap is the score's opinion, and it is the one I would defend hardest: for most reasons you are searching, "active in the last week" and "active eighteen months ago" are not close.

**When a source does not expose activity dates at all, the result gets a flat 5 points** instead of 0. Hacker News, DEV.to and Reddit do not reliably give a last-activity timestamp, and zeroing them would rank them below people who are genuinely inactive but happen to be on a source with better metadata. Five is an admission of ignorance, not a measurement.

### Topic match — up to 15 points

Two points per topic, capped at 15. The cap exists because topic lists are trivially gameable: a repository tagged with forty keywords is not more relevant than one tagged with eight.

### Profile quality — up to 6 points

Four for a bio, two for an avatar. Small on purpose. It is a weak proxy for "this person maintains their public presence", and weighting it higher would reward polish over output.

### Source-specific signals — up to 15 points

Every source exposes something different, so each gets its own branch:

- **GitHub** — a 4-point tiebreaker when a repository has substantially more stars than watchers (a ratio above 1.5), because stargazers are already counted in popularity and double-counting them would inflate repositories twice.
- **Reddit** — subreddit active users, `log1p(activeUsers) * 1.5`.
- **Hacker News** — submission count, `log1p(submitted) * 1.2`.
- **DEV.to** — article count, `log1p(articles) * 1.5`.
- **Devpost** — project count, capped at 15. Devpost exposes no follower data at all, so this branch carries more of the weight than elsewhere.

## Four things it cannot tell you

This is the part I would most like people to read, so it is not at the bottom by accident.

**1. It cannot see private work.** Someone doing their best engineering inside a company repository looks inactive here. The score measures *public* output, and a low score frequently means "works somewhere that does not open-source" rather than "does not ship".

**2. It is not comparable across sources.** A GitHub result and a Hacker News result can both score 60 and mean completely different things — one has real commit recency, the other may be carrying the flat 5-point ignorance allowance plus submission volume. Compare within a source, not across.

**3. It rewards visibility, and visibility is unevenly distributed.** Prolific posting scores well. So does maintaining a presence with a bio and an avatar. People who ship quietly, or who are not on English-language platforms, or who do not enjoy self-promotion, score lower for reasons that have nothing to do with capability.

**4. It has no idea whether the work is good.** There is no code quality dimension. There cannot be one from this data. A score of 90 means "highly visible and recently active", full stop.

## Why publish the formula at all

Two reasons.

An opaque score invites people to treat it as authority. A published one invites them to argue with it, which is the correct relationship to have with a heuristic. If you read the recency table above and think the 7-to-30-day cliff is too steep for your kind of search, you are now equipped to ignore it — and that is a better outcome than trusting it blindly.

And it keeps me honest. The weights above are not aspirational; they are what `src/lib/score.ts` does today. If I change them, this post has to change, and someone can check.

---

*Draft — the score components and weights are read from `src/lib/score.ts` as of 2026-08-04. Re-check them before publishing if the file has changed since.*
