#!/usr/bin/env bash
#
# Provisions a disposable database with the real non-owner roles and runs the enrichment
# adversarial matrix against it (scripts/ops/verify-enrichment-adversarial-local.mjs).
#
# This is the same setup `pnpm ci:local` performs for its `api-isolation` step, reduced to the parts
# the matrix needs. It is a separate entry point rather than a step inside ci:local on purpose: the
# matrix is evidence production for a plan gate (plans/phase-1/42-stealth-scraping Phase 7), it takes
# ~30s of which 10s is a deliberate timeout, and it touches the live network once. A quality gate
# should not do any of those things on every run.
#
# Usage:
#   pnpm test:enrichment-matrix:local                  # includes the one real api.github.com request
#   ADVERSARIAL_LIVE_GITHUB=false pnpm test:enrichment-matrix:local   # fully offline
#
# Output is the matrix JSON on stdout. Exit code 0 means every case produced its documented outcome.

set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

RUN_ID="advmatrix$(date +%s)"
DB="builderhunt_security_test_${RUN_ID}"

MIGRATION_URL="$(grep -m1 '^DATABASE_MIGRATION_URL=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$MIGRATION_URL" ]; then
  echo "DATABASE_MIGRATION_URL not found in .env — needed to create the throwaway database." >&2
  exit 1
fi
PG_BASE="${MIGRATION_URL%/*}"

if ! psql "$MIGRATION_URL" -Atc 'select 1' >/dev/null 2>&1; then
  echo "Cannot reach Postgres at DATABASE_MIGRATION_URL. Is the container up? (pnpm db:up)" >&2
  exit 1
fi

ROLES_FILE="$(mktemp -t enrichment-matrix-roles)"
cleanup() {
  psql "$MIGRATION_URL" -q -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" >/dev/null 2>&1
  # Per-run login roles outlive their database. Read them back from the fixture's own output so a
  # role added there is still dropped — the leak ci:local's comment describes came from a hand-kept list.
  if [ -f "$ROLES_FILE" ]; then
    for role in $(sed -n 's|.*postgresql://\([^:]*\):.*|\1|p' "$ROLES_FILE" | sort -u); do
      psql "$MIGRATION_URL" -q -c "DROP ROLE IF EXISTS \"${role}\"" >/dev/null 2>&1
    done
    rm -f "$ROLES_FILE"
  fi
}
trap cleanup EXIT

psql "$MIGRATION_URL" -q -c "CREATE DATABASE ${DB}" || exit 1

export TZ=UTC
export TEST_MIGRATION_URL="${PG_BASE}/${DB}"
export APP_URL="http://localhost:3000"
export VITE_APP_URL="$APP_URL"
export BETTER_AUTH_SECRET=adversarial-matrix-secret-with-more-than-thirty-two-characters

# Applies the full migration chain to the fresh database. `drizzle-kit migrate` is deliberately not
# used here: it reads its URL through dotenvx and would migrate the development database instead.
pnpm test:migrations:local >/dev/null || { echo "migrations failed" >&2; exit 1; }

# Mints the per-run login roles that inherit from builderhunt_app/_auth/_worker/_platform, without
# touching the shared roles' passwords (which would break any concurrent dev server on this cluster).
FIXTURE_JSON="$(pnpm exec node scripts/db/prepare-rls-fixture.mjs | tail -1)" || { echo "rls fixture failed" >&2; exit 1; }

python3 - "$ROLES_FILE" <<PY || exit 1
import json, sys
data = json.loads('''$FIXTURE_JSON''')
if data.get('mutatedGlobalRoles'):
    print('REFUSING: the fixture mutated the shared roles', file=sys.stderr)
    raise SystemExit(1)
names = {'builderhunt_app': 'DATABASE_URL', 'builderhunt_auth': 'DATABASE_AUTH_URL',
         'builderhunt_worker': 'DATABASE_WORKER_URL', 'builderhunt_platform': 'DATABASE_PLATFORM_URL',
         'builderhunt_capability': 'DATABASE_CAPABILITY_URL'}
with open(sys.argv[1], 'w') as fh:
    for base, url in data['urls'].items():
        if base in names:
            fh.write(f'export {names[base]}={url}\n')
PY

# shellcheck disable=SC1090
. "$ROLES_FILE"
export OWNER_SEED_URL="${PG_BASE}/${DB}"

# The evidence file is deliberately outside the repository: it is a dated run artifact, and what gets
# committed is the summary a human wrote into the source register, not the raw dump.
export MATRIX_OUT="${MATRIX_OUT:-${TMPDIR:-/tmp}/enrichment-matrix-${RUN_ID}.json}"

pnpm exec tsx scripts/ops/verify-enrichment-adversarial-local.mjs
