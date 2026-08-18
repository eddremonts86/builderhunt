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
# 3260, not 3210. `edd-remonts-dashboard` runs its dev server on 3210, and this gate refusing to start
# is the *correct* behaviour when the port is taken — the mistake is picking a default that collides
# with a sibling project on the same machine. Twice I read "Port 3210 is in use" and killed the process
# instead of the one thing the message actually asks for, taking that project's dev server down with it.
#
# Override with CI_LOCAL_PREVIEW_PORT if 3260 is busy too. Nothing else in the repository references
# this port: the preview is started here and Lighthouse is pointed at it through APP_URL.
PREVIEW_PORT="${CI_LOCAL_PREVIEW_PORT:-3260}"

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

# MinIO and ClamAV, which `tests/e2e/documents.spec.ts` needs and the workflow starts as containers.
# They sit behind docker-compose's `interviews` profile locally, so they are off unless asked for —
# and their absence reads as a storage error inside six specs rather than as a missing container.
for svc in "object store:9000" "virus scanner:3310" "embeddings server:11434"; do
  if ! (exec 3<>/dev/tcp/127.0.0.1/"${svc##*:}") 2>/dev/null; then
    echo "No ${svc%%:*} on 127.0.0.1:${svc##*:} — documents specs will fail as storage errors." >&2
    echo "Start them with: docker compose --profile interviews --profile standalone up -d storage antivirus embeddings" >&2
    exit 1
  fi
done

if lsof -nP -iTCP:"$PREVIEW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PREVIEW_PORT is in use; set CI_LOCAL_PREVIEW_PORT to something free." >&2
  exit 1
fi

# The same check for the E2E port, and for a stronger reason than "the port is busy".
#
# `playwright.config.ts` sets `reuseExistingServer: !CI`, so locally Playwright *adopts* whatever
# already answers on this port instead of starting its own. For this gate that is never right: the
# database the suite runs against is created below, inside this run, and dropped by the EXIT trap. A
# server that was listening before the gate started is by definition pointed at some other database
# — an orphan from an interrupted run, pointed at one that no longer exists at all.
#
# It also masks a real bug rather than causing one, which is the more important reason. A stray
# server on this port makes the port-resolution race in `playwright.config.ts` (see `localE2EPort`)
# invisible: the suite goes green because something happens to be answering where the workers are
# looking. Refusing to start is what keeps that race falsifiable.
#
# Do not try to tell an adopted server from a spawned one by counting `[WebServer]` lines. I did, and
# it is wrong: `webServer.stdout` defaults to `'ignore'` and Vite's ready banner goes to stdout, so a
# clean spawn prints zero of them too.
E2E_PORT_IN_USE="$(grep -m1 '^E2E_PORT=' .env 2>/dev/null | cut -d= -f2-)"
E2E_PORT_IN_USE="${E2E_PORT_IN_USE:-3100}"
E2E_PORT_PIDS="$(lsof -nP -iTCP:"$E2E_PORT_IN_USE" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')"
if [ -n "$E2E_PORT_PIDS" ]; then
  echo "Port $E2E_PORT_IN_USE (E2E_PORT) is already serving: pid(s) ${E2E_PORT_PIDS% }." >&2
  echo "Playwright would adopt it rather than start its own, and it is pointed at a database this" >&2
  echo "run has not created. Stop it first:  kill ${E2E_PORT_PIDS% }" >&2
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
  #
  # `capability` was missing from this list until 2026-08-04, so every run since the capability role
  # was introduced leaked one: the database counted 100 orphaned
  # `builderhunt_capability_rls_local*` roles against 6 of each other kind (those six are runs killed
  # before the trap could fire — ordinary noise, not a leak). Keep this list in step with the roles
  # the setup step creates; it is not derived from anything, so nothing else will notice a new one.
  for base in app auth worker platform capability; do
    psql "$MIGRATION_URL" -q -c "DROP ROLE IF EXISTS builderhunt_${base}_rls_${RUN_ID}" >/dev/null 2>&1
  done
  # And the same list read from the fixture's own output, so a role added there is dropped even if
  # nobody remembers to add it above. This is the half that would have prevented the leak.
  if [ -f "/tmp/ci-local-roles-${RUN_ID}.sh" ]; then
    for role in $(sed -n 's|.*postgresql://\([^:]*\):.*|\1|p' "/tmp/ci-local-roles-${RUN_ID}.sh" | sort -u); do
      psql "$MIGRATION_URL" -q -c "DROP ROLE IF EXISTS \"${role}\"" >/dev/null 2>&1
    done
  fi
  # These two hold the per-run roles' passwords in plaintext. They are throwaway local test roles, but
  # a file of credentials with no owner and no expiry is not something to leave in /tmp for weeks.
  rm -f "/tmp/ci-local-roles-${RUN_ID}.sh" "/tmp/ci-local-fixture-${RUN_ID}.json"
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

# First, and cheap: everything after this is only worth what the environment it ran in is worth.
# This script's whole claim is that a green run here means a green run on GitHub, and a value that
# only `.env` carries quietly voids that — see scripts/ci/check-env-fidelity.mjs for the twenty
# specs it cost. Local-only by nature: there is no `.env` on CI to diverge from.
step env-fidelity node scripts/ci/check-env-fidelity.mjs
# And the other half of the same claim: same environment, same list of checks.
step step-parity node scripts/ci/check-step-parity.mjs

