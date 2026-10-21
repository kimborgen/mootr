// The scratch homes of the deploy check (check() in src/deploy.ts) and their sweep (S-2573). A home is a
// `stam-check-*` folder directly under a root: the check root on disk, where new homes go (the temp dir may be a small
// tmpfs, and a full one stopped the deploy that carried its own fix), or the temp dir, where earlier ones leaked.
// Only node built-ins are imported, so `node scripts/check-homes.mjs --sweep` runs from a fresh tree before any install.
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { envVar } from '../src/env.ts';
import { isMain } from './main-guard.mjs';

export const CHECK_PREFIX = 'stam-check-';
export const CHECK_HOME_MAX_AGE_MS = 60 * 60 * 1000;

// Where new check homes are made: on disk, outside any git checkout.
export const checkRoot = () => resolve(envVar('CHECK_TMP') || join(homedir(), '.cache', 'stam', 'check'));

// A path without a trailing slash, relative part or symlink, so roots and homes compare equal however they were spelled.
export const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
// Every folder that can hold a check home, normalized.
export const checkRoots = () => [...new Set([checkRoot(), tmpdir()].map(real))];
const gone = (e) => e?.code === 'ENOENT' || e?.code === 'ESRCH';

export const OWNER_FILE = '.owner';

// The start time of a process in clock ticks since boot (field 22 of /proc/PID/stat), which tells a pid's owner from a
// later process that reuses the number. Throws when the process is gone (ENOENT) or can't be read.
export function procStart(pid, proc = '/proc') {
  const stat = readFileSync(`${proc}/${pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[19];
  if (!/^\d+$/.test(start ?? '')) throw new Error(`no start time in ${proc}/${pid}/stat`);
  return start;
}

// Marks a home as in use by the calling check: its pid and that pid's start time. The sweep keeps a home whose owner
// still runs, however old it is. A start time that can't be read throws, so the check fails at its start rather than
// leaving a marker that protects nothing.
export function writeOwner(home, pid = process.pid, proc = '/proc') {
  writeFileSync(join(home, OWNER_FILE), `${pid} ${procStart(pid, proc)}\n`);
}

// Whether the home's check still runs: 'none' (no marker), 'exited' (its owner is gone, or the pid was reused),
// 'running', or 'unsure' with a reason when the marker or the owner can't be read or parsed. Only 'none' and 'exited'
// allow a removal.
function ownerState(home, proc) {
  let text;
  try {
    text = readFileSync(join(home, OWNER_FILE), 'utf8');
  } catch (e) {
    return e?.code === 'ENOENT' ? { state: 'none' } : { state: 'unsure', why: `${OWNER_FILE}: ${e.code ?? e.message}` };
  }
  const m = /^(\d+) (\d+)\n?$/.exec(text);
  if (!m) return { state: 'unsure', why: `${OWNER_FILE} isn't "PID START"` };
  try {
    return procStart(m[1], proc) === m[2] ? { state: 'running' } : { state: 'exited' };
  } catch (e) {
    return gone(e) ? { state: 'exited' } : { state: 'unsure', why: `owner ${m[1]} stat: ${e.code ?? e.message}` };
  }
}

// The homes a live process carries as STAM_HOME in its environment, has as its working directory, or holds a file
// open under. A process that exits while it is read (ENOENT) holds nothing. A process of another user, or one of ours
// that is not dumpable (EACCES or EPERM: systemd --user, a setuid or credential-changing service), is not readable and
// can't be a check's child, which inherits dumpable; it is skipped. Any other failure to look at a process leaves
// `unsure` set with the reason: it might hold any home.
// Throws when the process list itself can't be read.
export function heldHomes(homes, proc = '/proc') {
  const held = new Set();
  const unsure = [];
  const under = (path) => homes.find((h) => path === h || path.startsWith(`${h}/`));
  const note = (what, e) => {
    if (!gone(e) && e?.code !== 'EACCES' && e?.code !== 'EPERM') unsure.push(`${what}: ${e.code ?? e.message}`);
  };
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    const dir = `${proc}/${name}`;
    try {
      if (statSync(dir).uid !== process.getuid()) continue;
    } catch (e) {
      if (!gone(e)) unsure.push(`pid ${name} stat: ${e.code ?? e.message}`);
      continue;
    }
    try {
      for (const kv of readFileSync(`${dir}/environ`, 'utf8').split('\0')) {
        if (!/^(MOOTR|STAM)_HOME=/.test(kv)) continue;
        const v = kv.slice(kv.indexOf('=') + 1);
        const h = under(resolve(v)) ?? under(real(v));
        if (h) held.add(h);
      }
    } catch (e) {
      note(`pid ${name} environ`, e);
    }
    try {
      const h = under(readlinkSync(`${dir}/cwd`));
      if (h) held.add(h);
    } catch (e) {
      note(`pid ${name} cwd`, e);
    }
    try {
      for (const fd of readdirSync(`${dir}/fd`)) {
        try {
          const h = under(readlinkSync(`${dir}/fd/${fd}`));
          if (h) held.add(h);
        } catch (e) {
          note(`pid ${name} fd ${fd}`, e);
        }
      }
    } catch (e) {
      note(`pid ${name} fds`, e);
    }
  }
  return { held, unsure };
}

// Removes the check homes older than an hour (mtime) that no live process holds, one log line each. Only real
// directories directly under a root match; a symlink is never followed. Best-effort: a root that can't be read, or a
// home that goes away or can't be removed, is skipped. When the process list can't be read, or a process of ours can't
// be inspected, nothing is removed and one line says why. Returns the removed paths.
export function sweepCheckHomes({ roots = checkRoots(), now = Date.now(), maxAgeMs = CHECK_HOME_MAX_AGE_MS, log = console.log, proc = '/proc' } = {}) {
  const old = [];
  for (const root of new Set(roots.map(real))) {
    let names;
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(CHECK_PREFIX)) continue;
      const home = join(root, name);
      try {
        const st = lstatSync(home);
        if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) old.push(home);
      } catch {}
    }
  }
  if (!old.length) return [];
  let holders;
  try {
    holders = heldHomes(old, proc);
  } catch (e) {
    log(`deploy: couldn't read the process list (${e.code ?? e.message}), so ${old.length} stale check home(s) were kept`);
    return [];
  }
  if (holders.unsure.length) {
    log(`deploy: couldn't inspect ${holders.unsure.length} process(es) (${holders.unsure[0]}), so ${old.length} stale check home(s) were kept`);
    return [];
  }
  const removed = [];
  for (const home of old) {
    if (holders.held.has(home)) continue;
    const owner = ownerState(home, proc);
    if (owner.state === 'running') continue;
    if (owner.state === 'unsure') {
      log(`deploy: kept stale check home ${home}: ${owner.why}`);
      continue;
    }
    try {
      rmSync(home, { recursive: true, force: true });
      removed.push(home);
      log(`deploy: removed stale check home ${home}`);
    } catch (e) {
      log(`deploy: couldn't remove stale check home ${home}: ${e.message}`);
    }
  }
  return removed;
}

if (isMain(import.meta.url) && process.argv.includes('--sweep')) {
  try {
    sweepCheckHomes();
  } catch (e) {
    console.log(`deploy: check home sweep failed: ${e.message}`);
  }
}
