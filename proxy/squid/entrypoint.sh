#!/bin/sh
set -e

if [ -z "$PROXY_USER" ] || [ -z "$PROXY_PASS" ]; then
  echo "ERROR: PROXY_USER and PROXY_PASS must be set" >&2
  exit 1
fi

# create or overwrite passwd file
htpasswd -b -c /etc/squid/passwd "$PROXY_USER" "$PROXY_PASS"

# ensure necessary directories and permissions for squid logging and cache
mkdir -p /var/log/squid /var/spool/squid /var/cache/squid
chown -R proxy:proxy /var/log/squid /var/spool/squid /var/cache/squid || true

# prepare cache directory if needed
squid -z || true

# start squid as a daemon (so we can tail logs to stdout)
if ! squid; then
  echo "Failed to start squid" >&2
  exit 1
fi

# tail logs to stdout/stderr so the platform captures them
exec tail -F /var/log/squid/access.log /var/log/squid/cache.log
