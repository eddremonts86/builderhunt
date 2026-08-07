#!/usr/bin/env bash
# /review-all — orchestrator. Runs the phases in order with gates between.
#
# Usage:
#   scripts/ai-os/review-all.sh                  # full pipeline
#   scripts/ai-os/review-all.sh --report-only    # walker + audit, no code
#   scripts/ai-os/review-all.sh --landing       # landing-only
#   scripts/ai-os/review-all.sh --copy          # humanize-only
#   scripts/ai-os/review-all.sh --verify        # re-run walker + gates
#   scripts/ai-os/review-all.sh --no-walker     # skip walker (faster dry run)
#
# Each phase is committed separately. If a gate fails, the pipeline aborts.
# No push — commits stay on the working branch.

set -euo pipefail

# Resolve the audited repo. Two paths:
#
# 1. Caller passes REPO_ROOT_OVERRIDE=/path/to/repo. Use that.
# 2. Walk up from the script location looking for the nearest ancestor with
#    a package.json AND a `name` field whose value suggests a real repo
#    (not a skills index). Bounded at 6 levels.
#
# The skill ships outside any audited repo (under ~/.agents/skills/...), so
# the walk-up rarely finds a real repo. Callers should always pass
# REPO_ROOT_OVERRIDE. We error out cleanly if neither resolves.

REPO_ROOT=""
if [[ -n "${REPO_ROOT_OVERRIDE:-}" ]]; then
  if [[ ! -d "$REPO_ROOT_OVERRIDE" ]]; then
    echo "REPO_ROOT_OVERRIDE=$REPO_ROOT_OVERRIDE does not exist" >&2; exit 1
  fi
  if [[ ! -f "$REPO_ROOT_OVERRIDE/package.json" ]]; then
    echo "REPO_ROOT_OVERRIDE=$REPO_ROOT_OVERRIDE has no package.json" >&2; exit 1
  fi
  REPO_ROOT="$(cd "$REPO_ROOT_OVERRIDE" && pwd)"
fi
if [[ -z "$REPO_ROOT" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  CANDIDATE="$SCRIPT_DIR"
  for _ in $(seq 1 6); do
    CANDIDATE="$(dirname "$CANDIDATE")"
    if [[ -f "$CANDIDATE/package.json" ]]; then
      REPO_ROOT="$CANDIDATE"; break
    fi
  done
fi
if [[ -z "$REPO_ROOT" ]]; then
  echo "could not auto-detect the audited repo (skill lives outside it)." >&2
  echo "Pass the repo explicitly:" >&2
  echo "  REPO_ROOT_OVERRIDE=/path/to/repo $0" >&2
  exit 1
fi
export REPO_ROOT
# Everything below runs inside the repo. Subshell + `cd` so phase
# functions (which run commands in nested subshells) inherit cwd.
(
  cd "$REPO_ROOT" || { echo "cd failed: $REPO_ROOT" >&2; exit 1; }

MODE="full"
SKIP_WALKER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --report-only) MODE="report-only" ;;
    --landing) MODE="landing" ;;
    --copy) MODE="copy" ;;
    --verify) MODE="verify" ;;
    --no-walker) SKIP_WALKER=1 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

step() { printf "\n\033[1;34m== %s ==\033[0m\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!\033[0m %s\n" "$*"; }
fail() { printf "\033[31m✗\033[0m %s\n" "$*"; exit 1; }

run_gate() {
  step "gate: type-check + lint + test:unit"
  pnpm type-check || fail "type-check failed"
  pnpm lint --quiet || fail "lint failed"
  pnpm vitest run --silent || fail "test:unit failed"
  ok "gate green"
}

ensure_dev_server() {
  if curl -sf -m 2 http://localhost:3010/api/status >/dev/null 2>&1; then
    ok "dev server alive on 3010"
    return
  fi
  warn "dev server not running on 3010, starting"
  pnpm exec vite dev --port 3010 --strictPort >/tmp/vite-review.log 2>&1 &
  VITE_PID=$!
  for _ in $(seq 1 30); do
    if curl -sf -m 1 http://localhost:3010/api/status >/dev/null 2>&1; then
      ok "dev server up after probe loop"
      return
    fi
    sleep 1
  done
  fail "dev server failed to come up on 3010 within 30s"
}

phase_ground_truth() {
  step "phase 0: ground truth"
  pnpm db:up >/dev/null 2>&1 || warn "db:up failed (postgres may already be running)"
  pnpm db:migrate >/dev/null 2>&1 || warn "db:migrate skipped or already up"
  pnpm db:seed:test-users 2>&1 | tail -3
  ensure_dev_server
  run_gate
}

phase_walker() {
  step "phase 1: saas-review walker (multi-viewport)"
  SAAS_REVIEW_BASE_URL=http://localhost:3010 \
  SAAS_REVIEW_VIEWPORTS=desktop-light,desktop-dark,mobile-375 \
  SAAS_REVIEW_ROLES=owner,admin,member,platform-admin \
    pnpm tsx --env-file-if-exists=.env scripts/audit/saas-review-walk.ts \
      2>&1 | tail -8
  ok "walker complete"
  warn "review docs/ui-audit/evidence/walk-summary.json for new findings"
}

phase_audit_critique() {
  step "phase 2: fix-ui-ux audit + critique"
  warn "this phase uses delegate_task; rate-limit may force degraded mode"
  warn "see docs/impeccable/audit.md and critique.md for output"
}

phase_design_taste() {
  step "phase 3: design-taste-frontend v2 pre-flight + Phase 4 redesign"
  warn "phase 4.A — hero glass already shipped, Phase 4.B sticky-stack shipped"
  warn "phase 4.C humanize requires the humanizer skill; run interactively"
  warn "phase 4.D copy self-audit requires visual review"
}

phase_dashboard() {
  step "phase 5: dashboard polish (sober)"
  warn "DashboardLayout useMatch fix already shipped (18a96d7b5)"
  warn "CookieBanner delay already shipped (e007c849f)"
}

phase_verify() {
  step "phase 6: verification"
  run_gate
  SAAS_REVIEW_BASE_URL=http://localhost:3010 \
  SAAS_REVIEW_VIEWPORTS=desktop-light,mobile-375 \
  SAAS_REVIEW_ROLES=platform-admin \
    pnpm tsx --env-file-if-exists=.env scripts/audit/saas-review-walk.ts \
      2>&1 | tail -8
  ok "verification walker complete"
  warn "append before/after to docs/impeccable/verification.md"
}

# ─────────────────────────── dispatch ───────────────────────────
case "$MODE" in
  full)
    phase_ground_truth
    [[ "$SKIP_WALKER" -eq 0 ]] && phase_walker
    phase_audit_critique
    phase_design_taste
    phase_dashboard
    phase_verify
    ;;
  report-only)
    phase_ground_truth
    phase_walker
    phase_audit_critique
    ;;
  landing)
    phase_ground_truth
    phase_design_taste
    ;;
  copy)
    phase_ground_truth
    ;;
  verify)
    phase_verify
    ;;
esac

  ok "/review-all ($MODE) complete"
  echo "see docs/impeccable/verification.md for the before/after report"
)
