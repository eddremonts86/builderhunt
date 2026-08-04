---
title: How switching the test database to non-owner roles caught five real permission bugs
description: A walk-through of BuilderHunt's row-level security harness — why the tests used to pass while production would have failed, and the specific five bugs the new harness found.
slug: rls-non-owner-roles-five-bugs
date: 2026-08-09
tags: [engineering, security, testing]
author: edd
---

There is a class of bug that does not show up in tests but shows
up in production, and the most expensive version of it is a
permission bug — a query that returns a row the user is not
allowed to see. The unit tests pass. The integration tests pass.
The code review looked fine. The production deploy goes out and
the bug is there, because the test database connection was
running as the role that row-level security does not apply to.

This post is about that class of bug, the harness BuilderHunt
built to catch it, and the five real permission bugs the harness
found on the first run. None of them were caught by code review.
None of them were caught by the existing test suite. They were
all caught by a test database that was connected as the actual
runtime role, not as a role with superuser authority.

## Why RLS tests are a different problem

Postgres row-level security is enforced for non-owner roles. The
session role, the application's runtime role, the worker role,
and the platform-admin role are all non-owner. The test role
used to be `postgres`, the database superuser, for whom RLS
policies simply do not apply.

That meant: a query that forgot to filter by `organization_id`
would pass in tests because the test connection could see every
row, and fail in production because the runtime connection could
not. The query was wrong. The test was wrong in a specific way.
The bug existed, and the test suite said it did not.

The harness is the fix. The setup is mechanical:

1. Spin up a disposable local Postgres with the project's
   schema applied.
2. Create the four non-owner roles
   (`builderhunt_app`, `builderhunt_auth`, `builderhunt_worker`,
   `builderhunt_platform`) and the per-role policies, exactly
   the way production creates them.
3. Seed a two-tenant fixture: organization A with its own
   tracked builders, organization B with its own.
4. Run real route handlers — not mocks — connected as the
   runtime role.
5. Assert that organization A's requests only see organization
   A's rows, organization B's requests only see organization
   B's rows, and platform-admin requests see what they should
   see (and not what they should not).

The harness exists in
`scripts/db/verify-api-isolation-local.mjs` and runs as part of
`pnpm ci:local`. It refuses to run against a database whose
name does not match `builderhunt_security_test_*`, because
pointing the wrong test at a real database is the kind of
mistake that cannot be undone.

## The five bugs the first run found

The first run of the harness surfaced five permission bugs that
the existing test suite had missed. They are real bugs, they
are fixed in the current codebase, and they are worth writing
down because each one is a different shape of mistake.

### Bug 1: A left-join that exposed another tenant's notes

A route that returned "recent activity for a tracked builder"
joined the activity table to the private notes table to filter
out builders that the requester had marked private. The join
was correct. The filter on the notes table was correct. The
filter on the activity table was missing. The runtime could
read another tenant's activity rows because RLS on the activity
table was scoped to `organization_id` and the query had not
filtered by it.

The query had been written before row-level security existed.
The migration to multi-tenant had added a `withTenantContext`
helper that set `app.organization_id` for the RLS policies, and
the query had not been migrated to use it. The original
`userId`-based filter had been removed when the schema moved to
`organization_builders`, and the replacement `organization_id`
filter had not been added. The query was doing neither, and
the test suite was not catching it because the test role was
the owner.

The fix was the helper call. The lesson was that
`withTenantContext` is not a stylistic preference; it is the
only sanctioned way to scope a query to a tenant.

### Bug 2: An `IN` clause that crossed tenants

A search-results list filtered candidates by an `IN (...)`
clause over a list of builder ids, and the list of ids came
from a query that did not include the tenant filter. The IN
clause was correct. The ids it operated on were not from this
tenant.

The same shape of bug as the first, but in a different place.
The harness caught it because the assertion that "tenant A
should not see tenant B's results" failed when the search
returned tenant B's builder. The fix was the same: route the
list of ids through a tenant-scoped query, not through a
helper that returned ids from any tenant.

### Bug 3: A count query that included every tenant's data

A dashboard tile showed "tracked builders: N", and N was the
count of every tracked builder in the database, not the count
for the requesting organization. The query had been
`SELECT count(*) FROM organization_builders`, which is
correct in a world where every connection is the owner and
sees every row, and wrong in a world where the connection is
the runtime role and RLS applies.

