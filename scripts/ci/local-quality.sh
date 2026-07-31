#!/usr/bin/env bash
#
# Runs the `quality` job from .github/workflows/quality.yml on this machine.
#
# The point is not to re-type the commands — it is to reproduce the *environment*, because that is
# where the divergences that cost real CI cycles came from. Five consecutive red runs on 2026-07-27
# were diagnosed one per hour, and only one of them was a broken command. The rest were environment:
#
#   * **TZ.** `pnpm test` passed on a laptop in Europe/Copenhagen and failed in CI under UTC, because
#     ical-generator formatted DTSTART in the process's timezone while labelling it with the event's
#     TZID. A local run that inherits your shell's TZ would have missed it exactly as it was missed.
#     This script pins TZ=UTC.
#   * **Role passwords.** Postgres roles are cluster-wide. `alter role builderhunt_auth password …`
#     breaks every concurrent dev server and E2E run on the same cluster — observed as sign-up 500s
#     and 28P01. `scripts/db/prepare-rls-fixture.mjs` already knows this and creates per-run login
#     roles that inherit from the base roles unless CI=true. So this script deliberately does NOT set
#     CI=true, and consumes the role URLs that script emits.
#   * **Your .env.** With Stripe configured locally, self-service plan requests are retired and three
#     isolation checks behave differently than in CI. This script builds the job's env from the
#     workflow's own values instead of sourcing .env.
#   * **Ports and services.** Port 3000 is often already taken by a dev server; the E2E harness
#     requires a real Redis and refuses the in-memory fallback. Both are checked, not assumed.
#
# Everything runs against throwaway databases whose names start with `builderhunt_security_test_`, so
# your development database is never touched. They are dropped on exit, along with the per-run roles.
#
# Usage:
#   pnpm ci:local              # every step
#   pnpm ci:local --fast       # skip e2e, build, and the accessibility gate (the slow tail)
#   pnpm ci:local --from lint  # start at a named step, for iterating on one failure
#
# `--from` skips *checks*, never setup: the database creation and the RLS role fixture always run,
# because later steps connect with the credentials the fixture mints. Skipping them made the
# accessibility gate fail on sign-in for want of a DATABASE_AUTH_URL, which is a property of the flag,
# not of the gate.
#
# Higher fidelity, if you want the workflow file itself executed rather than mirrored: `act`
# (https://github.com/nektos/act) runs it in Docker, including the service containers. Slower, needs
# Docker, and ARM images for some actions are imperfect — but it validates the YAML too, which this
# script cannot.

set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

RUN_ID="local$(date +%s)"
DB="builderhunt_security_test_${RUN_ID}"
RESTORE_DB="${DB}_restore"
PREVIEW_PORT="${CI_LOCAL_PREVIEW_PORT:-3210}"

FAST=0
START_AT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1 ;;
    --from) START_AT="${2:-}"; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ── Preconditions ────────────────────────────────────────────────────────────────────────────────

MIGRATION_URL="$(grep -m1 '^DATABASE_MIGRATION_URL=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$MIGRATION_URL" ]; then
  echo "DATABASE_MIGRATION_URL not found in .env — needed to create the throwaway databases." >&2
  exit 1
fi
PG_BASE="${MIGRATION_URL%/*}"

if ! psql "$MIGRATION_URL" -Atc 'select 1' >/dev/null 2>&1; then
  echo "Cannot reach Postgres at DATABASE_MIGRATION_URL. Is the container up? (pnpm db:up)" >&2
  exit 1
fi

