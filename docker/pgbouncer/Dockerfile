# PgBouncer, built from the upstream release archive (plan 55 phase 4).
#
# ## Why build rather than pull
#
# There is no official PgBouncer image. Every popular one is a third party's build of the same tarball, and
# taking one means trusting a maintainer we have not vetted with the connection pooler that every database
# credential passes through. Building from the signed-by-checksum release archive is fewer moving parts than
# auditing somebody else's Dockerfile, and the provenance is a line in this file rather than a hope.
#
# ## The checksum is real
#
# `924ad351…b332` was computed from the archive downloaded from pgbouncer.org, not copied from a README. A
# checksum nobody has verified is decoration: it makes the build *look* pinned while accepting whatever the
# URL serves. If upstream ever republishes, this build fails loudly instead of quietly using new code.
FROM alpine:3.22 AS build

ARG PGBOUNCER_VERSION=1.25.2
ARG PGBOUNCER_SHA256=924ad35113fd0a71c8e2dbe85b5d03445532e2b7b37a9f8a48983beea238b332

RUN apk add --no-cache build-base libevent-dev openssl-dev c-ares-dev pkgconf curl

WORKDIR /src
RUN curl -fsSL -o pgbouncer.tar.gz \
      "https://www.pgbouncer.org/downloads/files/${PGBOUNCER_VERSION}/pgbouncer-${PGBOUNCER_VERSION}.tar.gz" \
 && echo "${PGBOUNCER_SHA256}  pgbouncer.tar.gz" | sha256sum -c - \
 && tar xzf pgbouncer.tar.gz --strip-components=1 \
 && ./configure --prefix=/usr/local --with-cares \
 # `make pgbouncer`, not a bare `make`. Upstream's default target also builds the man pages with
 # `pandoc`, which is not installed here and should not be: a documentation toolchain in the build stage
 # of a connection pooler is a dependency that can break the build of the thing that fronts every
 # database credential. The first attempt at this image failed on exactly that —
 # `make[1]: pandoc: No such file or directory` — and adding pandoc would have been the wrong fix.
 && make -j"$(nproc)" pgbouncer \
 && install -m 0755 pgbouncer /usr/local/bin/pgbouncer

# ── Runtime ──────────────────────────────────────────────────────────────────────────────────────
#
# A separate stage so the compiler, the headers and the source tree do not ship. The image that runs in
# front of the database should contain the pooler and nothing that could build another one.
FROM alpine:3.22

ARG PGBOUNCER_VERSION=1.25.2
LABEL org.opencontainers.image.title="builderhunt-pgbouncer" \
      org.opencontainers.image.version="${PGBOUNCER_VERSION}" \
      org.opencontainers.image.licenses="ISC" \
      org.opencontainers.image.source="https://www.pgbouncer.org/downloads/files/${PGBOUNCER_VERSION}/pgbouncer-${PGBOUNCER_VERSION}.tar.gz" \
      org.opencontainers.image.description="Upstream PgBouncer, built from the checksum-pinned release archive"

RUN apk add --no-cache libevent openssl c-ares postgresql-client \
 # A dedicated non-root user. PgBouncer needs no privilege beyond binding its own port and reading a file
 # it generates itself, and a pooler running as root is a pooler whose compromise is a host compromise.
 && addgroup -g 10001 -S pgbouncer \
 && adduser -u 10001 -S -G pgbouncer -h /var/lib/pgbouncer pgbouncer \
 && mkdir -p /var/lib/pgbouncer /etc/pgbouncer /run/pgbouncer \
 && chown -R pgbouncer:pgbouncer /var/lib/pgbouncer /etc/pgbouncer /run/pgbouncer

COPY --from=build /usr/local/bin/pgbouncer /usr/local/bin/pgbouncer
COPY pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# The upstream licence travels with the binary, which is what the ISC terms require.
COPY LICENSE /usr/share/licenses/pgbouncer/LICENSE

RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER pgbouncer
EXPOSE 6432

# `userlist.txt` is written by the entrypoint into a tmpfs at run time, never baked here — see
# `entrypoint.sh` for why an auth file in an image layer is a credential in a registry.
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD pg_isready -h 127.0.0.1 -p 6432 -U pgbouncer -d pgbouncer || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
