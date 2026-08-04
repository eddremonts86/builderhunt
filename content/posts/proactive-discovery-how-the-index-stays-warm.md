---
title: How the semantic-search index stays warm before anyone searches
description: A look at the proactive discovery worker — what it walks, how it stays polite to upstream APIs, and why a warm vector index is what makes semantic search feel right on day one.
slug: proactive-discovery-how-the-index-stays-warm
date: 2026-08-05
tags: [ai, engineering, infrastructure]
author: edd
---

There is a moment in every vector-search product's life when someone types a
query, gets back a result, and wonders why the system is so much worse than
keyword search. The answer is almost always the same: the index is cold.
Nobody has asked about this topic yet, so there is no signal in the
embedding store, and the model is searching a near-empty space.

BuilderHunt's solution to that problem is a small background worker that runs
on a cron cadence, walks a static matrix of cells, federated-searches each
one, and write-throughs the people-shaped results into the global embedding
table. No model calls. No per-user writes. Pure infrastructure, deliberately
boring.

This post is about what that worker does, why it has to exist at all, and
the constraints that shaped it.

## The cold-index problem, in one paragraph

A search-by-meaning system matches the user's query against an embedding
table. Each row is a vector representing one builder's public work, derived
from the topics, the bio, the languages and the highlights. A query gets the
same treatment and ranking becomes "closest in meaning" instead of "most
keywords in common".

That only works if the table is populated. The table fills naturally when
users search, because every result is written through to the index. But
"naturally" only covers topics people have already searched. The first
recruiter to ask about "WebAssembly component model" finds a near-empty
embedding space, because nobody has asked before, and the model has nothing
useful to compare against. Keyword search wins that round, and the recruiter
stops opening the semantic tab.

The fix is the same fix cold caches always get: pre-warm them.

## What the worker actually does

The matrix is a curated list of cells. Each cell is one
`(keywords, sources)` pair — a topic plus a small group of source adapters.
A run walks a few cells (currently two, on a 15-minute cadence) and for each
cell does the same federated search a real user would have done. The people
results are written through to `builder_embeddings` via the same
`upsertEmbeddingStubs` helper that real searches use. The next time someone
asks, the index already has rows.

The matrix is built once at module load from two constants:

```ts
const TOPICS: Array<{ slug: string; keywords: string[] }> = [
  { slug: 'rust', keywords: ['rust'] },
  { slug: 'go', keywords: ['go', 'golang'] },
  { slug: 'react', keywords: ['react'] },
  { slug: 'vue', keywords: ['vue'] },
  { slug: 'python', keywords: ['python'] },
  { slug: 'machine-learning', keywords: ['machine learning', 'ml'] },
  { slug: 'llm', keywords: ['llm', 'large language model'] },
  { slug: 'devops', keywords: ['devops'] },
  { slug: 'embedded', keywords: ['embedded systems', 'firmware'] },
  { slug: 'security', keywords: ['security', 'appsec'] },
  { slug: 'data-engineering', keywords: ['data engineering', 'etl'] },
  // ... thirty topics in total, spanning languages, frameworks, domains.
]
```

```ts
const SOURCE_GROUPS: Record<string, SourceName[]> = {
  code: ['github', 'gitlab', 'codeberg'],
  community: ['hn', 'reddit', 'lobsters'],
  content: ['devto', 'stackoverflow'],
  registries: ['npm', 'huggingface'],
}
```

The matrix builder takes each topic, pairs it with two adjacent source
groups (rotated by index so no topic repeats a group and every group gets
exercised roughly evenly), and emits two cells per topic. Sixty cells total.
At two cells per run on a 15-minute cadence, a full walk takes about seven
and a half hours, which is the design point: a topic gets re-walked roughly
twice a day, and any new person appearing in the upstream sources is
re-embedded within that window.

## Why the pacing math is what it is

Each cell is a federated search against three to four upstream sources.
BuilderHunt's adapters are polite — they respect per-source rate limits, they
back off on 429, and they cache the response for five minutes. The matrix
walk is sized so that a 15-minute run with two cells touches at most eight
upstream source calls in parallel, well under the per-source rate ceiling
even if all 58 plans in phase-1 happened to be running their own workers at
the same time. This is one of the reasons the worker runs on a cron rather
than on a queue: a queue can burst, and a bursty worker is how you get
upstream rate-limited and silently stop indexing new builders.

The worker also has a per-day stub cap. The matrix walk is meant to be
endless — it is a 60-cell ring, not a finite backlog — but each stub written
to the embedding table costs an upstream call, and a runaway worker is more
expensive than a slow one. The cap is generous (a few thousand stubs per
day) and exists so a config bug cannot turn a warm-up into a flood.

## What gets written and what does not

Only `kind === 'person'` results are upserted. Repository-shaped results
have no business being in a builder-embedding table — the entire pitch of
the product is "builders, not repos", and the discovery worker is the
strictest place to enforce that. If a cell returns three people and two
repos, two stubs get written and two do not. The repos surface in the
search UI as usual, but they do not pollute the index.

The stubs are *stubs*, not full embeddings. They contain the minimum
required for the embedding-table schema: the identity triple
(`source`, `sourceId`, `username`), the embedding vector, and the
enriched-at timestamp. The full builder record is filled in lazily when a
real user opens the profile, because the discovery worker has no idea which
fields a real user will care about and no budget to compute them all
upfront.

## What happens when the worker is not running

If the worker stops — a deploy, a crashed process, a missed cron — the
index goes cold. The first users searching in that window get the worse
results. There is a unit test that fails CI if a real user's semantic
search ever falls back to keyword search without a warning attached, so
the symptom is visible, but the right answer is to fix the worker, not to
silently degrade. The worker has its own health check, exposed on the
admin metrics page, that shows the last run time and the cursor position.
A blank "last run" cell on that page is the page-level equivalent of a
pager.

## What this does not do

It does not learn which topics recruiters actually care about. The matrix
is curated. It does not weight the cells by traffic. It does not skip
topics that have not produced a result in weeks. Those are reasonable
features and they are not built, because the worker is a fixed-cost piece
of infrastructure whose job is to be always running, not to be clever.
Cleverness is what the discovery layer is for once it grows beyond a single
file; right now it is a single worker file and a static matrix, and that
is the right size for the problem.

The matrix also does not cover every topic. There are 60 cells, not 6,000.
If you search for "PostgreSQL planner internals" and we have a "databases"
cell but not a "planner" cell, you may still see cold-index results for
that query. The worker is a warm-up, not a guarantee. The guarantee is
that the first page of the most common searches is warm on day one.

## Why this is not "AI"

It is worth being clear about this because the worker is part of the same
feature surface as semantic search and the AI task registry, and an
outsider reading the roadmap could reasonably confuse the two. The worker
calls no model. It makes no embedding call itself; the upsert helper
handles that as part of writing the stub. It does not decide what to walk —
the matrix is hard-coded. It does not prioritise or skip. The most you can
say is that it produces a useful side effect for the AI features, and
that's a fine reason for it to exist.

A model that decides "this topic is too niche to warm" is a model that
decides who gets good results before they ask. That is a different
product, and one I am not interested in building. The matrix is the
honest version of "we decided these topics are worth pre-warming, in
these proportions", and you can read the matrix file and disagree with
the choices.

[Run a semantic search](/explore?q=postgres+performance) and see the
index working against real upstream data. The fact that it is warm is the
only reason that page renders the way it does.
