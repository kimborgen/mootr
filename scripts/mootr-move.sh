#!/bin/sh
# One machine's live move of the data dir from ~/.local/share/stam to ~/.local/share/mootr (S-3351, P6 of S-2890).
# Run it by hand on each machine, with the operator present; never from a loop or a watcher.
#
#   scripts/mootr-move.sh [--dry-run] [--home DIR] [--unit-dir DIR] [--systemctl CMD]
#   scripts/mootr-move.sh --rollback [same flags]
#
# Steps:
#   0. Preconditions. Refuses while a running agent was launched or resumed before the cutoff release's built_at, the first release that lists mootr-deploy-names (--allow-stale-agents
#      skips it; an unreadable /api/agents refuses). Refuses unless the deployed release's .release.json lists the capabilities mootr-deploy-names (P4, S-3347)
#      and mootr-suite-names (P5, S-3349). Refuses, and leaves everything as it was, when: there is no regular stamd.service (or kept copy) to base mootrd.service on; mootr is a symlink, or exists as a real dir beside a real
#      stam dir; the data dir (or a dir inside it) is on another filesystem than its parent, so mv would copy; releases/.flock or
#      full-suite.lock or gate.lock is held; deploy-hold exists or can't be created; the disk can't hold the backup. Any inspection
#      error other than "not found" stops the script. Lists the harness processes (claude, codex, opencode) whose cwd is under the
#      data dir, read from /proc/PID/cwd, so the operator sees who step 7 restarts (S-4344). The stale agent cutoff is the first capable release's built_at, not its activation. The gap is a few minutes only when that release went live straight after its build; it is wider when that release failed activation and a later capable release went live after it, or when a rollback to a release without the capability ran after one went live. Check the window by hand before the move (S-3404).
#   1. Freeze: record each stam-*.timer's enabled and active state in STAMPREMOVE/timers; create deploy-hold; stop the timers, never their services;
#      wait, with a bound (MOOTR_MOVE_LOCK_TRIES, MOOTR_MOVE_LOCK_SLEEP), for their running services to finish, then take
#      releases/.flock and full-suite.lock, and keep them (flock on open descriptors, plus the releases/.lock pid file) until step 4's
#      health check passes; then take gate.lock the same way (the gate lock, see lockFile in scripts/gate.mjs). An EXIT trap frees them on every exit.
#   2. Install mootrd.service (stamd.service with the data path changed, Alias=stamd.service, MOOTR_NODE beside STAM_NODE).
#   3. Stop stamd, back up stam.db* and settings*.json only (never the whole dir), mv stam mootr, ln -s mootr stam.
#   4. Disable stamd and move its unit file to STAMPREMOVE/units, enable --now mootrd; wait for GET /api/health 200, then
#      /api/health/db 200. A failure rolls back to stamd on the old path.
#   5. Replace each stam-* timer pair with a mootr-* one (old files to STAMPREMOVE/units); enable it when the old one was enabled.
#   6. Start the timers that ran, then remove deploy-hold when this script made it; record step6 in STAMPREMOVE/progress.
#   7. Only once health passed, restart each agent on this machine whose harness runs in its worktree under the data dir, through
#      the daemon's POST /api/agents/ID/restart (agent_control restart: --resume keeps the conversation and picks up the new path;
#      S-3809, S-3813). A resting agent, or one with no harness process in its worktree, is skipped and named. A restart the
#      daemon accepted (200) is recorded in STAMPREMOVE/progress after the call and never asked again; one that failed, timed out,
#      or was cut off by a crash is asked again by a rerun (at least once: the daemon merges a second ask into a pending restart).
#      A failure is reported and never rolls back or fails the move. A rollback restarts nothing.
# --rollback takes the same freeze first (hold, every stam-* and mootr-* timer and service stopped, locks free), and only then
# stops mootrd, puts stamd.service and the old timers back, removes the symlink, mv mootr back to stam, and starts stamd and the
# timers that ran. Nothing here deletes or overwrites stam.db: the only removals are the stam symlink, the deploy-hold this
# script made, and the mootr-* units (moved aside, not deleted).
# Idempotent: every step checks what is already true and skips it, so a rerun after any partial step finishes the move, or
# says it is already done. --dry-run prints each action as "would: ..." and changes nothing.
#
# Env (each has a flag): MOOTR_MOVE_HOME (--home, default $HOME), MOOTR_MOVE_UNIT_DIR (--unit-dir, default
# HOME/.config/systemd/user), MOOTR_MOVE_SYSTEMCTL (--systemctl, default "systemctl --user"). Also MOOTR_MOVE_CURL,
# MOOTR_MOVE_HEALTH_URL (default http://127.0.0.1:PORT; the port is MOOTR_PORT, then STAM_PORT, then the unit, then 7878), MOOTR_MOVE_HEALTH_TRIES (30), MOOTR_MOVE_HEALTH_SLEEP (2),
# MOOTR_MOVE_NODE (node), MOOTR_MOVE_REQUIRE_CAPS, MOOTR_MOVE_PROC (the proc root, /proc), MOOTR_MOVE_HARNESS_COMM (the
# process names that are harnesses, "claude codex opencode"). MOOTR_MOVE_TEST=1 makes the script refuse unless home, unit dir and systemctl are all given
# explicitly and the home isn't the real $HOME: tests set it so a missing override can't reach a live home.
# The API token is read from DATA/token into curl's config on stdin and is never printed.
set -eu
LC_ALL=C
export LC_ALL

DRY=0
ROLLBACK=0
MODE=move
ALLOW_STALE=${MOOTR_MOVE_ALLOW_STALE_AGENTS:-0}
HOME_ROOT=${MOOTR_MOVE_HOME:-}
UNIT_DIR=${MOOTR_MOVE_UNIT_DIR:-}
SYSTEMCTL=${MOOTR_MOVE_SYSTEMCTL:-}
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --rollback) ROLLBACK=1; MODE=rollback ;;
    --allow-stale-agents) ALLOW_STALE=1 ;;
    --home) HOME_ROOT=${2:?--home needs a dir}; shift ;;
    --unit-dir) UNIT_DIR=${2:?--unit-dir needs a dir}; shift ;;
    --systemctl) SYSTEMCTL=${2:?--systemctl needs a command}; shift ;;
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
    *) echo "mootr-move: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "mootr-move: $*" >&2; exit 1; }
say() { echo "mootr-move: $*"; }

if [ "${MOOTR_MOVE_TEST:-}" = 1 ]; then
  [ -n "$HOME_ROOT" ] && [ -n "$UNIT_DIR" ] && [ -n "$SYSTEMCTL" ] ||
    die "MOOTR_MOVE_TEST=1 needs --home, --unit-dir and --systemctl (or their MOOTR_MOVE_ env names); refusing to run"
  real=$(cd "${HOME:-/nonexistent}" 2>/dev/null && pwd -P || true)
  here=$(cd "$HOME_ROOT" 2>/dev/null && pwd -P || true)
  [ -n "$here" ] || die "test home $HOME_ROOT doesn't exist"
  [ "$here" != "$real" ] || die "test home is the real home; refusing to run"
