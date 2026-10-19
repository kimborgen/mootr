// Codex adapter. Each agent runs its own Codex app-server on a unix socket in its state
// folder, with the Codex TUI attached to it (`codex --remote`), both in the agent's tmux
// session. The daemon is a second client of that app-server: it follows thread status
// and token usage, and starts turns with `turn/start`. A turn started that way shows live
// in the TUI, and a half-typed draft in the TUI's input survives (tested with 0.162.1).
//
// One app-server per agent, rather than one shared like OpenCode's, because hooks and
// MCP servers inherit the app-server's environment: STAM_AGENT_ID reaches them without
// a `self` argument, and an agent's server dies with its tmux session.
//
// Everything is configured with `-c` overrides on the command line, so the user's
// ~/.codex/config.toml and login stay untouched and shared. The system prompt and the
// first prompt are the exception: command lines show in `ps` and match a broad
// `pkill -f`, so the daemon starts (or resumes) the agent's thread itself with the system
// prompt as `developerInstructions`, the TUI then resumes that thread, and the first
// prompt is a `turn/start`.
import { cachedLessons, warmLessons } from '../retro-lessons.ts';
import { workspacePrompt } from '../workspace-prompt.ts';
import { grantedPaths } from '../workspace-share.ts';
import { loadOwned, itsaPrompt } from '../itsa-owners.ts';
import { prompt as requirementsPrompt } from '../requirements.ts';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { STAM_BIN, STAM_HOME, agentDir } from '../config.ts';
import { isReviewerType } from '../agent-types.ts';
import * as db from '../db.ts';
import { signal as costSignal } from '../rules.ts';
import type { Agent, Activity } from '../db.ts';
import type { Adapter, ErrorClass, HookResult, LaunchSpec } from './types.ts';
import * as tmux from '../tmux.ts';
import { render, humanMailPrompt } from '../templates.ts';
import { schedulePush } from '../mail.ts';
import { onIdle, dropRestRequest } from '../lifecycle.ts';
import { orgPrompt, managerCostPrompt } from '../org.ts';
import { instructionsPrompt, extraMcpServers, linkSkills, agentsSkillsDir } from '../instructions.ts';
import { replaceHookWaits, clearHookWaits, type HookWait } from './hook-waits.ts';
import { onContext } from '../context.ts';
import { report, reportSubscription } from '../usage.ts';

const BIN = process.env.STAM_CODEX_BIN ?? (existsSync(join(homedir(), '.local/bin/codex')) ? join(homedir(), '.local/bin/codex') : 'codex');
const HOOK_COMMAND = `${STAM_BIN} hook codex`;
// Stop is a fallback for when the daemon isn't following the app-server; idle normally
// comes from thread/status/changed.
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const socketPath = (agentId: string) => join(agentDir(agentId), 'codex.sock');
// The thread the TUI opens, written by the daemon once it has started or loaded it.
const threadFile = (agentId: string) => join(agentDir(agentId), 'codex-thread');

function systemPrompt(agent: Agent): string {
  return render('system-prompt', {
    id: agent.id,
    name: agent.name,
    machine: agent.machine,
    role: agent.role || 'not set',
    org: orgPrompt(agent),
    instructions: instructionsPrompt('codex', agent.cwd),
    cost: managerCostPrompt(agent),
    retro: render('retro', {}, agent.type),
    lessons: cachedLessons(agent.id) ?? '',
    workspace: workspacePrompt(agent),
    itsa: itsaPrompt(agent.id),
    requirements: requirementsPrompt(),
    human_mail: humanMailPrompt(agent.model, agent.type),
  }, agent.type);
}

// A TOML literal for a `-c key=value` override. JSON strings are valid TOML basic strings.
function toml(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(toml).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}=${toml(x)}`).join(',')}}`;
  return JSON.stringify(v);
}

const hookArgs = (): string[] => HOOK_EVENTS.flatMap((e) => ['-c', `hooks.${e}=${toml([{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }])}`]);

// Codex runs a hook only once its hash is trusted. stam trusts its own hooks for its own
// app-servers by passing the hashes as `hooks.state` overrides (Codex reads trust from
// the session-flags layer), instead of writing them to the user's config. The hashes
// come from Codex itself: a short-lived app-server lists the hooks with `hooks/list`.
// Cached per Codex version, since the hash format is Codex's business.
let trustCache: { version: string; command: string; state: Record<string, { trusted_hash: string }> } | undefined;
const TRUST_FILE = join(STAM_HOME, 'codex-hook-trust.json');

async function hookTrust(): Promise<Record<string, { trusted_hash: string }>> {
  const version = codex.version();
  if (!trustCache) {
    try {
      trustCache = JSON.parse(readFileSync(TRUST_FILE, 'utf8'));
    } catch {}
  }
  if (trustCache?.version === version && trustCache.command === HOOK_COMMAND) return trustCache.state;
  const hooks = await probeHooks();
  const state = Object.fromEntries(hooks.filter((h) => h.command === HOOK_COMMAND).map((h) => [h.key, { trusted_hash: h.currentHash }]));
  if (Object.keys(state).length !== HOOK_EVENTS.length) throw new Error(`Codex listed ${Object.keys(state).length} of stam's ${HOOK_EVENTS.length} hooks`);
  trustCache = { version, command: HOOK_COMMAND, state };
  writeFileSync(TRUST_FILE, JSON.stringify(trustCache, null, 2));
  return state;
}

function probeHooks(): Promise<{ key: string; command: string; currentHash: string }[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, ['app-server', '--listen', 'stdio://', ...hookArgs()], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('Codex hook probe timed out'));
    }, 20_000);
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: {} }) + '\n');
        } else if (msg.id === 2) {
          clearTimeout(timer);
          p.kill();
          if (msg.error) return reject(new Error(msg.error.message));
          resolve((msg.result?.data ?? []).flatMap((d: any) => d.hooks ?? []));
        }
      }
    });
    p.on('error', reject);
    // A Codex that exits at once fails these writes with EPIPE; the timeout reports it.
    p.stdin.on('error', () => {});
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'stam', version: '2' }, capabilities: null } }) + '\n');
  });
}

