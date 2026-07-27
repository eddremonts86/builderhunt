---
title: Organizations, teams, and row-level security under non-owner roles
slug: organizations-teams-and-row-level-security
date: 2026-07-22
tags: [feature, breaking]
---

BuilderHunt was a single-player app: your saved searches, your tracked builders,
your notes. It is now organization-scoped from the database up.

- Every account gets a **personal organization** on sign-up, created atomically
  with the account, and self-healing on the next request if that ever races.
- **Teams**: invite by email, roles of owner, admin and member, ownership
  transfer, seat limits that count accepted members *and* outstanding
  invitations, and organization deletion with a grace period.
- An organization **switcher**, with the active organization carried on the
  session rather than in a URL you could tamper with.
- Authorization goes through one `can()` function. A boundary test fails the
  build if new code compares roles inline instead of asking it.
- **Row-level security is enabled and forced** on every private table, and the
  web app, auth layer, background workers and platform admin each connect as
  their own non-owner database role with its own policies.

Building it this way found five real permission bugs that code review and the
existing test suite had both missed — because the old tests ran as the database
owner, for whom RLS simply does not apply. There is now a harness that exercises
real route handlers as the actual runtime roles.

Invitations on personal organizations are blocked: a personal org is a container
for one person, and letting it grow a member list was a quiet way to bypass seat
limits.
