---
title: The unified activity timeline — what it is, what it isn't, and why it is not a feed
description: A walk-through of the per-builder timeline on BuilderHunt — the sources it merges, the shape of the merge, the read-through cache, and why this is not a stream you watch.
slug: unified-builder-timeline
date: 2026-08-08
tags: [product, engineering, guide, sourcing]
author: edd
---

A builder's public work is spread across a dozen services. The
last meaningful activity is the thing you actually want to see
when you open a profile, and the dozen services are the reason
you usually cannot see it: you open the GitHub tab and miss
the post on DEV.to, you open the DEV.to tab and miss the npm
release, you open the npm tab and miss the answer on Stack
Overflow.

The unified timeline is the feature that fixes that. It is a
single, time-ordered list of public activity for one builder,
with each row linked to the original. It is not a stream. It
is not a notification. It is a description of what the
sources actually said, in date order, with no scoring on top.

This post is about the design choices that make it a
description rather than a stream, and the parts of the system
that exist specifically to keep the two honest.

## What the timeline shows

The last ~30 public events for a builder, drawn from every
source the indexer reads. The exact mix depends on the
builder: a GitHub-heavy backend engineer gets pushes,
releases, and merged PRs; a Stack Overflow veteran gets
answers and accepted answers; an active DEV.to writer gets
posts and series updates. The list is deduplicated by URL
within a source (so a package release does not appear three
times because the indexer saw it three times) and merged
across sources by date.

Each row carries:

- A short type label (`push`, `release`, `pr`, `answer`,
  `post`, `package`).
- The date the source reported, in UTC.
- A title, taken from the upstream and truncated if it is
  too long.
- A single link, to the original.
- A source badge, so a reader can see at a glance which
  service the row came from.

That is the full row. There is no engagement metric, no
"trending score", no count of reactions, no thumbnail. The
row is a record of something the builder did, attributed
to the source, and the link takes you to the original
where the engagement metrics live if you want them.

## What it deliberately does not do

- **It is not a feed.** There is no "newer than the last
  fetch" logic, no push notifications, no realtime stream.
  The timeline is computed on read, and a builder who has
  not been fetched recently has a timeline with the last
  fetch's data. The freshness of the timeline is the
  freshness of the source adapters, and the source
  adapters are documented in their own per-source blog
  posts.
- **It is not a ranking.** Events are sorted by date, not
  by importance. A merged PR to a popular repo is on the
  same row as a comment on a small one, and a starred
  answer on Stack Overflow is on the same row as an
  un-starred one. The point of the timeline is to make
  the activity checkable; ranking is a different question
  and a different feature.
- **It is not personalised.** Everyone who opens the same
  builder's profile sees the same timeline. There is no
  per-recruiter weighting, no "show me only the events
  that match my saved searches", no per-org filter. The
  timeline is the public activity, in public order, and
  any filtering on top would be a different surface.
- **It is not a substitute for the sources themselves.**
  The timeline exists to point you at the right source on
  the right day. Reading the timeline and never clicking
  through is a worse outcome than not opening the profile
  at all, because the timeline is a summary and the
  summary is lossy by design.

## How the merge works

The timeline is composed per request. For a builder, the
system:

1. Resolves the builder's tracked-builder row, including
   the source identity triple.
2. Fans out to each per-source timeline fetcher that
   applies to the builder (a Reddit-only builder does not
   need a GitHub fetcher call, and the system skips
   fetcher calls whose source is irrelevant to the
   builder).
3. Each fetcher returns its own list of
   `{date, type, title, url, source}` records, normalised
   to a shared shape. The fetcher is responsible for the
   date — that is the source's own timestamp, not a
   BuilderHunt-observed timestamp.
4. The merge step sorts by date, deduplicates by URL
   within a source, and slices the result to the most
   recent 30 rows.

Each per-source fetcher is a small module under
`src/lib/timeline/fetchers/`, and the shared shape is
defined in `src/lib/timeline/types.ts`. Adding a new source
to the timeline is one new fetcher file and a one-line
registration in the orchestrator. The merge step does not
need to change.

## Why it is computed on read, not on a schedule

The fetcher results are read-through cached, not
durable-stored. There is no `builder_timeline_events` table
holding rows; there is a Redis cache keyed by builder id
with a short TTL, and the next read after expiry re-runs
the fetchers.

The reasoning is the same as the team-fit analysis: a
durable timeline would be wrong more often than it would
be useful. A builder publishes a new post at 10:00, the
durable timeline does not see it until the next ingestion
run at 14:00, and the recruiter who opened the profile at
10:30 saw a stale timeline. The read-through cache means
the recruiter who opens the profile within the cache TTL
sees the cached result, the recruiter who opens it after
the TTL sees a fresh result, and the recruiters in
between are a measurable but small fraction of the total.

The trade-off is honest: the read-through path costs more
on cache miss than a durable table read, and the cache
miss path is the common case for builders who have not
been opened recently. The cost is real but bounded — each
fetcher respects per-source rate limits, and the worst
case is a fan-out to 15 sources for one builder, which is
exactly the same fan-out the search product does for
federated queries.

## How the cache invalidation works

The cache TTL is short — currently 30 minutes — and there
is no explicit invalidation path. The trade-off is
deliberate: a real-time invalidation path means watching
the source webhooks and updating the cache, which is a
per-source integration for each of the 15 sources, and
the marginal freshness gain over 30 minutes is small. A
recruiter opening a profile within 30 minutes of the
builder's last activity gets the cached version; a
recruiter opening it after 30 minutes gets a fresh
result.

If you want fresher data, the timeline exposes a
"refresh" affordance on the profile page that bypasses the
cache and re-runs the fetchers. The affordance is
rate-limited to a few refreshes per user per hour so it
cannot be used as a DoS vector against the upstream
sources. For the use case the feature is built for —
"is this person active?" — the 30-minute TTL is more
than fresh enough.

## What the timeline looks like in practice

![A builder profile with a 30-row timeline of public activity, sorted by date, each row linked to the original source](/images/blog/timeline.webp)

*The timeline sits below the persona card and the
code-style card on the profile detail view. Each row
links to the original, and the source badge tells you
where the row came from.*

A useful property of the rendering: a builder with
activity across multiple sources has a timeline where
the sources are interleaved by date, not grouped by
source. The interleaving is the point. A grouped view
makes it easy to miss the DEV.to post that landed the
same day as a GitHub release; an interleaved view
surfaces the timing at a glance.

## What this looks like for the builder who is being indexed

For builders, the timeline is the second most important
surface on the page after the curated portfolio block.
It is the answer to the question "what does BuilderHunt
say I have been doing?" and it is the one a builder
should look at first to decide whether to claim and
curate the profile.

The timeline cannot be edited by the builder — it is
what the sources actually reported, in date order, with
no scoring. The builder who wants to influence it
influences it by publishing more (or less) in the
sources the indexer reads. The timeline is a description
of public activity, and the public activity is the
builder's to author.

## Why this is the foundation of every "are they active" question

The persona card, the team-fit analysis, the code
fingerprint — all of them sit on top of the same
public-work signal the timeline surfaces. The timeline
is the one place where a recruiter can see the
underlying signal without a model's interpretation on
top, and that is the design point. Every other
"AI-generated summary of the candidate" feature is
useful, and every one of them is also a layer that can
be wrong, and the timeline is the place to check
whether the layer is wrong. The check is one click
away, and that is the property the feature exists to
provide.

[Search for a builder](/search) and look at the
timeline. The point of the page is that the timeline
is the answer, and the AI cards are the orientation.
The orientation is what makes the page fast; the
timeline is what makes the page honest.
