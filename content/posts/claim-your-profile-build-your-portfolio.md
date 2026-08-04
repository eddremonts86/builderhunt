---
title: Claim your profile, build a portfolio — what builders get to control on BuilderHunt
description: A walk-through of the claim flow, the public portfolio, and the timeline surface — what builders can edit, what the indexer still owns, and how the verification step is bound to the source identity rather than a general claim of identity.
slug: claim-your-profile-build-your-portfolio
date: 2026-08-07
tags: [product, trust, guide, how-to]
author: edd
---

If you have ever searched for yourself on a developer indexer and
found a half-correct profile scraped from your GitHub bio, you
know the feeling. The picture is from 2019, the bio is the
sentence you wrote when you were 22, the topics are whatever the
indexer guessed, and the one thing you cannot do is fix it.

The claim flow exists to fix that, and the portfolio surface is
what the claim unlocks. This post is about both — what builders
get to control, what stays under the indexer's control, and the
parts of the system that exist specifically to keep the two
honest.

## What "claim" means here

Claiming a profile means proving you control the source account
the indexer read to build it. The proof is bound to that source —
a successful claim proves you control *this* GitHub account, or
*this* GitLab account, and nothing else. The verifier cannot be
re-used to claim someone else's profile at a different source,
and the system is explicit about this in the spec because the
broader claim "I am this person" is a different question and a
much harder one to answer over a network.

The flow is:

1. **You open your profile page** at `/builders/$builderId` while
   signed in to your BuilderHunt account. (If you do not have an
   account, the claim flow will create one as part of the
   verification step — the account is the durable record of the
   claim, not a prerequisite for it.)
2. **You click "Claim this profile".** The system records a
   `builder_claim_request` keyed by `(source, sourceId)` and
   your user id, and sends a verification email to an address
   you supply. The address does not have to match anything on
   the source — it has to be an address you can read.
3. **You click the link in the email.** The verifier marks the
   row verified and writes a `claim_verified` audit row. The
   profile is now yours to edit, and your user id is recorded
   as the `claimedByUserId` on the canonical builder identity.
4. **You curate.** The public portfolio surface unlocks, and
   you can edit the things the indexer is allowed to leave
   alone.

The "edit the things the indexer is allowed to leave alone"
sentence is the part that takes the most explaining, and it is
the part the system is most careful about.

## What you can edit, and what you cannot

A claimed profile has two layers. The bottom layer is the
indexer's view: bio, avatar, topics, languages, the activity
timeline, the code fingerprint. The indexer owns these. They
are read from upstream sources and updated when the upstream
changes. The only edits the indexer will accept on this layer
are ones the upstream itself has produced — the system does not
let a builder override their GitHub bio from the BuilderHunt
dashboard, because the next crawl would re-write it back.

The top layer is yours: a curated public-facing surface that
sits *on top of* the indexer's data, not in place of it. The
things you can edit here are:

- **Your headline.** A short, hand-written sentence that
  appears at the top of the portfolio. It is the only field on
  the page that is not derived from anywhere.
- **Your topics.** A short list of tags you want to be
  associated with. They appear alongside the indexer's
  auto-derived topics, and the two are visually distinct so a
  visitor can tell which is which.
- **Your availability.** An "open to" signal — none, roles you
  are open to, the kind of work you are open to. It renders as
  a small badge and is the only behavioural signal the page
  carries.
- **The order of your highlighted work.** A handful of repos,
  posts, or packages, chosen from the indexer's view and
  reordered by you. The content is not editable; the
  presentation is.
- **A free-form "about" block.** A few hundred characters of
  hand-written text that lives above the auto-derived bio. The
  indexer's bio still appears below it, with a small "from
  $source" label so a visitor knows which is the curated
  version.

That is the full list. There is no field to override the
auto-derived bio, no field to set a custom avatar that does
not match the upstream, no field to add skills the indexer has
not seen you demonstrate. The system is restrictive on
purpose, because a profile that is half-curated and
half-inherited is harder to read than one that is clearly
inherited and clearly claims that.

## What the verification step is and is not proving

