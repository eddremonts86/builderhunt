---
title: One username is not one person, and other things aggregating developer profiles taught me
description: The deduplication bug that merged strangers into single profiles, why it also corrupted their scores, and what I stopped trying to do about it.
slug: lessons-indexing-developers
date: 2026-08-04
tags: [engineering, data, postmortem]
author: edd
---

<!--
  DRAFT — not published. The `_` filename prefix is what keeps it out of /blog and the Atom feed:
  `src/shared/lib/blog.ts` filters `_`-prefixed files and ignores a `draft:` frontmatter key entirely.
  To publish: review, then rename to `lessons-indexing-developers.md`.

  TITLE CHANGED FROM THE PLAN, deliberately. The task called this "What I learned indexing 10,000
  developer profiles" while also instructing "do not invent scale metrics". There is no 10,000: the
  largest real figure is 459 `builder_identities` in a development database, and production holds 12
  builders. Publishing that headline would have been a fabricated claim in the first five words, and
  the task's own Verify line requires every quantitative statement to have evidence. If you want a
  number in the title, use one you can point at.
-->

# One username is not one person, and other things aggregating developer profiles taught me

BuilderHunt reads public developer activity from a dozen platforms and puts it in one list. The hard part is not fetching. It is deciding when two records are the same person — and the most useful thing I have learned is how confidently wrong a simple answer to that can be.

## The bug: `alice` is not `alice`

For a long time, deduplication keyed on the lowercased username. If GitHub returned `alice` and Hacker News returned `alice`, they collapsed into one builder.

The reasoning was that one username is usually one person. Across independent platforms, that is simply not true — and the failure was not one bug but three, stacked.

**Strangers were shown as one person.** The merged record carried one person's follower count, the union of both their topics, and a metadata blob mixed from both. Anyone reading that profile was reading a composite of two humans.

**Their scores were computed against the wrong curve.** This is the part I did not see coming. The scoring function picks its branch from the record's `source`, and the merge kept whichever source was seen *first*. GitHub connectors are dispatched first, so a Hacker News account that lost a merge was scored against GitHub's stargazer curve — a formula that has nothing to do with the data it was applied to.

**And the loser disappeared.** The record that lost the merge was dropped from results entirely. A real, distinct developer became unfindable because someone else on another platform had taken the same handle first. That is the failure I find hardest to forgive, because it is invisible: nobody reports the search result they never saw.

## The fix was to stop guessing

The key became `source:sourceId` — so `github:alice` and `hn:alice` are two records, because they are two accounts. Merging now only fires when the *same* account arrives twice, which happens legitimately: a connector returning it on two pages, or two keyword queries overlapping. In that case combining is correct, and the merge takes the richer value of each field.

What I deliberately did not do is replace the bad heuristic with a cleverer one. Cross-platform identity is a real problem with real evidence requirements — a shared verified email, a link one profile makes to another, an explicit claim by the person themselves. It needs reversible merges and a review queue for anything probabilistic, because a wrong merge is a claim about a human being.

That work exists separately. It is not something a string comparison gets to do silently in a hot loop.

## Three things I would tell anyone building this

**Ambiguity is not a tie to be broken.** The instinct when two records might be the same is to pick a rule and move on. But an unresolved identity is information, and collapsing it destroys that information silently. Keeping both records and saying "these might be the same person" is almost always better than picking one.

**Watch what a merge carries with it.** The username bug would have been merely wrong if it only affected display. It became corrupting because `source` was load-bearing somewhere else entirely — in the scoring branch. When you merge two records, audit every field that any downstream code branches on.

**Silent data loss is the expensive kind.** Every other failure mode here was visible: a strange profile, an odd score, something you could screenshot. The dropped record produced no artifact at all. When you are building an index, the results nobody sees are the ones to instrument first.

## What I still do not know

Whether the same-handle collision was rare or common in practice. The data to answer that — how many pairs of records across sources shared a handle — was destroyed by the merge that caused the problem. I can prevent it going forward; I cannot measure what it cost.

---

*Draft. The deduplication behaviour described here is `src/lib/dedup.ts` and the scoring-branch interaction is `src/lib/score.ts`, both as of 2026-08-04. Every claim above is traceable to those two files or to this repository's history; nothing here is estimated.*
