---
title: Semantic search was not using the vector index
slug: semantic-search-uses-the-vector-index
date: 2026-07-25
tags: [bugfix]
---

Semantic search worked. It was also doing a sequential scan over every embedding
on every query, because the `ORDER BY` wrapped the pgvector distance operator in
an expression, and pgvector's HNSW index only serves an order-by on the bare
operator.

Ordering by the bare operator fixes it. Worth recording alongside the fix: our
p95 latency metric did not catch this and could not have. At the current index
size a sequential scan is fast enough to look healthy, so the metric stayed
green while the query plan was wrong — the graph proved the page felt fast, not
that the index was used. Verifying an index is used means reading `EXPLAIN`, not
reading a dashboard.

Semantic search still degrades to keyword search on any embedding or provider
failure, which is why nothing looked broken while this was broken.
