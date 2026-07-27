---
title: Sourcing that keeps working after you close the tab
description: How AI sourcing sprints and semantic search actually work in BuilderHunt — what runs in the background, what a credit pays for, and what happens when the model is unavailable.
slug: sourcing-sprints-and-semantic-search
date: 2026-07-27
tags: [ai, sourcing, guide, engineering]
author: edd
---

Keyword search has a specific failure mode. You type "rust async runtime", get a
page of results, refine it four times, find two good people, and then close the
tab. The other twelve good people were on page six, or they published on
Thursday. Search is a snapshot, and sourcing is not a snapshot problem.

Two features in BuilderHunt attack that from different sides.

## Semantic search: matching meaning, not spelling

Every builder BuilderHunt sees gets an embedding — a numeric representation of
what their public work is *about* — stored in Postgres with pgvector. Your query
gets the same treatment, and ranking becomes "closest in meaning" instead of
"most keywords in common".

In practice that means "someone who makes databases go faster" finds people who
have never used the word "performance", and "distributed systems in Go" finds the
person whose bio says "consensus protocols".

Three implementation details that matter to you as a user:

**The index warms from real use.** Every search and every track writes through to
the embedding index, and a background discovery worker seeds topics nobody has
searched yet. A cold vector index is worse than keyword search — this is why
ours is not cold.

**It tells you which mode answered.** Each result carries a similarity value, and
the page says whether you are looking at semantic or keyword results. You are
never guessing which engine produced the list.

**It degrades instead of failing.** If the embedding provider is unavailable or
your organization's AI budget is spent, the query falls back to keyword search
and says so. A sourcing tool that returns an error page because a model was busy
is a sourcing tool you stop opening.

One honest engineering note, because it is the kind of thing that stays hidden
otherwise: for a while our semantic queries were doing a sequential scan over
every embedding. The `ORDER BY` wrapped pgvector's distance operator in an
expression, and the HNSW index only serves an order-by on the bare operator. Our
latency graph never noticed, because at this index size a sequential scan is
fast enough to look healthy. The graph proved the page felt fast; it could not
prove the index was used. Reading `EXPLAIN` proved otherwise. It is fixed, and
[the changelog entry](/changelog/semantic-search-uses-the-vector-index) has the
detail.

## Sourcing sprints: search that runs while you do something else

A sprint is the other half. You give it a job description, it derives a set of
query variants, and a background worker keeps executing them until it has
filled a result quota.

![The sprints page listing active sprints with candidate counts and last-run times](/images/blog/sprints.webp)

*Each sprint reports how many candidates it has found and when the worker last
ran it.*

The design choice that makes this useful is that it is *not* interactive. You do
not sit and watch it. You start it, close the tab, and come back to a set of
candidates with the evidence attached. Sprints are gated by plan — Free gets
none, paid plans get a number of concurrent sprints listed on
[/pricing](/pricing) — because each one is a worker doing real work against real
APIs on a schedule.

## What a credit is, and why the feature is metered

Everything above that calls a model costs a credit. So do work-sample analysis,
code fingerprinting v2, and team-fit analysis. Search over public sources does
not: that is HTTP requests and a cache, and it is included in every plan
including Free.

We meter the model-backed features for a boring reason: they have a real
per-request marginal cost, and a plan priced only on "how many saved searches"
cannot absorb that honestly. The alternative is either a much higher flat price
for everyone or a quiet quality reduction when someone uses the feature a lot,
and both are worse than a number you can see.

Some structure around it, so it cannot surprise you:

- Every AI task goes through one registry, with a declared schema, and its output
  is validated before anything renders it. A model cannot invent a field the UI
  then presents as fact.
- There is a per-organization budget and a cache. Two people on your team asking
  the same question about the same candidate pay once.
- There is a kill switch, globally and per task. If a provider misbehaves, the
  feature turns off and the non-model rungs keep working.
- A CI check fails the build if new code calls a provider directly instead of
  through the registry — an unmetered call is a bug, not a shortcut.

## Where the model is deliberately not in charge

Work-sample analysis reads a candidate's public repositories and gives you a
structured review: what the code does, what it suggests about how they work,
what to ask them about. It will not give you a hire/no-hire verdict. That is an
explicit prohibited output in the domain contracts, not an omission we will get
around to.

A model that has read three repositories is not qualified to make that call. You
are. The job of this software is to get you to the point where you can, faster
than reading 200 applications would.

[Try a search](/search) and save it — the free tier covers the loop, and you can
add a sprint later when a background worker is worth paying for.