// Permission modes. 'auto' is the counterpart of Claude Code's auto mode: commands run in
// Codex's workspace-write sandbox, the model may ask to step outside it (on-request), and
// those requests go to Codex's automatic reviewer instead of waiting for a human. When
// the reviewer says no, the agent asks through stam's request_permission tool. 'bypass'
// is Codex's --dangerously-bypass-approvals-and-sandbox: no sandbox, no approvals. 'default' is
// 'auto' with the requests left to the user, in the TUI or the conversation view (S-1967).
export function permissionConfig(mode: string): Record<string, string> {
  if (mode === 'bypass') return { approval_policy: 'never', sandbox_mode: 'danger-full-access', approvals_reviewer: 'user' };
  return { approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: mode === 'default' ? 'user' : 'auto_review' };
}

// The same settings as thread parameters, for threads that already exist.
function permissionParams(mode: string) {
  const c = permissionConfig(mode);
  return { approvalPolicy: c.approval_policy, sandbox: c.sandbox_mode, approvalsReviewer: c.approvals_reviewer };
}

// What a reviewer's Codex workspace-write sandbox needs and the default one withholds (S-731):
// network, so `gh` and `git fetch` work, and ~/.cache/stam-review writable, where the reviewer
// brief makes its own clone (S-817). Only that scratch root: never the shared repo's git dir. A
// reviewer usually runs in the live deploy checkout, so a writable shared .git would let it write
// hooks and config that then run for every agent and the deploy watcher. The root is made here,
// before the launch script is written: Codex's sandbox can't create a writable root that doesn't
// exist, and ~/.cache is read-only to it. Scoped to reviewer types; every other Codex agent keeps
// the plain workspace-write policy. Codex takes these as app-server config, so they apply to the
// whole agent, TUI turns included; a thread started with sandbox 'workspace-write' reads them
// (checked with 0.162.1).
export function reviewerSandbox(agent: Agent): Record<string, unknown> {
  if (!isReviewerType(agent.type ?? '')) return {};
  const root = join(homedir(), '.cache', 'stam-review');
  mkdirSync(root, { recursive: true });
  return { 'sandbox_workspace_write.network_access': true, 'sandbox_workspace_write.writable_roots': [root] };
}

// reviewerSandbox plus the agent's own workspace and the ones shared with it for writing (S-896),
// as writable roots. A read share needs nothing here: Codex can read them already.
export function agentSandbox(agent: Agent): Record<string, unknown> {
  const base = reviewerSandbox(agent);
  const write = [...(agent.personal_workspace ? [agent.personal_workspace] : []), ...grantedPaths(agent.id, 'write')];
  if (!write.length) return base;
  const roots = (base['sandbox_workspace_write.writable_roots'] as string[] | undefined) ?? [];
  return { ...base, 'sandbox_workspace_write.writable_roots': [...roots, ...write] };
}

// When the tmux server goes down without a reboot, the Codex TUI outlives the hangup and
// keeps the launch script and the agent's app-server running. Every one of them names the
// agent's socket on its command line, so they are found by it and stopped before a relaunch.
async function stopStale(sock: string): Promise<void> {
  const pattern = `unix://${sock}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < 20; i++) {
    const signal = i < 10 ? 'TERM' : 'KILL';
    if (spawnSync('pkill', [`-${signal}`, '-f', pattern]).status !== 0) return;
    await sleep(300);
  }
}

const overrides = (o: Record<string, unknown>) => Object.entries(o).flatMap(([k, v]) => ['-c', `${k}=${toml(v)}`]);

// The environment variable that carries one remote server's header value.
const mcpEnvName = (server: string, header: string) => `STAM_MCP_${server}_${header}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

// The mcp_servers.* overrides for settings.mcpServers, and the environment each needs.
// overrides() puts config on the app-server's command line, where `ps` and a broad
// `pkill -f` can read it, so only *names* go there: a stdio server's env values are
// forwarded by name (env_vars) and a remote server's headers are read from environment
// variables (env_http_headers). The values themselves go into the app-server's own
// environment, which the launch script (mode 0600) sets, and no command line shows them.
export function codexMcpServers(): { overrides: Record<string, unknown>; env: Record<string, string> } {
  const overrides: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  for (const [name, s] of Object.entries(extraMcpServers())) {
    if (s.auth) {
      // The token lives in the daemon, so the proxy gets it at call time from the app-server's
      // environment, as stam's own server does; nothing secret rides on this command line.
      overrides[`mcp_servers.${name}`] = { command: STAM_BIN, args: ['mcp-proxy', name], env_vars: ['STAM_AGENT_ID', 'STAM_URL', 'STAM_TOKEN'] };
    } else if (s.url) {
      const o: Record<string, unknown> = { url: s.url };
      const headers: Record<string, string> = {};
      for (const [header, value] of Object.entries(s.headers ?? {})) {
        const key = mcpEnvName(name, header);
        headers[header] = key;
        env[key] = value;
      }
      if (Object.keys(headers).length) o.env_http_headers = headers;
      overrides[`mcp_servers.${name}`] = o;
    } else if (s.command) {
      const o: Record<string, unknown> = { command: s.command, args: s.args ?? [] };
      const names = Object.keys(s.env ?? {});
      for (const k of names) env[k] = s.env![k];
      if (names.length) o.env_vars = names;
      overrides[`mcp_servers.${name}`] = o;
    }
  }
  return { overrides, env };
}

// --- The daemon's connection to each agent's app-server ---

interface Conn {
  ws: WebSocket;
  ready: Promise<void>;
  next: number;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;
  subscribed: boolean;
  subscribing?: boolean;
  // Set when stam relaunches the harness, which reconnects once the new TUI is up.
  closing?: boolean;
  compacting?: () => void;
  ephemeral: Set<string>;
  // Background work of the agent's own thread still running, keyed by wait target (see trackJob).
  jobs: Map<string, HookWait>;
  // Work seen ending while reconcileJobs is asking the app-server, so its answer can't revive it.
  ended: Set<string>;
  reconciling: number;
  // The agent's running turn, from turn/started until turn/completed, for turn/interrupt.
  turnId?: string;
}

const conns = new Map<string, Conn>();

// Listeners of an agent's app-server traffic, for stam's own agent view (codex-view.ts):
// every notification, and every server request (an approval), as it arrives. They share
// the daemon's one connection; nothing here opens another.
export interface AppServerListener {
  notify(method: string, params: any): void;
  request(id: string | number, method: string, params: any): void;
}
const listeners = new Map<string, Set<AppServerListener>>();
// Server requests the app-server sent an agent's connection that nobody has answered yet.
const requests = new Map<string, Map<string | number, { method: string; params: any }>>();
export const openRequests = (agentId: string): { id: string | number; method: string; params: any }[] =>
  [...(requests.get(agentId) ?? [])].map(([id, r]) => ({ id, ...r }));
export function listen(agentId: string, l: AppServerListener): () => void {
  let set = listeners.get(agentId);
  if (!set) listeners.set(agentId, (set = new Set()));
  set.add(l);
  return () => {
    set!.delete(l);
    if (!set!.size) listeners.delete(agentId);
  };
}

// Calls the agent's app-server and returns its result, over the daemon's connection.
export async function appServer(agentId: string, method: string, params?: unknown): Promise<any> {
  return call(await ready(agentId), method, params);
}

// Answers a server request the app-server sent this connection (an approval's JSON-RPC id).
// The request is taken off the open ones as it's sent, so a second answer finds nothing to
// send to. False when it's no longer open, or the connection is gone.
export function answerRequest(agentId: string, id: string | number, result: unknown): boolean {
  const c = conns.get(agentId);
  const open = requests.get(agentId);
  if (!c || c.ws.readyState !== WebSocket.OPEN || !open?.has(id)) return false;
  open.delete(id);
  c.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  return true;
}

// The agent's thread, for the view: the agent's session, or the thread the app-server loaded.
export async function threadOf(agentId: string): Promise<string | undefined> {
  return threadId(agentId, await ready(agentId));
}
const retrying = new Set<string>();
let rateLimitTimer: ReturnType<typeof setInterval> | undefined;

function call(c: Conn, method: string, params?: unknown, timeout = 15_000): Promise<any> {
  const id = ++c.next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(new Error(`Codex ${method} timed out`));
    }, timeout);
    c.pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    c.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

