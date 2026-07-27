---
title: Two operational bugs found by drilling the restore, not by waiting for it
slug: restore-drills-and-migration-gates
date: 2026-07-27
tags: [bugfix, improvement]
---

A backup you have never restored is a hypothesis. Ours is now rehearsed on a
schedule, and the rehearsal has already paid for itself twice.

**Roles were created after the data.** `pg_restore` was running before the
cluster roles existed, so every row-level-security policy that referenced a
missing role was silently dropped on the way in. The restored database looked
complete and had lost its tenant isolation — the single worst failure mode
available to us, and completely invisible without an explicit check. Roles are
now bootstrapped before the restore, and the capability role the candidate portal
uses was missing from that bootstrap too.

**Migrations and their snapshots drifted.** Four migrations landed without their
matching Drizzle snapshot files, which breaks the ability to generate a correct
next migration. There is a test asserting the migration journal and the snapshot
directory agree, so this now fails the build rather than surfacing weeks later as
an impossible-looking diff.

Also fixed in the same sweep: a Node-only Postgres client was leaking into the
browser bundle, and the alerts RLS fixture was seeding a row shape its own column
constraint rejected.

None of these reached a user. All of them would have, eventually.