The fix was a one-line change: add
`WHERE organization_id = current_setting('app.organization_id')::uuid`
and have the runtime set the setting. The test was added to
the harness to assert that the count for tenant A is
tenant A's count and the count for tenant B is tenant B's,
with no overlap.

### Bug 4: A `LIMIT` that came after a tenant-incorrect subquery

A "show me the first 10 builders" query had a subquery that
selected the right rows but in the wrong order, and the LIMIT
was applied to the outer query. The shape was: an unfiltered
inner query that returned every row in the database, ordered
by something, with a `LIMIT 10` on the outer query that
joined to the tenant-scoped table. The inner query had no
tenant filter, the outer query joined, and the LIMIT came
after the join, so the outer query was effectively choosing
the first 10 of everything. The result was a list that
included other tenants' builders at the top of the page.

The fix was to push the LIMIT into the subquery and apply
the tenant filter at the same level. The lesson was that
LIMIT and tenant-filter live on the same query, not on
different layers of a join.

### Bug 5: A background worker that used the wrong connection

A worker that ran on a cron cadence to refresh enrichment
metadata was using the runtime connection instead of the
worker connection. The runtime connection is the one that
RLS scopes to `app.organization_id`, and the worker was
running as a system process that did not have an
organization. The query was producing zero results because
the RLS policy was rejecting every row for "no organization
set on the session".

The fix was a one-line change in the worker bootstrap:
import `workerDb` instead of `client`, use it instead of the
runtime client. The lesson was that the four roles are not
interchangeable, and the worker role exists specifically so
the worker can read across tenants when it needs to.

## What the harness covers now

The harness exercises 86 real route handlers across the
spectrum: saved-queries, alerts, tracked builders and notes,
sprints, enrichment and evidence, the entitlement read,
exports, team and members, admin content management, dashboard
stats, the subject-only `/api/me/**` routes (data export,
delete account, evidence provenance, restrict processing),
the two grant-only public tables (`builder_embeddings`,
`discovery_state`), the alerts-worker cross-organization
isolation, the legal hard-delete sweep, and the platform-admin
abuse console. It is not the full inventory; the routes that
front a live external network call (search, sprint preview)
are exercised through the tenant-scoped logic they own
rather than the full HTTP handler, to keep the run fast and
deterministic.

The test takes about 30 seconds to run end to end, which is
slow for a unit test and fast for a security check. It runs
in CI on every push, and it runs in the local quality gate
before any deploy. The fixture is a disposable database that
is dropped and re-created on every run, so a leaked row from
a previous test cannot cause a false pass.

## What the harness does not catch

A few things the harness is honest about not catching:

- **It does not test every route.** The full inventory is
  roughly 34 routes under `src/routes/api/**`. The harness
  covers the bulk of them; the gaps are documented in
  `scripts/check-route-coverage.mjs` and exercised separately
  through the auth-guard check.
- **It does not test every input shape.** Malformed JSON,
  missing fields, oversized payloads — those are covered by
  the route's own validation, not by the isolation harness.
- **It does not test concurrent access.** Two requests
  racing for the same row is a different problem from one
  request reading another tenant's row, and the test for it
  is a different harness.
- **It does not test what happens after a future RLS policy
  change.** A new column on a private table that the RLS
  policy does not yet cover is a bug the harness would catch
  on the next run, not before. The harness is a guard, not a
  proof.

The list is honest because the failures from the first run
were real, and the same kind of bug exists in any codebase
whose tests run as the database owner. The harness catches
what the harness catches, and the rest of the security story
is in the production deployment, the role separation, and
the periodic restore drills.

## Why this post exists

Because the five bugs above are the kind of thing a
codebase can ship without noticing, and the only honest
thing to do is write down the specific kinds of mistakes
that produced them. A future engineer reading the commit
history and seeing "fix tenant filter on notes join" needs
to know that the bug was real, the test that should have
caught it did not, and the reason it now does. The harness
is the reason.

A test suite that runs as the database owner is not a
security test. A test that runs as the runtime role is.
BuilderHunt's test suite runs as the runtime role. That is
the only sentence of this post that matters, and the rest
of the post is the proof.
