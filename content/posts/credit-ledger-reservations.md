---
title: The credit ledger and why reservations matter
description: A walk-through of BuilderHunt's append-only credit ledger — idempotency keys, reservation semantics, the compensation pattern, and the invariant that 0 <= remaining <= original.
slug: credit-ledger-reservations
date: 2026-08-09
tags: [engineering, billing, infrastructure]
author: edd
---

A credit system that can be charged twice for the same request
is worse than a credit system that fails the request. The first
case is invisible to the user, visible to the bill at the end
of the month, and impossible to refund with any speed. The
second case is a loud error that the user can retry. The
plumbing that keeps the first case from happening is the
credit ledger, and the part of the plumbing that does the most
work is reservations.

This post is about the design of the credit ledger, the
specific decisions that make double-charging structurally
impossible, and the parts of the implementation that are
deliberately small because smaller is the right shape for the
problem.

## What the ledger is

The credit ledger is the append-only log of every change to
every credit grant in the system. It is not a balance. A
balance is a derived value, computed by walking the ledger and
summing the relevant entries. The schema reflects this: a
ledger row is an immutable record of a single event, and a
grant row carries the denormalized `remainingUnits` that the
ledger entry is supposed to match.

Two tables:

- `billing_credit_grants` — one row per grant. Has the
  `originalUnits` (what the grant was for), `remainingUnits`
  (what is left), the expiry, the source (`subscription_monthly`,
  `pack`, `legacy_manual`, etc.), and the `state` (active,
  expired, revoked).
- `billing_ledger_entries` — one row per mutation. Has the
  grant it mutated, the units delta, the
  `idempotencyKey` that produced it, the source event, and a
  timestamp. Inserts only; updates and deletes are forbidden
  by convention and by review.

The invariant is `0 <= remainingUnits <= originalUnits`, and
the invariant is maintained by writing both tables in the
same transaction. Every mutation produces one ledger entry
and one grant update, and the unit tests assert that the two
are always consistent.

## What reservations are for

A reservation is a ledger entry that holds credits for a
specific operation, without spending them yet. The pattern is
the same one Stripe uses for the same reason: when a request
is going to cost credits, you reserve the cost up front; if
the request succeeds, the reservation is converted into a
spend; if the request fails or the user cancels, the
reservation is released.

The failure mode the reservation prevents is the "request
spends credits twice" bug. The shape of the bug is: request
A begins, sees a credit balance of 10, decides it can afford
the operation, spends 3. Request A is retried by the network
or by the user or by an at-least-once queue. Request B begins
with the same balance of 10, decides it can afford the
operation, spends another 3. The user paid 6 for one
operation.

The reservation pattern: request A inserts a ledger entry
with `units: -3` and an `idempotencyKey` derived from the
request. The grant's `remainingUnits` drops to 7. Request B
arrives with the same idempotency key. The system finds the
existing ledger entry and replays the original result, not a
new mutation. The user paid 3 once, the system reports one
operation, and the retry is a no-op.

The idempotency key is the whole point. Without it, a retry
is a duplicate charge. With it, a retry is a lookup.

## How idempotency keys are derived

The key is a hash of the inputs that uniquely identify the
operation, plus a component that uniquely identifies the
request. The shape is `sha256(organizationId | taskId |
inputHash | requestId)`. The first three components mean the
same logical operation produces the same key, and the fourth
component means a genuinely different request — different
input, different attempt — produces a different key.

A reservation that comes from a retry has the same
idempotency key as the original. The system looks up by
key, finds the existing entry, and returns the original
result. The grant's `remainingUnits` is not touched a
second time.

A reservation that comes from a genuinely different
request has a different idempotency key. The system
inserts a new ledger entry, the grant's
`remainingUnits` is touched, and the result is reported.
Two different operations on the same grant are still two
different charges.

The boundary between "retry" and "different request" is
the part of the design that matters. The system is
deliberate about what counts as the same logical
operation: the same task, the same input, the same
organization. Anything else is a different operation.

## What the compensation pattern is

A refund is not a deletion. A refund is a new ledger
entry with the opposite sign. The pattern: the original
spend is `+(-3)`; the refund is `+3`; the grant's
`remainingUnits` is incremented by 3; the ledger has two
rows instead of one.

The reason is the same as the append-only property of the
ledger: a deletion would lose the record of the original
spend, and a future audit would not be able to answer
"did we ever charge this user for this operation". A
compensation entry answers the question in one join.

The same pattern handles corrections. If a credit grant
was created with the wrong `units` value, the correction
is a compensating entry, not a `UPDATE` to the original
row. The original row keeps its original value; the
correction is in the ledger. An audit walk produces a
full history.

## What the system explicitly does not do

