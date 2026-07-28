# ClamAV for arm64, built from the Alpine package.
#
# `clamav/clamav` publishes amd64 only — checked stable, stable_base, latest, 1.4
# and 1.4_base on Docker Hub, and neither ghcr.io nor quay.io serves the image at
# all. The deployment target is a Hetzner CAX21, which is ARM, so the upstream
# image is not an option there.
#
# Of the ways around that, this is the one that keeps provenance short: the
# binary comes from Alpine's own clamav package, signed and rebuilt by the
# distro, rather than from an unknown third-party rebuild of an antivirus — the
# one component whose entire job is to be trustworthy. It is also multi-arch for
# free, so amd64 developer machines and an ARM server run the same Dockerfile.
FROM alpine:3.21

# `clamav` brings clamd and clamscan; `clamav-libunrar` lets it look inside RAR
# archives, which is exactly where someone hides a payload from a scanner that
# cannot open them. `freshclam` ships in the clamav package.
RUN apk add --no-cache clamav clamav-libunrar \
  && mkdir -p /run/clamav /var/lib/clamav \
  && chown -R clamav:clamav /run/clamav /var/lib/clamav

# TCP rather than a unix socket: the app talks to this over the compose network.
# `StreamMaxLength` has to exceed the largest upload the app will accept, or a
# big-but-legitimate CV comes back as a scan failure rather than a verdict.
RUN printf '%s\n' \
  'LogTime yes' \
  'Foreground yes' \
  'TCPSocket 3310' \
  'TCPAddr 0.0.0.0' \
  'StreamMaxLength 64M' \
  'MaxFileSize 64M' \
  'MaxScanSize 256M' \
  > /etc/clamav/clamd.conf \
  && printf '%s\n' \
  'DatabaseMirror database.clamav.net' \
  'ScriptedUpdates yes' \
  'Foreground yes' \
  > /etc/clamav/freshclam.conf

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3310
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
