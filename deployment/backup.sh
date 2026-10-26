#!/usr/bin/env bash
# Linux VPS; invoke from any working directory. Requires a running backend.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
compose=(docker compose -f docker-compose.yml -f compose.production.yml)
destination="${1:?Usage: bash deployment/backup.sh /absolute/private/backup-directory}"
[[ "$destination" = /* ]] || { echo 'Use an absolute backup directory' >&2; exit 1; }
mkdir -p "$destination"
backup="$destination/switchboard-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -m 700 "$backup"
container="$("${compose[@]}" ps -q switchboard)"
[[ -n "$container" ]] || { echo 'Backend must be running before backup' >&2; exit 1; }
trap '"${compose[@]}" start switchboard >&2' EXIT
"${compose[@]}" stop switchboard
docker cp "$container:/app/data/." "$backup/"
echo "Database backup saved to $backup"
