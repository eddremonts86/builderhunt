---
title: Public radars and RSS — sharing a saved search without giving away your org
description: A walk-through of the two ways to share a saved search on BuilderHunt — a public radar page anyone can open, and an RSS feed for the people who already live in a reader — and why both are read-only by design.
slug: public-radars-and-rss
date: 2026-08-08
tags: [product, distribution, guide, sourcing]
author: edd
---

A saved search is the highest-leverage thing in the product.
You type the query once, the radar runs it on a schedule, and
the new matches arrive in your inbox. The radar is private by
default — it is your organization's data about who you are
looking for, and "we are looking for a senior Rust engineer"
is information most teams would rather not publish.

But there are cases where sharing the query is the point: a
public job description that doubles as a live "is this person
in the index" check, a community resource like "active
maintainers of $project", a personal homepage that links to
"people I've been working with lately". For those cases there
are two surfaces, and this post is about both, the security
model that keeps them read-only, and the parts of the
implementation that are deliberately small.

## Two ways to share the same query

A saved search has a private form (the radar, owned by the
creator's organization) and two public forms:

- **A public radar page.** A URL of the shape
  `/r/$slug`, rendered as a public web page that anyone
  can open without an account. The page shows the
  current top-N results for the query, with a "last
  refreshed" timestamp, and a link to the underlying
  sources. The page is indexable by external search
  engines, includes Open Graph metadata, and renders the
  same `Person`-shaped JSON-LD the profile pages render.
- **An RSS feed.** A URL of the shape
  `/api/queries/$id/feed.xml`, returning an Atom feed
  with the new matches since the last poll. The feed is
  intended for the recruiters and builders who already
  live in a reader, and the schema is deliberately
  standard so any reader (NetNewsWire, Feedly, Inoreader,
  a home-rolled script) can consume it without a
  BuilderHunt-specific client.

Both surfaces are generated from the same saved search
row. Creating a public radar or an RSS feed does not
duplicate the query — it exposes a different view of the
same underlying state. Turning the radar off turns both
surfaces off, and there is no path where a public radar
exists without a private row behind it.

## The read-only contract

Both surfaces are strictly read-only. There is no public
mutation path through them:

- The public radar page is a server-rendered page that
  reads from the saved-search index. There is no form,
  no API endpoint, no client-side mutation. A
  unauthenticated visitor cannot track a builder, save
  the search, or trigger an alert from the page.
- The RSS feed is a GET-only endpoint. It returns the
  new matches; it does not accept any input beyond the
  query id in the URL. There is no POST, no PUT, no
  DELETE; the route's `ANY` handler is the
  `methodNotAllowed(['GET'])` rejection the rest of the
  API uses.
- The capability token that gates the feed (see below)
  is one-way: presenting it grants read access to the
  feed, and revoking it removes read access. There is
  no token that grants write access to a public
  search, because no such path exists.

This is the property the security model is designed
around: "share the search" and "let the visitor do
anything" are two different actions, and the only
action a public radar grants is "see the results".

## What shows up in the public version

The public radar and the RSS feed are both
intentionally narrower than the private radar:

- **No internal-only fields.** Things like "last
  viewed by your team", "added to your shortlist",
  "has notes attached" are not on the public surface.
  A public visitor sees the same row a non-tracking
  recruiter would see, not the row a tracking
  recruiter would see.
- **No AI-augmented rows.** The public surface does
  not include the persona card, the team-fit score,
  the work-sample analysis, or the code-style
  fingerprint. Those are per-organization
  enrichments, and exposing them on a public page
  would mean exposing them to anyone who knows the
  slug.
- **No "tailored to your search" weighting.** The
  public page uses the same ranking the private
  radar would produce without org-specific
  adjustments. If your organization has a "boost
  profiles we've already tracked" feature, the
  public page does not use it.
- **No private activity data.** The public page
  shows the same public activity the underlying
  sources show. There is no per-org private
  metadata, no internal notes, no "this row is
  on your shortlist" tag.

The public version is the same view a logged-out
visitor with the same query would have produced in
the explorer. The only difference is that the
results page is identified by a stable URL and
refreshed on the radar's schedule.

## How the RSS feed is authenticated

The RSS feed is the trickier of the two surfaces,
because a feed reader needs a stable URL it can poll
on a schedule, and a stable URL is a stable
secret if it grants access. The design choice
mirrors the interview-booking flow: a
one-time capability token that lives in the URL
fragment, not the URL path, so it never reaches
server logs.

The token is generated when the feed is first
enabled, hashed and stored in the database, and
returned once in the URL fragment. The feed URL
looks like:

```
/api/queries/$id/feed.xml#capability=$token
```

The server only sees `/api/queries/$id/feed.xml`
in the request line. The fragment is stripped
before the request reaches the application. The
hash is checked at the database layer; the secret
never appears in any log line, in any error
message, in any Sentry breadcrumb, or in any
backup. The secret is irrecoverable from our side.

That means the same thing the booking flow
means: an RSS URL is regenerable, not resettable.
Losing the URL means revoking the old token and
generating a new one. The old token stops working
on the next revocation; the new one is delivered
through the same UI surface that created the
first one.

The trade-off is the same: a recoverable URL is a
URL anyone who reads the database can recover.
An irrecoverable URL is a URL only the person
who has the original email has. The design
picks the second, and the user experience cost
is "if you lose the URL, ask the system to send
a new one".

## What the public radar is good for

A few cases the feature was built for, with
concrete examples:

- **A job post.** A company hiring for a role
  publishes a public radar on the careers page
  that says "people who have shipped Rust in
  the last 30 days". The candidates who land
  on the page can self-check whether they
  would be a match before they apply, and the
  company's recruiters can use the same query
  internally.
- **A community resource.** A maintainer of an
  open-source project publishes a public
  radar titled "active contributors to $project"
  and links it from the project's README. The
  page becomes a discoverable artifact that
  shows the contributor base, and the maintainer
  does not have to manually maintain the list.
- **A personal homepage.** A developer who
  wants to be findable publishes a public
  radar on their personal site that says
  "things I've been writing about lately",
  generated from a saved search of their own
  recent activity. The radar refreshes itself
  and the page is always current.
- **A pipeline for an external system.** A
  team that has its own ATS pulls the RSS
  feed into a workflow that pipes new
  matches into the hiring pipeline. The feed
  is the integration; no API key or per-row
  scraping required.

## What the feature is not

It is not a way to share notes, shortlists, or
tracked builders. The public surface is the
query, not the org's private state about the
query. If you want to share who you have
shortlisted, the right surface is the
[shared-searches feature from
`28-shared-resources`](/roadmap) (currently
unblocked, work in progress), not the public
radar.

It is not a way to give someone write access
to your saved search. The public radar is a
read-only view. If you want a teammate to
edit the query, the right path is the
Team-tier invitation flow, not the radar.

It is not a way to build a public directory
of all saved searches. The slugs are
unpredictable, the page is noindex unless
the creator explicitly enables indexing, and
the only way to discover a public radar is to
have the URL.

## How to enable both surfaces

From the saved-search detail page, two
toggles:

- **Make this radar public.** Generates a
  slug, creates the public page, returns the
  URL. Toggling off unpublishes the page; the
  underlying saved search and RSS feed
  remain intact.
- **Enable RSS feed.** Generates the
  capability token, shows the fragment URL
  once, and emails the URL to the creator's
  verified email address. Toggling off
  revokes the token and the feed 404s.

The two toggles are independent. A public
radar without an RSS feed is a normal
distribution choice. An RSS feed without a
public radar is the right shape for a
private team's automated pipeline.

## What this looks like in the app

![The saved-search detail page with the "make this public" and "enable RSS" toggles, and a public radar rendered as a clean results page](/images/blog/radar.webp)

*The saved-search detail page is the same
page for private and public radars. The
toggles are the only difference, and the
public page renders with the same chrome
as the rest of the marketing site so it
is safe to embed.*

[Save a search](/search) and toggle the
public radar on. The URL is shareable, the
page is fast, and the underlying query
stays yours. That is the whole feature.
