// Test tmux sockets (S-3288): `tmux kill-server` can leave the socket file behind, so a test removes its
// own after the kill returns, and the janitor removes the dead ones of a known test prefix.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { envVar } from './env.ts';

// Where tmux keeps its sockets: TMUX_TMPDIR, else /tmp. tmux ignores TMPDIR.
export const tmuxSocketDir = () => join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`);

// Sockets that are never a test's: tmux's default and the live stam daemon's.
const NEVER = new Set(['default', 'stam']);
// The sweep also skips the home's configured socket (STAM_TMUX_SOCKET), read at call time. A test's own
// kill names its throwaway socket, which it usually sets there, so killTmuxServer doesn't refuse it.
const never = (name: string) => NEVER.has(name);
const sweepNever = (name: string) => never(name) || name === envVar('TMUX_SOCKET');

// The socket names tests use: a test's `NAME-test-PID` (rest-test, cost-switch-test, standing-rest-test,
// budgets-test, ...), `transcript-gz-resume-PID`, and the prefixes below. The sweep removes only a
// name that matches one of these.
export const TEST_SOCKET_PREFIXES = [
  'stam-test-', // test/lib.sh runs, tmux-snapshot, tmux-env, tmux-snapshot-async
  'stam-check-', // src/deploy.ts check(), test/deploy-canary.test.mjs
  'transcript-gz-resume-',
];
const TEST_PID_NAME = /^[a-z][a-z0-9-]*-test-\d+$/;

export function isTestSocket(name: string): boolean {
  if (sweepNever(name) || name.includes('/')) return false;
  return TEST_PID_NAME.test(name) || TEST_SOCKET_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length);
}

// What `tmux -L NAME ls` said. 'dead': nothing serves the socket, so its file is a leftover. 'live':
// a server answered. 'unknown': any other failure (a timeout, permission denied, a tmux that
// couldn't run): the socket stays.
export function classifyTmuxLs(r: { status: number | null; stderr: string; timedOut?: boolean }): 'dead' | 'live' | 'unknown' {
  if (r.timedOut) return 'unknown';
  if (r.status === 0) return 'live';
  if (/no server running/i.test(r.stderr)) return 'dead';
  if (/error connecting to .*\((connection refused|no such file or directory)\)/i.test(r.stderr)) return 'dead';
  return 'unknown';
}

// The process that made a PID-named socket (`NAME-test-PID`, `stam-check-PID`, `transcript-gz-resume-PID`,
// `stam-test-lock-PID-NAME`, a Go test's `stam-test-go-PID-NANOS`). Only that process recreates the name, so once it is
// gone nothing races a removal.
export function socketPid(name: string): number | undefined {
  const m =
    name.match(/^[a-z][a-z0-9-]*-test-(\d+)$/) ??
    name.match(/^(?:stam-check|transcript-gz-resume)-(\d+)$/) ??
    name.match(/^stam-test-lock-(\d+)-/) ??
    name.match(/^stam-test-go-(\d+)-\d+$/);
  return m ? Number(m[1]) : undefined;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface TmuxExec {
  status: number | null;
  stderr: string;
  timedOut?: boolean;
}
export type TmuxRun = (args: string[], timeoutMs: number) => TmuxExec;
const realRun: TmuxRun = (args, timeoutMs) => {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
  return { status: r.status, stderr: r.stderr ?? '', timedOut: r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' };
};

// Kills a test's tmux server and removes its socket file only when that is safe: kill-server
// succeeded, or a follow-up `tmux ls` says no server runs. Any other failure (a timeout, a server
// that stays up) keeps the file. Refuses the live, default and configured sockets. True when removed.
export function killTmuxServer(socket: string, opts: { timeoutMs?: number; run?: TmuxRun } = {}): boolean {
  if (!socket || never(socket) || socket.includes('/')) return false;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const run = opts.run ?? realRun;
  const killed = run(['-L', socket, 'kill-server'], timeoutMs);
  if (killed.status !== 0 && classifyTmuxLs(run(['-L', socket, 'ls'], timeoutMs)) !== 'dead') return false;
  rmSync(join(tmuxSocketDir(), socket), { force: true });
  return true;
}