fi
HOME_ROOT=${HOME_ROOT:-${HOME:?HOME is not set}}
UNIT_DIR=${UNIT_DIR:-$HOME_ROOT/.config/systemd/user}
SYSTEMCTL=${SYSTEMCTL:-systemctl --user}
CURL=${MOOTR_MOVE_CURL:-curl}
NODE=${MOOTR_MOVE_NODE:-node}
HEALTH_TRIES=${MOOTR_MOVE_HEALTH_TRIES:-30}
HEALTH_SLEEP=${MOOTR_MOVE_HEALTH_SLEEP:-2}
PROC=${MOOTR_MOVE_PROC:-/proc}
HARNESS_COMM=${MOOTR_MOVE_HARNESS_COMM:-claude codex opencode}

SHARE=$HOME_ROOT/.local/share
OLD=$SHARE/stam
NEW=$SHARE/mootr
PREMOVE=$HOME_ROOT/stam-premove
HERE=$(cd "$(dirname "$0")" && pwd)
STAMD=stamd.service
MOOTRD=mootrd.service

# Runs a changing command, or only prints it under --dry-run.
run() {
  if [ "$DRY" = 1 ]; then echo "would: $*"; else echo "+ $*"; "$@" 7>&- 8>&- 9>&-; fi
}
# $SYSTEMCTL is a command line ("systemctl --user"), so it's split on purpose.
sc() { run $SYSTEMCTL "$@"; }
unit_active() { $SYSTEMCTL is-active --quiet "$1" 2>/dev/null; }
# True while a unit has work in flight. A oneshot service that runs is `activating`, which is-active reports as not active, so
# this reads ActiveState: active, activating, deactivating and reloading are busy; inactive and failed are not; a failed query
# or any other value stops the script (fail closed).
unit_busy() {
  if ! st=$($SYSTEMCTL show -p ActiveState --value "$1" 2>/dev/null); then die "can't read the state of $1 (systemctl show failed); stopping with the freeze in place"; fi
  case $st in
    active|activating|deactivating|reloading) return 0 ;;
    inactive|failed) return 1 ;;
    *) die "$1 reports the unknown state '$st'; stopping with the freeze in place" ;;
  esac
}

# What PATH is: absent | dir | symlink | file | other. "No such file or directory" is the only error that means absent;
# any other error (permissions, a path component that isn't a dir) stops the script.
kind() {
  if ! out=$(stat -c %F -- "$1" 2>&1); then
    case $out in
      *'No such file or directory'*) echo absent; return 0 ;;
      *) die "can't inspect $1: $out" ;;
    esac
  fi
  case $out in
    directory) echo dir ;;
    'symbolic link') echo symlink ;;
    'regular file'|'regular empty file') echo file ;;
    *) echo other ;;
  esac
}
devof() { stat -c %d -- "$1" || die "can't stat $1"; }

# 0 free, 3 held, anything else is an inspection error (lock-held.mjs throws on one). A missing file is free.
lock_state() {
  [ "$(kind "$1")" = absent ] && return 0
  rc=0
  "$NODE" --no-warnings -e 'import(require("url").pathToFileURL(process.argv[1]).href).then((m) => process.exit(m.lockHeld(process.argv[2]) ? 3 : 0), (e) => { console.error(String(e && e.message || e)); process.exit(1); })' "$HERE/lock-held.mjs" "$1" || rc=$?
  return "$rc"
}
# Step 0: refuses on a held lock, or an error reading it; nothing has changed yet.
lock_check() {
  rc=0; lock_state "$1" || rc=$?
  case $rc in
    0) ;;
    3) die "$1 is held; a deploy or the full suite is running.$NC" ;;
    *) die "can't tell whether $1 is held (exit $rc).$NC" ;;
  esac
}
# The legacy pid-file lock releases/.lock that older callers take (src/release-lock.ts): held while it names a live pid, or is
# empty and under 5 s old; stale otherwise. Prints held, stale or free.
legacy_state() {
  if [ "$(kind "$1")" = absent ]; then echo free; return 0; fi
  pid=$(tr -d '[:space:]' <"$1" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    age=$(( $(date +%s) - $(stat -c %Y -- "$1") ))
    if [ "$age" -lt 5 ]; then echo held; else echo stale; fi
    return 0
  fi
  case $pid in *[!0-9]*) echo held; return 0 ;; esac
  if kill -0 "$pid" 2>/dev/null; then echo held; else echo stale; fi
}

LOCK_OPEN=0
LEGACY=0
STALE_REC=""
NC=""
# Takes the deploy locks and keeps them: releases/.flock on descriptor 9, full-suite.lock on 8 and gate.lock on 7 (flock(1) on a
# descriptor this shell keeps open, as src/release-lock.ts does; the lock belongs to the open file, so it stays with the file
# through the mv), and releases/.lock as a pid file naming this shell. Held from the freeze until the daemon is healthy; closed on
# every exit. gate.lock is the file scripts/gate.mjs lockFile() names (lockHome, src/default-home.ts): a gate or merge run takes it
# with flock too, so a held descriptor blocks them, and after the move the stam symlink reaches the same file.
open_locks() {
  if [ "$LOCK_OPEN" = 1 ]; then return 0; fi
  exec 9>>"$1/releases/.flock"
  exec 8>>"$1/full-suite.lock"
  exec 7>>"$1/gate.lock"
  LOCK_OPEN=1
}
# Takes releases/.lock the way src/release-lock.ts does: create first, with a hard link of a temp file that already names this
# shell (atomic, and it fails when the file exists). When it exists: held means wait; stale is removed only when the same
# inode and mtime are still there on a second look, then the create is tried again. Nothing is removed before a create attempt.
# Called only once releases/.flock is ours, so no new-code caller is in this window.
take_legacy() {
  if [ "$LEGACY" = 1 ]; then return 0; fi
  f=$1/releases/.lock
  tmp=$1/releases/.lock.$$.tmp
  printf '%s' "$$" >"$tmp"
  n=0
  while [ "$n" -lt 3 ]; do
    if [ "${MOOTR_MOVE_TEST:-}" = 1 ] && [ -n "${MOOTR_MOVE_HOOK_LEGACY:-}" ]; then sh -c "$MOOTR_MOVE_HOOK_LEGACY"; fi
    if ln "$tmp" "$f" 2>/dev/null; then LEGACY=1; rm -f -- "$tmp"; return 0; fi
    sig=$(stat -c '%i %Y' -- "$f" 2>/dev/null || true)
    if [ -n "$sig" ]; then
      if [ "$(legacy_state "$f")" = held ]; then rm -f -- "$tmp"; return 3; fi
      if [ "$(stat -c '%i %Y' -- "$f" 2>/dev/null || true)" = "$sig" ]; then rm -f -- "$f"; fi
    fi
    n=$((n + 1))
  done
  rm -f -- "$tmp"
  return 3
}
release_locks() {
  if [ "$LEGACY" = 1 ]; then
    for f in "$NEW/releases/.lock" "$OLD/releases/.lock"; do
      if [ -f "$f" ] && [ "$(tr -d '[:space:]' <"$f" 2>/dev/null || true)" = "$$" ]; then rm -f -- "$f"; fi
    done
    LEGACY=0
  fi
  if [ "$LOCK_OPEN" = 1 ]; then exec 9>&- 8>&- 7>&-; LOCK_OPEN=0; fi
}
trap release_locks EXIT