const running = (a: Agent | undefined) => a && a.harness === 'codex' && (a.lifecycle === 'active' || a.lifecycle === 'paused');

// Opens (or returns) the connection to an agent's app-server and keeps it open while the
// agent runs, reconnecting after a daemon restart or a harness relaunch.
function connect(agentId: string): Conn | undefined {
  const existing = conns.get(agentId);
  if (existing) return existing;
  if (!existsSync(socketPath(agentId))) return undefined;
  // Codex replaces a long socket path with a symlink to a short one; connecting to the
  // target avoids the unix socket path length limit.
  let sock = socketPath(agentId);
  try {
    sock = realpathSync(sock);
  } catch {}
  const ws = new WebSocket(`ws+unix://${sock}:/`);
  const c: Conn = { ws, ready: Promise.resolve(), next: 0, pending: new Map(), subscribed: false, ephemeral: new Set(), jobs: new Map(), ended: new Set(), reconciling: 0 };
  conns.set(agentId, c);
  c.ready = new Promise((resolve, reject) => {
    ws.on('open', async () => {
      try {
        await call(c, 'initialize', { clientInfo: { name: 'stam', version: '2' }, capabilities: { experimentalApi: true } });
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
        resolve();
        readRateLimits();
        await subscribe(agentId, c);
      } catch (e) {
        reject(e);
      }
    });
    ws.on('error', reject);
  });
  c.ready.catch(() => {});
  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = c.pending.get(msg.id);
      c.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    } else if (msg.method) {
      // Requests such as approvals are left to the TUI, which gets them too; the view hears
      // them through its listeners (see listen).
      if (msg.id === undefined) onNotification(agentId, c, msg.method, msg.params ?? {});
      else {
        // Open until serverRequest/resolved (any client answering counts).
        let open = requests.get(agentId);
        if (!open) requests.set(agentId, (open = new Map()));
        open.set(msg.id, { method: msg.method, params: msg.params ?? {} });
        for (const l of listeners.get(agentId) ?? []) l.request(msg.id, msg.method, msg.params ?? {});
      }
    }
  });
  ws.on('close', () => {
    requests.delete(agentId);
    if (conns.get(agentId) === c) conns.delete(agentId);
    for (const p of c.pending.values()) p.reject(new Error('Codex app-server connection closed'));
    if (!c.closing) keepConnected(agentId);
  });
  return c;
}

// Retries every two seconds while the agent runs and its socket isn't reachable.
function keepConnected(agentId: string): void {
  if (retrying.has(agentId)) return;
  retrying.add(agentId);
  (async () => {
    while (running(db.getAgent(agentId)) && tmux.hasSession(agentId) && !tmux.isDead(agentId)) {
      const c = connect(agentId);
      if (c && (await c.ready.then(() => true, () => false))) break;
      if (c) conns.delete(agentId);
      await sleep(2000);
    }
    retrying.delete(agentId);
  })();
}

async function ready(agentId: string): Promise<Conn> {
  const c = connect(agentId);
  if (!c) throw new Error('Codex app-server is not running');
  await c.ready;
  return c;
}

// Reads the account's limits, at most one read at a time, through one initialized
// connection: connection opens and the 5-minute tick in start() share the in-flight read, so
// N agents never make N racing reads. A failure is retried on the next tick.
let rateLimitRead: Promise<void> | undefined;
function readRateLimits(): void {
  if (rateLimitRead) return;
  rateLimitRead = (async () => {
    try {
      const c = [...conns.values()].find((x) => x.ws.readyState === WebSocket.OPEN);
      if (!c) return;
      await c.ready;
      recordRateLimitsRead(await call(c, 'account/rateLimits/read', {}));
    } catch {
      // A close mid-read, or a server without the method: the next tick retries.
    } finally {
      rateLimitRead = undefined;
    }
  })();
}

// The error probe (src/cost-probes.ts): one account/rateLimits/read through an open
// connection, recorded as a reading. True when it answers; false with no connection.
export async function probeRateLimits(): Promise<boolean> {
  const c = [...conns.values()].find((x) => x.ws.readyState === WebSocket.OPEN);
  if (!c) return false;
  try {
    await c.ready;
    recordRateLimitsRead(await call(c, 'account/rateLimits/read', {}));
    return true;
  } catch {
    return false;
  }
}

// The TUI starts its thread when it launches; the agent's thread is the one that isn't a
// title generator or a subagent.
async function threadId(agentId: string, c: Conn): Promise<string | undefined> {
  const a = db.getAgent(agentId);
  if (a?.session_id) return a.session_id;
  const r = await call(c, 'thread/loaded/list', {});
  for (const id of r.data ?? []) {
    if (c.ephemeral.has(id)) continue;
    const t = await call(c, 'thread/read', { threadId: id }).then((x) => x.thread, () => undefined);
    if (t?.ephemeral || t?.parentThreadId) {
      c.ephemeral.add(id);
      continue;
    }
    db.updateAgent(agentId, { session_id: id });
    return id;
  }
  return undefined;
}

