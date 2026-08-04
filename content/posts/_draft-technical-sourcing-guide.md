---
title: The solo founder's guide to technical sourcing
description: A process for finding engineers when you have no recruiter, no budget and no network — and the four judgement calls that decide whether it works.
slug: technical-sourcing-guide
date: 2026-08-04
tags: [sourcing, how-to, founders]
author: edd
---

<!--
  DRAFT — not published. The `_` filename prefix is what keeps it out of /blog and the Atom feed:
  `src/shared/lib/blog.ts` filters `_`-prefixed files and ignores a `draft:` frontmatter key entirely.
  To publish: review, then rename to `technical-sourcing-guide.md`.

  Deliberately tool-agnostic, per the plan's brief. BuilderHunt appears twice, both times as a worked example
  of a trade-off rather than a pitch, and every claim about it is checkable in this repository. If you want a
  harder sell, that is an editorial decision — but the piece is more useful to the reader as it stands, and a
  guide that turns into an advert stops ranking for the query it was written for.
-->

# The solo founder's guide to technical sourcing

You need an engineer. You have no recruiter, no agency budget, and a network that is mostly people who do what
you do. This is the process I use, written so it works with a spreadsheet and a browser — the tooling is the
easy part and the last thing you should worry about.

The hard part is four judgement calls. Everything else is mechanics.

## First, write down what you actually need

Not a job description. Two or three sentences a stranger could use to reject themselves.

"I need someone who has shipped a payments integration end to end, alone, and can tell me what went wrong the
first time." That is a searchable statement. "Senior full-stack engineer, 5+ years, team player" is not — it
describes a category, and categories are where every founder looks, which is exactly why they are crowded.

**The judgement call:** be specific enough to exclude most people. If your description does not make you
slightly nervous about how few people match, it is not doing any work.

## Then look where the evidence is, not where the people are

Job boards give you people who are looking. Public work gives you people who are *doing*. Those are different
populations and the second one is much larger.

Where the evidence lives, roughly in order of how much signal per minute of reading:

- **Code hosts** (GitHub, GitLab, Codeberg) — actual commits, actual review comments, actual abandoned
  branches. The best signal available, and the most over-read: everyone looks here, so the obvious profiles
  are contacted constantly.
- **Q&A archives** (Stack Overflow) — badly underused. The top answerers for a narrow tag are specialists in
  that tag, not generalists who touched it once. If you need someone who genuinely knows Postgres locking, the
  people who have explained Postgres locking forty times are right there, sorted.
- **Writing** (personal blogs, DEV.to, Lobsters, Hacker News comments) — the only place you find out how
  someone *thinks*, which is what you are actually hiring. Slower to read, highest ceiling.
- **Registries** (npm, Hugging Face) — maintainership is a strong signal of follow-through, because packages
  are boring to maintain and people quit.

**The judgement call:** pick two of these and go deep, rather than skimming all of them. Depth in Stack
Overflow answers will find you someone nobody else has contacted. Breadth finds you the same twenty profiles
everyone else found.

## Judge recency separately from reputation

This is the mistake I see most, and I built a product that makes it easy to make.

Followers, stars and karma measure *accumulated* reputation. They are lagging indicators and they compound, so
someone who was prolific three years ago outranks someone shipping steadily today. If you need someone
available and engaged now, recency is the signal and reputation is the distraction.

Concretely: I weight "active in the last week" far above "active eighteen months ago" — in BuilderHunt's
activity score, a push yesterday earns 30 points and a push five weeks ago earns 12, and follower count is
logarithmic specifically so reach cannot drown that out. Whether you use a tool or a spreadsheet, encode that
same asymmetry, because your instincts will not.

**The judgement call, and it cuts both ways:** low public activity often means "works somewhere that does not
open-source", not "does not ship". Recency tells you who is visible, and visibility is unevenly distributed —
by employer, by language, by whether someone enjoys self-promotion. Use it to *rank* your list, never to
reject someone outright.

## Assume one person is one person, and verify it

Sourcing tools — mine included — collapse duplicate records so your list is not full of the same human three
times. The dangerous version of that is merging by username, on the assumption that one handle is one person.

Across independent platforms it is not, and I learned this the expensive way. `github:alice` and `hn:alice`
were merged into one record, which produced a profile that was a composite of two strangers, scored one of
them against the wrong platform's curve, and — worst of all — made the losing record **disappear from
results entirely**. A real, distinct developer became unfindable because someone else had taken the same
handle first. Nobody reports the search result they never saw.

**The judgement call:** before you contact anyone, confirm the profiles you have stitched together are the
same human, and require real evidence — a link one profile makes to the other, a shared verified email, a
statement by the person themselves. Not a matching name. Never a matching handle.

## Then write to them like a person who read their work

I will not give you a template, because the template is the problem. The only thing that reliably works is
evidence that you looked: name the specific thing they built, say what you noticed about *how* they built it,
and make the ask small and concrete.

If you cannot write two sincere sentences about someone's work, you have not done the sourcing yet. Go back to
the list.

---

## The mechanics, briefly

If you want to do this with no tools: a spreadsheet with one row per person, columns for where you found them,
the specific evidence, the date of their last visible activity, and whether you have written to them. Sort by
last activity. That is 80% of what any product gives you.

What tooling buys you is the boring part — searching a dozen sources at once, deduplicating carefully rather
than crudely, and remembering who you already contacted. It does not buy you the four judgement calls above,
and any tool that claims to make them for you is selling you a number to hide behind.

---

*Draft. BuilderHunt-specific claims map to `src/lib/score.ts` (the recency weights and the logarithmic
follower curve) and `src/lib/dedup.ts` (the username-merge failure and its fix), both as of 2026-08-04.*
