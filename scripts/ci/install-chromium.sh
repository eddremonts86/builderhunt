#!/usr/bin/env bash
#
# Install the Chromium build Playwright expects, bounded in time and retried.
#
# `playwright install --with-deps` shells out to `apt-get` for the browser's system libraries, so it
# inherits whatever mood the Ubuntu mirrors are in. On 2026-08-19 `azure.archive.ubuntu.com` answered
# `Ign:` for every index and the fallback to `archive.ubuntu.com` stalled mid-transfer on
# `noble-security InRelease`. Two E2E shards sat there until their 30-minute timeout and the `quality`
# job until its 25-minute one — three of the nine required checks, red, on a commit that had changed
# two PNG files. GitHub reports a timed-out job as *cancelled*, which on the pull request page is
# indistinguishable from a test the commit broke.
#
# It is intermittent per runner, not an outage: in the same run, two shards installed fine while two
# hung. That is exactly the shape a retry fixes — provided the retry can actually start clean.
#
# ## Why a bare `timeout` is not enough
#
# The first version of this script bounded each attempt and retried three times, and attempts two and
# three failed in under a second with
#
#     E: Could not get lock /var/lib/apt/lists/lock. It is held by process 5144 (apt-get)
#
# `timeout` signals its direct child, which is the Playwright node process. The `apt-get` underneath
# it was started through `sudo`, so it is owned by root, sits in a different process tree, and
# survives — still holding apt's lock. Every retry then raced a corpse. Worse, an unprivileged SIGKILL
# could not have reached it even if `timeout` had aimed there.
#
# So the recovery is the interesting half, not the bound: kill the orphan as root, drop the locks it
# left, discard the half-downloaded index that caused the stall, and let dpkg finish anything it was
# in the middle of. Only then is attempt two a fresh attempt rather than a replay of the failure.
#
# Lives in a script rather than inline because five workflows run this same line, and five copies of
# this reasoning would be five copies to keep true.
set -uo pipefail

# Four minutes. Long enough for a slow mirror that is working — a cold `--with-deps` takes about one —
# and short enough that three dead attempts still leave a 30-minute job time to run its suite.
ATTEMPT_TIMEOUT=240

reset_apt() {
  # The orphan first: nothing else can proceed while it holds the lock, and it is root-owned.
  sudo pkill -9 -x apt-get 2>/dev/null || true
  sudo pkill -9 -x apt 2>/dev/null || true
  sudo rm -f /var/lib/apt/lists/lock /var/cache/apt/archives/lock \
    /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend
  # The partial index is the stall's residue. Left in place, apt resumes the same broken transfer.
  sudo rm -rf /var/lib/apt/lists/partial
  sudo dpkg --configure -a 2>/dev/null || true
}

for attempt in 1 2 3; do
  if timeout -k 15 "$ATTEMPT_TIMEOUT" pnpm exec playwright install --with-deps chromium; then
    exit 0
  fi
  echo "::warning::playwright install --with-deps stalled or failed (attempt ${attempt}/3) — clearing apt's locks and retrying"
  reset_apt
  sleep 10
done

echo "::error::playwright install --with-deps did not finish in three bounded attempts, each starting from a cleared apt state. This is the Ubuntu package mirrors being unreachable from the runner, not a problem with the commit under test."
exit 1