// S-759: opens the agent's thread for the TUI to attach to: resumes `resumeId` when there is
// one, else starts a fresh thread. A thread whose first turn never ran has no rollout, so
// thread/resume answers "no rollout found for thread id ...": that is an agent that never
// started, not a conversation to lose, so it starts fresh (and the caller delivers the first
// prompt its spawn stored). `fresh` says which path ran; a fresh thread's id is stored.
export async function openThread(agent: Agent, resumeId: string | null): Promise<{ id: string; fresh: boolean }> {
  const c = await ready(agent.id);
  const perm = permissionParams(agent.permission_mode);
  if (resumeId) {
    try {
      await call(c, 'thread/resume', { threadId: resumeId, excludeTurns: true, developerInstructions: systemPrompt(agent), ...perm });
      return { id: resumeId, fresh: false };
    } catch (e) {
      if (!/no rollout/i.test(e instanceof Error ? e.message : String(e))) throw e;
      db.addEvent(agent.id, 'codex:no-rollout', { thread: resumeId });
    }
  }
  const r = await call(c, 'thread/start', { cwd: agent.cwd, developerInstructions: systemPrompt(agent), ...perm });
  const id = r.thread.id as string;
  // A thread exists on disk only after its first item, and the TUI can't resume it before.
  // Naming it writes it, and the name shows in the TUI.
  await call(c, 'thread/name/set', { threadId: id, name: agent.name });
  db.updateAgent(agent.id, { session_id: id });
  return { id, fresh: true };
}

// thread/resume on a running thread subscribes this client to its turn, item, and token
// events. It fails until the thread's first turn creates its rollout file, so it retries.
async function subscribe(agentId: string, c: Conn): Promise<void> {
  if (c.subscribing) return;
  c.subscribing = true;
  while (!c.subscribed && conns.get(agentId) === c && running(db.getAgent(agentId))) {
    try {
      const id = await threadId(agentId, c);
      if (id) {
        const a = db.getAgent(agentId)!;
        await loadOwned(a.id);
        // A thread that isn't loaded yet loads with the system prompt; a running one keeps its own.
        const r = await call(c, 'thread/resume', { threadId: id, excludeTurns: true, developerInstructions: systemPrompt(a), ...permissionParams(a.permission_mode) });
        c.subscribed = true;
        db.addEvent(agentId, 'codex:subscribed', { thread: id, model: r.model, approvalPolicy: r.approvalPolicy, approvalsReviewer: r.approvalsReviewer, sandbox: r.sandbox?.type ?? r.sandbox });
        // Catch up on a turn that ended while the daemon wasn't listening.
        if (db.getAgent(agentId)!.activity !== 'starting') onStatus(agentId, r.thread?.status, c);
        reconcileJobs(agentId, c);
        break;
      }
    } catch {}
    await sleep(2000);
  }
  c.subscribing = false;
}

// After /clear the TUI is on a new thread, so the daemon follows that one instead.
function resubscribe(agentId: string): void {
  const c = conns.get(agentId);
  if (!c) return;
  c.subscribed = false;
  setTimeout(() => subscribe(agentId, c), 500);
}

// The TUI has no launch dialogs with stam's overrides; this waits for it to come up and
// keeps the daemon connected to its app-server.
async function waitForTui(agent: Agent): Promise<void> {
  const accept = /Yes, continue|Trust all and continue/;
  const readyRe = /Ask Codex|\? for shortcuts|esc to interrupt|Working \(/;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (!tmux.hasSession(agent.id) || tmux.isDead(agent.id)) throw new Error('the Codex TUI exited');
    const screen = tmux.capturePane(agent.id);
    const line = screen.split('\n').find((l) => accept.test(l));
    if (line && /^\s*›/.test(line)) {
      tmux.sendKeys(agent.id, 'Enter');
      await sleep(1000);
    } else if (readyRe.test(screen)) break;
  }
  keepConnected(agent.id);
}

function set(agentId: string, activity: Activity, detail: string | null, event: string): void {
  db.updateAgent(agentId, { activity, activity_detail: detail });
  db.addEvent(agentId, `codex:${event}`, { activity, detail });
}

function turnEnded(agentId: string): void {
  schedulePush(agentId);
  onIdle(agentId).catch((e) => db.addEvent(agentId, 'pending-error', String(e)));
}

function onStatus(agentId: string, status: any, c?: Conn): void {
  const a = db.getAgent(agentId);
  if (!a || !status) return;
  switch (status.type) {
    case 'active': {
      const flags: string[] = status.activeFlags ?? [];
      if (flags.includes('waitingOnApproval')) return set(agentId, 'blocked', 'approval', 'status');
      if (flags.includes('waitingOnUserInput')) return set(agentId, 'blocked', 'question', 'status');
      // A new turn: the rest its last turn asked for no longer holds (S-2237).
      if (a.activity === 'idle' || a.activity === 'waiting') dropRestRequest(agentId);
      if (a.activity !== 'working') set(agentId, 'working', null, 'status');
      return;
    }
    case 'idle':
      // A thread loading also reports idle; only the end of a turn the daemon saw counts.
      if (a.activity === 'idle' || a.activity === 'waiting' || a.activity === 'starting') return;
      // Waits first, so a turn that leaves work running ends in 'waiting', never passing idle.
      if (c) replaceHookWaits(agentId, 'job', [...c.jobs.values()]);
      set(agentId, 'idle', 'turn finished', 'status');
      turnEnded(agentId);
      if (c) reconcileJobs(agentId, c);
      return;
    case 'systemError':
      return set(agentId, 'errored', 'Codex system error', 'status');
  }
}

