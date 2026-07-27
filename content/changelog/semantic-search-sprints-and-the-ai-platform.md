---
title: Semantic search, AI sourcing sprints, and the platform underneath them
slug: semantic-search-sprints-and-the-ai-platform
date: 2026-07-20
tags: [feature]
---

Three features shipped together because they all needed the same foundation
first.

**The AI platform.** One versioned task registry, called as `ai(taskId, input)`.
Every task declares its schema, and outputs are validated before anything renders
them. Around it: a per-organization budget, a cache, a kill switch that can
disable AI globally or task-by-task, and audit-safe telemetry. Chrome's built-in
on-device AI is the local-first default where it is available; a server-side model
handles work that must be persisted, shared, backgrounded, or embedded. No feature
gets to call a provider directly — a CI check fails the build if one tries,
because a direct call is an unmetered call.

**Semantic search.** A global embeddings table on pgvector with an HNSW index,
written through on every search and track so the index warms from real use.
`/api/search/semantic` ranks by meaning rather than keyword overlap, with a
similarity badge on each result and a notice telling you which mode answered. If
embeddings or the provider fail, it falls back to keyword search instead of
failing the page. Embeddings run in a self-hosted container, locally and in
production.

**AI sourcing sprints.** Paste a job description, get a set of query variants, and
a background worker keeps re-running them until it has filled a result quota — so
sourcing continues while you are doing something else. Free plans get none, Pro
three concurrent sprints, Team ten.

A proactive discovery worker runs alongside them to warm the semantic index for
topics nobody has searched yet, which is what stops a cold index from making
semantic search look worse than keyword search on day one.
