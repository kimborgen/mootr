import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TMUX_SOCKET, MACHINE } from './config.ts';
import { agentProcesses, stopProcesses } from './proctree.ts';
import { timed } from './stall.ts';

function tmux(args: string[]): string {
  return execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8' });
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// A word in a tmux command file: single quotes keep `$`, `~`, `;` and braces literal.
function tmuxQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// One tmux session per agent, named by agent id, so a human attaches with `stam attach`.
// The env holds the agent's token, so it never goes on a command line (S-477): a tmux
// server keeps the argv of the client that started it, for anyone to read in `ps`. The
// new-session command goes in a file only this user can read, which tmux sources.
export function newSession(name: string, cwd: string, env: Record<string, string>, argv: string[]): void {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const cmd = ['new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', cwd, ...envArgs, argv.map(shellQuote).join(' ')];
  const dir = mkdtempSync(join(tmpdir(), 'stam-session-'));
  try {
    const file = join(dir, 'new-session.conf');
    writeFileSync(file, cmd.map(tmuxQuote).join(' ') + '\n', { mode: 0o600 });
    // source-file alone doesn't start a server.
    tmux(['start-server', ';', 'source-file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Keep the pane after the harness exits, so its last output stays visible.
  tmux(['set-option', '-t', name, 'remain-on-exit', 'on']);
  // The web UI names the agent; tmux's status bar would only take a row, and it's the
  // widest line on the screen.
  tmux(['set-option', '-t', name, 'status', 'off']);
}

export function hasSession(name: string): boolean {
  return timed('tmux has-session', () => spawnSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', `=${name}`]).status === 0);
}

// hasSession without holding the event loop while tmux answers: a fork from the daemon's big heap costs
// tens of ms, and a fleet-wide resume asks once per agent (S-2369).
// Only exit code 1 says the session is gone: a timeout, a signal or any other failure leaves it unknown, and the
// caller relaunches a session that isn't there, which would kill a live harness. So unknown reads as present.
export async function hasSessionAsync(name: string): Promise<boolean> {
  const r = await runner(['-L', TMUX_SOCKET, 'has-session', '-t', `=${name}`]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  console.error(`tmux has-session ${name}: no answer (status ${r.status}); treated as present`);
  return true;
}

// The tmux call behind hasSessionAsync, replaceable so a test can make it time out.
let runner: (args: string[]) => Promise<Out> = (args) => run(args);
export function setTmuxRunner(fn: ((args: string[]) => Promise<Out>) | null): void {
  runner = fn ?? ((args) => run(args));
}

// Whether a `stam attach` or other tmux client has the agent's session open.
export function hasClients(name: string): boolean {
  const r = spawnSync('tmux', ['-L', TMUX_SOCKET, 'list-clients', '-t', `=${name}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '';
}

// Ends the session and stops what its agent started (S-323): the pane's tree, sandboxed
// children in sessions of their own, and orphans that carry the agent's id.
export function killSession(name: string): void {
  if (!hasSession(name)) {
    stopProcesses(agentProcesses(name, undefined, serverPids()));
    return;
  }
  // A dead pane's pid may belong to another process by now, so only a live pane counts.
  const [pid, dead] = spawnSync('tmux', ['-L', TMUX_SOCKET, 'list-panes', '-t', `=${name}:`, '-F', '#{pane_pid} #{pane_dead}'], { encoding: 'utf8' })
    .stdout.trim()
    .split('\n')[0]
    .split(' ')
    .map(Number);
  // Found before the session goes: once the pane dies, its children leave its tree.
  const procs = agentProcesses(name, pid > 1 && !dead ? pid : undefined, serverPids());
  tmux(['kill-session', '-t', `=${name}`]);
  // The Codex TUI outlives the hangup that closing the pane sends, and keeps its
  // app-server running, so the pane's whole process group gets a SIGTERM too.
  if (pid > 1 && !dead) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {}
  }
  stopProcesses(procs);
}

// The tmux server's pid, which an agent's sweep must spare: an agent that ran tmux on the
// socket first would have started the server with its own env.
function serverPids(): number[] {
  const pid = Number(serverId()?.split(' ')[0]);
  return pid > 1 ? [pid] : [];
}

// The running tmux server as its pid and start time, or null when none runs on the
// socket. A changed value means the server stopped and another took its place.
export function serverId(): string | null {
  const r = spawnSync('tmux', ['-L', TMUX_SOCKET, 'display-message', '-p', '#{pid} #{start_time}'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Whether a failed tmux call says no server runs on the socket (none started, or it went
// away), rather than failing for some other reason.
function noServer(stderr: string): boolean {
  return /^no server running on |^error connecting to .*\((No such file or directory|Connection refused)\)/m.test(stderr);
}

// Every session's state from one tmux call (S-345), for a loop that would otherwise spawn tmux
// per agent: the server (as serverId gives it, null when none runs) and, per session, whether
// its window's panes are all dead (as isDead), when its window last had output (S-349,
// #{window_activity}, in seconds), and its active pane's id (%N; a new session or a switched
// window has another). Null when the call failed without saying the
// server is gone (a timeout, another error, output it can't read), or listed no panes while
// the server holds sessions, so nothing is known.
export type Snapshot = { server: string | null; dead: Map<string, boolean>; activity: Map<string, number>; pane: Map<string, string> };
const LIST_PANES = ['-L', TMUX_SOCKET, 'list-panes', '-a', '-F', '#{pid} #{start_time}\t#{session_name}\t#{window_active}\t#{pane_dead}\t#{window_activity}\t#{pane_active}\t#{pane_id}'];
const SERVER_SESSIONS = ['-L', TMUX_SOCKET, 'display-message', '-p', '#{pid} #{start_time}\t#{server_sessions}'];
type Out = { status: number | null; stdout: string; stderr: string };

// The snapshot from list-panes' result; `more` is the display-message result the empty case needs, fetched
// only then. Returns a Snapshot, null, or 'ask' when only `more` can tell.
function parseSnapshot(r: Out): Snapshot | null | 'ask' {
  const dead = new Map<string, boolean>();
  const activity = new Map<string, number>();
  const pane = new Map<string, string>();
  // tmux 3.6 answers a server with no sessions with "no current target": no panes, as empty output.
  const none = r.status === 1 && /^no current target/m.test(r.stderr);
  if (r.status !== 0 && !none) return r.status === 1 && noServer(r.stderr) ? { server: null, dead, activity, pane } : null;
  const lines = none ? [] : r.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 7) return null;
    const [, session, active, paneDead, when, paneActive, id] = fields;
    if (active !== '1') continue;
    dead.set(session, (dead.get(session) ?? true) && paneDead === '1');
    activity.set(session, Number(when));
    if (paneActive === '1') pane.set(session, id);
  }
  if (lines.length) return { server: lines[0].split('\t')[0], dead, activity, pane };
  return 'ask';
}

// No panes names no server either, and is believed only from a server that says it has no sessions.
function parseEmpty(id: Out): Snapshot | null {
  const empty = { dead: new Map<string, boolean>(), activity: new Map<string, number>(), pane: new Map<string, string>() };
  if (id.status !== 0) return id.status === 1 && noServer(id.stderr) ? { server: null, ...empty } : null;
  const [server, sessions] = id.stdout.trim().split('\t');
  return sessions === '0' && /^\d+ \d+$/.test(server) ? { server, ...empty } : null;
}

export function snapshot(): Snapshot | null {
  const at = Date.now();
  const r = spawnSync('tmux', LIST_PANES, { encoding: 'utf8', timeout: 5000 });
  const p = parseSnapshot(r);
  const out = p !== 'ask' ? p : parseEmpty(spawnSync('tmux', SERVER_SESSIONS, { encoding: 'utf8', timeout: 5000 }));
  if (out) startedAt.set(out, at);
  return out;
}

function run(args: string[]): Promise<Out> {
  return new Promise((resolve) =>
    execFile('tmux', args, { encoding: 'utf8', timeout: 5000 }, (e, stdout, stderr) => {
      const code = (e as { code?: unknown } | null)?.code;
      resolve({ status: e ? (typeof code === 'number' ? code : null) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    }),
  );
}

// snapshot() without holding the event loop while tmux answers (S-2125).
export async function snapshotAsync(): Promise<Snapshot | null> {
  const at = Date.now();
  const p = parseSnapshot(await run(LIST_PANES));
  const out = p === 'ask' ? parseEmpty(await run(SERVER_SESSIONS)) : p;
  if (out) startedAt.set(out, at);
  return out;
}

// When the tmux call behind a snapshot started (ms): what the snapshot says is true from then on, so a caller
// that applies it later can tell the agents that changed since (S-2125).
const startedAt = new WeakMap<Snapshot, number>();
export const snapshotStartedAt = (s: Snapshot): number | undefined => startedAt.get(s);

// One snapshotAsync shared by the loops that ask (banners, reconcile): a call while one is in flight joins
// it (however long it has run, so requests never overlap or finish out of order), and a settled answer is
// reused for SNAPSHOT_REUSE_MS after it arrived. A failed answer (null) isn't kept.
const SNAPSHOT_REUSE_MS = 1000;
let inflight: Promise<Snapshot | null> | null = null;
let settled: { at: number; value: Snapshot } | null = null;
export function sharedSnapshot(): Promise<Snapshot | null> {
  if (inflight) return inflight;
  if (settled && Date.now() - settled.at < SNAPSHOT_REUSE_MS) return Promise.resolve(settled.value);
  const p: Promise<Snapshot | null> = snapshotAsync()
    .then((v) => {
      settled = v ? { at: Date.now(), value: v } : null;
      return v;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

export function isDead(name: string): boolean {
  const r = spawnSync('tmux', ['-L', TMUX_SOCKET, 'list-panes', '-t', `=${name}:`, '-F', '#{pane_dead}'], { encoding: 'utf8' });
  return r.status !== 0 || r.stdout.trim() === '1';
}

export function capturePane(name: string): string {
  return tmux(['capture-pane', '-p', '-t', `=${name}:`]);
}

// One pane's screen (by its %N id) without holding the event loop while tmux answers (S-349).
export function capturePaneAsync(pane: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('tmux', ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-t', pane], { encoding: 'utf8', timeout: 5000 }, (e, out) => (e ? reject(e) : resolve(out))),
  );
}

// The server and session a pane (by its %N id) is in now, as `server session`, or null when it's
// gone (tmux then names no session). A pane id is unique only within one server, so a caller
// compares both.
export function paneOwner(pane: string): string | null {
  const r = spawnSync('tmux', ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', pane, '#{pid} #{start_time}\t#{session_name}'], { encoding: 'utf8', timeout: 5000 });
  const [server, session] = r.status === 0 ? r.stdout.trim().split('\t') : [];
  return server && session ? `${server}\t${session}` : null;
}

export async function paneOwnerAsync(pane: string): Promise<string | null> {
  const r = await run(['-L', TMUX_SOCKET, 'display-message', '-p', '-t', pane, '#{pid} #{start_time}\t#{session_name}']);
  const [server, session] = r.status === 0 ? r.stdout.trim().split('\t') : [];
  return server && session ? `${server}\t${session}` : null;
}

export async function sendKeysToPaneAsync(pane: string, ...keys: string[]): Promise<void> {
  const r = await run(['-L', TMUX_SOCKET, 'send-keys', '-t', pane, ...keys]);
  if (r.status !== 0) throw new Error(`tmux send-keys failed: ${r.stderr.trim()}`);
}

// Keys to one pane by its %N id, for a caller that has checked whose pane it is (paneOwner).
export function sendKeysToPane(pane: string, ...keys: string[]): void {
  tmux(['send-keys', '-t', pane, ...keys]);
}

// The pane's screen with its colours (ANSI), trailing blank lines dropped, at most `lines` lines.
export function capturePaneAnsi(name: string, lines = 40): string {
  const rows = tmux(['capture-pane', '-p', '-e', '-t', `=${name}:`]).replace(/\s+$/, '').split('\n');
  return rows.slice(-lines).join('\n');
}

// The width of the agent's pane, in columns.
export function paneWidth(name: string): number {
  return Number(tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_width}']).trim()) || 0;
}

// The cursor's column and row in the agent's pane (0-based), or undefined when tmux doesn't say.
export function cursor(name: string): { x: number; y: number } | undefined {
  const [x, y] = tmux(['display-message', '-p', '-t', `=${name}:`, '#{cursor_x} #{cursor_y}']).trim().split(' ').map(Number);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : undefined;
}

export function sendKeys(name: string, ...keys: string[]): void {
  tmux(['send-keys', '-t', `=${name}:`, ...keys]);
}

// Pastes text into a session as one bracketed paste, as if the human pasted it, then
// presses Enter. A harness takes a multi-line paste as one message.
export async function pasteText(name: string, text: string): Promise<void> {
  paste(name, text);
  // Harnesses ignore an Enter that arrives inside the paste's burst of input.
  await new Promise((r) => setTimeout(r, 400));
  tmux(['send-keys', '-t', `=${name}:`, 'Enter']);
}

// One bracketed paste, without Enter. The text reaches tmux on stdin, so it never shows
// on a command line.
export function paste(name: string, text: string): void {
  const buf = 'stam-' + Math.random().toString(36).slice(2, 8);
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'load-buffer', '-b', buf, '-'], { input: text });
  tmux(['paste-buffer', '-p', '-d', '-b', buf, '-t', `=${name}:`]);
}

// A web terminal sizes its session's window itself (daemon.ts attachTerminal), so the
// window's size no longer follows its clients: `manual` while a web viewer is attached,
// `latest` otherwise, when the window fits the terminal of the client that last acted.
// tmux has no session-level window option, so this sets every window of the session, and
// a hook gives each window made later the same mode until it's set back to `latest`.
// Failures are ignored: the session may have just ended.
export function setWindowSize(name: string, mode: 'manual' | 'latest'): void {
  const w = spawnSync('tmux', ['-L', TMUX_SOCKET, 'list-windows', '-t', `=${name}`, '-F', '#{window_index}'], { encoding: 'utf8' });
  if (w.status === 0)
    for (const idx of w.stdout.trim().split('\n'))
      spawnSync('tmux', ['-L', TMUX_SOCKET, 'set-option', '-w', '-t', `=${name}:${idx}`, 'window-size', mode]);
  if (mode === 'manual') spawnSync('tmux', ['-L', TMUX_SOCKET, 'set-hook', '-t', name, 'after-new-window', 'set-option -w window-size manual']);
  else spawnSync('tmux', ['-L', TMUX_SOCKET, 'set-hook', '-u', '-t', name, 'after-new-window']);
}

// The daemon's start: a crash leaves windows `manual` with no viewer left to reset them, so
// every session on the socket goes back to `latest` before any viewer attaches.
export function resetWindowSizes(): void {
  const r = spawnSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
  if (r.status === 0) for (const name of r.stdout.trim().split('\n')) if (name) setWindowSize(name, 'latest');
}

export function resizeWindow(name: string, cols: number, rows: number): void {
  spawnSync('tmux', ['-L', TMUX_SOCKET, 'resize-window', '-t', `=${name}:`, '-x', String(cols), '-y', String(rows)]);
}

export function attachArgs(name: string): string[] {
  return ['-L', TMUX_SOCKET, 'attach-session', '-t', `=${name}`];
}

// The human's own terminals: a login shell in tmux, named sh-XXXXX, kept until it exits.
export function newShell(cwd: string): { id: string; cwd: string; machine: string } {
  const id = 'sh-' + Math.random().toString(36).slice(2, 7);
  const shell = process.env.SHELL || 'bash';
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STAM|MOOTR)_AGENT/.test(k))) as Record<string, string>;
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'new-session', '-d', '-s', id, '-x', '120', '-y', '40', '-c', cwd, shell, '-l'], { env: { ...env, TERM: 'xterm-256color' } });
  tmux(['set-option', '-t', id, 'status', 'off']);
  return { id, cwd, machine: MACHINE };
}

export function listShells(): { id: string; cwd: string; machine: string }[] {
  const r = spawnSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}\t#{pane_current_path}'], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter((l) => l.startsWith('sh-')).map((l) => { const [id, cwd] = l.split('\t'); return { id, cwd, machine: MACHINE }; });
}
