// The seam every agent's process goes through (S-2861). A harness starts with agentExec, and a
// signal to an agent's processes goes out with agentKill or agentKillMatching, so the adapters
// and the lifecycle never call spawn, execFile or process.kill on an agent's behalf. Nothing
// here changes what runs or how: the same argv, env and cwd, and the same signals. It is the
// place the agents' Unix user will be set (S-2861); the static check in test/agent-exec.test.mjs
// keeps the callers on it.
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess, type ChildProcessByStdio, type StdioOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import * as tmux from './tmux.ts';
import { withoutIdentity, withTwins } from './env.ts';

type Env = Record<string, string>;

const execFileAsync = promisify(execFile);

// `env` is what the harness gets beyond stam's own environment. In 'session' mode it is the
// tmux session's variables, which tmux sets on top of its server's as it always has.
export function agentExec(argv: string[], env: Env, opts: { mode: 'session'; cwd: string; session: string }): void;
export function agentExec(argv: string[], env: Env, opts: { mode: 'spawn'; cwd?: string; stdio: ['pipe', 'pipe', 'ignore'] }): ChildProcessByStdio<Writable, Readable, null>;
export function agentExec(argv: string[], env: Env, opts: { mode: 'spawn'; cwd?: string; stdio?: StdioOptions }): ChildProcess;
export function agentExec(argv: string[], env: Env, opts: { mode: 'file'; cwd?: string; timeout?: number }): ReturnType<typeof execFileAsync>;
export function agentExec(argv: string[], env: Env, opts: { mode: 'fileSync'; cwd?: string }): string;
export function agentExec(argv: string[], env: Env, opts: { mode: 'session' | 'spawn' | 'file' | 'fileSync'; cwd?: string; session?: string; stdio?: StdioOptions; timeout?: number }): unknown {
  const [file, ...args] = argv;
  env = withTwins(env); // each STAM_X also as MOOTR_X, the same value (S-3345)
  const merged = withoutIdentity(process.env, env); // an agent's identity reaches only the agent it belongs to (S-3329)
  switch (opts.mode) {
    case 'session':
      return tmux.newSession(opts.session!, opts.cwd!, env, argv);
    case 'spawn':
      return spawn(file, args, { cwd: opts.cwd, env: merged, stdio: opts.stdio });
    case 'file':
      return execFileAsync(file, args, { cwd: opts.cwd, env: merged, timeout: opts.timeout });
    case 'fileSync':
      return execFileSync(file, args, { cwd: opts.cwd, env: merged, encoding: 'utf8' });
  }
}

// Sends `signal` to `pid`, or to its process group when `pid` is negative, as process.kill does.
// False when nothing was signalled: the pid is gone or was never one.
export function agentKill(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Sends `signal` to every process whose command line matches `pattern` (pkill -f). True when any matched.
export function agentKillMatching(pattern: string, signal: 'TERM' | 'KILL'): boolean {
  return spawnSync('pkill', [`-${signal}`, '-f', pattern]).status === 0;
}
