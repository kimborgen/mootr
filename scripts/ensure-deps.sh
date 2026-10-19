#!/bin/sh
# Installs a live checkout's dependencies when its package-lock.json changed (S-941). `bin/stam deploy` runs from the
# checkout, so a dependency a merge added (yaml, S-871) must be in the checkout's node_modules before it runs. Run in the
# checkout; the installed lock's hash is kept in STAM_HOME/checkout-deps.sha, and an equal hash skips the install.
# Only the root lock: a deploy installs web/ and builds it inside the release, never from the checkout's web/.
# A missing node_modules reinstalls whatever the hash says; the install is killed after 280 s, since the watcher's timeout only kills sh.
# STAM_NPM overrides the npm command.
set -e

[ -f package-lock.json ] || exit 0
home=${STAM_HOME:-$HOME/.local/share/stam}
new=$(sha256sum package-lock.json | cut -d' ' -f1)
old=$(cat "$home/checkout-deps.sha" 2>/dev/null || true)
[ "$new" = "$old" ] && [ -d node_modules ] && exit 0

echo "ensure-deps: package-lock.json changed, running npm ci"
timeout 280 ${STAM_NPM:-npm} ci --no-audit --no-fund
mkdir -p "$home"
printf '%s' "$new" > "$home/checkout-deps.sha"
