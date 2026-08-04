---
title: What we deleted from the changelog and why
description: An honest accounting of the things that were on the BuilderHunt product surface and got removed — landing-page claims that nothing measured, fake trust badges, and the engineering policy that drove the deletions.
slug: what-we-deleted-from-the-changelog
date: 2026-08-12
tags: [transparency, trust, product]
author: edd
---

A changelog that only documents additions is a marketing
page. A changelog that documents both additions and
deletions is a record. The difference is small in tone
and large in what it lets the reader trust.

This post is about the things that were on the
BuilderHunt product surface — landing pages, marketing
copy, badges, metrics — and got removed because they
either could not be measured or were measured and
turned out to be wrong. The deletions are listed on
the changelog alongside the additions. This post is
the long version: why each one was on the surface in
the first place, why it was wrong, what replaced it,
and the policy that is meant to keep the wrong
things from coming back.

## The landing page used to claim a "98% accuracy" number

The number was on the hero section for the better
part of a year. It came from a benchmark I ran on
the search result set against a hand-picked "ground
truth" of 50 candidates, and it measured "fraction
of top-20 results that were also in the ground
truth" — which is a useful number for the
specific benchmark, and a misleading number when
it is presented as the accuracy of a search product.

The 98% did not account for the fact that the
ground truth was hand-picked by the person who
wrote the search product, and the hand-picker knew
which results the search would return. The number
measured the search's ability to surface results
that matched the author's mental model of the right
results, and the author's mental model is exactly
what the search is supposed to surface. A more
honest measurement would have used a ground truth
built by someone who had not seen the search
output, and that measurement would have produced a
smaller number, and a smaller number is not what a
landing page wants.

The number was deleted in 2026-07. The replacement
is no number. The hero section now says
"recency-weighted search across 15 public sources",
which is a description, not a measurement, and is
the right shape for a marketing claim: it tells you
what the product does, not how good it is at doing
it.

## The "trusted by 1,200+ teams" badge

A social proof badge, with a number that came from
"total sign-ups since launch" — including free
sign-ups, including one-time downloads, including
the accounts that never came back. The number was
true in the sense that 1,200+ email addresses had
been associated with an account at some point, and
it was dishonest in the sense that a recruiter
looking at the badge would read it as "1,200 teams
are using this product" and that is not what the
number said.

A more honest version of the number would have
been "1,200 sign-ups, 200 active teams in the last
30 days", and that version is not what a social
proof badge wants. The honest version is also the
less useful one, because the question a recruiter
asking about a product is not "how many sign-ups",
it is "how many active teams", and the active
number is a number a competitor can also produce.

The badge was deleted. The replacement is a single
sentence at the bottom of the landing page: "We
publish what is shipped, what is planned, and what
was removed on the [changelog](/changelog) and the
[roadmap](/roadmap)." The replacement is a
description of the honesty posture, not a
substitute for the social proof. The honesty
posture is the part that compounds; the social
proof is the part that erodes.

## The "5,000+ developers indexed" count

A counter on the homepage that incremented as the
indexer added new builders. The number was true in
the same way the 1,200 was true, and dishonest in
the same way. A "5,000 developers indexed" claim
reads as "5,000 profiles you can search", and the
indexer does not produce 5,000 searchable profiles
in the sense a recruiter would want — it produces
5,000 deduplicated builder identities, of which a
fraction have meaningful public activity, of which
a smaller fraction would be a fit for any specific
search, of which a much smaller fraction are
contactable.

A number that is true in the strict sense and
dishonest in the implied sense is the most
dangerous kind of marketing claim, because the
recruiter who quotes it in a hiring manager
meeting is the recruiter who has to explain why
the search returned three results for "senior
python developer". The number was deleted. The
replacement is a live counter on the
[status page](/status) that shows the indexer's
last-crawl totals — a number that is true, that
updates, and that is the right surface for a
"how much is in the index" question.

## The "Uptime 99.99%" badge on the marketing site

A static badge in the footer. The number was
plucked from a calculation I did not save, and
the calculation was "uptime over the last 30
days based on my recollection of the past 30
days". The number is exactly the kind of number
the [status page](/status) was built to compute
honestly: a per-component health snapshot on an
interval, 90 days retained, uptime computed from
the snapshots.