// Waits Codex creates (source 'hook', kind 'job'): background terminals and sub-agents still
// running when the agent's turn ends. Seen live on 0.162.1, all on the agent's own thread:
// a command starts as a `commandExecution` item (item/started, status inProgress) and ends
// with its item/completed, also when it outlived the turn as a background terminal
// (unified exec); a sub-agent starts as a `subAgentActivity` item of kind 'started' naming
// its thread, and when it finishes a 'completed' one is added to the parent, while the
// parent stays idle. So the agent's running work is tracked from items, and at the end of a
// turn it becomes the agent's job waits (foreground commands have all completed by then).
// Codex doesn't wake the agent when such work ends, so its wait just clears, and an agent
// with nothing left goes idle. Ending on 'interrupted' and running again on 'interacted' (a
// parent's input to a finished sub-agent) are inferred from the names. After a turn, and
// when the daemon (re)subscribes, the list is checked against the app-server's own:
// `thread/backgroundTerminals/list` and the loaded threads whose parent is the agent's and
// whose status is active. Codex has no timers to report. A new app-server has none of the
// old one's work, so a launch drops the hook waits.
function trackJob(agentId: string, c: Conn, item: any, started: boolean): void {
  const run = (id: string, w: HookWait) => (c.jobs.set(id, w), c.ended.delete(id));
  // Ends clear the wait even when the job isn't tracked (a reconnect starts with none).
  const end = (id: string) => {
    c.jobs.delete(id);
    if (c.reconciling) c.ended.add(id);
    db.clearWaits(agentId, 'job', id);
  };
  if (item?.type === 'commandExecution' && item.id) {
    if (started && item.status === 'inProgress') {
      const cmd = item.commandActions?.[0]?.command ?? item.command;
      run(item.id, { target: item.id, detail: `background command "${cmd}"`, data: { type: 'terminal', processId: item.processId } });
    } else if (!started) end(item.id);
  } else if (item?.type === 'subAgentActivity' && item.agentThreadId) {
    const id = item.agentThreadId as string;
    c.ephemeral.add(id);
    if (item.kind === 'started' || item.kind === 'interacted') run(id, { target: id, detail: `sub-agent ${item.agentPath ?? id}`, data: { type: 'subagent' } });
    else if (item.kind === 'completed' || item.kind === 'interrupted') end(id);
  }
}

// Replaces the tracked work with what the app-server reports running, and the hook waits
// with it once the agent's turn is over. A turn that started meanwhile keeps its own list.
async function reconcileJobs(agentId: string, c: Conn): Promise<void> {
  const id = db.getAgent(agentId)?.session_id;
  if (!id) return;
  c.reconciling++;
  try {
    const jobs = new Map<string, HookWait>();
    for (const t of (await call(c, 'thread/backgroundTerminals/list', { threadId: id })).data ?? [])
      jobs.set(t.itemId, c.jobs.get(t.itemId) ?? { target: t.itemId, detail: `background command "${t.command}"`, data: { type: 'terminal', processId: t.processId } });
    for (const tid of (await call(c, 'thread/loaded/list', {})).data ?? []) {
      const t = await call(c, 'thread/read', { threadId: tid }).then((x) => x.thread, () => undefined);
      if (t?.parentThreadId === id && t.status?.type === 'active') jobs.set(tid, c.jobs.get(tid) ?? { target: tid, detail: `sub-agent ${t.name ?? tid}`, data: { type: 'subagent' } });
    }
    const a = db.getAgent(agentId);
    if (a?.session_id !== id || (a.activity !== 'idle' && a.activity !== 'waiting')) return;
    // Work whose end was seen while the app-server was asked stays ended.
    for (const k of c.ended) jobs.delete(k);
    c.jobs = jobs;
    replaceHookWaits(agentId, 'job', [...jobs.values()]);
  } catch (e) {
    db.addEvent(agentId, 'codex:jobs-error', String(e));
  } finally {
    if (--c.reconciling === 0) c.ended.clear();
  }
}

export function onNotification(agentId: string, c: Conn, method: string, p: any): void {
  if (method === 'serverRequest/resolved') requests.get(agentId)?.delete(p.requestId);
  for (const l of listeners.get(agentId) ?? []) l.notify(method, p);
  const a = db.getAgent(agentId);
  if (!a) return;
  const mine = (id: string | undefined) => !a.session_id || id === a.session_id;
  switch (method) {
    case 'thread/started':
      if (p.thread?.ephemeral || p.thread?.parentThreadId) c.ephemeral.add(p.thread.id);
      return;
    case 'thread/status/changed':
      if (mine(p.threadId) && !c.ephemeral.has(p.threadId)) onStatus(agentId, p.status, c);
      if (!c.subscribed) subscribe(agentId, c);
      return;
    case 'turn/started':
      if (mine(p.threadId) && !c.ephemeral.has(p.threadId)) c.turnId = p.turn?.id;
      return;
    case 'turn/completed':
      if (!mine(p.threadId)) return;
      if (c.turnId === p.turn?.id) c.turnId = undefined;
      if (p.turn?.status === 'failed') {
        const cls = classifyCodexError(p);
        if (cls) costSignal(agentId, { source: 'turn/completed', class: cls, codexErrorInfo: p.turn?.error?.codexErrorInfo, message: p.turn?.error?.message });
        set(agentId, 'errored', String(p.turn.error?.message ?? 'turn failed'), 'turn-failed');
      } else if (p.turn?.status === 'interrupted') db.updateAgent(agentId, { activity_detail: 'interrupted' });
      return;
    case 'account/rateLimits/updated': {
      // A fresh snapshot: log a reached limit or depleted credits (build step 1) and record
      // the windows for the cost policy (build step 3).
      const cls = classifyCodexError(p);
      if (cls) costSignal(agentId, { source: 'account/rateLimits/updated', class: cls, rateLimitReachedType: p.rateLimits?.rateLimitReachedType, spendControlReached: p.rateLimits?.spendControlReached });
      recordRateLimits(p);
      return;
    }
    case 'item/started':
      if (mine(p.threadId) && p.item?.type === 'contextCompaction') db.updateAgent(agentId, { activity_detail: 'compacting' });
      if (mine(p.threadId)) trackJob(agentId, c, p.item, true);
      return;
    case 'item/completed':
      if (mine(p.threadId) && p.item?.type === 'contextCompaction') {
        c.compacting?.();
        c.compacting = undefined;
        db.addEvent(agentId, 'codex:compacted');
      }
      if (mine(p.threadId)) trackJob(agentId, c, p.item, false);
      return;
    case 'thread/tokenUsage/updated': {
      // `last` is the latest model call: its input is the context the model saw. A
      // compaction's own call carries the old history, so it doesn't count.
      if (!mine(p.threadId) || a.activity_detail === 'compacting') return;
      const u = p.tokenUsage;
      const tokens = u?.last?.inputTokens;
      if (typeof tokens === 'number') {
        db.updateAgent(agentId, { context_tokens: tokens, ...(u.modelContextWindow ? { context_window: u.modelContextWindow } : {}) });
        onContext(agentId, tokens);
      }
      recordTokenUsage(a, p);
      return;
    }
  }
}

