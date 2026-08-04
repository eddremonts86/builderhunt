---
title: Restore drills — the two operational bugs we found by practising the disaster
description: A write-up of two real restore-rehearsal failures on BuilderHunt — the missing RLS roles in pg_restore, and the grant-only migration that lost its snapshot — and the schedule-driven drills that now catch them.
slug: restore-drills-the-two-bugs
date: 2026-08-10
tags: [engineering, operations, security]
author: edd
---

The most expensive time to find out that a backup does not
restore is the moment you need it. The second most expensive
time is the next morning, when the partial restore has
already been promoted to primary and the production traffic
is on top of it. The least expensive time is in a scheduled
drill, on a disposable database, with no users waiting and
no on-call rotation stressed.

This post is about the two specific restore failures the
drill found on BuilderHunt, what the production system would
have looked like if the drill had not been scheduled, and the
specific things the system now does so the next drill is
boring.

## Why drills exist at all

A backup that has never been restored is a backup that
"works", in the sense that the file exists and the schedule
says it ran. It is not a backup in the sense the word is
useful for, which is "a thing that can be promoted to primary
in an emergency". The difference between the two is the
restore path: the operations that read the backup, apply the
metadata, run the migrations, set the roles, and verify the
final state is the database the application expects.

The path is long, and every step is a place where the
restored database can diverge from the source. The two
divergences that follow are both real, both caught by the
drill, and both would have produced a "the database looks
fine, the application is broken" situation in production.

The drill exists to make the path boring. The drill is
scheduled, not reactive. The drill runs against a disposable
copy of the production data, not against staging, because
staging is not production. The drill asserts the result is
the same shape as production, and a divergence is treated
as a bug, not as a thing to investigate later.

## Bug 1: pg_restore ran before the cluster roles existed

Postgres row-level security is enforced based on the session
role. The BuilderHunt runtime uses four non-owner roles:
`builderhunt_app`, `builderhunt_auth`, `builderhunt_worker`,
`builderhunt_platform`. The RLS policies are written in
terms of these roles. A restored database that does not
have these roles has the policies but no one to enforce
them, and a policy that references a non-existent role is
silently dropped by Postgres at restore time.

That is the worst possible failure mode. The restore
completes. The database has every table. The schema looks
right. The application starts. The application connects as
`builderhunt_app`, which does not exist on this cluster,
which means the connection falls back to `postgres` —
the database owner, for whom RLS does not apply — and the
application now reads every row in every table across every
tenant. The restored database is up, the application is up,
and the multi-tenant isolation is silently gone.

The drill caught it because the assertion "the runtime role
can connect, the runtime role can read its own row but not
another tenant's row" failed on the restored database. The
"can connect" passed because the connection falls back to
the owner; the "cannot read another tenant's row" failed
because the RLS policy that would have blocked the read
was dropped at restore time, because the role the policy
referenced did not exist at restore time.

The shape of the fix: the restore script now creates the
roles *before* `pg_restore` runs. The order matters, and
the order is in a script that the drill exercises. The
roles are created from a committed SQL file, not from a
command-line flag, so the version of the roles the restore
applies is the version in the repository.

The shape of the prevention: the drill runs on a schedule
(now weekly), and the assertion is the same one every time.
A future change that re-introduces the order bug fails the
drill before it reaches production.

## Bug 2: A grants-only migration had no snapshot

Drizzle tracks schema state with a `journal` file and a
`meta/_journal.json` that maps migration numbers to their
snapshot files. A migration that does not change the schema
— for example, a migration that only grants privileges to a
new role — has no schema diff and therefore no snapshot.
Drizzle is happy to apply it. The next migration in the
sequence depends on a snapshot existing for this number, and
the absence of the snapshot is a silent failure of the
`drizzle-kit check` invariant.

The production data was unaffected. The local development
environment was unaffected, because the migrations ran in
order from a clean state. The drill caught it because the
drill's "clean restore" path applies every migration to a
fresh database and asserts the schema matches the
expectation, and a missing snapshot makes the assertion
fail with a message that points at the gap.

The fix: the grants-only migration gets a snapshot anyway.
The snapshot is the previous migration's schema, unchanged,
and it is committed to `drizzle/meta/` alongside the
migration. The check passes, the drill passes, and the
invariant is held.

The prevention: the migration release gate
(`scripts/db/check-migrations.mjs`) now runs on every push
and asserts that every entry in `_journal.json` has a
matching snapshot. The check used to be "if a snapshot
exists, it is parseable"; the check is now "every
journal entry has a snapshot, full stop". A future
grants-only migration that forgets the snapshot fails
the gate.

## What the drill does, step by step

The drill is implemented in
`scripts/db/restore-drill-local.mjs` and is scheduled by
the CI quality gate. The steps are:

1. Take the most recent production backup file from
   `backups/`. (In CI, this is a fixture; in production,
   it is the real file.)
2. Spin up a disposable Postgres cluster with a name that
   matches `builderhunt_security_test_*`, so the
   restore cannot accidentally target a real database.
3. Create the four non-owner roles from the committed
   SQL file.
4. Run `pg_restore` against the disposable cluster.
5. Apply every Drizzle migration in order, from a clean
   state, against the restored database. This is the
   step that catches the grants-only-without-snapshot
   bug.
6. Run the RLS isolation harness
   (`scripts/db/verify-api-isolation-local.mjs` from
   the [previous post](/blog/rls-non-owner-roles-five-bugs))
   against the restored cluster.
7. Assert the application's health check returns 200,
   the runtime role can read a row from the same
   tenant, and the runtime role cannot read a row from
   a different tenant.
8. Drop the disposable cluster, no matter what.

A drill that takes 12 minutes end to end is run on every
push that touches the migrations directory and on a weekly
cron for everything else. The weekly cron is the one that
catches a slow drift; the push-time check is the one that
catches a fast regression.

## What the drill is honest about not catching

- **It does not test the application.** The drill
  exercises the database and the migration runner. A
  bug in the application code that affects the restored
  database is caught by the integration tests, not by
  the drill.
- **It does not test the restore from cold storage.**
  The drill uses a local backup file. A real disaster
  is a backup that has been replicated to a different
  region, and that path is tested by a different
  exercise on a different cadence.
- **It does not test the time-to-restore.** The drill
  measures correctness, not speed. A drill that
  produces a correct result in three hours is a
  successful drill even though three hours is too slow
  for a real RTO. The speed dimension has its own
  measurement and its own alerts.
- **It does not test the human in the loop.** A
  drill that is run by the system has no human
  decision to test. The on-call rotation's
  response to a real alert is exercised by a
  different kind of drill, run by a different team,
  on a different cadence.

The list is the honest disclosure. The drill is
what the drill is, and the things it does not
test have their own tests.

## What the post-mortem was, and what it changed

The two bugs above are the two real findings from the
last restore drill cycle. The post-mortem produced
three changes:

1. **The restore script's role-creation step is now
   in the same committed file as the migration
   sequence.** The two are versioned together.
2. **The migration release gate now asserts
   journal-to-snapshot coverage.** The check is
   part of the CI quality gate, not a manual
   review.
3. **The drill is weekly, not "when we have
   time".** The schedule is the only thing that
   makes a drill a drill rather than a chore.

A backup that restores is a backup that has been
restored. A backup that has been restored is a
backup that has been restored in the last week.
Anything older than that is a guess, and the
guess is the part of operational security that
fails when you need it.

[Read the changelog entry](/changelog/restore-drills-and-migration-gates)
for the short version. The long version is this
post, and the reason the long version exists is
the same reason the drill exists: so the next
time something is wrong, the system catches it
before a user does.
