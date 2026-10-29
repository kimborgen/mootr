#!/bin/sh
# Installs a live checkout's dependencies when its package-lock.json changed (S-941). `bin/stam deploy` runs from the
# checkout, so a dependency a merge added (yaml, S-871) must be in the checkout's node_modules before it runs. Run in the
# checkout; the installed lock's hash is kept in STAM_HOME/checkout-deps.sha, and an equal hash skips the install.
# Only the root lock: a deploy installs web/ and builds it inside the release, never from the checkout's web/.
# A missing node_modules reinstalls whatever the hash says; the install is killed after 280 s, since the watcher's timeout only kills sh.
# STAM_NPM overrides the npm command.
set -e

[ -f package-lock.json ] || exit 0
home=${MOOTR_HOME:-${STAM_HOME:-}}
# deploy-storage.sh sends this script over ssh from a base64 copy, so default_home (scripts/default-home.sh; a test
# keeps the two equal) is inlined rather than sourced.
default_home() {
  s="$HOME/.local/share/stam"; m="$HOME/.local/share/mootr"
  if [ -d "$s" ] && [ ! -L "$s" ]; then
    [ ! -e "$m" ] || echo "default home: $s and $m are both real folders; using $s" >&2
    echo "$s"; return 0
  fi
  if [ -e "$m" ] || [ -L "$s" ]; then echo "$m"; return 0; fi
  err=$(LC_ALL=C stat -c %F -- "$s" 2>&1 >/dev/null) || case $err in
    *"No such file"*|*"Not a directory"*) ;;
    *) echo "default home: $err" >&2; return 1 ;;
  esac
  echo "$m"
}
[ -n "$home" ] || home=$(default_home) || exit 1
new=$(sha256sum package-lock.json | cut -d' ' -f1)
old=$(cat "$home/checkout-deps.sha" 2>/dev/null || true)
[ "$new" = "$old" ] && [ -d node_modules ] && exit 0

echo "ensure-deps: package-lock.json changed, running npm ci"
timeout 280 ${MOOTR_NPM:-${STAM_NPM:-npm}} ci --no-audit --no-fund
mkdir -p "$home"
printf '%s' "$new" > "$home/checkout-deps.sha"