# The plan record, which is documentation only until something reads it. Both are seconds and both
# guard a claim this repository now makes out loud: `plans/implemented/` means done and tested, and a
# plan's two-digit prefix is its position in the build order. Neither check ran anywhere before
# 2026-08-11, which is how eight unreadable status values and four plans sitting at 100% of their tasks
# while labelled `pending` survived for weeks.
step plans-links pnpm plans:check-links
step plans-order pnpm plans:check-order
step plans-implemented pnpm plans:check-implemented
# And the two that were written, wired into `package.json`, and then never called from anywhere —
# which is the same failure the paragraph above describes, one layer out. `plans:check-readiness`
# guards the trio-and-header contract for phase 2 and phase 3 and chains `plans:check-tasks`, so a
# plan landing without `Depends on`/`Blocks`/`Reality check`, or an open task with no Verify line,
# now fails the gate instead of waiting to be noticed by hand.
#
# Running it by hand on 2026-08-12 found two real faults, both invisible until then: phase-2 plan 08
# had shipped with three headers missing from `plan.md` and `tasks.md`, and the checker itself
# resolved only `plans/<phase>/` for every phase but the first — so phase 3, whose plans 01-13 are
# archived under `plans/implemented/phase-3/`, reported `14-unified-table-visual-style is position 14,
# expected 1`. A correct number measured against a corpus missing thirteen entries.
step plans-readiness pnpm plans:check-readiness

# The landing's viewport-height budget (plan: phase-2/08).
#
# Enforces the *recorded* baseline; it does not measure the page. Measuring needs a browser and a
# running app, which is `pnpm audit:landing:walk` and belongs with the change that moves the page —
# see docs/operations/development.md. The honest limit: this step catches a committed baseline going
# over budget, and it cannot catch a page that grew without the walker being re-run.
step landing-budget pnpm audit:landing
step migration-integrity pnpm test:migration-integrity
step deploy-imports pnpm test:deploy-imports
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
# Phase 3's two gates, beside the route-coverage step they were modelled on: no list read without a
# declared bound, and no data grid without a registered capability.
step check-unbounded pnpm check:unbounded
step check-admin-metrics pnpm check:admin-metrics
step check-table-surfaces pnpm check:table-surfaces
step security-ui-route-graph pnpm security:ui-route-graph
# Added 2026-07-28 after an exported route helper put the postgres driver in the client bundle and every
# page threw "Buffer is not defined". Type-check, lint, 4236 tests and a production build all passed.
step security-route-client-boundary pnpm security:route-client-boundary
step security-route-methods pnpm security:route-methods
step security-auth-before-validate pnpm security:auth-before-validate
step e2e-route-coverage pnpm test:e2e:coverage
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
    # The harness serves `dist/` now, so this is a precondition of the e2e step rather than a
    # check that happens to follow it.
    step build pnpm build
    step e2e env -u APP_URL -u VITE_APP_URL E2E_MODE=true pnpm test:e2e --workers=1
  else
    skip e2e "no Redis on 6379"
  fi

  step dependency-audit pnpm security:dependencies

  # Before the preview, for the same reason the workflow puts it there: these projects start their
  # own dev server and `reuseExistingServer` is false under CI, so a held port fails the step with
  # "already used" and never takes a screenshot.
  #
  # One caveat this gate cannot close: baselines are per-OS. Here it compares against the *darwin*
  # files; GitHub compares against the linux ones. So a green run here proves the pages still render
  # as expected, not that the images CI will diff are current. Refreshing those means taking them
  # from a CI artifact — see the commit that last did it.
  step visual pnpm test:visual

  # Only meaningful after `build`, and it is the only step that runs the entrypoint that actually ships.
  # `server/security.mjs` had 22 unit cases and nothing proved the server *sent* the headers — the e2e
  # harness runs `vite dev` and the accessibility gate runs `vite preview`, neither of which applies one.
  # Its first run found a duplicated `Referrer-Policy` that no unit test could have seen, because the
  # collision only exists once a real response and the security set are merged.
  step prod-headers pnpm security:prod-headers

  accessibility_gate() {
    pnpm exec drizzle-kit migrate >/dev/null || return 1
    pnpm db:seed:admin >/dev/null || return 1
    # Seeding creates the admin *user*; ADMIN_USER_IDS is what makes them a platform admin, and
    # `seed-admin.ts` mints a fresh UUID per run — so `.env`'s value names an id this throwaway
    # database does not contain. Read it back, exactly as the workflow does.
    ADMIN_USER_IDS="$(psql "${PG_BASE}/${DB}" -Atc "select id from auth_users where email = 'edd_admin@local.com'")"
    [ -n "$ADMIN_USER_IDS" ] || { echo "seeded admin not found — every /admin/* gate would redirect" >&2; return 1; }
    export ADMIN_USER_IDS
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

  # Runs against the same preview the accessibility gate just started, which is why it lives here
  # rather than as its own step.
  #
  # It was CI-only until now, and that is a fidelity gap of a different kind from the environment
  # one: a step this script does not run is a step its green cannot speak for. It went unnoticed
  # because the e2e step failed ahead of it in every recent run, so CI never reached it either —
  # and the first time it did, it found `/admin/incidents` redirecting because ADMIN_USER_IDS was
  # never set. Two gates that had both been quiet for months, agreeing about nothing.
  step status-trust pnpm test:status-trust
  step conversion pnpm test:conversion
  step lighthouse pnpm test:lighthouse
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
