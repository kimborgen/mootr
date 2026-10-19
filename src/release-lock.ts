// The deploy lock: one deploy, rollback, prune or canary-bisection cleanup at a time (S-1750). Every caller takes it
// here. It is two locks, taken in order:
// - A kernel lock, flock(1) on releases/.flock, a file nothing deletes. The caller's own process opens it and hands that
//   descriptor to `flock -n 3`, which locks it and exits; the lock belongs to the open file, so it stays held while the
//   caller keeps the descriptor open, and goes when the caller closes it or dies. No child holds it, so none can lose it.
//   Node opens files close-on-exec, so the caller's builds and services never inherit it.
// - The pid-file lock on releases/.lock that releases before this one take (origin/main's deploy.ts lock()), with that
//   same protocol, so old and new code still exclude each other: a live pid in it means held; a dead pid is taken over,
//   and so is an empty one once it is 5 s old (younger, old code may not have written its pid yet). It is judged from
//   one descriptor's view, and any change after the read counts as held. Under the flock only
//   one new caller does that at a time. Its pid is the holder the messages name. Old code that read a dead pid can
//   still delete a new holder's .lock; main has that race among old callers too (S-1936).
// Without flock(1) taking the lock throws: it fails closed.
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, linkSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// flock's status when the lock is held (-E), as in scripts/gate.mjs.
const HELD = 75;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const legacy = (dir: string): string => join(dir, '.lock');
const readPid = (dir: string): number => {
  try {
    return Number(readFileSync(legacy(dir), 'utf8').trim());
  } catch {
    return 0;
  }
};

// The pid holding the lock in `dir`, from releases/.lock, or undefined.
export function lockHolder(dir: string): number | undefined {
  const pid = readPid(dir);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// Creates releases/.lock already holding our pid (a hard link of a written temp file), so old code never reads it empty.
// False when it exists.
function createLegacy(dir: string): boolean {
  const tmp = join(dir, `.lock.${process.pid}.tmp`);
  writeFileSync(tmp, String(process.pid));
  try {
    linkSync(tmp, legacy(dir));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// An empty releases/.lock younger than this may be old code between its `wx` create and its pid write: held.
const EMPTY_GRACE_MS = 5000;

// Whether an existing releases/.lock is stale, from one view of it: one descriptor's fstat and read, then the same
// fstat again, and the path's stat, after `afterRead` (a hook, for tests). It is stale when its pid is dead, or when it
// is empty and EMPTY_GRACE_MS old. Any change after the read (a pid written, the file replaced) means held. When it is
// gone there is nothing to remove: the next create decides.
function legacyState(dir: string, afterRead?: () => void): 'held' | 'stale' | 'gone' {
  let fd: number;
  try {
    fd = openSync(legacy(dir), 'r');
  } catch {
    return 'gone';
  }
  try {
    const before = fstatSync(fd);
    const text = readFileSync(fd, 'utf8');
    afterRead?.();
    const after = fstatSync(fd);
    let path;
    try {
      path = statSync(legacy(dir));
    } catch {
      return 'gone';
    }
    if (text.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || path.ino !== after.ino) return 'held';
    const pid = Number(text.trim());
    if (pid) return alive(pid) ? 'held' : 'stale';
    return text !== '' || Date.now() - before.mtimeMs >= EMPTY_GRACE_MS ? 'stale' : 'held';
  } finally {
    closeSync(fd);
  }
}

// Takes releases/.lock as origin/main's lock() does: create it, else take it over once if it is stale. `afterRead` is
// legacyState()'s hook, for tests.
function takeLegacy(dir: string, afterRead?: () => void): boolean {
  for (let i = 0; i < 2; i++) {
    if (createLegacy(dir)) return true;
    const state = legacyState(dir, afterRead);
    if (state === 'held') return false;
    if (state === 'stale') rmSync(legacy(dir), { force: true });
  }
  return false;
}

export type Unlock = () => Promise<void>;

// Takes the lock in `dir` (which must exist) without waiting. Resolves with its release, or undefined when another
// holder has it, new code or old. Rejects when flock(1) is missing or fails, or releases/.lock can't be written. `flock`
// names the binary, and `afterRead` runs between reading an existing releases/.lock and checking it again, for tests.
export async function tryLock(dir: string, { flock = 'flock', afterRead }: { flock?: string; afterRead?: () => void } = {}): Promise<Unlock | undefined> {
  const fd = openSync(join(dir, '.flock'), 'a');
  const r = spawnSync(flock, ['-n', '-E', String(HELD), '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8' });
  if (r.status !== 0) {
    closeSync(fd);
    if (r.status === HELD) return undefined;
    if (r.error) throw new Error(`can't take the deploy lock: ${flock} (flock(1)) is not available: ${r.error.message}`);
    throw new Error(`can't take the deploy lock: ${flock} exited ${r.status ?? r.signal}: ${r.stderr.trim()}`);
  }
  let legacyHeld: boolean;
  try {
    legacyHeld = takeLegacy(dir, afterRead);
  } catch (e) {
    closeSync(fd);
    throw new Error(`can't take the deploy lock: can't write ${legacy(dir)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!legacyHeld) {
    closeSync(fd);
    return undefined;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      if (readPid(dir) === process.pid) rmSync(legacy(dir), { force: true });
    } finally {
      closeSync(fd);
    }
  };
}
