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
# A retry only helps if the first attempt actually ends, and that is the part apt does not give you:
# the stall was a slow drip rather than a dead socket, so `Acquire::*::Timeout` never fired. `timeout`
# around the whole command is what bounds it. Three attempts turn a mirror having a bad morning into
# a few minutes of delay and a warning that names the real culprit.
#
# Lives in a script rather than inline because five workflows run this same line, and five copies of
# a retry loop drift.
set -uo pipefail

for attempt in 1 2 3; do
  if timeout -k 15 600 pnpm exec playwright install --with-deps chromium; then
    exit 0
  fi
  echo "::warning::playwright install --with-deps stalled or failed (attempt ${attempt}/3) — retrying"
  sleep 15
done

echo "::error::playwright install --with-deps did not finish in three bounded attempts. This is almost always the Ubuntu package mirrors being unreachable from the runner, not a problem with the commit under test."
exit 1