- **It does not allow direct `UPDATE` on `remainingUnits`.** Every change to
  `remainingUnits` is paired with a ledger entry in the same transaction. The
  function that does the change takes a connection and an idempotency key,
  and it refuses to run if the key already exists. There is no other path
  that writes to the column.
- **It does not silently allow overspending.** A request that needs 3
  credits and finds a grant with 2 `remainingUnits` is rejected. The error
  has a structured `code: 'insufficient_credits'`, and the API layer
  converts it to a 402 with a `Retry-After`-style hint pointing at the next
  monthly refresh. The user is told, the grant is not touched, and the
  request is not partially billed.
- **It does not allow concurrent double-spends.** The reservation is
  taken under a row-level lock on the grant. Two concurrent reservations
  for the same grant are serialized; the second one waits, sees the new
  `remainingUnits`, and either succeeds or fails based on the post-first
  value. The lock is taken inside the same transaction as the ledger
  insert, so a crash between the lock and the insert is a no-op.
- **It does not allow the system to invent credits.** Every ledger entry
  has a source — a grant, a refund, a compensation — and a unit value
  derived from that source. There is no path that adds credits to a
  grant without a matching entry.

The list is the part of the design that makes the rest
trustworthy. A credit ledger that allows any of these is
a credit ledger that needs to be reconciled manually
every month. The BuilderHunt ledger is reconciled by
walking the entries and asserting the invariant, and
that walk is a unit test that runs on every push.

## How the cache fits in

The ledger is the source of truth. The cache is a
convenience for the common case of "what is my
organization's credit balance right now". A typical
request does not need to walk the ledger; it needs the
`remainingUnits` on the active grants, summed. The
cache stores that sum, keyed by `organizationId`, with
a short TTL.

The TTL is short because the cache must be invalidated
on any grant mutation. The invalidation is part of the
same transaction as the ledger insert: the function
that writes a ledger entry also publishes a cache
invalidation. A reader that hits the cache between
invalidations and the next read sees a stale balance;
the staleness window is the same as the cache TTL,
which is currently 60 seconds.

The cache is not the source of truth. A stale cache that
shows more credits than the ledger supports is a
display bug, not a billing bug — the reservation
mechanism still prevents the over-spend. A stale cache
that shows fewer credits than the ledger supports is
an over-conservative display, which is the right
direction to be wrong in.

## How refunds work end to end

The flow is mechanical:

1. The recruiter hits "refund" on a credit pack
   purchase. The action is rate-limited and audited.
2. The system inserts a `compensation` ledger entry
   for the original grant, with a `units` value that
   is the same magnitude as the original spend.
3. The grant's `remainingUnits` is incremented by
   the same value, in the same transaction.
4. The cache is invalidated.
5. The Stripe refund is processed by the
   billing platform's `refund` flow, which is
   separate from the credit ledger and lives in
   the same `src/shared/lib/billing/` tree.
6. The recruiter sees a "refund pending" status
   that resolves to "refunded" once Stripe confirms.

The credit ledger and the Stripe ledger are
intentionally separate. The credit ledger answers
"how many BuilderHunt credits does this
organization have"; the Stripe ledger answers
"how much money has moved". Refunding one does not
automatically refund the other; the system
reconciles the two by walking both, and the
reconciliation is a daily job.

## What the daily reconciliation does

The reconciliation walks every credit grant in the
last 24 hours, walks every Stripe event in the same
window, and asserts the two are consistent. A
mismatch is logged to the admin metrics dashboard
and emailed to the operator. The expectation is
that the daily reconciliation finds zero mismatches
on a normal day; a non-zero count is a bug, and
the operator investigates before the next
reconciliation runs.

The reconciliation is not a credit reset. A
mismatch means "something happened that the
ledger did not record"; the fix is to add the
missing ledger entry, not to invent a balance
that papers over the gap. A credit ledger that
is reconciled by re-deriving the balance is a
credit ledger that has stopped being a ledger.

## What this looks like for the user

A user who spends credits sees two things: the
credit balance on the dashboard, and a per-task
audit log of what was spent. The balance is the
cached sum of `remainingUnits` across active
grants; the audit log is a query over the ledger
filtered to the user's organization. The two
should agree at all times; the reconciliation job
is the proof that they do.

A user who hits a credit error sees a clear
message that explains which grant ran out, when
it expires, and when the next monthly refresh
will land. The system does not silently fall
back to a "best effort" mode, because a credit
system that sometimes spends and sometimes
does not is a credit system users do not trust.

The pattern is the same one the rest of the
product uses: be honest, be specific, be small.
A credit system that needs a "best effort" mode
is a credit system that has run out of credits
in its own design.

[Open the billing dashboard](/settings/billing) —
if the plans are open. They are not, yet, but the
ledger is. The reconciliation job has been
running in dry-run mode since 2026-07-24, and
zero mismatches is the boring number that means
the design is doing its job.
