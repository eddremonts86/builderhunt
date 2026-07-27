---
title: Semantic search
slug: semantic-search
status: shipped
category: features
ship_estimate: null
order: 310
---

Ranking by meaning rather than keyword overlap, on a pgvector index that is written through from real searches and warmed by a background discovery worker. Every result shows its similarity, and the page tells you which mode answered. Falls back to keyword search on any provider failure instead of failing.
