#!/usr/bin/env bash
# Stage and deploy the receiver page to CapRover.
#
# share.html is NOT kept in this folder: docs/share.html is the single copy, and
# GitHub Pages serves that same file. Staging it here at deploy time is what
# stops the two hosts from drifting apart.
#
# Usage: ./deploy.sh [app-name]        (default app name: share)
set -euo pipefail

app="${1:-share}"
here="$(cd "$(dirname "$0")" && pwd)"
page="$here/../docs/share.html"

[ -f "$page" ] || { echo "missing $page" >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$here/Dockerfile" "$here/captain-definition" "$stage/"
cp "$page" "$stage/share.html"

tarball="$here/deploy.tar"
tar -cf "$tarball" -C "$stage" .
echo "built $tarball ($(wc -c < "$tarball" | tr -d ' ') bytes) from docs/share.html"

if command -v caprover >/dev/null 2>&1; then
    caprover deploy -t "$tarball" -a "$app"
else
    echo
    echo "caprover CLI not installed. Either:"
    echo "  npm install -g caprover && caprover deploy -t $tarball -a $app"
    echo "  or upload $tarball in the CapRover dashboard: Apps -> $app -> Deployment -> Upload tar"
fi
