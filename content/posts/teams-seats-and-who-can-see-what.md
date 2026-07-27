---
title: Teams on BuilderHunt — seats, roles, and who can see what
description: How organizations, roles and seat limits work, what your team shares today, what it does not share yet, and how tenant isolation is enforced below the application code.
slug: teams-seats-and-who-can-see-what
date: 2026-07-27
tags: [teams, security, guide]
author: edd
---

BuilderHunt began as a single-player tool. Everything you saved was yours, keyed
to your user id, and if a second person needed to see it the answer was a CSV.

It is organization-scoped now, from the database up. This post is about what that
means for your team in practice — including the two things it does not do yet,
because you should know those before you invite anyone.

## Every account already has an organization

When you sign up, a personal organization is created in the same transaction as
your account. You do not choose to create it and you cannot end up without one —
if the bootstrap ever raced, the next request heals it.

Your private data lives in that organization, not on your user row. Which is why
turning a personal account into a team is an invitation, not a migration.

## Roles, and the one function that decides everything

Three roles: **owner**, **admin**, **member**.

- **Owner** — one per organization. Manages billing, transfers ownership, deletes
  the organization.
- **Admin** — invites and removes members, manages shared configuration.
- **Member** — full use of the product inside the organization.

Every permission check in the product goes through a single `can()` function.
That is not a style preference: a boundary test fails the build if new code
compares a role inline instead of asking it. Authorization logic scattered across
forty route handlers is how one of them ends up subtly more permissive than the
rest, and nobody finds out until it matters.

Ownership transfer is a first-class operation rather than a support ticket, and
account deletion is organization-aware — if you are the sole owner of a
multi-member organization, deleting your account is blocked until you transfer
it, because the alternative is orphaning your colleagues' data. Owners of a
personal-only organization are never blocked.

## Seats

A seat is one person. Team includes up to ten.

Outstanding invitations count against your seat limit, not just accepted members
— otherwise ten pending invites plus ten members is twenty people on a ten-seat
plan, and the limit means nothing. Invitations on a *personal* organization are
blocked outright: a personal org is a container for one person, and letting one
grow a member list was a quiet way around seat limits.

Credits on Team are pooled across the organization rather than divided per seat,
because one person doing all the sourcing during a hiring push is the normal
shape of the work.

## What your team shares today — and what it does not

Shared today: the organization's tracked builders, the private notes attached to
them, recently-viewed builders, exports, seats and billing, and sourcing sprints.

**Not shared yet: saved searches and builder lists.** They are organization-scoped
in storage, but there is no per-resource visibility, so in practice a saved
search is still the creator's. Making a search or a list belong to the team is
[in progress on the roadmap](/roadmap), and the team activity feed is queued
directly behind it, because a feed of shared activity needs shared resources to
have activity about.

I would rather tell you that than let you invite four people and discover it.

## The part underneath, which is the part I would ask about

If you are evaluating a tool that will hold notes about candidates, "we scope
queries by organization" is not a satisfying answer. Application code forgets
things.

So isolation is enforced below it. Row-level security is enabled and forced on
every private table. The web app, the auth layer, the background workers and
platform admin each connect as their own non-owner database role with its own
policies — the runtime cannot read a row its policy does not allow even if a
query forgets its filter. As of this week, `organization_id` is `NOT NULL` on
every one of those tables; nullable was the honest state during the migration and
also a permanent invitation to a bug.

Two things I will say about how that went, because they are the useful part.

Building it found five real permission bugs that code review and the existing
test suite had both missed — because those tests ran as the database owner, for
whom row-level security simply does not apply. There is now a harness that
exercises real route handlers as the actual runtime roles.

And a restore rehearsal found that `pg_restore` was running before the cluster
roles existed, so every policy referencing a missing role was silently dropped.
The restored database looked complete and had lost its tenant isolation. That is
the single worst failure available to a multi-tenant product, it was invisible
without an explicit check, and it is why the restore is now rehearsed on a
schedule instead of assumed to work.

Platform admin, incidentally, is a completely separate allow-list from
organization roles. Being an owner of your organization grants zero platform
capability, and vice versa.

[Invite your team](/settings/team) — or read
[the changelog entry](/changelog/organizations-teams-and-row-level-security) if
you want the engineering detail first.
