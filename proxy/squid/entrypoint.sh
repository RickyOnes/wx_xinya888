#!/bin/sh
set -e

if [ -z "$PROXY_USER" ] || [ -z "$PROXY_PASS" ]; then
  echo "ERROR: PROXY_USER and PROXY_PASS must be set" >&2
  exit 1
fi

# create or overwrite passwd file
htpasswd -b -c /etc/squid/passwd "$PROXY_USER" "$PROXY_PASS"
chown proxy:proxy /etc/squid/passwd || true

# prepare cache directory if needed
squid -N -z || true

# start squid in foreground with verbose logging
exec squid -NYCd 1
