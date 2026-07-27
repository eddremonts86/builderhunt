---
title: The alerts inbox was showing repositories instead of people
slug: the-alerts-inbox-now-shows-people
date: 2026-07-25
tags: [bugfix, improvement]
---

BuilderHunt's whole premise is builders, not repos. The alerts inbox was showing
repos. When a saved search matched, the digest rendered the repository rows from
the result set rather than the people rows, and the row layout collapsed at
common widths on top of it.

Fixed, and then rethought rather than patched:

- Matches are grouped by the saved search — the "radar" — that produced them, so
  a noisy query is visibly noisy instead of blending into one flat list.
- Each row is a person with the evidence that triggered the match and a direct
  action: open the profile, track them, or dismiss.
- Alert frequency is now honoured. A daily alert delivers once a day; before, the
  frequency field was stored and ignored.
- There is a `PATCH` endpoint for alerts, an unread badge in the nav that
  reflects real unread counts, and a digest-summary AI task for long batches.

If you set up alerts before this and quietly stopped opening them, they are worth
another look.
