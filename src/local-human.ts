// Local human login (S-613): on one machine without Tailscale, the human proves who they are with a one-time
// secret that only their browser holds, vouched for by root. The login page draws a random 128-bit secret S,
// keeps it in memory, and shows N = nameOf(S) (a truncated SHA-256, base32) in the command to run:
// `sudo /usr/bin/install -d -m 755 /run/stam-human /run/stam-human/<uid> && sudo /usr/bin/install -m 644
// /dev/null /run/stam-human/<uid>/N`. The folders get their mode explicitly (`install -D` would take the
// user's umask, which sudo keeps, and a 0700 folder locks the daemon out). Only coreutils runs as root, never
// stam's code or node, which the human's user (and so any agent) can edit. The page then posts S to
// POST /api/human/login on 127.0.0.1: a root-owned empty file at <uid>/nameOf(S), in root-owned folders,
// created within the last 5 minutes and since the daemon started, and not used before, buys one session.
//
// Agents run as the human's Unix user: they can read the terminal and N, but can't make a root-owned file
// without root, nor find S from N. A session token lives only in this process's memory (as its hash) and in
// the page's localStorage; it expires after 12 hours or on restart. Residual: an agent can wrap `sudo` through
// the human's shell rc or PATH, which no login here can prevent; and hosts where agents have passwordless
// sudo or docker gain nothing (there they are root). Linux only for now (macOS's install has no -D); elsewhere
// it fails closed. Used files stay until reboot (/run is a tmpfs); nothing but root could remove them.
// The human runs the command in a terminal outside stam: sudo's per-terminal credential cache in a stam web
// shell would let anything typing there act as root. A hard link that refreshes a file's ctime needs
// protected_hardlinks off (Linux's default is on), and is no use without S anyway.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { testOnlyEnv } from './test-env.ts';

export const CODE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 3600_000;
export const LINUX_ONLY = 'local login works only on Linux for now';

// Tests point the folder elsewhere and name the uid that stands in for root; both count only in a marked
// test home (S-634), like STAM_TEST_HUMAN_KEY.
export function codeDir(): string {
  return testOnlyEnv('STAM_TEST_HUMAN_CODE_DIR') ?? '/run/stam-human';
}
function rootUid(): number {
  const v = testOnlyEnv('STAM_TEST_HUMAN_CODE_ROOT_UID');
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : 0;
}
// This user's folder of codes, which the page names in its command.
export function userDir(): string {
  return join(codeDir(), String(process.getuid?.() ?? ''));
}
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();
const SECRET = /^[A-Za-z0-9_-]{22}$/;

// RFC 4648 base32, lower case, no padding. The web page computes the same (web/src/local-login.tsx).
function base32(b: Buffer): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const x of b) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) out += abc[(acc >>> (bits -= 5)) & 31];
  }
  return bits ? out + abc[(acc << (5 - bits)) & 31] : out;
}
// The name a secret is vouched for under: the first 128 bits of its SHA-256, base32 (26 characters).
export function nameOf(secret: string): string {
  return base32(sha256(secret).subarray(0, 16));
}

// Owned by root and writable by nobody else.
const rootOwned = (st: { uid: number; mode: number }): boolean => st.uid === rootUid() && (st.mode & 0o022) === 0;

// When this process started: a file made before it was for an earlier daemon, whose uses are forgotten.
const processStart = (): number => Date.now() - process.uptime() * 1000;
const used = new Set<string>();
// Whether root vouched for `secret`, for this daemon's user. Each is good once: its name is kept as used,
// since the daemon can't remove a root-owned file. The file's contents are never read. Returns undefined
// when good, else why not.
export function redeemCode(secret: unknown, now = Date.now(), startedAt = processStart()): string | undefined {
  if (process.platform !== 'linux') return LINUX_ONLY;
  if (typeof secret !== 'string' || !SECRET.test(secret)) return 'not a login secret';
  const name = nameOf(secret);
  if (used.has(name)) return 'that login was already used; reload the page for a new code';
  const unreadable = (dir: string) => `stam can't read ${dir}: run the command again (it sets the folders to 755)`;
  for (const dir of [codeDir(), userDir()]) {
    let d;
    try {
      d = lstatSync(dir);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EACCES' ? unreadable(dirname(dir)) : 'no such code yet: run the command above first';
    }
    if (!d.isDirectory() || !rootOwned(d)) return `${dir} isn't a folder that only root can write`;
  }
  let fd: number | undefined;
  try {
    fd = openSync(join(userDir(), name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || !rootOwned(st)) return "that code's file isn't root's";
    if (st.ctimeMs < startedAt) return 'that code was made before stam started; reload the page for a new one';
    if (now - st.ctimeMs > CODE_TTL_MS) return 'that code has expired; reload the page for a new one';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EACCES' ? unreadable(userDir()) : 'no such code yet: run the command above first';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  used.add(name);
  return undefined;
}

// Whether this user has passwordless sudo (S-2121): there an agent is root, and this login keeps no agent out,
// so the page warns. Asked once, the first time the page asks (`sudo -n true` runs only `true`, and fails at
// once where sudo wants a password); a change to sudoers shows after a restart. A test sets the answer with
// STAM_TEST_PASSWORDLESS_SUDO (1 or 0), in a marked test home only, so no test runs sudo.
let sudoCheck: Promise<boolean> | undefined;
export function passwordlessSudo(): Promise<boolean> {
  const t = testOnlyEnv('STAM_TEST_PASSWORDLESS_SUDO');
  if (t !== undefined) return Promise.resolve(t === '1');
  sudoCheck ??= new Promise((resolve) => execFile('sudo', ['-n', 'true'], { timeout: 3000 }, (e) => resolve(!e)));
  return sudoCheck;
}

const sessions = new Map<string, number>();
export function startSession(now = Date.now()): { token: string; expires: number } {
  const token = randomBytes(32).toString('base64url');
  const expires = now + SESSION_TTL_MS;
  sessions.set(sha256(token).toString('hex'), expires);
  return { token, expires };
}
export function sessionLive(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const h = sha256(token).toString('hex');
  const exp = sessions.get(h);
  if (exp === undefined) return false;
  // Keyed by the token's hash, so a lookup's timing says nothing about the token.
  if (exp <= now) sessions.delete(h);
  return exp > now;
}
export function endSession(token: string | undefined): boolean {
  return Boolean(token) && sessions.delete(sha256(token!).toString('hex'));
}
// Every session ends, as when the setting is turned off.
export function endAll(): void {
  sessions.clear();
}

// The session token a request carries: its Bearer, or ?token= only where a browser can't send a header
// (a mail attachment's media player; a terminal socket uses a ticket, S-742).
export function sessionToken(method: string | undefined, rawUrl: string | undefined, authorization: string | undefined): string | undefined {
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  const url = new URL(rawUrl ?? '/', 'http://x');
  const media = method === 'GET' && /^\/api\/mail\/[\w-]+\/attachments\//.test(url.pathname);
  return media ? (url.searchParams.get('token') ?? undefined) : undefined;
}
