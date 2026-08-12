#!/bin/sh
# Generates `userlist.txt` at run time, into tmpfs, from the role passwords in the environment.
#
# ## Why not bake it into the image
#
# An auth file in an image layer is a credential in a registry. Layers are cacheable, pullable and — for
# anyone who can read the image — permanent, so a `COPY userlist.txt` would publish five database passwords
# to everywhere that image ever travels. Generating it here means the secrets exist only in this
# container's memory-backed `/run/pgbouncer`, and die with it.
#
# `/run/pgbouncer` and not `/etc/pgbouncer`: the tmpfs has to be mounted somewhere, and mounting it over the
# directory holding the baked `pgbouncer.ini` hides that file. The container then restarts forever on
# `could not load file "/etc/pgbouncer/pgbouncer.ini"` — with a clean build and a correct `--version` behind
# it, so nothing before `docker compose up` catches it.
#
# ## Why `set -u` and no echo of any value
#
# `set -u` turns a missing role variable into an immediate failure rather than a `userlist.txt` line
# reading `"builderhunt_app" ""` — which PgBouncer would accept and then refuse every connection, hours
# later, as an authentication problem nobody could trace to a typo in a compose file.
#
# Nothing in this script prints a password. Not on success, not on failure, and not in the error that
# explains which variable is missing: naming the variable is enough to fix it.
set -eu

USERLIST=/run/pgbouncer/userlist.txt

require() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    echo "pgbouncer: $1 is required and unset" >&2
    exit 1
  fi
}

for var in \
  BUILDERHUNT_APP_PASSWORD \
  BUILDERHUNT_AUTH_PASSWORD \
  BUILDERHUNT_WORKER_PASSWORD \
  BUILDERHUNT_PLATFORM_PASSWORD \
  BUILDERHUNT_CAPABILITY_PASSWORD \
  PGBOUNCER_ADMIN_PASSWORD
do
  require "$var"
done

# Written with a restrictive umask rather than chmod-after-write: between the two there is a window in
# which the file is world-readable, and this is the file that holds every role's password.
umask 0177
: > "$USERLIST"
{
  printf '"%s" "%s"\n' builderhunt_app "$BUILDERHUNT_APP_PASSWORD"
  printf '"%s" "%s"\n' builderhunt_auth "$BUILDERHUNT_AUTH_PASSWORD"
  printf '"%s" "%s"\n' builderhunt_worker "$BUILDERHUNT_WORKER_PASSWORD"
  printf '"%s" "%s"\n' builderhunt_platform "$BUILDERHUNT_PLATFORM_PASSWORD"
  printf '"%s" "%s"\n' builderhunt_capability "$BUILDERHUNT_CAPABILITY_PASSWORD"
  printf '"%s" "%s"\n' pgbouncer "$PGBOUNCER_ADMIN_PASSWORD"
} >> "$USERLIST"

# The upstream, written rather than baked — see the note in pgbouncer.ini. `*` forwards whatever database
# the client asked for, so one line serves the app, the disposable load databases and the admin console.
DATABASES=/run/pgbouncer/databases.ini
printf '[databases]\n* = host=%s port=%s\n' \
  "${PGBOUNCER_UPSTREAM_HOST:-db}" "${PGBOUNCER_UPSTREAM_PORT:-5432}" > "$DATABASES"
chmod 0600 "$DATABASES"
printf 'pgbouncer: upstream %s:%s\n' "${PGBOUNCER_UPSTREAM_HOST:-db}" "${PGBOUNCER_UPSTREAM_PORT:-5432}"

# Confirms the mode without revealing the contents. `0600` is what the ini file's `auth_file` requires and
# what makes this safe to leave in a shared tmpfs.
printf 'pgbouncer: wrote %s (%s), %s roles\n' "$USERLIST" "$(stat -c '%a' "$USERLIST")" 6

exec /usr/local/bin/pgbouncer /etc/pgbouncer/pgbouncer.ini
