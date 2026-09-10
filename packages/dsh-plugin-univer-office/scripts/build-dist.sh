#!/usr/bin/env bash
# Build every application and create the normal npm TGZ from package.json#files.
# The user's package manager installs runtime/native dependencies for that host;
# never copy this build machine's node_modules into the archive. No publishing.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
DIST="${1:-$ROOT/dist}"

mkdir -p "$DIST"
DIST="$(cd "$DIST" && pwd)"
(cd "$ROOT" && pnpm run build && pnpm pack --pack-destination "$DIST")
