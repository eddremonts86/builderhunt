#!/usr/bin/env bash
#
# builderhunt-backup-sync.sh — ship the production database backups off the box.
#
# Installed on conductor-01 as /usr/local/bin/builderhunt-backup-sync.sh, run from cron:
#
#   30 3 * * * /usr/local/bin/builderhunt-backup-sync.sh >> /var/log/builderhunt-backup-sync.log 2>&1
#
# Timing (do not reorder these without re-reading the chain):
#   03:00 UTC  Coolify's scheduled backup of builderhunt-db writes a pg_dump custom-format
#              archive into /data/coolify/backups/
#   03:30 UTC  this script — captures the cluster roles, then rsyncs everything to the
#              Hetzner Storage Box sub-account
#   05:00 UTC  Storage Box automated snapshot (max 10) — the accidental-deletion and
#              ransomware protection; a replication target without snapshots just mirrors
#              a deletion
#
# THE ROLES DUMP IS NOT OPTIONAL — read this before removing it
# ============================================================
# Coolify's backup is `pg_dump` of a single database. `pg_dump` does not include roles: they
# are cluster-level objects and live only in `pg_dumpall`. This application's entire
# multi-tenant security model is RLS policies bound to named roles, so restoring that dump
# into a fresh cluster fails every `CREATE POLICY ... TO builderhunt_app` statement in it —
# 192 of them in the 2026-07-26 restore test — while `ALTER TABLE ... ENABLE ROW LEVEL
# SECURITY` restores fine. The result is RLS forced on every tenant table with zero policies:
# fail-closed, so not a data leak, but a database no application role can read.
#
# `--no-role-passwords` is deliberate: a backup target must never hold credential material.
# Role passwords are provisioned from the Coolify `DATABASE_*_URL` env vars by
# `pnpm deploy:db` step 5 on the next deploy, exactly as on a normal release.
#
# The repo also carries `scripts/db/roles.sql`, which recreates the same roles from the
# migrations. That is the primary recovery path and needs nothing from this script; the dump
# captured here is the belt-and-braces copy that also captures any role present in the live
# cluster but not in the repo.
#
# Full restore procedure: docs/operations/database-restore.md

set -euo pipefail

# --- configuration ------------------------------------------------------------------------
BACKUP_ROOT="${BACKUP_ROOT:-/data/coolify/backups}"
ROLES_DIR="${ROLES_DIR:-${BACKUP_ROOT}/builderhunt-roles}"
ROLES_KEEP="${ROLES_KEEP:-30}"

# Storage Box sub-account, scoped to the `builderhunt` home directory — never the root
# credentials. Port 23, not 22: port 22 is SFTP-only (mod_sftp, no shell) and rsync needs a
# shell, so key auth on 22 fails with `Permission denied (publickey,password)` no matter the
# key type. The host resolves IPv6-only.
SB_HOST="${SB_HOST:-u640315-sub1.your-storagebox.de}"
SB_USER="${SB_USER:-u640315-sub1}"
SB_PORT="${SB_PORT:-23}"
SB_KEY="${SB_KEY:-/root/.ssh/storagebox_rsa}"
SB_DEST="${SB_DEST:-./coolify-db-backups/}"

# MinIO holds the candidate documents (CVs). Its data lives in a Docker named volume, so it is
# read through a throwaway container rather than a host path: Docker owns where that path lives
# and it must not be hardcoded here. Deployed 2026-07-26 as `builderhunt-minio` on the `coolify`
# network with no published ports.
#
# WHY THIS IS IN THE SAME SCRIPT AS THE DB DUMPS: the register's whole justification for a
# €4/month Storage Box is the MinIO volume, not the database (the DB is ~5 MB). A single disk
# with no redundancy holding candidate CVs is the one real trade-off accepted when MinIO was
# chosen over Cloudflare R2. Sync was wired up *before* any document exists, so the off-site
# copy is never retrofitted onto data that already matters.
MINIO_VOLUME="${MINIO_VOLUME:-builderhunt-minio-data}"
MINIO_DEST="${MINIO_DEST:-./minio-data/}"
MINIO_STAGE="${MINIO_STAGE:-/tmp/builderhunt-minio-stage}"