The verification step is the only thing standing between
"someone claims a profile" and "someone owns a profile". The
proof it asks for is narrow: control of an email inbox. That is
the minimum that supports the consent model, and it is
intentionally not the maximum.

A claim that proved identity in general — via a government
ID, via a credit-card-based identity service, via a manual
review — would be a stronger claim, but it would also be a
different product. The legal exposure of storing government IDs
is real, the cost of running a manual review at the volume the
indexer ingests is real, and the marginal value over "the
person who controls the email address" is small for the use
case the feature is built for. The use case is: the
GitHub-bio-on-BuilderHunt problem. The minimum proof that fixes
that problem is email control, and the system is honest about
what it is and is not proving.

Platform admins can revoke a claim that turns out to be wrong
— a claim that misrepresents the relationship between the
account and the source is revokable from the admin tools, and
the revocation is itself audited. The audit log is the
defense against the case where the verification was technically
valid but the outcome was not.

## The portfolio, the timeline, and the public read

The portfolio page is what shows up at `/builders/$builderId`
when you visit your own (or anyone else's) profile after
claiming. Two other surfaces hang off the same record:

- **The public activity timeline.** A merged, time-ordered
  feed of the source-reported activity: pushes, releases,
  merged PRs, posts, package updates. Each row links to the
  original. The timeline is not curated by the indexer and
  not editable by the builder — it is what the sources
  actually reported, in date order, with no scoring. Its
  purpose is to make "this person is active" a claim you can
  verify in ten seconds rather than take on faith.
- **The skill fingerprint.** The five-metric record from the
  [code fingerprinting post](/blog/code-fingerprinting-v2).
  The builder cannot edit the metrics, but can mark specific
  metrics as "not representative" with a one-line reason,
  which renders as a small note next to the score. The note
  is honest, because the next visitor is allowed to see the
  reason alongside the metric.

All three surfaces — portfolio, timeline, fingerprint — are
publicly indexable by external search engines. The page
includes the standard SEO metadata, an Open Graph card, and a
JSON-LD `Person` payload. The page is the answer to the
question "if I Google myself, what comes up at
`builderhunt.dev/builders/<handle>`?", and it is meant to
rank.

## How this interacts with the rest of the system

The claim flow sits in the middle of three other features, and
the design choices are made to keep all four consistent:

- **The profile removal flow.** A claim does not prevent
  removal. The removal flow operates on the canonical
  `(source, sourceId)` identity, and the claim is a flag on
  the same record. Removing a profile removes the claim with
  it; the audit log of the claim is retained, but the
  builder-facing record is gone.
- **The processing restriction cascade.** A builder who has
  asked for a processing restriction sees their profile
  removed from every organization's view, including their
  own. The claim does not override the restriction; the
  restriction is the bigger right.
- **The org-shared builder lists.** When an organization
  tracks a builder, the tracking row is on the
  `organization_builders` table keyed by org id + builder id.
  The claim does not give the org any access it did not
  already have, and the org's view of the profile is
  unaffected by the claim.

The claim is the smallest durable connection between a
BuilderHunt account and a builder identity. It does not
unlock a private channel, it does not give the builder
administrative access to the indexer's view of them, and it
does not promise anything about the indexer's future
treatment of the profile. It is the right to curate the
top layer and to verify, for the rest of the system, that
the top layer is yours.

## What the page is meant to look like

A claimed profile has the curated "about" block at the top,
then the indexer's bio with a `from $source` label, then the
auto-derived topics alongside the curated ones, then the
code-style card, then the activity timeline. An unclaimed
profile is the same page without the curated block and
without the edit affordances — the indexer's view is the
only thing on the page, with a claim CTA at the top.

The visual treatment is the same; the only difference is the
existence of the curated block and the edit controls. A
visitor should not be able to tell at a glance whether a
profile is claimed; they should be able to tell only by
reading it.

[Search for yourself](/search) — if you are in the index, your
profile is the first result for your handle, and the claim
button is at the top of the page. The verification step is
an email, a click, and a minute. The portfolio surface is
the part that takes longer, but it is yours to take as
much time on as you want.