# Stops at a bound: names what is still busy and the way on for this direction. The freeze stays in place.
bound_stop() {
  if [ "$MODE" = rollback ]; then way="the rollback has not changed anything but the freeze; run --rollback again when the holder ends"
  else way="rerun when the holder ends, or run --rollback"; fi
  die "$1. The freeze is in place (deploy-hold, timers stopped); $way"
}

# After the freeze: takes the three locks, waiting with a bound for whoever holds one, and says what it waits for. An error
# reading a lock stops at once. Still held at the bound: stops, and the message names the way on for this direction.
wait_locks() {
  tries=${MOOTR_MOVE_LOCK_TRIES:-60}
  i=0
  open_locks "$1"
  while :; do
    held=""
    rc=0; flock -n -E 75 9 || rc=$?
    case $rc in 0) ;; 75) held="$held $1/releases/.flock" ;; *) die "can't lock $1/releases/.flock (flock exit $rc); stopping with the freeze in place" ;; esac
    if [ -z "$held" ]; then
      rc=0; take_legacy "$1" || rc=$?
      case $rc in 0) ;; 3) held="$held $1/releases/.lock" ;; *) die "can't take $1/releases/.lock; stopping with the freeze in place" ;; esac
    fi
    rc=0; flock -n -E 75 8 || rc=$?
    case $rc in 0) ;; 75) held="$held $1/full-suite.lock" ;; *) die "can't lock $1/full-suite.lock (flock exit $rc); stopping with the freeze in place" ;; esac
    # The gate lock comes last: a gate or merge that holds it is waited for only once the deploy locks are ours.
    if [ -z "$held" ]; then
      rc=0; flock -n -E 75 7 || rc=$?
      case $rc in 0) ;; 75) held="$held $1/gate.lock" ;; *) die "can't lock $1/gate.lock (flock exit $rc); stopping with the freeze in place" ;; esac
    fi
    if [ -z "$held" ]; then return 0; fi
    i=$((i + 1))
    if [ "$i" -ge "$tries" ]; then bound_stop "still held after $tries tries:$held"; fi
    say "waiting for$held to be free (try $i of $tries)"
    sleep "${MOOTR_MOVE_LOCK_SLEEP:-2}"
  done
}

# premove/progress records each step that finished, one `stepN` line each; "done" is read from it, never from the hold. A
# rollback archives it, so a later move starts fresh.
mark_step() {
  if [ "$DRY" = 1 ]; then return 0; fi
  mkdir -p "$PREMOVE"
  if ! grep -qxF "$1" "$PREMOVE/progress" 2>/dev/null; then echo "$1" >>"$PREMOVE/progress"; fi
}
step_done() { grep -qxF "$1" "$PREMOVE/progress" 2>/dev/null; }

# The deployed release must carry the fixes for the stam names this move leaves behind: P4 (S-3347, src/deploy.ts
# serviceRunsReleases) and P5 (S-3349, full-suite.mjs --request). A release says so in its .release.json, in a `capabilities`
# array: `mootr-deploy-names` for P4, `mootr-suite-names` for P5 (MOOTR_MOVE_REQUIRE_CAPS overrides the list). Missing file,
# unreadable JSON, or a missing entry refuses, before anything changes.
require_release_caps() {
  f=$1/releases/current/.release.json
  if [ "$(kind "$f")" != file ]; then die "$f is missing, so the deployed release can't say it carries the P4 and P5 fixes.$NC"; fi
  have=$("$NODE" --no-warnings -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); for (const c of Array.isArray(m.capabilities) ? m.capabilities : []) console.log(c)' "$f") || die "can't read $f.$NC"
  missing=""
  for c in ${MOOTR_MOVE_REQUIRE_CAPS:-mootr-deploy-names mootr-suite-names}; do
    if ! printf '%s\n' "$have" | grep -qx -- "$c"; then missing="$missing $c"; fi
  done
  if [ -n "$missing" ]; then
    die "the deployed release lacks${missing} in $f; deploy P4 (S-3347, mootr-deploy-names) and P5 (S-3349, mootr-suite-names) first.$NC"
  fi
}

STALE_CAP=mootr-deploy-names
# The cutoff: the earliest release in releases/ whose .release.json lists STALE_CAP, the first build that carries the deny rules for
# both homes (P4, S-3347). Prints its release name (the label the progress record keys on) and its built_at. A later deploy doesn't
# move it. A pruned earliest release makes the cutoff later, which only makes the check stricter. The cutoff is built_at, not an
# activation time: the deploy records none (src/deploy.ts only moves `current`), so an agent launched between built_at and the switch
# to `current` passes, though it ran the release before. That gap is a few minutes only when the first capable release went live
# straight after its build. It is wider when that release failed activation (src/deploy.ts:628-650 points `current` back and keeps
# the folder) and a later capable release went live after it, or when a rollback to a release without the capability ran after
# one went live: check the window by hand before the move. Fails closed (exit 3 none lists the capability;
# 5 a .release.json that can't be read or parsed, any error but not-found, since it might be the earliest; 6 a capable release with
# no built_at). A release folder with no .release.json is an unfinished build and is skipped.
cutoff_release() {
  "$NODE" --no-warnings -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1], cap = process.argv[2];
    let best = null;
    for (const name of fs.readdirSync(dir).sort()) {
      let text;
      try { text = fs.readFileSync(path.join(dir, name, ".release.json"), "utf8"); } catch (e) {
        if (e.code === "ENOENT" || e.code === "ENOTDIR") continue;
        console.error(`mootr-move: cannot read ${name}/.release.json (${e.code})`);
        process.exit(5);
      }
      let m;
      try { m = JSON.parse(text); } catch { console.error(`mootr-move: ${name}/.release.json is not readable JSON`); process.exit(5); }
      const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
      if (!caps.includes(cap)) continue;
      const built = Date.parse(m.built_at);
      if (!(built > 0)) { console.error(`mootr-move: ${name} lists ${cap} but has no usable built_at`); process.exit(6); }
      if (!best || built < best.built) best = { label: m.release || m.commit || "-", at: m.built_at, built };
    }
    if (!best) { console.error(`mootr-move: no release lists ${cap}`); process.exit(3); }
    console.log(`${best.label} ${best.at}`);
  ' "$1/releases" "$STALE_CAP"
}

