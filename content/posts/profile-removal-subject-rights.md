---
title: How to remove yourself from BuilderHunt — what gets deleted, what doesn't, and why
description: A walk-through of the /privacy/remove flow — what the request does, what it covers, how verification works, and the parts of the system that are designed to keep you out entirely.
slug: profile-removal-subject-rights
date: 2026-08-06
tags: [legal, privacy, trust, product, guide]
author: edd
---

BuilderHunt indexes public developer activity. Some of the developers
it indexes have not asked to be indexed, and the only honest thing
to do about that is to give them a real way out — one that does not
require an account, does not require them to explain why, and does
not have a hidden "but we will keep you in our model anyway" clause.

This post is about how that exit works, what it actually does to
the data, and the small set of situations where it is designed to
prevent you from being indexed in the first place.

## The flow, end to end

The entry point is [/privacy/remove](/privacy/remove). It is
public, unauthenticated, and reachable from the footer of every
page on the site. You paste a URL to the profile you want
removed — your GitHub URL, your GitLab URL, your npm maintainer
URL, your SourceHut URL — and optionally an email for the
verification step. The request is rate-limited per IP and per
IP+profile so one visitor cannot mint unlimited challenges for
arbitrary or single profiles, and the response is always a 202
with the same shape regardless of whether that identity exists
in our data yet, already has a pending request, or was never
indexed. We do that on purpose — the same response for every
case means a third party cannot use the endpoint to enumerate
who is and is not in the index.

Behind that 202, the system:

1. Normalises the URL to a `(source, sourceId)` pair — the same
   identity the indexing pipeline uses.
2. Checks whether a removal request is already pending for that
   identity. If it is, the existing request is reused; we do not
   stack duplicates.
3. Creates or refreshes a `profile_removal_request` row with the
   identity triple, the supplied email (if any), and a TTL.
4. Sends a verification email to the supplied address (or, if no
   address was supplied, returns a 202 and waits — the subject is
   expected to follow the link from the indexer UI, see below).
5. On verification, the row is marked verified, and a
   `data_subject_actions` worker is queued.

If you do not have an account and the only thing you want is the
removal, the flow is: open the page, paste the URL, paste your
email, click the link, done. There is no account creation. There
is no consent screen. There is no "would you like to verify your
identity via your phone number" step.

## What the verification proves

The verification step proves you can read the email at the
address you supplied. It does not prove you are the person whose
profile is at the URL. The two are different claims, and the
flow is designed around the smaller one, because the smaller one
is the only one the law actually requires — controlling an email
address is enough to consent to a removal request, and the
removal request is itself the consent.

The "but someone could remove my profile" attack is real, and
the answer is that the URL you remove is the URL you can read
the email about. The email goes to the address you supplied;
the link in the email confirms the request; the request removes
the indexed record. The attacker needs to control your email to
remove your profile, at which point they can probably do worse
things to you than remove a public-developer index entry.

For builders who do have an account, the flow is also wired
through the dashboard: if you open your own profile's privacy
page while signed in, you can confirm a removal with one click
because your session is itself the proof of identity. The
email flow exists for the case where the subject does not have
or want an account.

## What the worker actually does

The verification step is fast. The deletion is not. Once a
request is verified, the system:

1. **Marks the canonical builder identity as removed.** Every
   row keyed by `(source, sourceId)` is updated to a
   `removed_at` timestamp and excluded from every downstream
   read.
2. **Cascades the removal across every organization.** This
   is the part that was easy to get wrong. A removal request is
   not scoped to the organization that surfaced the profile —
   it is global. Every organization's tracked builders are
   re-evaluated, every organization's notes about the builder
   are flagged, and every organization's alerts are
   re-checked for matches that now no longer apply.
3. **Records a global suppression.** A row in
   `profile_removal_suppressions` keyed by `(source, sourceId)`
   means the next crawl will skip the identity entirely. The
   row is the persistent version of the request, and the
   indexing pipeline checks it before every read.
