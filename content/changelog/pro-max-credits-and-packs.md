---
title: A new plan lineup — Pro Max, monthly credits and credit packs
slug: pro-max-credits-and-packs
date: 2026-07-24
tags: [feature]
---

BuilderHunt's plans changed shape, because what the product costs to run changed
shape. Search over public sources is cheap. Sprints, semantic search, work-sample
analysis and fingerprinting call a model per request, and a plan built only on
"how many saved searches" cannot price that honestly.

The lineup on [/pricing](/pricing):

| Plan | Monthly | Credits / month | Seats |
| --- | --- | --- | --- |
| Free | $0 | — | 1 |
| Pro | $19 | 140 | 1 |
| Pro Max | $79 | 700 | 1 |
| Team | $199 | 2,100 pooled | up to 10 |

Annual is roughly ten months for twelve. Credit packs — 300 for $15, 1,000 for
$45, 5,000 for $299 — are separate from a subscription grant, expire twelve
months after purchase, and are spent only after the monthly grant is used up.
Subscription credits refresh each period and do not roll over; that is the
trade-off for them being far cheaper per credit than a pack.

Two things stated plainly. **Team's price moved from $99 to $199.** Anyone
already on the old price keeps it until they choose to move, with at least 30
days' notice before any increase — the legacy plan system still runs alongside
the new catalog specifically so that promise is enforced by code and not by
memory. And **checkout is not switched on yet.** Everything behind it is built —
Checkout, the customer portal, webhooks, the credit ledger, dunning, refunds,
disputes, reconciliation — but payments stay off until the last operational gates
close. Until then the beta runs on Free, and if you need a paid tier now, ask us
and we will grant it.