# Agents launched or resumed before the cutoff release still carry the old rules (deny rules that name only the stam spelling), so
# the move refuses while one runs: names are printed so they can be resumed first. The agents come from the daemon's GET
# /api/agents (token from DATA/token through curl's stdin, never printed). An agent is stale when its launch time is before the
# cutoff's built_at; the launch time is the newest of launched_at, resumed_at, started_at and created_at the row carries, and a
# running (lifecycle active) agent whose row carries none of them counts as stale. The check fails closed: no cutoff, an unreadable
# API or a bad answer refuses. --allow-stale-agents (or MOOTR_MOVE_ALLOW_STALE_AGENTS=1) skips it.
check_stale_agents() {
  if [ "$ALLOW_STALE" = 1 ]; then say "skipping the stale agent check (--allow-stale-agents)"; return 0; fi
  cutoff=$(cutoff_release "$1") ||
    die "can't find the cutoff release (the first release that lists $STALE_CAP), so agents can't be compared with it (see above).$NC"
  cut_rel=${cutoff%% *}
  built=${cutoff#* }
  # A first run needs the daemon to answer. Once step 3 has stopped it, a rerun can't ask: the pass is recorded in the progress
  # file, for this cutoff, and a rerun with the same record skips the check.
  STALE_REC="stale-check $cut_rel $built"
  if step_done "$STALE_REC"; then say "the stale agent check already passed for this release in an earlier run; not asking the daemon again"; return 0; fi
  health_port
  if [ "$(kind "$1/token")" != file ]; then die "no API token file at $1/token, so the agents can't be listed.$NC"; fi
  resp=$({ printf 'header = "authorization: Bearer '; tr -d '\n' <"$1/token"; printf '"\n'; } |
    $CURL -s -K - -m 10 -w '\n%{http_code}' "${MOOTR_MOVE_HEALTH_URL:-http://127.0.0.1:$HPORT}/api/agents" 2>/dev/null) || resp=""
  code=$(printf '%s\n' "$resp" | tail -n 1)
  [ "$code" = 200 ] || die "can't list the agents (GET /api/agents answered ${code:-nothing}); refusing, since a stale agent can't be ruled out.$NC"
  rc=0
  names=$(printf '%s\n' "$resp" | sed '$d' | "$NODE" --no-warnings -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let a; try { a = JSON.parse(s); if (!Array.isArray(a)) throw 0; } catch { process.exit(4); }
      const built = Date.parse(process.argv[1]);
      const stale = a.filter((x) => x && x.lifecycle === "active").filter((x) => {
        const t = ["launched_at", "resumed_at", "started_at", "created_at"].map((k) => Date.parse(x[k])).filter((n) => n > 0);
        return !t.length || Math.max(...t) < built;
      }).map((x) => x.name || x.id);
      if (stale.length) { console.log(stale.join(" ")); process.exit(3); }
    });' "$built") || rc=$?
  case $rc in
    0) say "no agent predates the cutoff release $cut_rel ($built)" ;;
    3) die "these running agents were launched or resumed before the cutoff release $cut_rel ($built), the first release with $STALE_CAP, and still carry the old rules: $names. Resume them, or pass --allow-stale-agents.$NC" ;;
    *) die "the agent list from the daemon isn't readable JSON (exit $rc); refusing.$NC" ;;
  esac
}

# The data dir that exists right now: mootr once it moved, else stam.
cur_dir() { if [ "$(kind "$NEW")" = dir ]; then echo "$NEW"; else echo "$OLD"; fi; }

# The port the daemon listens on, read the way src/config.ts does: MOOTR_PORT, then STAM_PORT, then the default 7878. A
# PORT line in the unit's Environment (where the daemon gets it from) comes after the env names and before the default.
health_port() {
  p=${MOOTR_PORT:-${STAM_PORT:-}}
  if [ -z "$p" ]; then
    for u in "$UNIT_DIR/$STAMD" "$UNIT_DIR/$MOOTRD" "$PREMOVE/units/$STAMD"; do
      [ "$(kind "$u")" = file ] || continue
      p=$(sed -n -e 's/^Environment="\{0,1\}MOOTR_PORT=\([0-9]*\)"\{0,1\}$/\1/p' -e 's/^Environment="\{0,1\}STAM_PORT=\([0-9]*\)"\{0,1\}$/\1/p' "$u" | head -n 1)
      [ -z "$p" ] || break
    done
  fi
  case ${p:-7878} in *[!0-9]*) die "the port ${p} isn't a number" ;; esac
  HPORT=${p:-7878}
}
health_code() {
  d=$(cur_dir)
  [ "$(kind "$d/token")" = file ] || die "no API token file at $d/token"
  { printf 'header = "authorization: Bearer '; tr -d '\n' <"$d/token"; printf '"\n'; } |
    $CURL -s -K - -o /dev/null -w '%{http_code}' -m 5 "${MOOTR_MOVE_HEALTH_URL:-http://127.0.0.1:$HPORT}$1" 2>/dev/null || true
}
wait_health() {
  health_port
  if [ "$DRY" = 1 ]; then say "would: wait up to $HEALTH_TRIES tries for GET /api/health 200 on port $HPORT, then /api/health/db 200"; return 0; fi
  i=0
  while [ "$i" -lt "$HEALTH_TRIES" ]; do
    if [ "$(health_code /api/health)" = 200 ] && [ "$(health_code /api/health/db)" = 200 ]; then say "health ok"; return 0; fi
    i=$((i + 1))
    [ "$i" -lt "$HEALTH_TRIES" ] && sleep "$HEALTH_SLEEP"
  done
  return 1
}

# A path's place inside the data dir, in either spelling (a harness started before the move reads stam/..., and its
# /proc/PID/cwd reads mootr/... after it), or nothing when it is outside.
data_rel() {
  case $1 in
    "$OLD"|"$NEW") echo . ;;
    "$OLD"/*) echo "${1#"$OLD"/}" ;;
    "$NEW"/*) echo "${1#"$NEW"/}" ;;
  esac
}

# The harness processes whose cwd is inside the data dir, one "PID NAME REL" line each: a process whose name
# (PROC/PID/comm) is in HARNESS_COMM, its cwd read from PROC/PID/cwd. Read only; nothing is signalled.
harness_cwds() {
  [ -d "$PROC" ] || return 0
  for p in "$PROC"/[0-9]*; do
    c=$(cat -- "$p/comm" 2>/dev/null) || continue
    case " $HARNESS_COMM " in *" $c "*) ;; *) continue ;; esac
    w=$(readlink -- "$p/cwd" 2>/dev/null) || continue
    r=$(data_rel "$w")
    [ -n "$r" ] || continue
    printf '%s %s %s\n' "${p##*/}" "$c" "$r"
  done
}

# Step 0's listing: who step 7 restarts.
show_harness_cwds() {
  if [ ! -d "$PROC" ]; then say "can't read $PROC, so the harnesses running under $OLD can't be listed; step 7 restarts none"; return 0; fi
  h=$(harness_cwds)
  if [ -z "$h" ]; then say "no harness process has its cwd under $OLD"; return 0; fi
  say "harness processes with their cwd under $OLD (step 7 restarts their agents through the daemon once health passes):"
  printf '%s\n' "$h" | while read -r pid c r; do say "  pid $pid ($c) in $r"; done
}

