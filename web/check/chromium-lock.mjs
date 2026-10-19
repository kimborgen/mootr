// One Chromium check at a time on this machine, like test/run.sh's test lock: several at
// once starved the machine of memory. Import this first; it re-runs the script under
// `flock` on /tmp/stam-chromium.lock (or STAM_CHROMIUM_LOCK, a path a test sets for its own lock).
// While it waits it names the holder (from `$LOCK.owner`, written by the check that holds the lock)
// and repeats "still waiting" every minute. Set STAM_CHROMIUM_NOLOCK=1 to skip the lock. The re-run
// sets STAM_CHROMIUM_LOCKED=1, so it doesn't try to lock again.
// STAM_CHROMIUM_PRIORITY=gate (set by scripts/gate.mjs, S-1594) puts a check ahead of other waiters: while it
// waits it keeps a marker `$LOCK.gate.<pid>`, and a waiting check without it holds off until no live marker is
// left (76 is reserved for that; a holder is never pre-empted; one that got the lock first and finds a marker exits 76 and waits again).
// STAM_CHROMIUM_TIMEOUT=SECONDS limits the check itself, counted from when it gets the lock (waiting
// doesn't count); on expiry it exits 124, like `timeout`. Use it, not `timeout N`, around a check,
// which would count the wait too. Unset means no limit.
import { spawn, spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// A check run by hand takes a test slot first (scripts/test-slot.sh, S-692); web/check/run.sh already holds one.
const slot = new URL('../../scripts/test-slot.sh', import.meta.url).pathname;
if (process.env.STAM_CHROMIUM_NOLOCK !== '1' && spawnSync('sh', [slot, '--held']).status !== 0) {
  const r = spawnSync('sh', [slot, process.execPath, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const LOCK = process.env.STAM_CHROMIUM_LOCK || '/tmp/stam-chromium.lock';
const OWNER = `${LOCK}.owner`;
const MINUTE = 60_000;
const TICK = Number(process.env.STAM_CHROMIUM_TICK_MS) || MINUTE; // a test shortens the "still waiting" interval
const POLL = Number(process.env.STAM_CHROMIUM_POLL_MS) || 1000;
const GATE = process.env.STAM_CHROMIUM_PRIORITY === 'gate';
const MARKER = `${LOCK}.gate.`;
const NOLOCK = process.env.STAM_CHROMIUM_NOLOCK === '1';

// The lock holder's owner file, if its pid is still alive; otherwise null.
function holder() {
  try {
    const o = JSON.parse(readFileSync(OWNER, 'utf8'));
    process.kill(o.pid, 0); // throws when the pid is gone
    return o;
  } catch {
    return null;
  }
}

// A pid's start time (field 22 of /proc/PID/stat), so a marker whose pid was reused isn't taken as live; '' off Linux.
function startOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[19] ?? '';
  } catch {
    return '';
  }
}

// Whether a gate check other than WAITER (a pid) is waiting: a marker `$LOCK.gate.<pid>` whose pid is alive.
function gateWaiting(except) {
  try {
    return readdirSync(dirname(LOCK)).some((f) => {
      if (!f.startsWith(basename(MARKER))) return false;
      const pid = Number(f.slice(basename(MARKER).length));
      if (!pid || pid === except) return false;
      try {
        process.kill(pid, 0);
        if (readFileSync(`${dirname(LOCK)}/${f}`, 'utf8') === startOf(pid)) return true;
      } catch {}
      rmSync(`${dirname(LOCK)}/${f}`, { force: true }); // a dead or reused pid left it
      return false;
    });
  } catch {
    return false;
  }
}

function describe(o) {
  const since = new Date(o.start).toTimeString().slice(0, 5);
  return `${o.script} in ${o.cwd} since ${since} (pid ${o.pid})`;
}

if (!NOLOCK && process.env.STAM_CHROMIUM_LOCKED !== '1') {
  const env = { ...process.env, STAM_CHROMIUM_LOCKED: '1' };
  const argv = process.argv.slice(1);
  const flock = (args) => spawnSync('flock', args, { stdio: 'inherit', env });
  // -E 75: exit 75 when the lock is busy, so a check that itself exits 1 isn't mistaken.
  // A gate check marks itself before its first try, so it never loses a round to a plain check in between.
  const marker = `${MARKER}${process.pid}`;
  if (GATE) writeFileSync(marker, startOf(process.pid));
  process.on('exit', () => rmSync(marker, { force: true }));
  let r = flock(['-n', '-E', '75', LOCK, process.execPath, ...argv]);
  if (r.status === 75 || r.status === 76) {
    const started = Date.now();
    const say = (prefix) => {
      const o = holder();
      console.error(o ? `${prefix} the Chromium lock: ${describe(o)}` : `${prefix} another Chromium check...`);
    };
    say('waiting for');
    let tick = setInterval(() => say(`still waiting (${Math.floor((Date.now() - started) / MINUTE)}m) for`), TICK);
    // The locked re-run signals once it holds the lock: the wait is over, so stop the ticker.
    process.on('SIGUSR2', () => clearInterval(tick));
    const wenv = { ...env, STAM_CHROMIUM_WAITER: String(process.pid) };
    // Top-level await: the importing script doesn't run here, only in the locked re-run.
    await new Promise(() => {
      const next = async () => {
        // Behind a waiting gate check: don't compete for the lock until it has had it.
        while (!GATE && gateWaiting(process.pid)) await new Promise((res) => setTimeout(res, POLL));
        spawn('flock', [LOCK, process.execPath, ...argv], { stdio: 'inherit', env: wenv }).on('close', (code) => {
          if (code === 76) return next();
          clearInterval(tick);
          process.exit(code ?? 1);
        });
      };
      next();
    });
  } else {
    // No flock on this machine: run the check anyway, unlocked.
    if (r.error && r.status === null) r = spawnSync(process.execPath, argv, { stdio: 'inherit', env });
    process.exit(r.status ?? 1);
  }
} else {
  // This check runs: it holds the lock (unless NOLOCK) and may have a time limit.
  const waiter = Number(process.env.STAM_CHROMIUM_WAITER) || 0;
  delete process.env.STAM_CHROMIUM_WAITER; // the check's own descendants must not inherit it
  if (!NOLOCK && !GATE && gateWaiting(waiter)) process.exit(76); // a gate check is waiting: give the lock up
  if (waiter) {
    try {
      process.kill(waiter, 'SIGUSR2');
    } catch {}
  }
  if (!NOLOCK) {
    writeFileSync(OWNER, JSON.stringify({ pid: process.pid, script: basename(process.argv[1] || 'node'), cwd: process.cwd(), start: Date.now() }));
    process.on('exit', () => {
      try {
        if (JSON.parse(readFileSync(OWNER, 'utf8')).pid === process.pid) rmSync(OWNER);
      } catch {}
    });
  }
  const limit = Number(process.env.STAM_CHROMIUM_TIMEOUT);
  if (limit > 0) {
    setTimeout(() => {
      console.error(`Chromium check timed out after ${limit}s (STAM_CHROMIUM_TIMEOUT)`);
      process.exit(124);
    }, limit * 1000).unref(); // unref: a check that finishes isn't held open by the timer
  }
}
