---
title: Three more sources — Bluesky, Product Hunt and Devpost
slug: three-new-sources
date: 2026-07-25
tags: [feature]
---

Fifteen source adapters now ship in BuilderHunt, up from twelve.

- **Bluesky** goes through the public AppView. No key, no OAuth, no rate-limit
  negotiation: a search plus one batch profile call per uncached query, both well
  inside the five-minute search cache.
- **Product Hunt** uses the official GraphQL API and is token-gated. Without
  `PRODUCTHUNT_TOKEN` the source is skipped entirely rather than degrading
  silently, so you can tell the difference between "nobody matched" and "we never
  asked".
- **Devpost** has no API and challenges plain server-side fetches, so ingestion
  runs through a headless-browser worker. It is off unless explicitly enabled.

Two existing sources also got real work: npm search moved off the third-party
npms.io endpoint onto the first-party registry, and GitLab user and project
search is unlocked when a token is present. Hashnode's id prefixes were colliding
with another source's, which could attribute one person's post to another —
fixed.

Sources are per-query, so adding these does not slow down a search that does not
select them.