# One daemon API call: METHOD PATH [JSON]. Prints the body, then the HTTP code on its own last line (empty when curl failed).
# The token goes through curl's config on stdin and is never printed.
api() {
  d=$(cur_dir)
  [ "$(kind "$d/token")" = file ] || return 0
  u="${MOOTR_MOVE_HEALTH_URL:-http://127.0.0.1:$HPORT}$2"
  if [ -n "${3:-}" ]; then
    { printf 'header = "authorization: Bearer '; tr -d '\n' <"$d/token"; printf '"\n'; } |
      $CURL -s -K - -m 10 -X "$1" -H 'content-type: application/json' -d "$3" -w '\n%{http_code}' "$u" 2>/dev/null || true
  else
    { printf 'header = "authorization: Bearer '; tr -d '\n' <"$d/token"; printf '"\n'; } |
      $CURL -s -K - -m 10 -X "$1" -w '\n%{http_code}' "$u" 2>/dev/null || true
  fi
}

# Step 7, run only after health passed: restart, through the daemon, each agent on this machine (the machine GET /api/health
# names) that is live, not resting, and has a harness process in its worktree under the data dir. Nothing here fails the move:
# a problem is reported and the step stays open, so a rerun retries what is left. "restart-asked ID" goes into the progress file
# only after the daemon accepted that restart (200), so a rerun skips it; anything short of that is asked again (at least once).
restart_agents() {
  say "step 7: restart the agents whose harness runs under the old path"
  if [ "$DRY" = 1 ]; then
    say "would: ask the daemon (POST /api/agents/ID/restart) to restart each live agent whose harness runs in its worktree under $OLD; resting agents are skipped"
    return 0
  fi
  h=$(harness_cwds)
  if [ -z "$h" ]; then say "no harness runs under the data dir; nothing to restart"; mark_step step7; return 0; fi
  health_port
  resp=$(api GET /api/health)
  machine=""
  if [ "$(printf '%s\n' "$resp" | tail -n 1)" = 200 ]; then
    machine=$(printf '%s\n' "$resp" | sed '$d' | "$NODE" --no-warnings -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { const m = JSON.parse(s).machine; if (typeof m === "string") console.log(m); } catch {} })' || true)
  fi
  if [ -z "$machine" ]; then say "can't tell this machine's name from GET /api/health, so its agents can't be told from a peer's; restart them by hand (agent_control restart): pids $(printf '%s\n' "$h" | awk '{print $1}' | tr '\n' ' ')"; return 0; fi
  resp=$(api GET /api/agents)
  if [ "$(printf '%s\n' "$resp" | tail -n 1)" != 200 ]; then say "can't list the agents (GET /api/agents answered $(printf '%s\n' "$resp" | tail -n 1)); restart them by hand (agent_control restart), or rerun"; return 0; fi
  done_ids=$(sed -n 's/^restart-asked //p' "$PREMOVE/progress" 2>/dev/null || true)
  # One line per agent of this machine in the data dir: "restart ID NAME" or "skip NAME: why".
  plan=$(printf '%s\n' "$resp" | sed '$d' | "$NODE" --no-warnings -e '
    const [machine, oldDir, newDir, harness, done] = process.argv.slice(1);
    const rel = (p) => (p === oldDir || p === newDir ? "." : p.startsWith(oldDir + "/") ? p.slice(oldDir.length + 1) : p.startsWith(newDir + "/") ? p.slice(newDir.length + 1) : null);
    const cwds = harness.split("\n").filter(Boolean).map((l) => l.split(" ").slice(2).join(" "));
    const asked = new Set(done.split("\n").filter(Boolean));
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let a; try { a = JSON.parse(s); if (!Array.isArray(a)) throw 0; } catch { process.exit(4); }
      for (const x of a) {
        if (!x || x.machine !== machine || (x.lifecycle !== "active" && x.lifecycle !== "paused") || typeof x.cwd !== "string") continue;
        const r = rel(x.cwd);
        if (r === null) continue;
        const name = x.name || x.id;
        if (asked.has(x.id)) console.log(`skip ${name}: the daemon accepted its restart in an earlier run`);
        else if (x.resting) console.log(`skip ${name}: resting, its harness is stopped`);
        else if (!cwds.some((c) => c === r || (r !== "." && c.startsWith(r + "/")))) console.log(`skip ${name}: no harness process runs in its worktree`);
        else console.log(`restart ${x.id} ${name}`);
      }
    });' "$machine" "$OLD" "$NEW" "$h" "$done_ids") || { say "the agent list from the daemon isn't readable JSON; restart the agents by hand (agent_control restart), or rerun"; return 0; }
  failed=0
  while read -r verb rest; do
    case $verb in
      skip) say "skipped $rest" ;;
      restart)
        id=${rest%% *}; name=${rest#* }
        if [ "${MOOTR_MOVE_TEST:-}" = 1 ] && [ -n "${MOOTR_MOVE_HOOK_RESTART:-}" ]; then sh -c "$MOOTR_MOVE_HOOK_RESTART"; fi
        code=$(api POST "/api/agents/$id/restart" '{"reason":"the data dir moved to mootr (mootr-move.sh)"}' | tail -n 1)
        if [ "$code" = 200 ]; then mark_step "restart-asked $id"; say "asked the daemon to restart $name"
        else
          failed=1
          say "the restart of $name failed (POST /api/agents/$id/restart answered ${code:-nothing}); the move stands. Restart it by hand (agent_control restart), or rerun"
        fi ;;
    esac
  done <<EOF
$plan
EOF
  if [ "$failed" = 0 ]; then mark_step step7; fi
}

# The units a timer replacement covers: every stam-*.timer in the unit dir (on the host whose watcher deploys the others:
# deploy-watch, full-suite, sweep-test-homes; on the others: go-parity).
timer_units() {
  [ "$(kind "$UNIT_DIR")" = dir ] || return 0
  for f in "$UNIT_DIR"/stam-*.timer; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    basename "$f"
  done
}

# The mootr-* timer units are derived by copying the old unit file with the name and the data path changed, until an --install
# writer for them replaces this (planned as S-3349). This is the one place to swap for that writer.
derive_timer_unit() {
  src=$1; dest=$2
  tmp=$UNIT_DIR/.$(basename "$dest").new.$$
  sed -e "s#/.local/share/stam/#/.local/share/mootr/#g" -e 's#stam-\(deploy-watch\|full-suite\|sweep-test-homes\|go-parity\)#mootr-\1#g' "$src" >"$tmp"
  mv -- "$tmp" "$dest"
}

# mootrd.service from stamd.service: data path and log under the new dir, Alias=stamd.service, MOOTR_NODE beside STAM_NODE.
derive_daemon_unit() {
  src=$1; dest=$2
  tmp=$UNIT_DIR/.$(basename "$dest").new.$$
  sed -e "s#/.local/share/stam/#/.local/share/mootr/#g" \
    -e 's#^Description=stam daemon#Description=mootr daemon#' \
    -e 's#^Environment="STAM_NODE=\(.*\)"$#&\nEnvironment="MOOTR_NODE=\1"#' \
    -e 's#^WantedBy=default.target$#&\nAlias=stamd.service#' "$src" >"$tmp"
  mv -- "$tmp" "$dest"
}

