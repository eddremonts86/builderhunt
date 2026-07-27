# Database Restore

How to bring the BuilderHunt database back from a backup, and why the obvious way is wrong.

Companion docs: [`../runbook.md`](../runbook.md) (backup schedule, cron table),
[`deploy-runbook.md`](./deploy-runbook.md) (how roles get their passwords),
[`database-roles.md`](./database-roles.md) (what each role is allowed to do),
[`external-services-register.md`](./external-services-register.md#7-hetzner-storage-box--off-box-backup-4mo)
(the Storage Box, snapshot schedule, and the restore-test record).

---

## The one rule

**Create the cluster roles *before* `pg_restore`.** Everything else in this document follows
from that.

`pg_dump` of a single database — which is what Coolify's scheduled backup of `builderhunt-db`
produces — does **not** contain roles. Roles are *cluster-level* objects, so they live in
`pg_dumpall`, not `pg_dump`. This application's entire multi-tenant security model is RLS
policies bound to named roles (`builderhunt_app`, `_auth`, `_worker`, `_platform`), so a dump
is full of statements like:

```sql
CREATE POLICY work_sample_analyses_app_update ON public.work_sample_analyses
  FOR UPDATE TO builderhunt_app USING (...);
```

Restore that into a cluster where `builderhunt_app` does not exist and **every one of those
statements fails** — 162 of them in the 2026-07-26 production restore test, 192 in the local
reproduction of it.

### What the failure actually looks like

This is the part worth internalising, because nothing about the restore *looks* wrong:

| Signal an operator checks | What it says after a roles-less restore |
| --- | --- |
| Table count | ✅ correct (all 90 restored) |
| Row counts | ✅ correct (`auth_users` 84, `organizations` 198, `builders` 21 …) |
| `vector` extension | ✅ present |
| RLS enabled on tenant tables | ✅ `relrowsecurity` **and** `relforcerowsecurity` set on all 54 |
| Policies | 🚨 **zero** |

`ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` and `CREATE POLICY` are separate entries in
the archive, and only the second kind depends on roles existing. So the enable flags come back
and the policies do not.

### It is fail-closed, not a leak

Verified empirically on 2026-07-26 against the reproduction: with RLS **forced** and zero
policies, a `builderhunt_app`-shaped role sees **0 of 198** `organizations` rows. Postgres
denies by default when RLS is on and no policy matches, and `FORCE` means even the table owner
gets no exemption.

So the failure mode is **an unusable database, not exposed data** — the app role cannot log in
at all (the role does not exist), and if someone creates it by hand it can read nothing.

The real risk is second-order, and it is an incident-time human risk: an operator under
pressure sees `permission denied` / empty pages everywhere and "fixes" it with
`ALTER TABLE ... DISABLE ROW LEVEL SECURITY` or `ALTER ROLE builderhunt_app BYPASSRLS`. **That**
turns a recoverable outage into a tenant-isolation breach. If you are ever tempted, stop and
restore again properly instead — it takes minutes.

---

## Restoring

`scripts/db/restore.ts` does the roles step for you. It auto-detects all three archive formats
in use (gzipped plain SQL from `scripts/db/backup.ts`, `pg_dump` custom format from Coolify,
and gzipped custom format), applies the roles, restores, and then **verifies** the result.

```bash
pnpm db:restore --file /path/to/backup.dmp --target postgresql://user:pass@host:5432/builderhunt_restore
```

It refuses to restore over `DATABASE_URL` unless you pass `--force`, because both dump paths
drop and recreate every object they touch.

Useful flags:

| Flag | When |
| --- | --- |
| `--roles-file <path>` | Use the roles dump captured next to the backup instead of the repo's `scripts/db/roles.sql`. |
| `--skip-roles` | Only when the target cluster already has the roles — e.g. a scratch database beside the live one. |
| `--skip-verify` | Not recommended; skips the RLS integrity check that exists because of this bug. |

### What the verification asserts

After restoring, the script fails loudly if:

- any table has **RLS enabled with zero policies** — the exact fingerprint of this defect;
- any `builderhunt_*` role has **SUPERUSER or BYPASSRLS**, which would defeat every policy
  that was just restored.

A clean run ends with:

```
[restore]   tables: 90, RLS-enabled: 54, policies: 192
[restore]   RLS integrity OK — every RLS-enabled table has policies
```

---

## Where the roles come from

Two independent sources, in this order of preference:

1. **`scripts/db/roles.sql`** (in-repo, the default). Idempotent, password-free, and
   `tests/unit/security/restore-roles-bootstrap.test.ts` fails the ordinary test run if it drifts
   from the `CREATE ROLE`/`ALTER ROLE` statements in `drizzle/0002_database_roles.sql`,
   `0007_auth_broker.sql` and `0012_platform_role.sql`. Works with *any* backup, including
   ones taken before the roles dump existed.
2. **`builderhunt-roles-latest.sql`** next to the backup on the Storage Box, captured nightly
   by `scripts/ops/builderhunt-backup-sync.sh` with
   `pg_dumpall --roles-only --no-role-passwords`. Use it via `--roles-file` when you want the
   roles the live cluster *actually* had rather than the ones the repo expects.

### Neither source carries passwords, on purpose

A backup target must not hold credential material, so the roles dump is taken with
`--no-role-passwords` and `roles.sql` contains no `PASSWORD` clause. Role passwords are
provisioned from the Coolify `DATABASE_*_URL` env vars by **`pnpm deploy:db` step 5**
(`scripts/deploy/orchestrate.mjs`), exactly as on a normal deploy — see
[`deploy-runbook.md`](./deploy-runbook.md#the-orchestrator--pnpm-deploydb). That is why the
restore leaves the roles login-capable but credential-less: the deploy path owns passwords.

> **Gotcha if you apply a captured roles dump by hand:** `pg_dumpall --roles-only` always
> includes a `CREATE ROLE` for the cluster's own bootstrap superuser (usually `postgres`),
> which already exists on the target. With `psql --set ON_ERROR_STOP=1` that single expected
> error aborts the whole file. `restore.ts` therefore judges the roles step by checking which
> roles exist afterwards, not by psql's exit code.

---

## Full disaster recovery — restoring onto a new host

Order matters; steps 2 and 3 are the ones that get skipped.

1. **Provision Postgres as `pgvector/pgvector:pg16`.** Not plain `postgres:16` — the dump
   contains `CREATE EXTENSION vector`, and on an image without pgvector that failure rolls
   back the batch (see `runbook.md` §7 and `drizzle/0013_polite_night_thrasher.sql`).
2. **Create the target database.** `CREATE DATABASE builderhunt` (or `pnpm tsx
   scripts/db/create-db.ts` with `DATABASE_MIGRATION_URL` pointed at the new cluster).
3. **Restore, roles first.** `pnpm db:restore --file <dump> --target <new-cluster-url>`. Do
   not run `drizzle-kit migrate` first — the dump already contains the full schema *and* a
   populated `drizzle.__drizzle_migrations`, so migrations would be skipped as already applied
   while the roles still would not exist.
4. **Provision role passwords**: set the `DATABASE_*_URL` env vars in Coolify and deploy, or
   run `pnpm deploy:db` against the new cluster. Step 5 `ALTER ROLE ... PASSWORD`s each role
   and step 6 verifies each can log in.
5. **Verify as a real role, not as the owner.** Never accept an owner-connection query as
   proof: the owner is exempt from RLS unless it is forced, so it sees rows a tenant role
   would not. `pnpm test:rls:local` against the restored database is the strong check.
6. **Check `/api/status`** — it reports DB health, and `/status` shows the public view.

### If you see `role "builderhunt_app" does not exist`

The roles step was skipped. Do **not** create the role by hand and re-point the app at it — the
policies from that dump are already lost and no amount of role creation brings them back. Drop
the target database, recreate it, and restore again with the roles step. `restore.ts` prints
this same instruction when it detects those errors.

---

## Drills

### Fresh-cluster drill — `pnpm db:restore-drill`

```bash
pnpm db:restore-drill --file /path/to/backup.dmp
```

Spins up a throwaway `pgvector/pgvector:pg16` container (random loopback-only port, no volume,
auto-removed), confirms it has **zero** `builderhunt_*` roles, restores into it, then verifies
independently from inside the container. Requires Docker; touches nothing long-lived.

**This is the drill that matters for this class of bug**, and it is deliberately separate from
`pnpm db:restore-test`. `scripts/db/restore-test.ts` rehearses dump→restore between two
databases on *one* server — `assertRestoreTestTargets` requires the same host on purpose — and
a same-cluster restore always finds the roles already present. That is precisely why it passed
for months while a real fresh-cluster restore was broken. **A restore rehearsal that reuses the
cluster cannot prove a restore works.**

To reproduce the original defect on demand:

```bash
pnpm db:restore-drill --file /path/to/backup.dmp --skip-roles   # expect: FAILED, 0 policies
```

### Cadence

Re-run the drill against a **real Storage Box dump** (not a locally generated one) after any
change to: the role migrations, the Coolify backup configuration, the sync script, or the
Postgres major version. Record the result in
[`external-services-register.md` §7](./external-services-register.md#7-hetzner-storage-box--off-box-backup-4mo)
— a restore that was never repeated after the thing it depends on changed is back to being a
hope.

---

## Pulling a dump from the Storage Box

The off-site copy lives on sub-account `u640315-sub1` under `./coolify-db-backups/`, with the
roles dumps in `./coolify-db-backups/builderhunt-roles/`. Pull **from the Storage Box** rather
than from the VPS's local disk when drilling — that is what proves the off-site copy is
readable, which is the only copy that survives losing the box.

```bash
# port 23, not 22: port 22 is SFTP-only (no shell) and rsync needs a shell.
# The host resolves IPv6-only.
rsync -avz -e 'ssh -p 23 -i /root/.ssh/storagebox_rsa' \
  u640315-sub1@u640315-sub1.your-storagebox.de:./coolify-db-backups/ ./restore-scratch/
```

Restore into a **throwaway** target, never anything production-adjacent. The dump contains
real user data, so treat the scratch cluster as production-grade for handling purposes and
destroy it when the drill is done — `pnpm db:restore-drill` does that by default.
