---
title: SourceHut and Hashnode retired — thirteen sources now
slug: two-sources-retired
date: 2026-08-04
tags: [change]
---

Search now covers **thirteen** sources, down from fifteen. Two were retired on the same day, for
completely different reasons.

**SourceHut** was retired on its operator's terms, not on a technical limit. `git.sr.ht/robots.txt`
states that "anything used to feed a machine learning model" is disallowed. BuilderHunt indexes profiles
into a vector store and feeds AI ranking and explanation, so that sentence describes this product. It is a
statement about the *use*, which means an access token would not have changed the answer — a token records
that someone accepted terms while the excluded use continues.

Separately, and worth saying plainly: the SourceHut connector had **never returned a result**. The
GraphQL field it queried (`users(search:)`) does not exist on meta.sr.ht, and git.sr.ht offers no keyword
search over repositories at all. It failed silently to an empty list, which is indistinguishable from "no
token configured".

**Hashnode** moved its public GraphQL API behind a paid plan. `gql.hashnode.com` now redirects to the
pricing announcement and the older `api.hashnode.com` returns 404. The connector had been returning nothing
since that change, and — the part worth learning from — its API key was documented as *optional*, so a
source returning nothing with no key looked exactly like a source returning nothing because the API had
closed. Any future connector whose key is optional needs a way to tell those two states apart.

Both remain in the source registry, disabled rather than deleted, so their history is still visible and the
decision is reversible with one migration. Nothing else about search changed: no result you were getting
yesterday came from either of them.

Older posts that describe these two as searchable now carry a dated correction rather than an edit. A
changelog records what happened on its date; rewriting one backwards would make it fiction.