# The E2E harness throws without Redis rather than falling back, by design.
REDIS_OK=0
if (exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null; then REDIS_OK=1; fi
if [ "$REDIS_OK" -eq 0 ]; then
  echo "WARNING: no Redis on 127.0.0.1:6379 — the e2e step will be skipped, not silently passed." >&2
fi

if lsof -nP -iTCP:"$PREVIEW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PREVIEW_PORT is in use; set CI_LOCAL_PREVIEW_PORT to something free." >&2
  exit 1
fi

# ── The job's environment, from the workflow rather than from .env ───────────────────────────────

export TZ=UTC
export APP_URL="http://localhost:${PREVIEW_PORT}"
export VITE_APP_URL="$APP_URL"
export BETTER_AUTH_SECRET=ci-only-secret-with-more-than-thirty-two-characters
export TEST_MIGRATION_URL="${PG_BASE}/${DB}"
export DATABASE_URL="${PG_BASE}/${DB}"
export DATABASE_MIGRATION_URL="${PG_BASE}/${DB}"

PREVIEW_PID=""
cleanup() {
  [ -n "$PREVIEW_PID" ] && kill "$PREVIEW_PID" 2>/dev/null
  psql "$MIGRATION_URL" -q -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" >/dev/null 2>&1
  psql "$MIGRATION_URL" -q -c "DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)" >/dev/null 2>&1
  # Per-run roles outlive their database, so drop them explicitly. Named for this run only; the
  # shared base roles are never touched.
  for base in app auth worker platform; do
    psql "$MIGRATION_URL" -q -c "DROP ROLE IF EXISTS builderhunt_${base}_rls_${RUN_ID}" >/dev/null 2>&1
  done
}
trap cleanup EXIT

# ── Step plumbing ────────────────────────────────────────────────────────────────────────────────

PASSED=(); FAILED=(); SKIPPED=(); TOLERATED=()
SKIPPING=0
[ -n "$START_AT" ] && SKIPPING=1

# `step_soft` mirrors a workflow step marked `continue-on-error: true`: the result is reported, but it
# does not fail the run. Treating it as fatal locally would make this script stricter than the gate it
# is supposed to predict, which is its own kind of wrong answer.
step_soft() {
  local name="$1"; shift
  if [ "$SKIPPING" -eq 1 ]; then
    if [ "$name" = "$START_AT" ]; then SKIPPING=0; else
      SKIPPED+=("$name (before --from $START_AT)"); return 0
    fi
  fi
  printf '\n\033[1m── %s\033[0m \033[2m(informational)\033[0m\n' "$name"
  if "$@"; then PASSED+=("$name"); else TOLERATED+=("$name"); fi
}

step() {
  local name="$1"; shift
  if [ "$SKIPPING" -eq 1 ]; then
    if [ "$name" = "$START_AT" ]; then SKIPPING=0; else
      SKIPPED+=("$name (before --from $START_AT)"); return 0
    fi
  fi
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then
    PASSED+=("$name")
  else
    FAILED+=("$name")
  fi
}

# Runs regardless of --from: later steps depend on what it produces.
setup_step() {
  local name="$1"; shift
  printf '\n\033[1m── %s\033[0m \033[2m(setup)\033[0m\n' "$name"
  if "$@"; then PASSED+=("$name"); else FAILED+=("$name"); fi
}

skip() { SKIPPED+=("$1 ($2)"); printf '\n\033[2m── %s — skipped: %s\033[0m\n' "$1" "$2"; }

# ── Steps, in the workflow's order ───────────────────────────────────────────────────────────────

psql "$MIGRATION_URL" -q -c "CREATE DATABASE ${DB}" || exit 1

step migration-integrity pnpm test:migration-integrity
step drizzle-check pnpm exec drizzle-kit check
step migrations-local pnpm test:migrations:local

# The fixture emits the per-run role URLs the next two steps connect as. Without CI=true it creates
# dedicated members instead of rewriting the shared roles' passwords.
prepare_fixture() {
  local out
  out="$(pnpm exec node scripts/db/prepare-rls-fixture.mjs)" || return 1
  printf '%s\n' "$out" | tail -1 > /tmp/ci-local-fixture-"$RUN_ID".json
  python3 - "$RUN_ID" <<'PY'
import json, sys
run = sys.argv[1]
d = json.load(open(f'/tmp/ci-local-fixture-{run}.json'))
if d.get('mutatedGlobalRoles'):
    print('REFUSING: the fixture mutated the shared roles — CI must not be set here', file=sys.stderr)
    raise SystemExit(1)
with open(f'/tmp/ci-local-roles-{run}.sh', 'w') as fh:
    for base, url in d['urls'].items():
        key = base.replace('builderhunt_', '').upper()
        fh.write(f'export RLS_TEST_{key}_URL={url}\n')
        fh.write(f'export DATABASE_{key}_URL={url}\n' if key != 'APP' else f'export DATABASE_URL={url}\n')
print('per-run roles prepared:', ', '.join(d['roles'].values()))
PY
}
# The throwaway database is created empty by this script, and `migrations-local` is what fills it.
# Under `--from` that check is skipped, so the schema has to be applied anyway — otherwise the fixture
# has no tables to grant on and every later step fails for a reason that has nothing to do with the
# step being investigated. Conditional on the schema actually being absent, so a full run still lets
# `migrations-local` prove that migrations apply to a genuinely fresh database.
ensure_schema() {
  local has_tables
  has_tables="$(psql "${PG_BASE}/${DB}" -Atc "select to_regclass('public.alerts') is not null" 2>/dev/null)"
  if [ "$has_tables" = "t" ]; then
    echo "schema already present (migrations-local ran)"
    return 0
  fi
  echo "applying schema (migrations-local was skipped by --from)"
  # Reuses the sanctioned path rather than inventing one. `drizzle-kit migrate` reads its URL through
  # dotenvx, which overrides the exported DATABASE_MIGRATION_URL with the *development* database from
  # .env — so it migrated the wrong database and left the throwaway one empty, and every later step
  # died on `relation "auth_users" does not exist`. `test:migrations:local` uses drizzle's programmatic
  # migrator against TEST_MIGRATION_URL, which nothing can override, and is idempotent by design.
  pnpm test:migrations:local >/dev/null
}
setup_step schema ensure_schema

setup_step rls-fixture prepare_fixture

if [ -f "/tmp/ci-local-roles-${RUN_ID}.sh" ]; then
  # The workflow sets DATABASE_AUTH_URL / _WORKER_URL / _PLATFORM_URL at *job* level — better-auth
  # needs the auth broker connection for sign-in, which the accessibility gate depends on. Mirrored
  # here from the per-run roles. DATABASE_URL stays the owner, as it is at job level in the workflow;
  # only the two role-scoped steps below narrow it.
  export DATABASE_AUTH_URL="$(grep '^export DATABASE_AUTH_URL=' "/tmp/ci-local-roles-${RUN_ID}.sh" | cut -d= -f2-)"
  export DATABASE_WORKER_URL="$(grep '^export DATABASE_WORKER_URL=' "/tmp/ci-local-roles-${RUN_ID}.sh" | cut -d= -f2-)"
  export DATABASE_PLATFORM_URL="$(grep '^export DATABASE_PLATFORM_URL=' "/tmp/ci-local-roles-${RUN_ID}.sh" | cut -d= -f2-)"

  # Scoped to these two steps only, exactly as the workflow scopes them with per-step `env:` blocks.
  # Exporting them for the whole run leaks the *app role* into DATABASE_URL, and then anything needing
  # owner rights fails with "permission denied for table auth_users" — which is what happened here on
  # the first attempt, in both the seed-admin and the sign-up paths.
  step rls-policies env $(cat "/tmp/ci-local-roles-${RUN_ID}.sh" | sed 's/^export //' | tr '\n' ' ') pnpm test:rls:local
  step api-isolation env OWNER_SEED_URL="${PG_BASE}/${DB}" $(cat "/tmp/ci-local-roles-${RUN_ID}.sh" | sed 's/^export //' | tr '\n' ' ') pnpm test:api-isolation:local
else
  skip rls-policies "fixture step failed"
  skip api-isolation "fixture step failed"
fi

restore_rehearsal() {
  psql "$MIGRATION_URL" -q -c "CREATE DATABASE ${RESTORE_DB}" || return 1
  RESTORE_TEST_SOURCE_URL="${PG_BASE}/${DB}" \
  RESTORE_TEST_TARGET_URL="${PG_BASE}/${RESTORE_DB}" \
    pnpm db:restore-test
}
step restore-rehearsal restore_rehearsal

step security-boundaries pnpm security:boundaries
step security-route-coverage pnpm security:route-coverage
# Added 2026-07-28 after an exported route helper put the postgres driver in the client bundle and every
# page threw "Buffer is not defined". Type-check, lint, 4236 tests and a production build all passed.
step security-route-client-boundary pnpm security:route-client-boundary
step security-provider-metering pnpm security:provider-metering
step schema-audit pnpm db:audit-schema
step lint pnpm lint
step type-check pnpm type-check
step unit-tests pnpm test

if [ "$FAST" -eq 1 ]; then
  skip e2e "--fast"
  skip dependency-audit "--fast"
  skip build "--fast"
  skip accessibility "--fast"
else
  if [ "$REDIS_OK" -eq 1 ]; then
    step e2e env -u APP_URL -u VITE_APP_URL E2E_MODE=true pnpm test:e2e --workers=1 --grep-invert="@requires-embeddings"
  else
    skip e2e "no Redis on 6379"
  fi

  step dependency-audit pnpm security:dependencies
  step build pnpm build

  accessibility_gate() {
    pnpm exec drizzle-kit migrate >/dev/null || return 1
    pnpm db:seed:admin >/dev/null || return 1
    # vite preview runs the build as production, which turns on the production env rules: the runtime
    # role may not be an owner and must differ from the migration identity. The per-run fixture roles
    # satisfy that; the owner URL stays on DATABASE_MIGRATION_URL.
    DATABASE_URL="$(grep '^export DATABASE_URL=' "/tmp/ci-local-roles-${RUN_ID}.sh" | cut -d= -f2-)" \
    pnpm preview --port "$PREVIEW_PORT" >/tmp/ci-local-preview-"$RUN_ID".log 2>&1 &
    PREVIEW_PID=$!
    for _ in $(seq 1 30); do
      curl -sf "$APP_URL/api/health" >/dev/null 2>&1 && break
      sleep 2
    done
    curl -sf "$APP_URL/api/health" >/dev/null 2>&1 || {
      echo "preview never became healthy; see /tmp/ci-local-preview-$RUN_ID.log" >&2
      return 1
    }
    pnpm test:a11y
  }
  step accessibility accessibility_gate
fi

# ── Summary ──────────────────────────────────────────────────────────────────────────────────────

printf '\n\033[1m════ summary ════\033[0m\n'
printf '\033[32mpassed  %d\033[0m\n' "${#PASSED[@]}"
if [ "${#TOLERATED[@]}" -gt 0 ]; then
  printf '\033[33mfailed but tolerated (continue-on-error in the workflow) %d\033[0m\n' "${#TOLERATED[@]}"
  for t in "${TOLERATED[@]}"; do printf '  - %s\n' "$t"; done
fi
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  printf '\033[33mskipped %d\033[0m\n' "${#SKIPPED[@]}"
  for s in "${SKIPPED[@]}"; do printf '  - %s\n' "$s"; done
fi
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '\033[31mfailed  %d\033[0m\n' "${#FAILED[@]}"
  for f in "${FAILED[@]}"; do printf '  - %s\n' "$f"; done
  printf '\nRe-run one step with: pnpm ci:local --from %s\n' "${FAILED[0]}"
  exit 1
fi
printf '\nEvery step that ran passed.\n'
[ "${#SKIPPED[@]}" -gt 0 ] && printf 'Note the skips above — a skip is not a pass.\n'
exit 0
