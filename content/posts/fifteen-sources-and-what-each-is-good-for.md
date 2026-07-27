---
title: Fifteen sources, and what each one is actually good for
description: BuilderHunt now reads fifteen public sources. A practical guide to which ones to select for which kind of role, and what each one can and cannot tell you.
slug: fifteen-sources-and-what-each-is-good-for
date: 2026-07-27
tags: [sourcing, guide, list]
author: edd
---

BuilderHunt started with twelve sources. It reads fifteen now, and the source
selector is not decoration — picking the right three beats searching all fifteen,
both in speed and in signal.

Here is what each one is for.

![The public explorer running a query across selected sources](/images/blog/explore.webp)

## Code hosts — where the work itself lives

**GitHub** is the default and the deepest. Best for: almost any engineering role.
Caveat worth knowing: repository results use the repository's description as the
bio, because a repository is not a person.

**GitLab** finds the people GitHub misses — a lot of European and enterprise
development never leaves it. User and project search unlock when a token is
configured.

**Codeberg** is small, non-commercial, and disproportionately full of people who
care about licensing, privacy and doing things properly. If that is the kind of
engineer you want, this is a high-signal, low-volume source.

**SourceHut** is smaller still and skews toward systems, compilers and people who
send patches by email. Nobody ends up on SourceHut by accident, which is exactly
what makes it useful.

## Where developers explain themselves

**Hacker News** is the best source for people who can *think out loud* about a
problem. Two caveats, both real: the adapter sets the person's topics to your own
query keywords, so "matches your topic" is circular for HN results, and the bio is
the title of something they posted. Read the linked thread, not the row.

**Lobsters** is HN with a higher technical floor and no bios at all. Excellent for
systems and language-adjacent work.

**Reddit** is broad and noisy, and the specific subreddits are where practitioners
answer beginners — which tells you who can teach, a thing worth hiring for.

**DEV.to** and **Hashnode** are where people publish tutorials and build logs.
Ideal for frontend, developer-experience and DevRel roles, where the ability to
explain is part of the job rather than a bonus.

**Stack Overflow** is answers, which is a different signal from posts: it shows
who debugs. One caveat — the adapter reports the accept rate in the bio field and
stamps "last seen" as the moment of the request, so recency from this source is
not a real observation. Check the profile.

## Where the artefacts are

**npm** finds library authors, which is the strongest single signal for JavaScript
and TypeScript work: publishing and maintaining a package is a commitment ordinary
contribution is not. Caveat: the field the UI labels as followers carries a 0–1
quality score, so a very large number there is not a following.

**Hugging Face** is the ML source. Models, datasets and spaces, not papers — the
people who ship, not only publish.

**Product Hunt** finds builders who launch. Good for founding engineers and
generalists who can take a thing all the way out the door. Needs a token; without
one it is skipped entirely rather than quietly returning nothing.

**Devpost** is hackathon work: people who ship something complete in 48 hours.
Ingestion runs through a headless browser because there is no API, and it is off
unless explicitly enabled.

**Bluesky** is the newest and the cheapest to run — public AppView, no credential
at all. Good for the "who is talking about this right now" question, which is
often how you find someone before anyone else is emailing them.

## How to actually use the selector

Three patterns that work better than "select everything":

**Hiring a library maintainer.** npm + GitHub + Lobsters. You want publishing
history, code, and the ability to reason in public about API design.

**Hiring an ML engineer.** Hugging Face + GitHub + DEV.to. Artefacts, code, and
whether they can explain a model to someone who has to use it.

**Hiring a founding engineer.** Product Hunt + Devpost + GitHub. Shipped things,
finished under constraint.

**Hiring for a specific ecosystem outside the US.** GitLab + Codeberg + Reddit.
The people who are not on the default source.

## What every source shares

Results are deduplicated across sources, so the same person appearing on GitHub
and Lobsters is one row with two provenance badges rather than two candidates.
Everything is cached for five minutes, so refining a query does not re-hit
fifteen APIs. And every row links back to the original — which matters more than
usual given the per-source caveats above. I keep a full list of which fields are
measured and which are synthesized in
[a separate post](/blog/which-numbers-to-trust), and it is worth ten minutes if
you are going to make decisions from this data.

Sources arrive on the same rule every time: a public, documented surface we can
read without pretending to be a browser, and nothing behind a login. If there is
a place your kind of builder congregates and we do not read it, that is the most
useful thing you can put on [the roadmap](/roadmap).

[Try the explorer](/explore?q=rust) — no account needed, and the source selector
is right there.