// Codex app-server error signals for the cost policy (build step 1). Field and value names
// come from `codex app-server generate-json-schema` (codex-cli 0.162.1):
// TurnCompletedNotification -> turn.error.codexErrorInfo (a CodexErrorInfo string, or an
// object variant for connection failures), and AccountRateLimitsUpdatedNotification ->
// rateLimits with rateLimitReachedType and spendControlReached.
const CODEX_ERROR_CLASS: Record<string, ErrorClass> = {
  usageLimitExceeded: 'limit',
  rateLimitExceeded: 'limit',
  // A session budget is exhausted paid usage, like a credit balance.
  sessionBudgetExceeded: 'credits',
  unauthorized: 'auth',
  serverOverloaded: 'transient',
  internalServerError: 'transient',
  // contextWindowExceeded, cyberPolicy, misalignmentPolicyViolation, tooManyDenials,
  // threadRollbackFailed, sandboxError, flexUnavailable, badRequest and other are not
  // signals a retry or the cost policy acts on.
};

// RateLimitReachedType values that mean a limit or a depleted credit balance.
const CODEX_REACHED_CLASS: Record<string, ErrorClass> = {
  rate_limit_reached: 'limit',
  workspace_owner_usage_limit_reached: 'limit',
  workspace_member_usage_limit_reached: 'limit',
  workspace_owner_credits_depleted: 'credits',
  workspace_member_credits_depleted: 'credits',
};

// The object variants of CodexErrorInfo carry the upstream HTTP status in a nested
// `httpStatusCode` (nullable). Classify on that status, since 429/402/401/403 are real cost
// or auth signals; anything else (5xx, null, or unknown) is a retryable provider failure.
function codexStatusClass(status: unknown): ErrorClass {
  if (status === 429) return 'limit';
  if (status === 402) return 'credits';
  if (status === 401 || status === 403) return 'auth';
  return 'transient';
}

function codexErrorClass(info: unknown): ErrorClass | null {
  if (typeof info === 'string') return CODEX_ERROR_CLASS[info] ?? null;
  if (info && typeof info === 'object') {
    // Any object variant that names a status (httpConnectionFailed,
    // responseStreamConnectionFailed, responseStreamDisconnected,
    // responseTooManyFailedAttempts, and any later one) is classified by it; a variant with
    // no status field (activeTurnNotSteerable) is not a cost signal.
    for (const v of Object.values(info as Record<string, any>)) {
      if (v && typeof v === 'object' && 'httpStatusCode' in v) return codexStatusClass(v.httpStatusCode);
    }
  }
  return null;
}

// Accepts the JSON-RPC notification envelope (with `params`) or the params alone, since the
// daemon sees `params` and fixes here carry the envelope the harness sends.
function classifyCodexError(payload: Record<string, any>): ErrorClass | null {
  const p = payload?.params ?? payload ?? {};
  if (p.turn) return p.turn.status === 'failed' ? codexErrorClass(p.turn.error?.codexErrorInfo) : null;
  const rl = p.rateLimits;
  if (rl) {
    const reached = CODEX_REACHED_CLASS[String(rl.rateLimitReachedType)];
    if (reached) return reached;
    if (rl.spendControlReached === true) return 'credits';
  }
  return null;
}

// --- Usage and rate-limit readings (docs/cost-policy.md, build step 3) ---

// `thread/tokenUsage/updated` carries cumulative thread usage. `inputTokens` includes the
// cached and cache-write input (codex-api's ResponseCompletedUsage: total_tokens = input +
// output, and input_tokens_details.cached_tokens / cache_write_tokens are subsets of
// input_tokens, 40 + 60 = 100 in its own test), so the uncached input is the remainder.
// `outputTokens` already includes `reasoningOutputTokens` (output_tokens_details), so
// tokens_out is output alone. Codex reports no cost.
export function recordTokenUsage(agent: Agent, p: Record<string, any>): void {
  const t = p?.tokenUsage?.total;
  if (!t || typeof t.inputTokens !== 'number') return;
  report(agent, {
    tokensIn: Math.max(0, t.inputTokens - (t.cachedInputTokens ?? 0) - (t.cacheWriteInputTokens ?? 0)),
    tokensOut: t.outputTokens ?? 0,
    tokensCacheRead: t.cachedInputTokens ?? 0,
    tokensCacheWrite: t.cacheWriteInputTokens ?? 0,
    session: p.threadId,
  });
}

// Codex reports rate limits per bucket: `account/rateLimits/read` returns the default bucket
// in `rateLimits` plus a `rateLimitsByLimitId` map (codex-rs's own test has `codex` and
// `codex_other`), and `account/rateLimits/updated` is a sparse rolling update for one of
// them. Cache each bucket by its limitId so one never overwrites another, and store the
// default one under the `codex` subscription with the rest beside it as `codex:<limitId>`.
const buckets = new Map<string, Record<string, any>>();
let defaultLimitId = 'codex';

function mergeRateLimits(prev: any, next: any): any {
  if (!next || typeof next !== 'object') return prev;
  const out: Record<string, any> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v == null) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeRateLimits(out[k] ?? {}, v) : v;
  }
  return out;
}

// The subscription name for a bucket: the default bucket is `codex`, the rest `codex:<id>`.
const bucketName = (id: string) => (id === '' ? 'codex' : `codex:${id}`);

// A bucket's windows in the shape the Claude ones use, named as Claude's (five_hour for 300
// minutes, seven_day for 10080) when the duration matches, so the same warn percentages
// apply. Credits and planType ride along as extra keys in the same entry.
function reportBucket(id: string): void {
  const s = buckets.get(id);
  if (!s) return;
  const windows: Record<string, unknown> = {};
  for (const slot of ['primary', 'secondary'] as const) {
    const w = s[slot];
    if (!w || typeof w.usedPercent !== 'number') continue;
    const mins = w.windowDurationMins;
    const name = mins === 300 ? 'five_hour' : mins === 10080 ? 'seven_day' : mins ? `${mins}m` : slot;
    windows[name] = { used_percentage: w.usedPercent, resets_at: w.resetsAt ?? undefined };
  }
  if (s.credits) windows.credits = { hasCredits: s.credits.hasCredits, unlimited: s.credits.unlimited, balance: s.credits.balance ?? null };
  if (s.planType) windows.planType = s.planType;
  if (typeof s.spendControlReached === 'boolean') windows.spendControlReached = s.spendControlReached;
  reportSubscription(bucketName(id), windows);
}

