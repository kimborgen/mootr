// Whether a flock(1) lock is held, read from /proc/locks (S-3144). A `flock -n LOCK true` probe takes the lock for an
// instant, so a real `flock -n` taker that starts in that instant is refused as busy (S-3130 hit it in a test; full-suite.mjs
// and its queue check did the same in production). This reads the kernel's table and never takes the lock.
// A /proc/locks line is `ID: FLOCK ADVISORY WRITE PID MAJOR:MINOR:INODE START END` (device in hex, inode in decimal); a waiter's
// line has `->` after the ID and is no holder.
import { readFileSync, statSync } from 'node:fs';

const procLocks = () => readFileSync('/proc/locks', 'utf8');

// The device as /proc/locks prints it: major and minor (the kernel's old 8:8-bit split does not apply to st_dev; glibc's major()/minor()).
function devParts(dev) {
  const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn));
  const minor = Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn));
  return [major, minor];
}

// True when a process holds a live FLOCK lock on the file at PATH. A missing file is not held. An unreadable /proc/locks throws:
// answering "free" without looking would hide a held lock. READLOCKS is a seam for tests.
export function lockHeld(path, { readLocks = procLocks } = {}) {
  let st;
  try {
    st = statSync(path, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  const [major, minor] = devParts(st.dev);
  const ino = st.ino;
  for (const line of readLocks().split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[1] !== 'FLOCK') continue; // not FLOCK, or a `->` waiter line (its second field is `->`)
    const m = /^([0-9a-f]+):([0-9a-f]+):(\d+)$/i.exec(f[5] ?? '');
    if (m && parseInt(m[1], 16) === major && parseInt(m[2], 16) === minor && BigInt(m[3]) === ino) return true;
  }
  return false;
}
