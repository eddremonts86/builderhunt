# PgBouncer image

Upstream PgBouncer **1.25.2**, built from the release archive in a multi-stage image. Plan 55 phase 4.

## Provenance

| | |
|---|---|
| source | `https://www.pgbouncer.org/downloads/files/1.25.2/pgbouncer-1.25.2.tar.gz` |
| sha256 | `924ad35113fd0a71c8e2dbe85b5d03445532e2b7b37a9f8a48983beea238b332` |
| licence | ISC — `LICENSE` is upstream's `COPYRIGHT` from tag `pgbouncer_1_25_2`, unmodified |

The checksum was computed from the downloaded archive, not copied from a page. A checksum nobody has
verified makes a build *look* pinned while accepting whatever the URL serves; if upstream republishes, this
build fails loudly instead of quietly compiling new code.

## Why build instead of pulling one

There is no official PgBouncer image. Every popular one is a third party's build of this same tarball, and
using one means trusting a maintainer we have not vetted with the component every database credential
passes through. Building from a checksum-pinned archive is fewer moving parts than auditing somebody else's
Dockerfile.

## Verified, not asserted

    docker buildx build --platform linux/amd64,linux/arm64 --check docker/pgbouncer
    # → Check complete, no warnings found.

    docker build -t builderhunt-pgbouncer:test docker/pgbouncer
    docker run --rm --entrypoint /usr/local/bin/pgbouncer builderhunt-pgbouncer:test --version
    # → PgBouncer 1.25.2

    docker run --rm --entrypoint id builderhunt-pgbouncer:test
    # → uid=10001(pgbouncer) gid=10001(pgbouncer)

    docker run --rm --entrypoint sh builderhunt-pgbouncer:test -c 'ls /etc/pgbouncer'
    # → pgbouncer.ini only; no userlist.txt in any layer

    docker run --rm --entrypoint sh builderhunt-pgbouncer:test -c 'command -v gcc || echo none'
    # → none; the build stage does not ship

## `make pgbouncer`, not `make`

Upstream's default target also builds the man pages with `pandoc`. The first build of this image failed on
`make[1]: pandoc: No such file or directory`, and adding pandoc would have been the wrong fix — a
documentation toolchain in the build stage of a connection pooler is a dependency that can break the build
of the thing that fronts every credential.

## The auth file is never in the image

`entrypoint.sh` writes `userlist.txt` at run time into a tmpfs, under `umask 0177`, from six environment
variables. It refuses to start if any is unset rather than writing an empty entry that PgBouncer accepts
and then fails on hours later as an authentication problem. Nothing in the script prints a password — not
on success, not in the error naming the missing variable.

An auth file baked into a layer is a credential in a registry: layers are cacheable, pullable and, for
anyone who can read the image, permanent.

## Running it

    docker compose --profile standalone --profile load up -d

**Both** profiles. `pgbouncer` depends on `db`, and Compose refuses a dependency whose profile is inactive
— `--profile load` alone answers `depends on undefined service "db"`. That is Compose being right: a pooler
with no database behind it would start, bind 6432 and refuse every connection.

The port is published on `127.0.0.1` only. The pooler holds every role's password, and a container
publishing 6432 on all interfaces is one café network away from being reachable.

## The budget in `pgbouncer.ini`

`transaction` mode, `default_pool_size = 12` plus `reserve_pool_size = 4`, `max_db_connections = 80`,
`max_client_conn = 500` — the numbers plan 55's threshold table asserts against. Its timeouts are
deliberately *longer* than the app's 5-second `statement_timeout`, so the pooler is never the thing that
cancels a query: a timeout an operator traced to the database but which actually came from here is a much
harder failure to diagnose.

Transaction mode is available at all because this app keeps no session state across statements — tenant
context is `SET LOCAL`, and there is no `LISTEN` and no session-scoped advisory lock.
`tests/e2e/api/pgbouncer-compatibility.spec.ts` is what proves that rather than this paragraph asserting it.
