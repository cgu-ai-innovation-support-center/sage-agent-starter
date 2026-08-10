#!/bin/sh
set -eu

# The reviewed official image marks /usr/bin/caddy with
# cap_net_bind_service=ep. Linux refuses to exec that file after every
# capability is removed from the container bounding set, even though this
# profile listens only on unprivileged port 8443. A normal copy does not carry
# the file capability, so the sidecar can retain cap_drop: ALL.
cp /usr/bin/caddy /tmp/caddy-unprivileged
chmod 0500 /tmp/caddy-unprivileged
exec /tmp/caddy-unprivileged run \
  --config /etc/caddy/Caddyfile \
  --adapter caddyfile