# premove/timers holds one line per timer found in step 1: "NAME ENABLED ACTIVE" (1 or 0).
# Under --dry-run nothing is written, so the list found in step 1 is kept in DRY_TIMERS instead.
timers_list() {
  if [ "$(kind "$PREMOVE/timers")" = file ]; then cat -- "$PREMOVE/timers"; else printf '%s' "${DRY_TIMERS:-}"; fi
}
mootr_name() { echo "mootr-${1#stam-}"; }

# Step 5: stop and disable each old timer, move its unit files to premove/units, install the mootr-* pair and enable it when the old timer was enabled.
replace_timers() {
  [ -n "$(timers_list)" ] || return 0
  while read -r t _ _; do
    [ -n "$t" ] || continue
    base=${t%.timer}; nbase=$(mootr_name "$base")
    if [ "$(kind "$UNIT_DIR/$t")" = file ]; then
      unit_active "$t" && sc stop "$t"
      sc disable "$t"
      for ext in timer service; do
        if [ "$(kind "$UNIT_DIR/$base.$ext")" = file ]; then
          if [ "$(kind "$PREMOVE/units/$base.$ext")" = absent ]; then run mv -- "$UNIT_DIR/$base.$ext" "$PREMOVE/units/$base.$ext"
          else run mv -- "$UNIT_DIR/$base.$ext" "$PREMOVE/units/$base.$ext.$(date +%s)"; fi
        fi
      done
    fi
    for ext in timer service; do
      # Under --dry-run the old file hasn't moved, so it is read from the unit dir.
      src=$PREMOVE/units/$base.$ext
      [ "$(kind "$src")" = file ] || src=$UNIT_DIR/$base.$ext
      if [ "$(kind "$UNIT_DIR/$nbase.$ext")" = absent ] && [ "$(kind "$src")" = file ]; then
        if [ "$DRY" = 1 ]; then echo "would: derive $UNIT_DIR/$nbase.$ext from $src"; else
          derive_timer_unit "$src" "$UNIT_DIR/$nbase.$ext"; echo "+ wrote $UNIT_DIR/$nbase.$ext"
        fi
      fi
    done
  done <<EOF
$(timers_list)
EOF
  sc daemon-reload
  while read -r t en _; do
    [ -n "$t" ] && [ "$en" = 1 ] || continue
    sc enable "$(mootr_name "${t%.timer}").timer"
  done <<EOF
$(timers_list)
EOF
}

# Step 6 (and a rollback): start the timers that were running; with the argument "new", the mootr-* ones.
start_timers() {
  [ -n "$(timers_list)" ] || return 0
  while read -r t _ was; do
    [ -n "$t" ] && [ "$was" = 1 ] || continue
    [ "${1:-}" = new ] && t=$(mootr_name "${t%.timer}").timer
    unit_active "$t" || sc start "$t"
  done <<EOF
$(timers_list)
EOF
}

# Puts the old timer files back, in place of the mootr-* ones (the rollback of step 5).
restore_timers() {
  [ -n "$(timers_list)" ] || return 0
  while read -r t en was; do
    [ -n "$t" ] || continue
    base=${t%.timer}; nbase=$(mootr_name "$base")
    for u in "$nbase.timer" "$nbase.service"; do
      [ "$(kind "$UNIT_DIR/$u")" = file ] || continue
      case $u in *.timer) unit_active "$u" && sc stop "$u"; sc disable "$u" ;; esac
      run mv -- "$UNIT_DIR/$u" "$PREMOVE/units/$u.rolled-back-$(date +%s)"
    done
    for ext in timer service; do
      if [ "$(kind "$UNIT_DIR/$base.$ext")" = absent ] && [ "$(kind "$PREMOVE/units/$base.$ext")" = file ]; then
        run cp -- "$PREMOVE/units/$base.$ext" "$UNIT_DIR/$base.$ext"
      fi
    done
  done <<EOF
$(timers_list)
EOF
}

# Takes deploy-hold in DIR for this script. The hold holds a token unique to this move (also kept in premove/hold-made), and the
# hold is removed only while it still holds exactly that token: the deploy watcher's onStop overwrites deploy-hold, and a hold
# someone else wrote or rewrote is theirs. A hold that is already there stays, and stays after the move when it isn't ours.
take_hold() {
  k=$(kind "$1/deploy-hold")
  if [ "$k" = dir ] || [ "$k" = other ]; then die "$1/deploy-hold can't be created: something that isn't a file is there"; fi
  if [ "$k" = file ]; then
    if [ "$(kind "$PREMOVE/hold-made")" = file ] && [ "$(cat -- "$1/deploy-hold")" = "$(cat -- "$PREMOVE/hold-made")" ]; then
      say "$1/deploy-hold exists, made by an earlier run of this script; keeping it"
    else say "$1/deploy-hold exists and isn't ours; keeping it, and it stays after the move"; fi
    return 0
  fi
  if [ "$DRY" = 1 ]; then echo "would: create $1/deploy-hold"; return 0; fi
  tok="mootr-move $$ $(date -u +%FT%TZ) $(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s' "$tok" >"$PREMOVE/hold-made"
  if ! (set -C; printf '%s' "$tok" >"$1/deploy-hold") 2>/dev/null; then
    rm -f -- "$PREMOVE/hold-made"
    die "can't create $1/deploy-hold"
  fi
  echo "+ created $1/deploy-hold"
}

# Every stam-* and mootr-* timer base name known: from the step 1 record and from the unit dir.
timer_bases() {
  names=""
  while read -r t _ _; do
    [ -n "$t" ] || continue
    names="$names ${t%.timer} $(mootr_name "${t%.timer}")"
  done <<EOF
$(timers_list)
EOF
  if [ "$(kind "$UNIT_DIR")" = dir ]; then
    for f in "$UNIT_DIR"/stam-*.timer "$UNIT_DIR"/mootr-*.timer; do
      if [ -e "$f" ] || [ -L "$f" ]; then b=$(basename "$f"); names="$names ${b%.timer}"; fi
    done
  fi
  printf '%s\n' $names | sort -u
}

# Stops the timers only. A running service is a deploy, a suite run or a sweep in flight: it is waited for, never stopped (its
# stop handler would rewrite deploy-hold, and a killed deploy leaves a half-built release).
stop_timer_units() {
  for b in $(timer_bases); do
    if unit_active "$b.timer"; then sc stop "$b.timer"; fi
  done
}

# Waits, with a bound, for every timer's service to finish, and says which it waits for.
wait_services() {
  tries=${MOOTR_MOVE_LOCK_TRIES:-60}
  i=0
  while :; do
    busy=""
    for b in $(timer_bases); do
      if unit_busy "$b.service"; then busy="$busy $b.service"; fi
    done
    if [ -z "$busy" ]; then return 0; fi
    i=$((i + 1))
    if [ "$i" -ge "$tries" ]; then bound_stop "still running after $tries tries:$busy"; fi
    say "waiting for$busy to finish (try $i of $tries)"
    sleep "${MOOTR_MOVE_LOCK_SLEEP:-2}"
  done
}