// The bucket an update names: the default bucket and one carrying no limitId share the ''
// key, every other bucket keeps its own.
function bucketKey(s: Record<string, any>): string {
  const id = typeof s.limitId === 'string' ? s.limitId : '';
  return id === '' || id === defaultLimitId ? '' : id;
}

// `account/rateLimits/updated` is a sparse rolling update: merge it into its bucket rather
// than let it clear what it omits (a null field does not clear a known value).
export function recordRateLimits(p: Record<string, any>): void {
  const s = p?.rateLimits;
  if (!s || typeof s !== 'object') return;
  const key = bucketKey(s);
  buckets.set(key, mergeRateLimits(buckets.get(key) ?? {}, s));
  reportBucket(key);
}

// `account/rateLimits/read` is a full snapshot: replace each bucket outright, so a removed
// window or a cleared balance is dropped instead of being merged back in.
export function recordRateLimitsRead(r: Record<string, any>): void {
  const def = r?.rateLimits;
  if (def && typeof def === 'object') {
    defaultLimitId = typeof def.limitId === 'string' ? def.limitId : '';
    buckets.set('', def);
    reportBucket('');
  }
  const byId = r?.rateLimitsByLimitId;
  if (byId && typeof byId === 'object') {
    for (const [id, s] of Object.entries(byId)) {
      if (!s || typeof s !== 'object' || id === '' || id === defaultLimitId) continue; // the default bucket, stored above
      buckets.set(id, s as Record<string, any>);
      reportBucket(id);
    }
  }
}

