#!/bin/sh
# Self-heal volume permissions, then drop privileges to the non-root
# `hawkeye` user. Runs every container start — idempotent.

set -e

# /app/data may be a fresh bind mount owned by root on the host. Without
# this, the wallet store, position store, seen-tokens, and trade-history
# writes all fail with EACCES.
chown -R hawkeye:hawkeye /app/data

# Hand off to the actual command (CMD from the Dockerfile or `docker run`)
# under the `hawkeye` user. exec replaces the shell so signals reach Node
# directly via tini.
exec su-exec hawkeye:hawkeye "$@"