# The freeze shared by step 1 and --rollback, before anything moves: the hold, the timers stopped, their services finished, then
# the locks taken.
freeze() {
  run mkdir -p "$PREMOVE/units" "$PREMOVE/backup"
  take_hold "$1"
  stop_timer_units
  # From here the hold exists and the timers are stopped: record it before any wait, so a stop at a bound is not mistaken for
  # a run that changed nothing.
  if [ "$MODE" = move ]; then mark_step frozen; fi
  if [ "$DRY" = 1 ]; then
    say "would: wait up to ${MOOTR_MOVE_LOCK_TRIES:-60} tries for the timers' running services to finish, then take releases/.flock, releases/.lock and the full-suite lock"
  else
    wait_services
    wait_locks "$1"
  fi
}

# Removes the hold only while it holds exactly the token this script wrote.
drop_hold() {
  d=$(cur_dir)
  if [ "$(kind "$PREMOVE/hold-made")" != file ]; then return 0; fi
  if [ "$(kind "$d/deploy-hold")" = file ] && [ "$(cat -- "$d/deploy-hold")" = "$(cat -- "$PREMOVE/hold-made")" ]; then
    run rm -- "$d/deploy-hold"
  elif [ "$(kind "$d/deploy-hold")" = file ]; then
    say "$d/deploy-hold was rewritten since this script took it (the deploy watcher's stop handler does that); it is theirs now, so it stays"
  fi
  run rm -- "$PREMOVE/hold-made"
}

# Step 4: stamd is disabled and its unit file moved aside first (mootrd's Alias=stamd.service can't be enabled over a real
# stamd.service), then mootrd is enabled and started and must answer health.
start_new() {
  sc daemon-reload || return 1
  if [ "$(kind "$UNIT_DIR/$STAMD")" = file ]; then
    sc disable "$STAMD" || return 1
    run mv -- "$UNIT_DIR/$STAMD" "$PREMOVE/units/$STAMD.moved" || return 1
    sc daemon-reload || return 1
  fi
  sc enable --now "$MOOTRD" || return 1
  wait_health
}