The badge was deleted. The replacement is a
link to the status page, with the actual uptime
shown on the status page. The status page
uptime is sometimes worse than 99.99%, and the
honest answer to that is "the system was down
for 12 minutes on a Tuesday afternoon in
March". A status page that does not show the
bad days is a status page that has stopped
being a status page.

## The "AI-powered" label on the search button

A label that was on the search button for the
first six months. The search button was not, at
the time, AI-powered. The search was a
federated keyword search across N sources, and
"AI-powered" was the kind of marketing claim
that the keyword search did not earn.

The label was changed to "Search". Then the
search became AI-powered in a real sense — the
semantic ranking described in
[the sprints and semantic search post](/blog/sourcing-sprints-and-semantic-search)
shipped — and the label was changed to "Search
(semantic)" for clarity. Then a third mode
shipped, the keyword search became the fallback
rather than the default, and the label became
"Search" again, because the search is the
search, and the mode is reported on the results
page rather than on the button.

The lesson from the label is the lesson the rest
of this post keeps saying: a label that is true
today and dishonest tomorrow is a label that has
to be maintained, and a label that has to be
maintained is a label that will eventually be
wrong. A label that describes what the product
does, in the same words as the product, is a
label that does not need maintenance.

## The persona card used to claim "verified by our AI"

A label on the early persona card, before the
card was rebuilt with the schema that the
[AI Persona Cards post](/blog/ai-persona-cards)
describes. The "verified by our AI" label implied
that the model had checked the persona against
some external source, and the model had not —
the model had generated the persona from the
builder's public work and called it a summary.

The label was deleted. The replacement is a
card that says "AI-generated from public
activity" and shows the timestamp, the model
version, and the input highlights. A label that
describes what the model did is more useful than
a label that describes what the model might
have done, and the former is the label a
recruiter can verify.

## The "trust claims" deletion, in one paragraph

An audit of the landing page in 2026-07 found
seven claims that were either unverifiable or
verifiably wrong. The audit is
[on the changelog](/changelog/we-removed-trust-claims-we-could-not-prove).
The seven claims were deleted, the page was
rebuilt, and the rebuild is the version that
ships today. The audit is the example the rest
of this post keeps coming back to: the only way
to know which of your claims are wrong is to
audit them, and the audit is the only honest
way to do the deletion.

## The policy that is meant to keep this from happening again

The policy is in the
[trust post](/blog/which-numbers-to-trust): if a
number on the product surface cannot be traced to
a source, the number does not ship. The policy
applies to marketing copy, to UI labels, to
changelog entries, to this post. A claim that
cannot be traced is a defect, and the defect is
the part that gets fixed, not the part that gets
reworded.

The policy is also enforced by an audit, run on
a schedule, of the landing page and the marketing
copy. The audit is the same kind of audit the
2026-07 audit was: a person reads every claim,
follows the claim to the source, and either
confirms the claim is traceable or marks the
claim for deletion. The next audit is in
Q4-2026, and the audit's output will be on the
changelog the same way the 2026-07 audit's
output is on the changelog today.

## What we kept, and why

The numbers that survived the audit are the
numbers with a source. The recency of an index
snapshot. The number of public sources the
search reads. The number of saved searches
included in the free tier. The number of team
seats included in the Team plan. Each of these
is a number that can be verified by opening the
relevant page and reading the relevant section.
Each is a number a recruiter can quote in a
hiring manager meeting without a follow-up
email.

A small, honest set of claims is more useful
than a large, defensible set. A recruiter who
remembers one BuilderHunt number is a recruiter
who will remember the product. A recruiter who
remembers three is a recruiter who will not,
because three is where the memory of which
claim is real and which is marketing starts to
fail. The product's job is to make the
recruiter's job easier, and the recruiter's
job is easier with fewer honest numbers than
more defensible ones.

## The lesson, stated once

A product that has been around for more than a
year has on its surface a few claims that are
true, a few that are wrong, and a long tail that
nobody has checked. The tail is where the
damage is. The honest version of the audit is
the one that names the tail and removes it, and
the honest version of the policy is the one
that does not let the tail grow back.

[Read the changelog](/changelog) — both the
additions and the deletions. The ratio is the
honesty posture, and the honesty posture is the
only claim on this page that does not need a
source.
