---
title: "Saved searches as a hiring radar: a setup tutorial"
description: How to turn a one-off developer search into a standing radar that tells you when someone new matches — and what the radar does and does not watch.
slug: saved-search-hiring-radar
date: 2026-08-05
tags: [tutorial, alerts, sourcing]
author: edd
---

<!--
  DRAFT — not published. The `_` filename prefix is what keeps it out of /blog and the Atom feed:
  `src/shared/lib/blog.ts` filters `_`-prefixed files and ignores a `draft:` frontmatter key entirely.
  To publish: review, add the screenshots noted below, then rename to `saved-search-hiring-radar.md`.

  Every route, field label and dropdown option below was read out of the source, not remembered:
    /search           src/modules/search/components/SearchPage.tsx  ("Save search", "Name this search...")
    /alerts           src/routes/_dashboard/alerts.tsx              ("New radar", "Radar name",
                      "File matches as…", "Using tech… (comma-separated)", "Min stars / followers",
                      "Delivery", "Digest frequency", "Paused")
    delivery options  "Email digest + dashboard" | "Dashboard only"
    frequency options "Hourly" | "Daily digest" | "Weekly digest"

  SCREENSHOTS STILL NEEDED (the plan asks for current ones, and they need a signed-in session):
    1. /search with a query typed and the "Save search" control visible
    2. /alerts with the "New radar" form open
    3. /alerts showing one radar with matches in it
  Everything else in this post is verified against the code as of 2026-08-05.

  One thing this post deliberately does NOT do: sell the radar as event detection. It is not, and
  saying so is the whole reason the dropdown labels were rewritten the same day this was drafted.
-->

# Saved searches as a hiring radar: a setup tutorial

Most sourcing is re-running the same search. You find three good people on Tuesday, you contact two,
and the following Tuesday you type the same keywords again to see whether anyone new turned up.

That loop is worth automating, and it takes about four minutes. Here is the setup, and — more useful
— an honest account of what the radar watches, because that determines whether it is the right tool
for what you are doing.

## Step 1 — get one search right first

Go to **/search** and type the keywords you actually mean. Two or three is the sweet spot: `rust`,
`async`, `tokio` finds people working in that corner; `developer` finds everyone.

Use the source pills to narrow to a platform if you know where your people are. If you do not know,
leave them all on — the point of searching thirteen sources at once is that you do not have to guess.

**Do not skip to step 2 until this search's first page is genuinely good.** A radar is a saved search
that keeps running, so a mediocre search becomes a mediocre notification, forever, and you will
learn to ignore it. That is the actual failure mode — not missing candidates, but training yourself
to skim past the digest.

## Step 2 — save it

With results on screen, use **Save search**, give it a name in the **Name this search...** field, and
save. It appears under your saved searches, and re-running it is one click.

Name it after the *role*, not the query. "Rust async runtime builders" tells you what it is for six
weeks from now; "rust async tokio" makes you re-read the keywords to remember why you saved it.

## Step 3 — turn it into a radar

Go to **/alerts** and use **New radar**. The form has six fields, and two of them decide whether
this works:

- **Radar name** — same advice as above. This is the subject line you will be scanning.
- **File matches as…** — a label for your inbox. Read the next section before you assume it does more
  than that.
- **Using tech… (comma-separated)** — the keywords. Start with the same ones that made step 1 good.
- **Min stars / followers** — a floor, not a ranking. Leave it at 0 the first week. Set it only after
  you have seen what the unfiltered stream looks like, because a floor you guess at will silently
  remove the exact people you claim to want: someone who ships steadily at a company that does not
  open-source has a low follower count and a strong profile.
- **Delivery** — **Email digest + dashboard**, or **Dashboard only**.
- **Digest frequency** — **Hourly**, **Daily digest**, or **Weekly digest**.

**Pick Weekly digest first.** You can always tighten it. Hourly on a broad radar is how you end up
with a filter rule that sends the whole thing to a folder you never open.

## What the radar actually watches — read this part

This is the bit most tutorials would leave out, and it is the bit that determines whether the tool
fits your problem.

A radar **re-runs your keyword search and reports profiles it has not shown you before.** That is the
whole mechanism. It is genuinely useful: it is the Tuesday loop, automated, deduplicated per radar so
you never see the same person twice.

What it does **not** do is watch individual people for activity. BuilderHunt has no per-builder event
stream yet, so a radar cannot tell you "this person pushed a repo this morning" or "this person
posted that they are looking". The **File matches as…** options — Any match, New repository, New
product launch, Keyword match — are labels you can file matches under, to organise your inbox. They
are not events the product detected.

I am spelling that out because the dropdown used to be written the other way round. Its options read
"A developer launches a new repo" and "A candidate posts about looking for roles" — sentences that
describe things nobody was watching for. The worst of them paired the new-repo wording with the
setting that matches *everything*, so the option you would pick to narrow down to repos was the one
that could never be narrowed. Those labels are corrected now, and this post exists partly so the
capability is described the same way in both places.

Real per-builder event detection is planned — it needs an activity timeline per person, which is a
different piece of work. Until then, a radar is a standing search, and a standing search is the right
mental model for how to use it.

## Step 4 — run it for a week before you tune it

Leave it alone for seven days. Then look at the digest and ask two questions:

**Am I opening it?** If not, the radar is too broad or too frequent. Tighten the keywords first, the
frequency second. Raising **Min stars / followers** is the last thing to try, not the first — it is
the change most likely to remove people you wanted.

**Did anything in it surprise me?** If every match is someone you would have found anyway, the
keywords are describing a category rather than a capability. "Senior backend" is a category.
"Postgres locking" is a capability, and it will surface people no category search reaches.

A radar you can **Paused** and come back to is better than one you delete: pausing keeps the dedupe
history, so resuming does not re-show you everyone it already reported.

## Two or three radars, not ten

The temptation is one radar per role. Resist it. Overlapping radars mean the same person arrives in
three digests, and dedupe is per-radar, so it cannot help you across them.

Two or three well-shaped radars, each pointed at a capability you can describe in a sentence, will
out-perform ten that all say "developer" with different adjectives.

---

*Verified against the running app on 2026-08-05: every route, field label and dropdown option above
is read from `src/modules/search/components/SearchPage.tsx` and
`src/routes/_dashboard/alerts.tsx`. The description of what a radar watches matches
`src/lib/alerts/worker.ts` and `src/shared/lib/alerts.ts`.*