# After a rollback, the records of the move (timers, progress) and the saved unit files are set aside under a dated name, so a
# second move reads the current units and timers, not these.
archive_premove_state() {
  ts=$(date +%s)
  for f in "$PREMOVE/timers" "$PREMOVE/progress" "$PREMOVE"/units/*; do
    if [ -e "$f" ]; then
      case $f in *.rolled-back-*) ;; *) run mv -- "$f" "$f.rolled-back-$ts" ;; esac
    fi
  done
}

# Puts stamd back on the old path. Never touches stam.db: the only removal is the stam symlink.
rollback() {
  say "rolling back to stamd on $OLD"
  s=$(kind "$OLD"); m=$(kind "$NEW")
  if [ "$s" = dir ] && [ "$m" = dir ]; then die "both $OLD and $NEW are real dirs; not guessing which is the data"; fi
  if [ "$m" = symlink ]; then die "$NEW is a symlink (to $(readlink -- "$NEW")); not rolling back over it"; fi
  # Fenced like step 1, before mootrd stops or anything moves: a mootr-* timer or service that ran during the mv could
  # recreate a real mootr dir and split the writes.
  say "rollback: freeze"
  freeze "$(cur_dir)"
  if unit_active "$MOOTRD"; then sc stop "$MOOTRD"; fi
  if [ "$DRY" != 1 ] && unit_active "$MOOTRD"; then die "$MOOTRD still active after stop; not moving the data dir"; fi
  if [ "$(kind "$UNIT_DIR/$MOOTRD")" != absent ]; then
    sc disable "$MOOTRD"
    run mkdir -p "$PREMOVE/units"
    run mv -- "$UNIT_DIR/$MOOTRD" "$PREMOVE/units/$MOOTRD.rolled-back-$(date +%s)"
  fi
  if [ "$(kind "$UNIT_DIR/$STAMD")" = absent ] && [ "$(kind "$PREMOVE/units/$STAMD")" = file ]; then
    run cp -- "$PREMOVE/units/$STAMD" "$UNIT_DIR/$STAMD"
  fi
  if [ "$s" = symlink ]; then
    [ "$(readlink -- "$OLD")" = mootr ] || die "$OLD is a symlink to $(readlink -- "$OLD"), not mootr; not touching it"
    run rm -- "$OLD"
    s=absent
  fi
  if [ "$s" = absent ] && [ "$m" = dir ]; then
    run mv -T -- "$NEW" "$OLD"
  fi
  restore_timers
  sc daemon-reload
  sc enable --now "$STAMD"
  while read -r t en _; do
    [ -n "$t" ] && [ "$en" = 1 ] && sc enable "$t"
  done <<EOF
$(timers_list)
EOF
  if ! wait_health; then
    release_locks
    die "stamd didn't answer health on the old path after the rollback. deploy-hold stays in place and the timers stay stopped, so nothing deploys onto it; fix it by hand, then run --rollback again"
  fi
  release_locks
  start_timers
  drop_hold
  archive_premove_state
  say "rollback done"
}

main_move() {
  # --- Step 0: preconditions (nothing changes here) ---
  say "step 0: preconditions"
  [ "$(kind "$HOME_ROOT")" = dir ] || die "home $HOME_ROOT is not a dir"
  [ "$(kind "$SHARE")" = dir ] || die "$SHARE is not a dir"
  s=$(kind "$OLD"); m=$(kind "$NEW")
  NC=" Nothing was changed."
  if [ "$s" != dir ] || [ "$(kind "$PREMOVE/progress")" != absent ] || [ "$(kind "$PREMOVE/hold-made")" != absent ]; then
    NC=" An earlier run already changed things (see $PREMOVE); fix this and rerun, or run --rollback."
  fi
  if [ "$m" = dir ] && [ "$s" = dir ]; then die "$NEW already exists as a real dir beside a real $OLD; not moving.$NC"; fi
  if [ "$m" = file ] || [ "$m" = other ]; then die "$NEW exists and isn't a dir.$NC"; fi
  # mootr is a real dir this script moves stam to, never a link: a link, even a dangling one, would let mootrd start on another
  # tree while the DB stays in stam. (The link this script makes is stam -> mootr.)
  if [ "$m" = symlink ]; then die "$NEW is a symlink (to $(readlink -- "$NEW")); refusing, the move needs a real dir there.$NC"; fi
  if [ "$s" = absent ] && [ "$m" = absent ]; then die "neither $OLD nor $NEW exists.$NC"; fi
  if [ "$s" = file ] || [ "$s" = other ]; then die "$OLD exists and isn't a dir or symlink.$NC"; fi
  # Step 2 derives mootrd.service from the old stamd.service, a regular file (or the copy a first run kept in premove/units): a
  # hand-made layout without one fails here, before the freeze, not at Step 2 with the timers stopped and the hold made.
  if [ "$s" = dir ] && [ "$(kind "$UNIT_DIR/$STAMD")" != file ] && [ "$(kind "$PREMOVE/units/$STAMD")" != file ]; then
    die "$UNIT_DIR/$STAMD is not a regular file (it is $(kind "$UNIT_DIR/$STAMD")), and there is none in $PREMOVE/units to base $MOOTRD on.$NC"
  fi
  if [ "$s" = symlink ]; then
    [ "$(readlink -- "$OLD")" = mootr ] && [ "$m" = dir ] || die "$OLD is a symlink that isn't to a real $NEW.$NC"
  fi
  d=$(cur_dir)
  require_release_caps "$d"
  check_stale_agents "$d"
  show_harness_cwds
  parent_dev=$(devof "$SHARE")
  if [ "$(devof "$d")" != "$parent_dev" ]; then die "$d is on another filesystem than $SHARE (a mount boundary); mv would copy.$NC"; fi
  other=$(find "$d" -mindepth 1 -type d -printf '%D\n' 2>/dev/null | sort -u | grep -vx "$parent_dev" || true)
  [ -z "$other" ] || die "a dir inside $d is on another filesystem (a mount boundary).$NC"
  lock_check "$d/releases/.flock"
  lock_check "$d/full-suite.lock"
  lock_check "$d/gate.lock"
  if [ "$(legacy_state "$d/releases/.lock")" = held ]; then die "$d/releases/.lock names a live process; an older deploy is running.$NC"; fi
  hk=$(kind "$d/deploy-hold")
  if [ "$hk" = dir ] || [ "$hk" = other ]; then die "$d/deploy-hold can't be created: something that isn't a file is there.$NC"; fi
  if [ "$hk" = absent ] && [ ! -w "$d" ]; then die "$d/deploy-hold can't be created: $d isn't writable.$NC"; fi
  # Backup room: the db files and settings, once, with 20% margin; the whole dir is never copied.
  need=0
  for f in "$d"/stam.db* "$d"/settings*.json; do
    [ -f "$f" ] || continue
    sz=$(stat -c %s -- "$f"); need=$((need + sz))
  done
  need_k=$((need / 1024 * 12 / 10 + 1))
  mkdir_probe=$HOME_ROOT
  [ "$(kind "$PREMOVE")" = absent ] || mkdir_probe=$PREMOVE
  avail_k=$(df -Pk -- "$mkdir_probe" | awk 'NR==2 {print $4}')
  [ "${avail_k:-0}" -gt "$need_k" ] || die "not enough disk for the backup: need about ${need_k} KB, have ${avail_k:-0} KB.$NC"

  if [ "$s" = symlink ] && [ "$(kind "$UNIT_DIR/$MOOTRD")" = file ] && [ "$(kind "$UNIT_DIR/$STAMD")" != file ] &&
    step_done step6 && unit_active "$MOOTRD"; then
    say "already moved: $OLD -> mootr, $MOOTRD installed and active"
    wait_health || die "already moved, but health fails; run with --rollback to go back"
    # A run that stopped in step 7, or left a failed restart, finishes it here; restarts the daemon accepted are skipped.
    if ! step_done step7; then restart_agents; fi
    say "already done"
    return 0
  fi

  # --- Step 1: freeze ---
  say "step 1: freeze"
  if [ "$(kind "$PREMOVE/timers")" = absent ]; then
    rec=""
    for t in $(timer_units); do
      en=0; ac=0
      if $SYSTEMCTL is-enabled --quiet "$t" 2>/dev/null; then en=1; fi
      if unit_active "$t"; then ac=1; fi
      rec="$rec$t $en $ac
"
    done
    if [ "$DRY" = 1 ]; then DRY_TIMERS=$rec; printf 'would: record timers (name enabled active):\n%s' "$rec"
    else mkdir -p "$PREMOVE" && printf '%s' "$rec" >"$PREMOVE/timers"; fi
  fi
  freeze "$d"
  mark_step step1
  if [ -n "$STALE_REC" ]; then mark_step "$STALE_REC"; fi

  # --- Step 2: install the unit ---
  say "step 2: install $MOOTRD"
  if [ "$(kind "$UNIT_DIR/$STAMD")" = file ] && [ "$(kind "$PREMOVE/units/$STAMD")" = absent ]; then
    run cp -- "$UNIT_DIR/$STAMD" "$PREMOVE/units/$STAMD"
  fi
  src=$UNIT_DIR/$STAMD
  [ "$(kind "$src")" = file ] || src=$PREMOVE/units/$STAMD
  [ "$(kind "$src")" = file ] || die "no $STAMD to base $MOOTRD on (looked in $UNIT_DIR and $PREMOVE/units)"
  if [ "$(kind "$UNIT_DIR/$MOOTRD")" = absent ]; then
    if [ "$DRY" = 1 ]; then echo "would: write $UNIT_DIR/$MOOTRD from $src (data path, Alias=$STAMD, MOOTR_NODE, log under $NEW)"; else
      derive_daemon_unit "$src" "$UNIT_DIR/$MOOTRD"
      echo "+ wrote $UNIT_DIR/$MOOTRD"
    fi
  else
    say "$UNIT_DIR/$MOOTRD already installed"
  fi
  mark_step step2

  # --- Step 3: stop, back up, move, link ---
  say "step 3: stop, back up, move"
  # Once mootrd carries the alias, stamd.service names mootrd: only the old unit file, a regular file, is stamd.
  if [ "$(kind "$UNIT_DIR/$STAMD")" = file ] && unit_active "$STAMD"; then sc stop "$STAMD"; fi
  if [ "$DRY" != 1 ] && [ "$(kind "$UNIT_DIR/$STAMD")" = file ] && unit_active "$STAMD"; then die "$STAMD is still active after stop; not touching the data dir"; fi
  # The daemon is stopped only before the move; never copy a DB a running daemon writes.
  if [ "$(kind "$OLD")" = dir ]; then
    for f in "$d"/stam.db* "$d"/settings*.json; do
      [ -f "$f" ] || continue
      b=$PREMOVE/backup/$(basename "$f")
      if [ "$(kind "$b")" = absent ]; then run cp -p -- "$f" "$b"
      elif ! cmp -s -- "$f" "$b"; then run cp -p -- "$f" "$b.$(date +%s)"
      fi
    done
  fi
  if [ "$(kind "$OLD")" = dir ] && [ "$(kind "$NEW")" = absent ]; then
    run mv -T -- "$OLD" "$NEW"
  fi
  if [ "$DRY" = 1 ] || [ "$(kind "$OLD")" = absent ]; then
    run ln -s mootr "$OLD"
  fi
  mark_step step3

  # --- Step 4: start and health ---
  say "step 4: start $MOOTRD"
  if ! start_new; then
    say "the start or the health check failed after the move"
    rollback
    die "the move failed its health check and was rolled back to $STAMD on $OLD"
  fi
  mark_step step4
  release_locks

  # --- Step 5: timers ---
  say "step 5: replace the timers"
  replace_timers
  mark_step step5

  # --- Step 6: unfreeze ---
  say "step 6: unfreeze"
  start_timers new
  drop_hold
  mark_step step6
  say "moved: $OLD -> mootr; $MOOTRD runs; old unit files are in $PREMOVE/units"

  # --- Step 7: restart the agents under the old path (health passed; never fails the move) ---
  restart_agents
}

if [ "$ROLLBACK" = 1 ]; then rollback; else main_move; fi
