# Deploying PgBouncer on this Coolify instance

The copy-and-paste half of
[`load-testing.md`'s rollout section](./load-testing.md#rolling-pgbouncer-out-on-coolify), with this
environment's real values already resolved. That document explains *why*; this one is what to paste.

Written 2026-08-14 against the live instance. Nothing here was transcribed from memory — every id,
network and image below was read back from the Coolify API the same day.

## The environment, as it actually is

| Thing | Value | How it was established |
|---|---|---|
| Application | `l12rscsq1js9t4xr4a9a5zr6` — `builderhunt`, `https://builderhunt.dev` | `GET /applications` |
| Production database | `ekq4rkiqtyl5nzzb3cc32kkg` — `builderhunt-db-pg18`, `pgvector/pgvector:0.8.5-pg18` | `GET /databases` |
| Docker network | `coolify` | the database resource's `destination.network` |
| Database port | 5432, private only (`is_public: false`, `public_port: null`) | the database resource |
| `max_connections` | **100** — the image default | `postgres_conf` is empty, so nothing overrides it |

> ⚠️ **There are two `builderhunt` databases and only one is production.**
> `builderhunt-db` (`rhxnxwo8bnvbndyuvx56m00k`, pg16) is the **preview** environment's, and every
> production `DATABASE_*_URL` points at `ekq4rkiqtyl5nzzb3cc32kkg` instead. Pointing the pooler at the
> pg16 one would produce a certification of the wrong database that looked entirely normal.

## Step 0 — raise `max_connections` to 120

The connection budget assumes 120 (four app processes × 26 pooled connections, plus the pooler, the
migration connection and a monitor). At 100 the budget does not fit, so this comes first.

**Use `ALTER SYSTEM`, not Coolify's `postgres_conf` field.** That field is empty today, which means the
container is running the `postgresql.conf` `initdb` generated. Coolify mounts what you put there *as*
the config file rather than merging it, so a one-line value would drop every default the image relies
on — including `listen_addresses = '*'`, whose PostgreSQL default is `localhost`. The database would
come back up unreachable from the app, and the symptom would look like a network problem.

`ALTER SYSTEM` writes `postgresql.auto.conf`, which PostgreSQL *includes after* the main file. It adds;
it does not replace.

```bash
psql -U bhuser -d builderhunt -c "ALTER SYSTEM SET max_connections = 120;"
```

Nothing changes yet — `max_connections` needs a restart. That is deliberate: the value can be staged
well before the window and applied inside it.

Undo, if it is ever needed:

```bash
psql -U bhuser -d builderhunt -c "ALTER SYSTEM RESET max_connections;"
```

Apply it by restarting the database resource, then **verify the effective value rather than the
written one** — those are different claims, and this repository has already been caught by the
difference:

```sql
SHOW max_connections;   -- must print 120
```

## Step 1 — create the pooler service

A **separate Docker Compose resource on the `coolify` network**, not a container beside the app.
Nothing about it is published; the app reaches it by service name.

```yaml
services:
  pgbouncer:
    build:
      context: https://github.com/eddremonts86/builderhunt.git#master:docker/pgbouncer
    container_name: builderhunt-pgbouncer
    environment:
      # Upstream: the production database resource, by its Coolify internal hostname.
      PGBOUNCER_UPSTREAM_HOST: ekq4rkiqtyl5nzzb3cc32kkg
      PGBOUNCER_UPSTREAM_PORT: '5432'
      # The six secrets. Paste the values in Coolify's UI — see below.
      BUILDERHUNT_APP_PASSWORD: ${BUILDERHUNT_APP_PASSWORD}
      BUILDERHUNT_AUTH_PASSWORD: ${BUILDERHUNT_AUTH_PASSWORD}
      BUILDERHUNT_WORKER_PASSWORD: ${BUILDERHUNT_WORKER_PASSWORD}
      BUILDERHUNT_PLATFORM_PASSWORD: ${BUILDERHUNT_PLATFORM_PASSWORD}
      BUILDERHUNT_CAPABILITY_PASSWORD: ${BUILDERHUNT_CAPABILITY_PASSWORD}
      PGBOUNCER_ADMIN_PASSWORD: ${PGBOUNCER_ADMIN_PASSWORD}
    # Memory-backed, so the generated userlist.txt never reaches a writable layer or a volume.
    # Mounted at /run/pgbouncer and NOT /etc/pgbouncer: mounting over the latter shadows the
    # pgbouncer.ini the image bakes there, and the container then restart-loops on
    # `could not load file "/etc/pgbouncer/pgbouncer.ini"` — while the image itself builds clean.
    tmpfs:
      - /run/pgbouncer:mode=0700,uid=10001,gid=10001
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -p 6432 -U pgbouncer -d pgbouncer || exit 1']
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s
    restart: unless-stopped
networks:
  default:
    name: coolify
    external: true
```

No `ports:` mapping. The local compose file publishes `127.0.0.1:6432` for developer convenience;
publishing it here would put a database pooler on a public interface.

### The six secrets — paste these yourself

Five of them already exist in this Coolify instance, inside the application's
`DATABASE_*_URL` values. They are the password between `:` and `@`:

| Pooler variable | Source |
|---|---|
| `BUILDERHUNT_APP_PASSWORD` | `DATABASE_URL` (role `builderhunt_app`) |
| `BUILDERHUNT_AUTH_PASSWORD` | `DATABASE_AUTH_URL` |
| `BUILDERHUNT_WORKER_PASSWORD` | `DATABASE_WORKER_URL` |
| `BUILDERHUNT_PLATFORM_PASSWORD` | `DATABASE_PLATFORM_URL` |
| `BUILDERHUNT_CAPABILITY_PASSWORD` | `DATABASE_CAPABILITY_URL` |
| `PGBOUNCER_ADMIN_PASSWORD` | **new** — generate one: `openssl rand -hex 24`. It only reaches `SHOW POOLS`/`STATS`/`CONFIG`. |

Take them from the Coolify UI and paste them into the pooler's environment there. Do not route them
through a terminal, a chat window or a script: they are production database credentials, and every
copy that exists somewhere else is a copy that can leak. `DATABASE_MIGRATION_URL`'s `bhuser` password
is **not** among them — the migration connection never goes through the pooler.

## Step 2 — prove it before trusting it

```bash
pnpm load:pooler:preflight
```

Thirteen checks: five roles reaching `SELECT 1` through 6432, `SHOW CONFIG` reporting transaction mode
with 12/4/80/500, the migration URL still on the direct port, `max_connections >= 120`, and a healthy
container. It reads the caps **from the running pooler**, not from the committed ini — a file in the
repository is not evidence about a running container, and this repo has the scar: the ini was correct
while the container could not start at all.

## Step 3 — the cutover, and the one URL that must not move

Repoint **only** the five runtime role URLs at `builderhunt-pgbouncer:6432`, then redeploy:

`DATABASE_URL`, `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`, `DATABASE_PLATFORM_URL`,
`DATABASE_CAPABILITY_URL`.

`DATABASE_MIGRATION_URL` stays direct on `ekq4rkiqtyl5nzzb3cc32kkg:5432`. A migration runs many
statements in one transaction and takes advisory locks; under transaction pooling it is handed a
different backend between statements and the locks are released underneath it. A half-applied
migration is the worst outcome in this document.

**Rollback is one step**: point those five back at `ekq4rkiqtyl5nzzb3cc32kkg:5432` and redeploy. The
pooler holds no state the application needs and no schema changed.

## What this does not cover

The certification runs themselves — see *The certification window, step by step* in
[`load-testing.md`](./load-testing.md). They need this pooler, a disposable
`builderhunt_load_test_*` database, a verified-restorable backup and an approved window.
