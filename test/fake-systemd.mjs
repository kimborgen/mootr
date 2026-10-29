// A shared fake `systemctl --user` and `curl` for tests (S-3382). They keep every bit of state in a test's temp dir and never
// reach the real user systemd or a live daemon. Model the unit state real systemd has, since a fake that skipped it let five
// review rounds of S-3351 find bugs the tests missed:
//
// - Unit files live in the unit dir (`units`). `enable` reads [Install] there: each WantedBy=/RequiredBy= target gets a
//   TARGET.wants/UNIT (or .requires) symlink, and each Alias= gets UNITDIR/ALIAS -> UNIT. Enabling over an alias name that is a
//   regular file, or a symlink to another unit, fails. `disable` removes the wants, requires and alias symlinks to the unit. A unit
//   with no [Install] section is static: enable warns and changes nothing. enable and disable of a unit with no file fail (exit 1).
// - An alias name (a symlink in the unit dir) resolves to its unit for every command, as stamd.service does to mootrd.service.
//   A name with no unit type is a service (`mootrd` is mootrd.service). Options may come before the verb (`--user start X`); an
//   option or a verb the fake doesn't model fails with exit 1, so a call it can't answer never passes silently.
// - `is-enabled`: enabled 0, static 0, alias 0, disabled 1, not-found 4. `is-active`: active 0, any other state 3, an unknown
//   unit 4. `show -p ActiveState --value UNIT` prints the state. `--quiet` prints nothing.
// - `start` loads the unit (see daemon-reload) and makes it active. A Type=oneshot unit stays `activating` until the test marks it
//   done (`finish`), then turns inactive; a start never blocks, as with --no-block. `slowStart(unit, n)` keeps the next start
//   `activating` for n state queries (is-active, show, and the fake curl's requests count), then active. `stop` makes it inactive;
//   `restart` is stop then start. `start` of a unit with no file and nothing loaded fails with exit 5.
// - `daemon-reload` loads every unit file in the unit dir. Until then a start uses the copy loaded before (and warns that the file
//   changed on disk); a unit never loaded is loaded from disk on first use, as systemd does. `runningConfig(unit)` returns the text
//   the running instance started from, so a test can tell whether a changed file took effect.
//
// The fake curl answers as the daemon would: while no daemon unit (`daemonUnits`, default mootrd.service and stamd.service) is
// active, every request fails like a refused connection (code 000, exit 7); while one is activating it is down too. Once one is
// active it answers each path with `http(path, {code, body})` (default 200 and an empty body), or 503 for every path while that
// unit is marked `unhealthy(unit)`. It honours -o (body to a file or /dev/null) and -w (with %{http_code} and \n), reads a -K -
// config from stdin into `curl-stdin`, and appends each URL to `curl-urls`.
//
// API: `const sd = fakeSystemd(dir, { units, daemonUnits })` writes `dir/bin/systemctl` and `dir/bin/curl` and the state dir
// `dir/sc`; `sd.env` is the env both need (FAKE_SC, FAKE_UNITS, FAKE_DAEMON_UNITS). Then:
//   sd.systemctl, sd.curl                                  the paths of the two fakes
//   sd.run(...args) -> { status, stdout, stderr }          run the fake systemctl with `args`
//   sd.state(unit), sd.isActive(unit), sd.isEnabled(unit)  read state (isEnabled: a wants/requires symlink names this exact unit)
//   sd.setState(unit, value)                               force ActiveState (active, activating, failed, or any string)
//   sd.running(unit, polls?)                               a oneshot in flight: activating, and done after `polls` queries if given
//   sd.finish(unit)                                        a oneshot in flight ends now (inactive) or a slow start ends (active)
//   sd.slowStart(unit, polls), sd.unhealthy(unit), sd.http(path, { code, body })
//   sd.enable(unit), sd.start(unit)                        set up state through the fake itself
//   sd.runningConfig(unit), sd.log()                       the text the running unit started from; every call, one per line
//   sd.failOn('ARGS')                                      that exact call (args joined by spaces) fails with exit 1
// Hooks for one test file's needs: `dir/sc/log-extra.sh` is sourced for each call and what it prints is appended to that call's
// log line; `dir/sc/on-call.sh` is sourced after each call is applied, with the command in $cmd and its arguments in $@. The env
// FAKE_FAIL="ARGS" works like failOn.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SYSTEMCTL = String.raw`#!/bin/sh
sc=$FAKE_SC
ud=$FAKE_UNITS
extra=""
[ -f "$sc/log-extra.sh" ] && extra=" $(. "$sc/log-extra.sh")"
echo "$*$extra" >>"$sc/log"
if [ -n "$FAKE_FAIL" ] && [ "$FAKE_FAIL" = "$*" ]; then echo "fake failure: $*" >&2; exit 1; fi
if [ -f "$sc/fail" ] && grep -qxF -- "$*" "$sc/fail"; then echo "fake failure: $*" >&2; exit 1; fi

