// The lock a deps cache root shares between its consumers and its pruners (S-1965). A consumer links an entry
// (`cp -al`) under a shared flock; a pruner takes the exclusive lock, or skips, so an entry is never removed
// between a consumer's check and its link. One lock file per cache root: ROOT/.prune.lock, which nothing deletes.
// A missing flock(1) means a consumer links without the lock and a pruner prunes nothing.
// The consumer reads GONE (refill and retry), NODEPS (nothing to link) or 0 from the one operation; it checks nothing
// else outside the lock.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_NAME = '.prune.lock';
// The status a link exits with when the entry is gone (no .ready) by the time it holds the lock.
export const GONE = 75;
// The status when the entry exists but holds no node_modules: a package with no dependencies.
export const NODEPS = 76;

// One shared-lock operation: the entry's classification (node_modules, or .ready without it, or neither), the hard
// link, and the copy fallback (a link across filesystems fails with EXDEV) all run under `flock -s`, so the pruner
// can't remove or replace the entry between any two of them.
//   flock -s LOCK sh -c 'classify ENTRY; link ENTRY/node_modules TARGET || { rm -rf TARGET; cp -a ... TARGET; }'
// STAM_DEPS_LINK (default `cp -al`) names the link command; a test sets it to a failing one for the EXDEV path.
const SCRIPT = `if [ ! -e "$1/node_modules" ]; then [ -e "$1/.ready" ] && exit ${NODEPS}; exit ${GONE}; fi; \${STAM_DEPS_LINK:-cp -al} "$1/node_modules" "$2" && exit 0; rm -rf "$2"; exec cp -a "$1/node_modules" "$2"`;
const linkArgv = (root, entry, target) => ['flock', '-s', join(root, LOCK_NAME), 'sh', '-c', SCRIPT, 'sh', entry, target];
const plainArgv = (entry, target) => ['sh', '-c', SCRIPT, 'sh', entry, target];

// Links ENTRY's node_modules to TARGET under the root's shared lock. Returns the exit status: 0 linked (or copied),
// NODEPS for a filled entry with no node_modules, GONE when the entry vanished, another number when both the link and
// the copy failed.
export function linkLocked(root, entry, target) {
  const [cmd, ...args] = linkArgv(root, entry, target);
  const r = spawnSync(cmd, args);
  if (r.error?.code === 'ENOENT') {
    const [pc, ...pa] = plainArgv(entry, target);
    return spawnSync(pc, pa).status ?? 1;
  }
  return r.status ?? 1;
}

// The same, async, so a daemon request doesn't stall the event loop. Resolves to the exit status.
export function linkLockedAsync(root, entry, target) {
  const run = (cmd, args, fallback) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', (e) => (fallback && e.code === 'ENOENT' ? resolve(fallback()) : resolve(1)));
      child.on('close', (code) => resolve(code ?? 1));
    });
  const [cmd, ...args] = linkArgv(root, entry, target);
  const [pc, ...pa] = plainArgv(entry, target);
  return run(cmd, args, () => run(pc, pa));
}

// Takes the root's exclusive lock without waiting. Returns { release } or null when a consumer holds it, flock is
// missing, or the lock file can't be opened: the caller then prunes nothing. The lock belongs to the open file,
// so it stays held until release() closes the descriptor (as the deploy lock does, src/release-lock.ts).
export function tryExclusive(root) {
  let fd;
  try {
    fd = openSync(join(root, LOCK_NAME), 'a');
  } catch {
    return null;
  }
  const r = spawnSync('flock', ['-n', '-x', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
  if (r.status !== 0) {
    closeSync(fd);
    return null;
  }
  return { release: () => closeSync(fd) };
}