4. **Cancels any pending enrichment work.** If an AI task is
   in flight for the profile, the result is discarded rather
   than persisted. The schema on every AI task's output table
   rejects inserts for identities with a non-null `removed_at`.

The cascade is what makes the feature load-bearing. A removal
flow that deleted one row in one table and left every other
view of the same person in place would be the kind of "we
honored your request" theatre that gives privacy work a bad
name.

## What we keep and why

A small set of records is kept on purpose, and the list is
narrower than the lawyer's first draft:

- **The suppression row.** Required to stop re-ingestion on
  the next crawl, and to honour the request the next time the
  subject shows up in someone else's export or a partner's
  ingest.
- **The verification token's hash.** Required to prove the
  request was verified, in case it is later disputed.
- **Audit log rows.** Required for the same reason — to be
  able to answer the question "did we honor this request"
  with evidence, not a screenshot.

Everything else about the profile — the persona card, the
code fingerprint, the work-sample analyses, the team-fit
records, the alerts, the saved-search matches, the activity
timeline — is deleted. If you come back in two years asking
"do you still have me", the answer is "no, and here is the
audit row that proves it".

The system also retains anonymized aggregate metrics about
removal requests (request count by source, average time to
verification, average time to deletion) for the same reason
any other product retains operational metrics: the team needs
to see when a metric is moving in the wrong direction. None
of the aggregates can be reversed to identify the requester.

## What about "I never asked to be here in the first place"?

The removal flow handles the case where a developer learns
about BuilderHunt and wants out. The prevention side is a
different problem and it is split across three places:

- **The [/crawler](/crawler) page** documents the user agent
  the indexer sends, what it fetches, what it does not fetch,
  and which sub-processors are involved. The page exists so a
  developer can block the indexer at the edge before it ever
  reads a profile.
- **Per-source opt-outs** are respected at the source. A
  GitHub user who has set their profile to "no indexing" is
  not indexed in the first place. The same is true for npm
  maintainer pages and Hugging Face author pages, where the
  upstream provides the signal.
- **The robots.txt** for the public site excludes the
  indexer from the public pages themselves while leaving
  every other crawler alone. This is for the case where a
  developer wants their profile page to be searchable but
  does not want the indexer to follow the links.

None of these are substitutes for the removal flow. They are
the cheaper layer above it, and the right answer for most
people is "block at the source and you will never appear".

## What this looks like for the people we do not have

Some of the developers in the index have legitimate public
profiles and have not asked to be removed. The system's
position on that is straightforward: the data is public, the
indexer is documented, the removal flow is one URL away, and
the system is not in the business of guessing who would
rather not be there. The first three answers to "should
BuilderHunt have me" are "it should not, you can fix it",
"here is the documentation", and "one URL and it is gone".
The fourth answer would be paternalistic, and the product
is not built to be paternalistic.

If you are reading this and the answer to "should BuilderHunt
have me" is "no", the page is
[/privacy/remove](/privacy/remove) and the email is
[hello@builderhunt.dev](mailto:hello@builderhunt.dev) for the
cases the page does not cover.

## What the changelog entry for this feature did not say

Two things that did not fit in the changelog entry and are
worth saying here:

The verification step is deliberately silent on success. A
200 with a confirmation page is an information leak — it
tells the requester something about whether the identity
exists. The 202-with-the-same-shape response is the same
answer whether the request was for a known profile, a
pending request, or an unknown URL. That is a small design
choice with a real privacy consequence, and it is the kind
of choice that does not survive a feature-creep review
unless someone writes it down.

The suppression list is checked on every read, not on
every write. An ingest path that writes before checking
would re-introduce the profile and the next read would
have to clean up after it. The check-on-read posture means
the index can grow temporarily during a heavy crawl and
the next user-facing read still produces an empty result.
It is a slower path through the index, and the right one
for the consent guarantee.