# The Coolify Postgres container. Resolved by name rather than hardcoded because Coolify
# renames containers when a resource is recreated; override with DB_CONTAINER if needed.
DB_CONTAINER="${DB_CONTAINER:-}"
DB_SUPERUSER="${DB_SUPERUSER:-}"   # empty = read POSTGRES_USER off the container
DB_NAME="${DB_NAME:-builderhunt}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

failed=0
fail() { log "ERROR: $*"; failed=1; }

# --- 1. capture the cluster roles ----------------------------------------------------------
capture_roles() {
  local container="$DB_CONTAINER"
  if [ -z "$container" ]; then
    # Coolify names database containers after the *resource uuid*, not the display name, so
    # `--filter name=builderhunt-db` matches nothing (verified 2026-07-26: the container is
    # literally `rhxnxwo8bnvbndyuvx56m00k`). Identify it by what it actually is instead —
    # the running Postgres whose POSTGRES_DB is `builderhunt` — which also survives Coolify
    # recreating the resource under a new uuid.
    local c candidates=''
    for c in $(docker ps --format '{{.Names}}'); do
      if docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
           | grep -qx "POSTGRES_DB=${DB_NAME}"; then
        candidates="${candidates}${c} "
      fi
    done
    set -- $candidates
    if [ "$#" -gt 1 ]; then
      # More than one cluster answers to POSTGRES_DB=builderhunt. This is the normal state during
      # a major-version cutover (2026-08-05: pg16 kept running as the rollback while PG18 took
      # over), and taking the first match would have silently captured the roles of whichever
      # container `docker ps` happened to list first — the wrong cluster, in a file named
      # "latest", with no error. Ask the application which one it actually uses.
      local app_host=''
      for c in $(docker ps --format '{{.Names}}'); do
        app_host=$(docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
                   | sed -n 's#^DATABASE_URL=postgres\(ql\)\?://[^@]*@\([^:/]*\).*#\2#p' | head -1)
        [ -n "$app_host" ] && break
      done
      for c in "$@"; do
        [ "$c" = "$app_host" ] && container="$c" && break
      done
      if [ -n "$container" ]; then
        log "multiple Postgres containers match POSTGRES_DB=${DB_NAME} ($*) — using ${container}, the one DATABASE_URL points at"
      else
        fail "multiple Postgres containers match POSTGRES_DB=${DB_NAME} ($*) and none matches the application's DATABASE_URL host ('${app_host:-not found}') — roles NOT captured. Set DB_CONTAINER explicitly rather than letting this guess."
        return 1
      fi
    else
      container="$1"
    fi
  fi
  if [ -z "$container" ]; then
    fail "no running Postgres container with POSTGRES_DB=${DB_NAME} — roles NOT captured. A restore into a fresh cluster will lose every RLS policy unless scripts/db/roles.sql is applied first."
    return 1
  fi

  # The superuser is NOT `postgres` on a Coolify-provisioned Postgres — that role does not
  # exist and `pg_dumpall -U postgres` dies with `FATAL: role "postgres" does not exist`,
  # which the old `2>/dev/null` hid completely. Read the real one off the container.
  local superuser="$DB_SUPERUSER"
  if [ -z "$superuser" ]; then
    superuser="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
                 | sed -n 's/^POSTGRES_USER=//p' | head -n1)"
  fi
  if [ -z "$superuser" ]; then
    fail "could not determine POSTGRES_USER for ${container} — roles NOT captured"
    return 1
  fi
  DB_SUPERUSER="$superuser"

  mkdir -p "$ROLES_DIR"
  local stamp dated latest
  stamp="$(date -u '+%Y%m%d')"
  dated="${ROLES_DIR}/builderhunt-roles-${stamp}.sql"
  latest="${ROLES_DIR}/builderhunt-roles-latest.sql"

  # Write to a temp file first so a failure mid-dump cannot leave a truncated roles file
  # that looks valid to a future restore.
  local tmp
  tmp="$(mktemp "${ROLES_DIR}/.roles.XXXXXX")"
  if ! docker exec "$container" pg_dumpall \
        --username "$DB_SUPERUSER" --roles-only --no-role-passwords > "$tmp" 2>>"${ROLES_DIR}/.roles.err"; then
    rm -f "$tmp"
    fail "pg_dumpall --roles-only failed in container ${container} — roles NOT captured"
    return 1
  fi

  # A roles dump with no builderhunt_* role in it is worse than none: it would let a restore
  # drill pass its "roles file applied" step while creating nothing.
  if ! grep -q 'CREATE ROLE builderhunt_' "$tmp"; then
    rm -f "$tmp"
    fail "roles dump contains no builderhunt_* role — refusing to publish it"
    return 1
  fi
  if grep -qi 'PASSWORD' "$tmp"; then
    rm -f "$tmp"
    fail "roles dump unexpectedly contains password material — refusing to ship it off-box"
    return 1
  fi

  chmod 600 "$tmp"
  mv "$tmp" "$dated"
  cp "$dated" "$latest"
  log "captured roles from ${container}: $(grep -c 'CREATE ROLE' "$dated") role(s) -> ${dated}"

  # Roles change on the order of once a year; keep a short history.
  find "$ROLES_DIR" -maxdepth 1 -name 'builderhunt-roles-20*.sql' -type f \
    | sort -r | tail -n "+$((ROLES_KEEP + 1))" | while read -r old; do
      rm -f "$old" && log "pruned old roles dump $(basename "$old")"
    done
}

