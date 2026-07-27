---
title: Building in public — how the roadmap, changelog and status page actually work
description: BuilderHunt's roadmap, changelog and status page are not marketing pages. Here is what is on each of them, how voting changes what I build, and how the content is versioned.
slug: building-in-public-roadmap-changelog-status
date: 2026-07-27
tags: [product, transparency, engineering]
author: edd
---

Most "public roadmaps" are a wishlist with quarters attached, written once and
never revisited. Most changelogs stop when the team gets busy. I want mine to be
load-bearing instead, so they are wired to the same sources of truth I use to
decide what to work on.

## The roadmap is the real backlog, filtered

![The public roadmap board with planned, in-progress and shipped columns](/images/blog/roadmap.webp)

Three columns, and the rules for each are specific:

**Shipped** means the capability exists in production right now and you can use
it. Not "the code is merged", not "it works locally".

**In progress** means work is actively underway and there is a real estimate. Five
things are in this column today, and each of them is honest about what is
missing — interview intelligence has scheduling and a calendar shipped and
transcription and retention still to build; payments have every line of the
checkout system written and are waiting on certification, not on code.

**Planned** means I intend to build it and it has no date. You will notice none of
the planned items carry an estimate. That is not an oversight — a quarter next to
something nobody has started is a guess dressed as a commitment, and the column
order already tells you the sequence I believe in.

Signed-in users can vote, and votes genuinely reorder things. Ten of the current
planned items came out of one round of thinking hard about where the product
stops being useful: a hiring pipeline, an evidence panel on every result,
saved-search health, paste-a-JD matching, a collaboration graph, look-alike
sourcing, availability signals, a browser extension, ATS integrations and public
market reports. Which of those I build first is a question I would rather you
answer than I guess.

## The changelog includes the parts that are not achievements

![The public changelog filtered by tag, showing feature, improvement, bugfix and breaking entries](/images/blog/changelog.webp)

Four tags: `feature`, `improvement`, `bugfix`, `breaking`. The last two are the
ones that make it worth reading.

Some entries currently on it, to give you the flavour: the alerts inbox was
rendering repositories instead of people, which is embarrassing in a product
whose entire pitch is "builders, not repos". Semantic search was not using its
vector index. A restore rehearsal found that `pg_restore` ran before the cluster
roles existed, so every row-level-security policy referencing a missing role was
silently dropped — a restored database that looked complete and had lost its
tenant isolation. And an audit of my own landing page found numbers on it that
nothing measured, so I deleted them.

That last one is a policy, not a one-off. If you find a number in BuilderHunt you
cannot trace to a source, it is a defect and I want the email.

## The status page computes, rather than claims

[/status](/status) records a per-component health snapshot on an interval and
keeps 90 days of them. Uptime on that page is computed from those snapshots.
Incidents are published with their timeline — investigating, identified,
monitoring, resolved — and a severity.

The window is 90 days because that is how long the snapshots are kept. A
"99.99%" badge with no window behind it is a decoration.

## The part that is interesting if you build things

All three of these surfaces used to have the same structural flaw, and fixing it
is the reason this post exists.

Blog posts are markdown files in the repository. Changelog entries and roadmap
items were database rows, created by typing them into an admin panel. Which meant
they existed in exactly one database: not in git, not in a code review, and not
in a backup restored onto a fresh volume. My local site and the live site
disagreed permanently, and the only fix was to retype things.

So they are files now too. `content/changelog/*.md` and `content/roadmap/*.md`,
each with frontmatter, each validated by a parser with a unit test that fails CI
if a status is misspelled or a slug does not match its filename. One command
pushes them into the database, idempotently, and it runs automatically on every
deploy:

```bash
pnpm content:sync          # files -> database, safe to re-run
pnpm content:sync --dry-run
pnpm content:export        # database -> files, for anything drafted in the UI
```

The admin panel still works — drafting an entry in a form is faster than editing
YAML — and rows it creates are left alone by the sync. There is a badge in the
admin UI marking which rows are owned by a file, so nobody is surprised when a
deploy overwrites the one they edited in the browser.

![The admin content hub showing blog posts, changelog entries and roadmap items in one place](/images/blog/admin-content.webp)

*One page for all three surfaces, with the git-owned rows marked.*

There is also a script that drives a real browser against the running app and
writes the screenshots in this post. Every image above is the current product,
not a mockup, and re-running one command refreshes all of them after a redesign.
Marketing screenshots that drift from the product are a slow lie, and the only
reliable fix is to make them cheap to regenerate.

[Vote on the roadmap](/roadmap) — it is the highest-signal thing you can send me,
and it takes one click.