# An alias name is a symlink in the unit dir; it resolves to the unit it names.
res() { if [ -L "$ud/$1" ]; then basename "$(readlink "$ud/$1")"; else echo "$1"; fi; }
has_file() { [ -f "$ud/$1" ]; }
state() { if [ -f "$sc/state/$1" ]; then cat "$sc/state/$1"; else echo inactive; fi; }
setst() { if [ "$2" = inactive ]; then rm -f "$sc/state/$1"; else echo "$2" >"$sc/state/$1"; fi; }
oneshot() { f=$sc/loaded/$1; [ -f "$f" ] || f=$ud/$1; grep -qx 'Type=oneshot' "$f" 2>/dev/null; }
# The end of an activating unit: a oneshot run is over (inactive), a slow start is up (active).
done_() { if oneshot "$1"; then setst "$1" inactive; else setst "$1" active; fi; rm -f "$sc/finish/$1"; }
# $sc/finish/UNIT counts the state queries left before an activating unit is done.
tick() {
  f=$sc/finish/$1
  [ -f "$f" ] || return 0
  n=$(($(cat "$f") - 1))
  if [ "$n" -le 0 ]; then done_ "$1"; else echo "$n" >"$f"; fi
}
# Loads a unit on first use; a loaded copy that differs from the file stays until daemon-reload.
load() {
  if [ -f "$sc/loaded/$1" ]; then
    if ! has_file "$1" || ! cmp -s "$ud/$1" "$sc/loaded/$1"; then
      echo "Warning: The unit file, source configuration file or drop-ins of $1 changed on disk. Run 'systemctl --user daemon-reload' to reload units." >&2
    fi
    return 0
  fi
  has_file "$1" || return 1
  cp "$ud/$1" "$sc/loaded/$1"
}
install_keys() { sed -n "/^\[Install\]/,/^\[/{s/^$1=//p}" "$ud/$2" | tr ' ' '\n' | sed '/^$/d'; }
start_() {
  load "$1" || { echo "Failed to start $1: Unit $1 not found." >&2; return 5; }
  cp "$sc/loaded/$1" "$sc/running/$1"
  if [ -f "$sc/slow/$1" ]; then mv "$sc/slow/$1" "$sc/finish/$1"; setst "$1" activating
  elif oneshot "$1"; then setst "$1" activating
  else setst "$1" active; fi
}
stop_() { setst "$1" inactive; rm -f "$sc/finish/$1" "$sc/running/$1"; }
enable_() {
  u=$(res "$1")
  has_file "$u" || { echo "Failed to enable unit: Unit file $u does not exist." >&2; return 1; }
  w=$(install_keys WantedBy "$u"); r=$(install_keys RequiredBy "$u"); a=$(install_keys Alias "$u")
  if [ -z "$w$r$a" ]; then
    echo "The unit files have no installation config (WantedBy=, RequiredBy=, Alias= settings in the [Install] section)." >&2
    return 0
  fi
  for x in $a; do
    if [ -L "$ud/$x" ]; then
      [ "$(basename "$(readlink "$ud/$x")")" = "$u" ] || { echo "Failed to enable unit: File $ud/$x already exists and is a symlink to $(readlink "$ud/$x")." >&2; return 1; }
    elif [ -e "$ud/$x" ]; then echo "Failed to enable unit: File $ud/$x already exists." >&2; return 1; fi
  done
  # An alias in the unit's own dir is a relative link, as systemd makes it.
  for x in $a; do [ -L "$ud/$x" ] || { ln -s "$u" "$ud/$x"; echo "Created symlink $ud/$x -> $u." >&2; }; done
  for t in $w; do mkdir -p "$ud/$t.wants"; [ -L "$ud/$t.wants/$u" ] || ln -s "$ud/$u" "$ud/$t.wants/$u"; done
  for t in $r; do mkdir -p "$ud/$t.requires"; [ -L "$ud/$t.requires/$u" ] || ln -s "$ud/$u" "$ud/$t.requires/$u"; done
  return 0
}
disable_() {
  u=$(res "$1")
  has_file "$u" || { echo "Failed to disable unit: Unit file $u does not exist." >&2; return 1; }
  for l in "$ud"/* "$ud"/*.wants/* "$ud"/*.requires/*; do
    [ -L "$l" ] && [ "$(basename "$(readlink "$l")")" = "$u" ] && { rm -f "$l"; echo "Removed $l." >&2; }
  done
  return 0
}
enabled_() { for l in "$ud"/*.wants/"$1" "$ud"/*.requires/"$1"; do [ -L "$l" ] && return 0; done; return 1; }

quiet=0; now=0; prop=""; args=""; cmd=""
# Options may come before the verb (systemctl --user start X), as with the real one; an option it doesn't model is refused.
for a in "$@"; do
  if [ "$prop" = next ]; then prop=$a; continue; fi
  case $a in
    --quiet|-q) quiet=1 ;;
    --now) now=1 ;;
    --value|--user|--no-block|--no-pager) ;;
    -p) prop=next ;;
    -*) echo "fake systemctl: option $a is not modelled" >&2; exit 1 ;;
    *) if [ -z "$cmd" ]; then cmd=$a
      # A name with no unit type is a service, as systemctl reads it.
      else case $a in *.*) args="$args $a" ;; *) args="$args $a.service" ;; esac; fi ;;
  esac
done
case $cmd in
  is-active|show|is-enabled|start|stop|restart|enable|disable|daemon-reload|reset-failed) ;;
  "") echo "fake systemctl: no command given" >&2; exit 1 ;;
  *) echo "Unknown command verb '$cmd'." >&2; exit 1 ;;
esac
set -- $args
rc=0
case $cmd in
  is-active)
    u=$(res "$1"); tick "$u"; s=$(state "$u")
    [ $quiet = 1 ] || echo "$s"
    if [ "$s" = active ]; then rc=0; elif has_file "$u" || [ -f "$sc/loaded/$u" ] || [ -f "$sc/state/$u" ]; then rc=3; else rc=4; fi ;;
  show)
    u=$(res "$1"); tick "$u"
    case $prop in ActiveState) state "$u" ;; *) echo "fake systemctl: show -p $prop is not modelled" >&2; rc=1 ;; esac ;;
  is-enabled)
    if [ -L "$ud/$1" ]; then s=alias
    elif ! has_file "$1"; then s=not-found
    elif enabled_ "$1"; then s=enabled
    elif [ -z "$(install_keys WantedBy "$1")$(install_keys RequiredBy "$1")$(install_keys Alias "$1")" ]; then s=static
    else s=disabled; fi
    [ $quiet = 1 ] || echo "$s"
    case $s in enabled|static|alias) rc=0 ;; not-found) rc=4 ;; *) rc=1 ;; esac ;;
  start) for x; do start_ "$(res "$x")" || rc=$?; done ;;
  stop) for x; do stop_ "$(res "$x")"; done ;;
  restart) for x; do u=$(res "$x"); stop_ "$u"; start_ "$u" || rc=$?; done ;;
  enable) for x; do enable_ "$x" || rc=$?; [ $rc = 0 ] && [ $now = 1 ] && { start_ "$(res "$x")" || rc=$?; }; done ;;
  disable) for x; do disable_ "$x" || rc=$?; [ $now = 1 ] && stop_ "$(res "$x")"; done ;;
  daemon-reload)
    rm -f "$sc"/loaded/*
    for f in "$ud"/*; do [ -f "$f" ] && [ ! -L "$f" ] && cp "$f" "$sc/loaded/$(basename "$f")"; done ;;
  reset-failed) for x; do u=$(res "$x"); [ "$(state "$u")" = failed ] && setst "$u" inactive; done ;;
esac
[ -f "$sc/on-call.sh" ] && . "$sc/on-call.sh"
exit $rc
`;

const CURL = String.raw`#!/bin/sh
sc=$FAKE_SC
out=""; fmt=""; cfg=0; url=""
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift ;;
    -w) fmt=$2; shift ;;
    -K) [ "$2" = - ] && cfg=1; shift ;;
    -m|-H|-X|-d) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
[ $cfg = 1 ] && cat >"$sc/curl-stdin"
echo "$url" >>"$sc/curl-urls"
path=/$(echo "$url" | sed 's#^[a-z]*://[^/]*/##; s#?.*##')
res() { if [ -L "$FAKE_UNITS/$1" ]; then basename "$(readlink "$FAKE_UNITS/$1")"; else echo "$1"; fi; }
# The daemon's state, as a request sees it: each request counts as a state query of a starting daemon.
up=""; seen=" "
for d in $FAKE_DAEMON_UNITS; do
  u=$(res "$d")
  # An alias of a unit already counted (stamd.service -> mootrd.service) is the same daemon.
  case $seen in *" $u "*) continue ;; esac
  seen="$seen$u "
  f=$sc/finish/$u
  if [ -f "$f" ]; then
    n=$(($(cat "$f") - 1))
    if [ "$n" -le 0 ]; then echo active >"$sc/state/$u"; rm -f "$f"; else echo "$n" >"$f"; fi
  fi
  [ "$(cat "$sc/state/$u" 2>/dev/null)" = active ] && { up=$u; break; }
