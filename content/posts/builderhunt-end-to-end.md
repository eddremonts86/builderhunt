---
title: BuilderHunt end to end — from a blank search box to a booked interview
description: A walk-through of the whole product as it exists today — search, track, notes, alerts, exports and interview scheduling — with the screens you will actually see.
slug: builderhunt-end-to-end
date: 2026-07-27
tags: [guide, how-to, product]
author: edd
---

You signed up, you are looking at a search box, and you have about fifteen
minutes before the next thing. This is what to do with them, in the order that
actually pays off.

## 1. Search for the work, not the job title

Type what the person does, not what their profile says they are. "postgres
performance" finds people who have shipped and written about Postgres
performance in the last few weeks. "senior backend engineer" finds people who
wrote that phrase in a bio.

![The search page with results for a postgres performance query, showing per-person match evidence](/images/blog/search.webp)

*Every row is a person, with the source that produced them, when they were last
active, and the keywords that matched.*

A few things worth knowing about that screen:

- **Results are people first.** The People / Resources tabs are separate on
  purpose. Repositories are useful context; they are not who you are hiring.
- **The match line is the point.** "matches postgres, performance in topic"
  tells you *why* this person is here. If a row cannot justify itself, distrust
  the row, not your query.
- **The score is recency-weighted**, not popularity-weighted. Someone with
  200,000 followers and nothing shipped in a year ranks below someone with 300
  followers who pushed on Tuesday. That is deliberate — you are looking for
  people who are working, not people who are famous.
- **Sources are per query.** Fifteen adapters exist; select the ones that fit
  what you are looking for and the search stays fast. Hugging Face for ML
  people, npm for library authors, Lobsters and Hacker News for the ones who
  write about what they build.

There is a public version at [/explore](/explore?q=postgres) if you want to try
a query before signing in.

## 2. Track the ones worth a second look

Track is the only thing on that page that creates durable state. Search results
live in a cache and expire; a tracked builder belongs to your organization
until you remove them.

Once someone is tracked you can attach **private notes** — visible to your team,
never to the person — which is where "spoke to them in March, wants remote only"
belongs instead of in a spreadsheet nobody else on your team can find.

## 3. Save the search, then stop searching

The single highest-leverage thing in the product: save the query. A saved search
becomes a **radar** — it re-runs on your schedule and tells you about people who
appear *after* you looked.

Each radar can deliver to email, to the in-app inbox, or both, at the frequency
you choose. Matches arrive grouped by the radar that found them, so a noisy
query is visibly noisy and you can fix or kill it instead of ignoring the whole
inbox.

Two things you can also do with a saved search: publish it as a **public radar**
page anyone can open without an account (useful in a job post or a README), and
subscribe to it as **RSS** if your working day already runs through a reader.

The Free plan includes three saved searches, fifty tracked builders and three
RSS subscriptions. That is enough to run this whole loop for one open role.

## 4. Let the dashboard tell you what changed

![The dashboard overview with tracked-builder counts, weekly activity, sprint progress and recommendations](/images/blog/dashboard.webp)

The overview answers "what happened while I was away": how many of your tracked
builders shipped something in the last seven days, what your radars turned up,
which sprints are still running, and a short list of picks derived from your
saved searches. Everything on it is a link into the thing itself.

## 5. Export when you need to work somewhere else

`/exports` gives you a CSV of your organization's tracked builders. No API key,
no scraping, no per-row limit games. If your process lives in a spreadsheet or
an ATS, take the data there — pushing directly into Greenhouse, Lever and Ashby
is on the [roadmap](/roadmap) and is not built yet.

## 6. Book the conversation without making them sign up

When you are ready to talk to someone, send an interview invitation from their
profile. They get an email with a link, open a portal that shows your real
availability, pick a slot, and are booked.

![The calendar view merging interviews, worker runs and alert deliveries](/images/blog/calendar.webp)

No account. No password. No "create a profile to continue". Booking, cancelling
and rescheduling are atomic, so two candidates clicking the same slot cannot
both get it.

One detail with a real consequence: the invitation link carries a one-time
capability that only exists in the email. We store its hash, not the secret, and
the secret lives in the URL fragment so it never reaches our logs. That means
**an invitation cannot be resent** — if the candidate loses the email, issue a
new invitation. We would rather have that annoyance than a link we can recover
and therefore so can anyone who reads our database.

## What this looks like as a weekly habit

1. Monday: open the inbox, work through what the radars found, track the good ones.
2. Whenever: send two or three invitations from tracked profiles.
3. Friday: check which radars produced nothing useful and rewrite those queries.

That is the whole product. Everything else — semantic search, sourcing sprints,
work-sample analysis, code fingerprinting — makes steps 1 and 2 cheaper, and
none of it replaces them.

[Start with a search](/search) — Free, no credit card, and the loop above fits
inside the free limits.