# --- 2. replicate to the Storage Box -------------------------------------------------------
sync_offsite() {
  if [ ! -d "$BACKUP_ROOT" ]; then
    fail "backup root ${BACKUP_ROOT} does not exist — nothing to sync"
    return 1
  fi
  if [ ! -f "$SB_KEY" ]; then
    fail "SSH key ${SB_KEY} not found — cannot reach the Storage Box"
    return 1
  fi

  # No --delete, on purpose: local retention prunes at 30 days and the off-site copy keeps
  # history. Surviving a local deletion is the entire point of the off-site copy.
  if rsync -az --stats \
       -e "ssh -p ${SB_PORT} -i ${SB_KEY} -o StrictHostKeyChecking=accept-new -o BatchMode=yes" \
       "${BACKUP_ROOT}/" "${SB_USER}@${SB_HOST}:${SB_DEST}"; then
    log "rsync to ${SB_HOST}:${SB_DEST} complete"
  else
    fail "rsync to ${SB_HOST}:${SB_DEST} failed"
    return 1
  fi
}

# --- 3. ship the MinIO volume (candidate documents) ----------------------------------------
sync_minio() {
  if ! docker volume inspect "$MINIO_VOLUME" >/dev/null 2>&1; then
    log "no docker volume '${MINIO_VOLUME}' — MinIO not deployed yet, skipping"
    return 0
  fi
  rm -rf "$MINIO_STAGE"
  mkdir -p "$MINIO_STAGE"
  # Read the volume through a throwaway container: Docker owns the host path and it must not be
  # hardcoded. `:ro` so a bug here can never mutate the live bucket.
  if ! docker run --rm -v "${MINIO_VOLUME}:/src:ro" -v "${MINIO_STAGE}:/dst" alpine:latest \
        sh -c 'cp -a /src/. /dst/'; then
    fail "could not stage volume ${MINIO_VOLUME} — candidate documents NOT shipped off-box"
    rm -rf "$MINIO_STAGE"
    return 1
  fi
  # No --delete here either: a deletion in the live bucket must not propagate to the only
  # off-site copy of a candidate's CV.
  if rsync -az --stats \
       -e "ssh -p ${SB_PORT} -i ${SB_KEY} -o StrictHostKeyChecking=accept-new -o BatchMode=yes" \
       "${MINIO_STAGE}/" "${SB_USER}@${SB_HOST}:${MINIO_DEST}"; then
    log "rsync of ${MINIO_VOLUME} to ${SB_HOST}:${MINIO_DEST} complete"
  else
    fail "rsync of ${MINIO_VOLUME} failed"
    rm -rf "$MINIO_STAGE"
    return 1
  fi
  rm -rf "$MINIO_STAGE"
}

log "=== builderhunt backup sync starting ==="

# The roles capture runs first so the current roles ship with tonight's dump, but a failure
# there must not stop the database archives from leaving the box — a data backup without
# roles is still far better than no off-site copy. Both outcomes are reported, and any
# failure makes the whole run exit non-zero so it is visible in the log rather than silent.
capture_roles || true
sync_offsite || true
# MinIO last: the database is the smaller, more urgent artifact, and a MinIO failure must not
# stop the dumps from leaving the box.
sync_minio || true

if [ "$failed" -ne 0 ]; then
  log "=== builderhunt backup sync FINISHED WITH ERRORS (see above) ==="
  exit 1
fi
log "=== builderhunt backup sync complete ==="