done
emit() { [ -n "$fmt" ] && printf "$(printf '%s' "$fmt" | sed "s/%{http_code}/$1/g")"; return 0; }
if [ -z "$up" ]; then emit 000; exit 7; fi
key=$(echo "$path" | tr / _)
code=200
[ -f "$sc/http/$key.code" ] && code=$(cat "$sc/http/$key.code")
[ -f "$sc/unhealthy/$up" ] && code=503
body=""
[ -f "$sc/http/$key.body" ] && body=$sc/http/$key.body
if [ -z "$out" ]; then [ -n "$body" ] && [ "$code" = 200 ] && cat "$body"
elif [ "$out" != /dev/null ]; then if [ -n "$body" ]; then cp "$body" "$out"; else : >"$out"; fi; fi
emit "$code"
exit 0
`;

export function fakeSystemd(dir, { units = join(dir, 'units'), daemonUnits = ['mootrd.service', 'stamd.service'] } = {}) {
  const sc = join(dir, 'sc');
  const bin = join(dir, 'bin');
  for (const d of ['state', 'finish', 'slow', 'loaded', 'running', 'unhealthy', 'http'].map((s) => join(sc, s)).concat(bin, units)) mkdirSync(d, { recursive: true });
  for (const [f, body] of [['systemctl', SYSTEMCTL], ['curl', CURL]]) {
    writeFileSync(join(bin, f), body);
    chmodSync(join(bin, f), 0o755);
  }
  const env = { FAKE_SC: sc, FAKE_UNITS: units, FAKE_DAEMON_UNITS: daemonUnits.join(' ') };
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const systemctl = (...args) => {
    const r = spawnSync(join(bin, 'systemctl'), args, { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const ok = (r, what) => { if (r.status !== 0) throw new Error(`fake systemctl ${what} failed: ${r.stderr}`); };
  const state = (u) => read(join(sc, 'state', u)).trim() || 'inactive';
  const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
  const linkTo = (p, u) => isLink(p) && readlinkSync(p).split('/').pop() === u;
  return {
    dir, sc, bin, units, env,
    systemctl: join(bin, 'systemctl'),
    curl: join(bin, 'curl'),
    run: systemctl,
    state,
    isActive: (u) => state(u) === 'active',
    isEnabled: (u) => {
      if (!existsSync(units)) return false;
      return readdirSync(units).filter((d) => /\.(wants|requires)$/.test(d)).some((d) => linkTo(join(units, d, u), u));
    },
    setState: (u, v) => (v === 'inactive' ? rmSync(join(sc, 'state', u), { force: true }) : writeFileSync(join(sc, 'state', u), `${v}\n`)),
    running: (u, polls) => {
      writeFileSync(join(sc, 'state', u), 'activating\n');
      if (polls) writeFileSync(join(sc, 'finish', u), String(polls));
    },
    finish: (u) => {
      // Ends whatever is activating: a oneshot in flight goes inactive, a slow start goes active.
      const f = join(units, u);
      const oneshot = existsSync(f) && /^Type=oneshot$/m.test(readFileSync(f, 'utf8'));
      rmSync(join(sc, 'finish', u), { force: true });
      if (oneshot) rmSync(join(sc, 'state', u), { force: true });
      else writeFileSync(join(sc, 'state', u), 'active\n');
    },
    slowStart: (u, polls) => writeFileSync(join(sc, 'slow', u), String(polls)),
    unhealthy: (u, on = true) => (on ? writeFileSync(join(sc, 'unhealthy', u), '') : rmSync(join(sc, 'unhealthy', u), { force: true })),
    http: (path, { code, body } = {}) => {
      const key = path.replaceAll('/', '_');
      if (code === undefined) rmSync(join(sc, 'http', `${key}.code`), { force: true });
      else writeFileSync(join(sc, 'http', `${key}.code`), String(code));
      if (body !== undefined) writeFileSync(join(sc, 'http', `${key}.body`), body);
    },
    enable: (u) => ok(systemctl('enable', u), `enable ${u}`),
    start: (u) => ok(systemctl('start', u), `start ${u}`),
    runningConfig: (u) => (existsSync(join(sc, 'running', u)) ? readFileSync(join(sc, 'running', u), 'utf8') : null),
    log: () => read(join(sc, 'log')),
    failOn: (call) => writeFileSync(join(sc, 'fail'), `${read(join(sc, 'fail'))}${call}\n`),
  };
}
