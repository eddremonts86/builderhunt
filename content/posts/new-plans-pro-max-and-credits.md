---
title: New plans — Pro Max, credits, and what you are actually paying for
description: BuilderHunt's plan lineup changed. Here is the reasoning, the numbers, what happens to the old Team price, and why you cannot buy any of it yet.
slug: new-plans-pro-max-and-credits
date: 2026-07-27
tags: [pricing, product]
author: edd
---

BuilderHunt started with three plans priced on how much you could store: saved
searches, saved builders, RSS feeds. That worked while the product was search
over public APIs, where my marginal cost per user was rounding-error small.

It stopped working the moment sourcing sprints, semantic search, work-sample
analysis and code fingerprinting shipped. Those call a model per request. Storage
limits cannot price them, and the two usual dodges — one flat price high enough
to cover the heaviest user, or a quiet quality reduction for anyone who uses the
feature a lot — are both worse than telling you the number.

So the plans have two dimensions now: what you can *keep*, and what you can
*spend*.

![The pricing page showing the Free, Pro, Pro Max and Team plans](/images/blog/pricing.webp)

## The lineup

| Plan | Monthly | Credits / month | Seats |
| --- | --- | --- | --- |
| Free | $0 | — | 1 |
| Pro | $19 | 140 | 1 |
| Pro Max | $79 | 700 | 1 |
| Team | $199 | 2,100 pooled | up to 10 |

Annual billing is roughly ten months for twelve. Team's credits are pooled across
the whole organization rather than divided per seat, because one person doing all
the sourcing in a given week is the normal shape of a hiring push, not an abuse
of it.

Credit packs sit on top: 300 for $15, 1,000 for $45, 5,000 for $299. They expire
twelve months after purchase and are only spent once the month's subscription
grant is used up. Subscription credits refresh each period and do not roll over
— that is the trade-off for them being much cheaper per credit than a pack.

## What credits are for, and what they are not for

Credits pay for model-backed work: sourcing sprints, semantic search,
work-sample analysis, fingerprint comparisons, team-fit analysis, AI-upgraded
outreach drafts.

They do not pay for federated search across the fifteen sources, tracking
builders, notes, saved searches, radars, alerts, RSS, exports, public radars,
interview scheduling or the calendar. That is all in every plan, Free included,
because it costs me HTTP requests and cache, not tokens.

Free is not a trial. Three saved searches, fifty tracked builders and three RSS
subscriptions, no expiry, no card. It is enough to run one open role end to end,
which is the honest test of whether the product is worth paying for.

## Team went from $99 to $199, and nobody's bill changed

This is the part that deserves to be stated plainly rather than buried in a FAQ.

The old lineup priced Team at $99. The new one prices it at $199 with a much
larger credit grant and a feature set that did not exist at $99. If you are
already on the old price, you keep it until you choose to move, and any increase
comes with at least 30 days' notice.

That promise is enforced by code, not by my memory: the legacy plan system still
runs alongside the new catalog, and migrating an organization off it is an
explicit, deliberate operation rather than something a deploy does silently.

## You cannot buy any of this today

Everything behind checkout is built. Stripe Checkout, the customer portal, signed
webhooks with an encrypted durable inbox, the credit ledger with reservations so
a request cannot spend credits twice, annual grants issued monthly, dunning,
refunds, disputes, daily reconciliation, an accounting export. Roughly sixty
modules, each with tests.

Payments are still switched off. What is missing is not code — it is sandbox and
Test Clock certification and a small first-country canary, and until those close
the switch stays off. Shipping a payment system on the day the code compiles is
how you find out about the edge cases from your customers' bank statements.

So during the public beta: everyone is on Free, and if you need a paid tier now,
ask and I will grant it. When checkout opens, it will be in
[the changelog](/changelog) the same day.

## The fair-use line

Every plan is priced for one person per seat, signed in from their own normal
devices — a laptop and a phone at once is completely fine. Each seat also has
daily limits on searches, exports and profile reveals, sized for real research
rather than automation.

Detection for the cases where a seat is not a person is live and currently
running in **observe** mode: signals are recorded, nothing is blocked. When
enforcement turns on, the order is an in-app warning first, a step-up re-auth
prompt second, restriction last. I would rather tell you something looks unusual
than surprise you with a locked account.

[See the plans](/pricing) — and if the free tier turns out to be enough for you,
that is a perfectly good outcome.
