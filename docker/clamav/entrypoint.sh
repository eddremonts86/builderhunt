#!/bin/sh
# clamd refuses to start without a signature database, and the first fetch is
# ~1 GB and takes minutes. Fetch only when the volume is empty so a restart is
# fast; after that freshclam's own daemon keeps it current.
set -eu

if [ ! -f /var/lib/clamav/main.cvd ] && [ ! -f /var/lib/clamav/main.cld ]; then
  echo "clamav: no signature database yet, fetching (this takes a few minutes)"
  freshclam --foreground --stdout || {
    echo "clamav: initial freshclam failed; refusing to start without signatures" >&2
    exit 1
  }
fi

# Keep signatures current in the background, then hand the foreground to clamd
# so the container's lifetime is the daemon's.
freshclam --daemon --checks=12 --stdout &
exec clamd --config-file=/etc/clamav/clamd.conf