export const codex: Adapter = {
  name: 'codex',
  upgradeCommand: `${BIN} update`,
  version: () => execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim(),
  classifyError: classifyCodexError,

  async start() {
    await hookTrust().catch((e) => console.error(`codex: can't trust stam's hooks: ${e.message}`));
    for (const a of db.listAgents()) if (running(a)) keepConnected(a.id);
    // One timer for the daemon, not per agent: rate limits are per account, and one shared
    // read every 5 minutes keeps them fresh while any Codex agent runs.
    if (!rateLimitTimer)
      rateLimitTimer = setInterval(() => {
        if (!db.listAgents().some((x) => running(x))) return;
        readRateLimits();
      }, 300_000);
  },

  async afterUpgrade() {
    await hookTrust();
  },

  async launch(agent: Agent, opts: { resume?: boolean } = {}): Promise<LaunchSpec> {
    const dir = agentDir(agent.id);
    const sock = socketPath(agent.id);
    const old = conns.get(agent.id);
    if (old) {
      old.closing = true;
      old.ws.close();
      conns.delete(agent.id);
    }
    // Codex reads user skills from ~/.agents/skills; link ours there (S-889).
    try {
      linkSkills(agentsSkillsDir());
    } catch {}
    await stopStale(sock);
    clearHookWaits(agent.id);
    rmSync(sock, { force: true });
    rmSync(threadFile(agent.id), { force: true });

    const permissions = permissionConfig(agent.permission_mode);
    // A folder Codex hasn't seen asks for trust in the TUI; stam spawned the agent there.
    const trust = { projects: { [agent.cwd]: { trust_level: 'trusted' } } };
    const mcp = codexMcpServers();
    const server = [
      BIN,
      'app-server',
      '--listen',
      `unix://${sock}`,
      ...overrides({
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { model_reasoning_effort: agent.effort } : {}),
        ...permissions,
        ...trust,
        // The network and writable roots a reviewer needs (S-731); empty for other types.
        ...agentSandbox(agent),
        // settings.mcpServers, beside stam's own server.
        ...mcp.overrides,
        // Codex passes MCP servers only an allowlist of variables; env_vars adds stam's.
        'mcp_servers.stam': { command: STAM_BIN, args: ['mcp'], env_vars: ['STAM_AGENT_ID', 'STAM_URL', 'STAM_TOKEN'], default_tools_approval_mode: 'approve' },
        'hooks.state': await hookTrust(),
      }),
      ...hookArgs(),
    ];
    // The TUI always resumes the thread the daemon opened (see afterLaunch), which has its
    // permissions from the daemon; a TUI resuming a remote thread refuses permission overrides.
    const tui = [BIN, 'resume', '"$THREAD"', '--remote', `unix://${sock}`, ...overrides({ ...trust, check_for_update_on_startup: false })];

    // The app-server runs in the background of the agent's tmux session and stops with it.
    // Server env values and remote header values go in its environment here, never on its
    // command line (see codexMcpServers), so the file is private to the user.
    const script = join(dir, 'codex-launch.sh');
    const q = (argv: string[]) => argv.map((a) => (a === '"$THREAD"' ? a : tmux.shellQuote(a))).join(' ');
    const assigns = Object.entries(mcp.env).map(([k, v]) => `${k}=${tmux.shellQuote(v)}`).join(' ');
    const tf = tmux.shellQuote(threadFile(agent.id));
    writeFileSync(
      script,
      `#!/bin/sh
# Generated by stam for agent ${agent.name} (${agent.id}): starts this agent's Codex
# app-server, then, once the daemon has opened the agent's thread on it, the Codex TUI
# attached to that thread. The server stops when the TUI exits.
${assigns ? assigns + ' ' : ''}${q(server)} >> ${tmux.shellQuote(join(dir, 'codex-server.log'))} 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT HUP INT TERM
i=0
while [ ! -s ${tf} ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done
[ -s ${tf} ] || { echo "stam did not open this agent's Codex thread; see the daemon log"; exit 1; }
THREAD=$(cat ${tf})
${q(tui)}
`,
      { mode: 0o600 },
    );
    return { argv: ['sh', script], env: {}, fields: opts.resume ? {} : { session_id: null } };
  },

  // Opens the agent's thread on its app-server, with the system prompt, for the TUI to
  // resume; then waits for the TUI and starts the first turn with `prompt`.
  async afterLaunch(agent: Agent, prompt?: string, opts: { resume?: boolean; admit?: () => boolean } = {}) {
    for (let i = 0; !existsSync(socketPath(agent.id)); i++) {
      if (i > 150 || !tmux.hasSession(agent.id) || tmux.isDead(agent.id)) throw new Error('Codex app-server did not start');
      await sleep(100);
    }
    await loadOwned(agent.id);
    await warmLessons(agent);
    const opened = await openThread(agent, opts.resume ? agent.session_id : null);
    // S-759: a resume that found no rollout starts the agent fresh, so it gets the first prompt
    // its spawn stored, not the note of a resume whose conversation never existed.
    if (opened.fresh && opts.resume) prompt = agent.first_prompt ?? prompt;
    writeFileSync(threadFile(agent.id), opened.id);
    await waitForTui(agent);
    if (prompt) {
      if (opts.admit && !opts.admit()) return;
      if (!(await codex.pushPrompt(db.getAgent(agent.id)!, prompt))) throw new Error('no Codex thread to prompt');
      return;
    }
    const a = db.getAgent(agent.id);
    if (a?.activity === 'starting') {
      db.updateAgent(agent.id, { activity: 'idle', activity_detail: 'ready' });
      schedulePush(agent.id);
    }
  },

  onHook(agent: Agent, p: Record<string, any>): HookResult {
    // Subagents run in the same app-server; only the agent's own thread counts. Their hooks
    // carry the parent's session_id, and `agent_id`, which Codex's hook input schema
    // (0.162.1) marks optional and sets for a sub-agent. And while the daemon follows the
    // app-server, the agent's own thread reports its turns there first, so a tool hook while
    // the agent is idle or waiting is a sub-agent's (seen live: a sub-agent outliving the
    // turn made the agent 'working' again).
    const own = (!agent.session_id || p.session_id === agent.session_id) && !p.agent_id;
    const tool = own && !(conns.get(agent.id)?.subscribed && (agent.activity === 'idle' || agent.activity === 'waiting'));
    switch (p.hook_event_name) {
      case 'SessionStart':
        // A new thread (/clear in the TUI) becomes the agent's session. The TUI started it,
        // without stam's system prompt, so the prompt comes in as the hook's context.
        if (!own && p.source !== 'clear') return {};
        if (own) return { session_id: p.session_id, transcript_path: p.transcript_path ?? undefined };
        resubscribe(agent.id);
        return {
          session_id: p.session_id,
          transcript_path: p.transcript_path ?? undefined,
          stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: systemPrompt(agent) } }),
        };
      case 'UserPromptSubmit':
        return own ? { activity: 'working', detail: null } : {};
      case 'PreToolUse':
        return tool ? { activity: 'working', detail: `tool ${p.tool_name}` } : {};
      case 'PostToolUse':
        return tool ? { activity: 'working', detail: null, afterTool: true } : {};
      case 'Stop':
        if (!own || conns.get(agent.id)?.subscribed) return {};
        return { activity: 'idle', detail: 'turn finished', turnEnded: true };
      default:
        return {};
    }
  },

  inTurnNotice(text: string): string {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
  },

  // turn/start from stam's own connection: the TUI shows the turn, and whatever the human
  // has typed in its input stays there.
  async pushPrompt(agent: Agent, text: string): Promise<boolean> {
    const c = await ready(agent.id);
    const id = await threadId(agent.id, c);
    if (!id) return false;
    const { sandbox, ...perm } = permissionParams(agent.permission_mode);
    await call(c, 'turn/start', { threadId: id, input: [{ type: 'text', text, text_elements: [] }], ...perm });
    return true;
  },

  // The agent's app-server and TUI can outlive the tmux session (see stopStale): stop
  // whatever still names its socket, and confirm nothing does.
  async stop(agent: Agent): Promise<void> {
    const old = conns.get(agent.id);
    if (old) {
      old.closing = true;
      old.ws.close();
      conns.delete(agent.id);
    }
    const sock = socketPath(agent.id);
    await stopStale(sock);
    const pattern = `unix://${sock}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (spawnSync('pgrep', ['-f', pattern]).status === 0) throw new Error(`Codex for ${agent.name} still runs on ${sock}`);
  },

  // turn/interrupt {threadId, turnId} (app-server schema of codex-cli 0.162.1). The turn id
  // comes from turn/started, or, on a connection that opened mid-turn, from the newest turn
  // in thread/turns/list. The turn ends with turn/completed status 'interrupted'; on a
  // connection that saw no turn/started, nothing confirms it, so that returns false.
  async interrupt(agent: Agent): Promise<boolean> {
    const c = await ready(agent.id);
    const id = await threadId(agent.id, c);
    if (!id) return false;
    let turnId = c.turnId;
    if (!turnId) {
      const r = await call(c, 'thread/turns/list', { threadId: id, limit: 1 }).catch(() => undefined);
      const t = r?.data?.[0];
      if (t?.status === 'inProgress') turnId = t.id;
    }
    if (!turnId) return false;
    const seen = c.turnId === turnId;
    await call(c, 'turn/interrupt', { threadId: id, turnId });
    if (!seen) return false;
    // Confirmed by the turn/completed that clears it.
    for (let i = 0; i < 20; i++) {
      if (c.turnId !== turnId) return true;
      await sleep(250);
    }
    return false;
  },

  // thread/compact/start takes no instructions, so they go into the history first as a
  // developer message the summary can follow. Resolves when the compaction is done.
  async compact(agent: Agent, instructions?: string) {
    const c = await ready(agent.id);
    const id = await threadId(agent.id, c);
    if (!id) throw new Error(`${agent.name} has no Codex thread yet`);
    if (instructions) {
      const item = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `When this conversation is compacted, the summary must keep: ${instructions}` }] };
      await call(c, 'thread/inject_items', { threadId: id, items: [item] }).catch((e) => db.addEvent(agent.id, 'codex:inject-error', String(e)));
    }
    const done = new Promise<void>((resolve) => (c.compacting = resolve));
    await call(c, 'thread/compact/start', { threadId: id });
    await Promise.race([done, sleep(600_000)]);
    return { relaunch: false };
  },

  async reconnectMcp(agent: Agent, opts: { proceed?: () => boolean } = {}): Promise<boolean> {
    const c = await ready(agent.id);
    if (opts.proceed && !opts.proceed()) return true;
    await call(c, 'config/mcpServer/reload', undefined);
    return true;
  },
};

// turn/steer into the running turn (expectedTurnId is the precondition the app-server
// checks); with no turn running, the same turn/start as pushPrompt.
export async function steerPrompt(agent: Agent, text: string): Promise<boolean> {
  const c = await ready(agent.id);
  const id = await threadId(agent.id, c);
  if (!id) return false;
  if (!c.turnId) return codex.pushPrompt(agent, text);
  await call(c, 'turn/steer', { threadId: id, expectedTurnId: c.turnId, input: [{ type: 'text', text, text_elements: [] }] });
  return true;
}
