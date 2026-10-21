import { join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { STAM_BIN, STAM_HOME, STAM_URL, ROOT } from '../config.ts';
import * as db from '../db.ts';
import { mintServerToken } from '../agent-token.ts';
import { signal as costSignal } from '../rules.ts';
import type { Agent, Activity } from '../db.ts';
import type { Adapter, ErrorClass, LaunchSpec } from './types.ts';
import * as tmux from '../tmux.ts';
import { schedulePush } from '../mail.ts';
import { onIdle, dropRestRequest } from '../lifecycle.ts';
import { onContext, setCompactInstructions } from '../context.ts';
import { report } from '../usage.ts';
import { pollCreditsAfterTurn } from '../credits.ts';
import * as secrets from '../secrets.ts';
import { secretCommandPatterns, secretPaths } from '../secret-files.ts';
import { ingestSoon } from '../activity.ts';
import { indexTurnsSoon } from '../turn-vectors.ts';
import { extraMcpServers, linkSkills } from '../instructions.ts';
import { replaceHookWaits, type HookWait } from './hook-waits.ts';
import { opencodeProviders } from './opencode-providers.ts';
import { settings } from '../settings.ts';
import { registry } from '../registry.ts';
import { envVar } from '../env.ts';

// stam runs its own OpenCode server, so it needs no access to the user's background
// service. Every stam OpenCode agent is a TUI attached to this server.
const PORT = Number(envVar('OPENCODE_PORT') ?? 4790);
const SERVER = `http://127.0.0.1:${PORT}`;
const SERVER_SESSION = '_opencode';
const BIN = envVar('OPENCODE_BIN') ?? (existsSync(join(homedir(), '.opencode/bin/opencode')) ? join(homedir(), '.opencode/bin/opencode') : 'opencode');
const CONFIG_DIR = join(STAM_HOME, 'opencode');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function password(): string {
  const f = join(STAM_HOME, 'opencode-password');
  if (!existsSync(f)) writeFileSync(f, randomBytes(18).toString('base64url'), { mode: 0o600 });
  return readFileSync(f, 'utf8').trim();
}

// Each secret file as a session may name it: absolute, by its real path where a symlink holds it, and
// relative to the agent's folder. OpenCode names a file relative to the session's directory, in its
// project or not (`../stam/token`), and which folder is its project doesn't matter here: a relative
// name for a secret file reaches only that file, so naming every secret from every folder denies
// the ones OpenCode will name, whatever project it finds (a core.worktree, a .hg, or none). The
// folder is given and real, since a symlinked cwd is named either way. This guards canonical-path
// reads only; it is no boundary against an agent that means to read the file (see docs/status).
function secretResources(cwd?: string): string[] {
  const abs = secretPaths();
  if (!cwd) return abs;
  const secrets = [...new Set([...abs, ...abs.map(realOrSelf)])];
  const given = resolve(cwd);
  const dirs = [...new Set([given, realOrSelf(given)])];
  return [...new Set([...secrets, ...dirs.flatMap((d) => secrets.map((p) => relative(d, p)))])];
}

// A path's real path, or the path itself when it doesn't exist.
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// A new session's permission rules: every tool allowed in bypass, asked in 'default' (S-1967), and
// OpenCode's own rules in auto. A resume re-applies them; see permission-modes.ts's switchesInPlace.
// The secret files (S-1888) are denied in every mode: OpenCode takes the session's rules after its
// own (the last matching rule wins), so a deny here holds over the allow of bypass and the asks of
// default, and in auto it adds to OpenCode's own rules without replacing them.
// `cwd` is the agent's folder: OpenCode names a file inside it, or inside its project root, relative to
// that folder, so those forms are denied too (S-1891 review).
export function sessionPermissions(mode: string, cwd?: string): { action: string; resource: string; effect: string }[] {
  const denies = secretResources(cwd).flatMap((p) => [
    { action: 'read', resource: p, effect: 'deny' },
    { action: 'edit', resource: p, effect: 'deny' },
  ]);
  const shell = secretCommandPatterns().map((p) => ({ action: 'shell', resource: p, effect: 'deny' }));
  const modeRule = mode === 'bypass' ? [{ action: '*', resource: '*', effect: 'allow' }] : mode === 'default' ? [{ action: '*', resource: '*', effect: 'ask' }] : [];
  return [...modeRule, ...denies, ...shell];
}

export async function oc(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(SERVER + path, {
    method,
    headers: { authorization: 'Basic ' + Buffer.from(`opencode:${password()}`).toString('base64'), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenCode ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  // v2 wraps responses as { data }.
  const json = text ? JSON.parse(text) : {};
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

async function healthy(): Promise<boolean> {
  try {
    await oc('GET', '/openapi.json');
    return true;
  } catch {
    return false;
  }
}

// settings.mcpServers translated from Claude Code's format to OpenCode's, plus stam's
// own. A remote server's headers pass through; a disabled one never reaches extraMcpServers.
export function opencodeMcpServers(): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(extraMcpServers()))
    servers[name] = s.auth
      ? { type: 'local', command: [STAM_BIN, 'mcp-proxy', name] }
      : s.url
        ? { type: 'remote', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
        : { type: 'local', command: [s.command, ...(s.args ?? [])], environment: s.env };
  servers.stam = { type: 'local', command: [STAM_BIN, 'mcp'] };
  return servers;
}

// settings.providers as OpenCode provider blocks and the env that carries their keys (S-2118).
function providers(): ReturnType<typeof opencodeProviders> {
  try {
    const r = opencodeProviders(settings().providers, registry());
    if (r.collisions.length) console.error(`opencode: providers ${r.collisions.join(', ')} share a key variable; none of them is configured`);
    return r;
  } catch {
    return { blocks: {}, env: {}, collisions: [] };
  }
}

// The plugin and config are rewritten on every daemon start; OpenCode reloads them.
function writeConfig(): void {
  mkdirSync(join(CONFIG_DIR, 'plugins', 'stam'), { recursive: true });
  copyFileSync(join(ROOT, 'src/adapters/opencode-plugin/index.ts'), join(CONFIG_DIR, 'plugins/stam/index.ts'));
  const { blocks } = providers();
  writeFileSync(
    join(CONFIG_DIR, 'opencode.json'),
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...(Object.keys(blocks).length ? { provider: blocks } : {}), mcp: { servers: opencodeMcpServers() } }, null, 2),
  );
  linkSkills(join(CONFIG_DIR, 'skills'));
}

// One check or start at a time: at boot the adapter's start, the event stream's
// reconnect, and resumed agents' launches all ask for the server at once.
let ensuring: Promise<void> | undefined;
function ensureServer(): Promise<void> {
  ensuring ??= startServer().finally(() => (ensuring = undefined));
  return ensuring;
}

async function startServer(): Promise<void> {
  if (tmux.hasSession(SERVER_SESSION) && !tmux.isDead(SERVER_SESSION) && (await healthy())) return;
  writeConfig();
  tmux.killSession(SERVER_SESSION);
  // The server's own token (S-240), not the shared one: an OpenCode agent acts only as itself.
  const token = mintServerToken();
  tmux.newSession(
    SERVER_SESSION,
    STAM_HOME,
    { ...providerEnv(), ...providers().env, OPENCODE_SERVER_PASSWORD: password(), OPENCODE_CONFIG_DIR: CONFIG_DIR, ...{ STAM_URL, STAM_TOKEN: token } },
    [BIN, 'serve', '--hostname', '127.0.0.1', '--port', String(PORT)],
  );
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await healthy()) return;
  }
  throw new Error('OpenCode server did not start');
}

// Provider keys for stam's OpenCode server, such as OPENROUTER_API_KEY: the secret store's
// `agent` slot over the KEY=VALUE lines of STAM_HOME/opencode.env (S-2114). Lets a machine run
// OpenCode without the user's own OpenCode login.
function providerEnv(): Record<string, string> {
  return secrets.agentEnv();
}

function agentForSession(sid: string | undefined): Agent | undefined {
  return sid ? db.getAgentBySession(sid) : undefined;
}

async function updateContext(agent: Agent): Promise<void> {
  try {
    const s = await oc('GET', `/api/session/${agent.session_id}`);
    if (s?.tokens) {
      report(agent, {
        cost: s.cost,
        tokensIn: s.tokens.input ?? 0,
        tokensOut: (s.tokens.output ?? 0) + (s.tokens.reasoning ?? 0),
        tokensCacheRead: s.tokens.cache?.read ?? 0,
        tokensCacheWrite: s.tokens.cache?.write ?? 0,
        session: agent.session_id,
        sessionCumulative: true,
      });
    }
  } catch {}
  try {
    const r = await oc('GET', `/api/session/${agent.session_id}/message?type=assistant&order=desc&limit=1`);
    const m = (Array.isArray(r) ? r : (r.items ?? []))[0];
    const t = m?.tokens;
    if (t) {
      const tokens = (t.input ?? 0) + (t.cache?.read ?? 0);
      db.updateAgent(agent.id, { context_tokens: tokens });
      onContext(agent.id, tokens);
    }
  } catch {}
}

// Maps the server's event stream to agent states. Reconnects forever.
async function followEvents(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(SERVER + '/api/event', {
        headers: { authorization: 'Basic ' + Buffer.from(`opencode:${password()}`).toString('base64') },
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      seedJobs();
      let buf = '';
      for await (const chunk of res.body as any) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (data) onEvent(JSON.parse(data));
        }
      }
    } catch {}
    await sleep(2000);
    await ensureServer().catch(() => {});
  }
}

// Waits OpenCode creates (source 'hook', kind 'job'): background shells and sub-agents still
// running when the agent's execution ends. Seen live on v2.0.26: every shell the server
// runs, foreground or background, is `shell.created` with its session in
// `info.metadata.sessionID` and ends with `shell.exited`; a sub-agent is a child session
// (`session.created` with `parentID`) whose own `session.execution.*` events say whether it
// runs. Foreground ones end inside the parent's execution, so what still runs when it ends
// is background work. When background work ends, OpenCode queues a completion notice
// (`<shell ...>` or `<subagent ...>`) that starts a new execution of the parent, so the wait
// stays until that execution starts, rather than passing through idle; if none has started
// within JOB_GRACE_MS (not seen, only a safeguard), the wait clears anyway. OpenCode has no
// timers to report. Shells die with the server: each (re)connect to it reads the running
// shells (`GET /api/shell`), child sessions, and active sessions, and replaces the hook
// waits of agents between executions.
const JOB_GRACE_MS = 30_000;
const shells = new Map<string, { session: string; command: string }>();
const children = new Map<string, { parent: string; title: string; running: boolean }>();

function runningJobs(session: string): HookWait[] {
  const out: HookWait[] = [];
  for (const [id, s] of shells) if (s.session === session) out.push({ target: id, detail: `background command "${s.command}"`, data: { type: 'shell' } });
  for (const [id, ch] of children) if (ch.parent === session && ch.running) out.push({ target: id, detail: `sub-agent "${ch.title}"`, data: { type: 'subagent' } });
  return out;
}

function syncJobWaits(agent: Agent): void {
  if (agent.session_id) replaceHookWaits(agent.id, 'job', runningJobs(agent.session_id));
}

function jobEnded(session: string, target: string): void {
  const agent = agentForSession(session);
  if (!agent) return;
  setTimeout(() => {
    const a = db.getAgent(agent.id);
    if (a?.activity === 'waiting') db.clearWaits(a.id, 'job', target);
  }, JOB_GRACE_MS).unref();
}

// Follows shells and child sessions, which aren't the agent's own session.
function trackJobs(ev: { type: string; data?: any }): void {
  const d = ev.data ?? {};
  if (touched) for (const id of [d.info?.id, ev.type.startsWith('shell.') ? d.id : undefined, ev.type.startsWith('session.') ? d.sessionID : undefined]) if (id) touched.add(id);
  switch (ev.type) {
    case 'shell.created':
      if (d.info?.id && d.info.metadata?.sessionID) shells.set(d.info.id, { session: d.info.metadata.sessionID, command: d.info.command ?? '' });
      return;
    case 'shell.exited': {
      const s = shells.get(d.id);
      if (s && shells.delete(d.id)) jobEnded(s.session, d.id);
      return;
    }
    case 'session.created':
      if (d.parentID && d.sessionID) children.set(d.sessionID, { parent: d.parentID, title: d.title ?? d.slug ?? d.sessionID, running: false });
      return;
    case 'session.execution.started': {
      const ch = children.get(d.sessionID);
      if (ch) ch.running = true;
      return;
    }
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      const ch = children.get(d.sessionID);
      if (ch?.running) {
        ch.running = false;
        jobEnded(ch.parent, d.sessionID);
      }
      return;
    }
  }
}

// Reads what the server runs now; see trackJobs. Shells are listed per directory. The
// reads take a while and events keep coming: a shell or child session an event touched
// after the reads began keeps what the event said, so a stale read can't revive it.
let seeding: Promise<void> | undefined;
let touched: Set<string> | undefined;
export function seedJobs(): Promise<void> {
  seeding ??= readJobs().finally(() => {
    seeding = undefined;
    touched = undefined;
  });
  return seeding;
}

async function readJobs(): Promise<void> {
  touched = new Set();
  try {
    const agents = db.listAgents().filter((a) => a.harness === 'opencode' && a.session_id);
    const active = new Set(Object.keys((await oc('GET', '/api/session/active')) ?? {}));
    const nowShells = new Map<string, { session: string; command: string }>();
    const nowChildren = new Map<string, { parent: string; title: string; running: boolean }>();
    for (const dir of new Set(agents.map((a) => a.cwd))) {
      const r = await oc('GET', `/api/shell?${encodeURIComponent('location[directory]')}=${encodeURIComponent(dir)}`);
      for (const s of r ?? []) if (s.status === 'running' && s.metadata?.sessionID) nowShells.set(s.id, { session: s.metadata.sessionID, command: s.command ?? '' });
    }
    for (const a of agents) {
      const r = await oc('GET', `/api/session?parentID=${encodeURIComponent(a.session_id!)}`);
      for (const s of Array.isArray(r) ? r : (r?.items ?? [])) nowChildren.set(s.id, { parent: a.session_id!, title: s.title ?? s.id, running: active.has(s.id) });
    }
    for (const [map, now] of [[shells, nowShells], [children, nowChildren]] as [Map<string, any>, Map<string, any>][]) {
      for (const id of map.keys()) if (!now.has(id) && !touched.has(id)) map.delete(id);
      for (const [id, v] of now) if (!touched.has(id)) map.set(id, v);
    }
    for (const a of agents) {
      const now = db.getAgent(a.id);
      if (now && (now.activity === 'idle' || now.activity === 'waiting')) syncJobWaits(now);
    }
  } catch (e) {
    console.error(`opencode: can't read running jobs: ${(e as Error).message}`);
  }
}

// Other readers of the server's event stream: stam's own agent view (opencode-view.ts).
export const eventListeners = new Set<(ev: { type: string; data?: any }) => void>();

export function onEvent(ev: { type: string; data?: any }): void {
  for (const l of eventListeners) {
    try {
      l(ev);
    } catch (e) {
      console.error(`opencode: event listener failed on ${ev.type}: ${(e as Error).message}`);
    }
  }
  trackJobs(ev);
  const d = ev.data ?? {};
  const agent = agentForSession(d.sessionID ?? d.sessionId);
  if (!agent) return;
  const set = (activity: Activity, detail: string | null = null) => {
    db.updateAgent(agent.id, { activity, activity_detail: detail });
    db.addEvent(agent.id, `opencode:${ev.type}`, { activity, detail });
  };
  switch (ev.type) {
    case 'session.execution.started':
      dropRestRequest(agent.id); // a new turn: the rest its last turn asked for no longer holds (S-2237)
      set('working');
      // A completion notice starts this execution; the work it reports is over.
      return syncJobWaits(agent);
    case 'session.tool.called':
      return set('working', 'running a tool');
    case 'permission.asked':
      return set('blocked', d.action === 'question' ? 'question' : `permission ${d.action ?? ''}`.trim());
    case 'form.created':
      return set('blocked', 'question');
    case 'session.execution.succeeded':
    case 'session.execution.interrupted':
      // Waits first, so an execution that leaves work running ends in 'waiting', never idle.
      syncJobWaits(agent);
      set('idle', ev.type.endsWith('interrupted') ? 'interrupted' : 'turn finished');
      updateContext(agent);
      schedulePush(agent.id);
      pollCreditsAfterTurn(agent);
      // The turn's items for the timeline (S-1008): OpenCode has no Stop hook to ingest on.
      ingestSoon(agent.id);
      indexTurnsSoon(agent.id);
      return void onIdle(agent.id).catch((e) => db.addEvent(agent.id, 'pending-error', String(e)));
    case 'session.execution.failed': {
      const cls = classifyOpenCodeError(ev);
      if (cls) costSignal(agent.id, { source: ev.type, class: cls, error: d.error?.type, status: d.error?.status });
      set('errored', String(d.error?.message ?? d.error?.type ?? 'failed'));
      return ingestSoon(agent.id);
    }
    case 'session.compaction.started':
      return set('working', 'compacting');
  }
}

// OpenCode provider errors for the cost policy (build step 1). The event is
// `session.execution.failed` with `data.error` as OpenCode serializes it
// ({ type, message, status?, response? }); `status` is the API status the design names
// (402 credits, 429 rate limit). OpenCode maps 402 to `provider.quota`, 429 to
// `provider.rate-limit`, 401/403 to `provider.auth`, and network/5xx to
// `provider.transport`/`provider.internal`/`provider.timeout` (verified in opencode v2.0.26).
const OPENCODE_ERROR_CLASS: Record<string, ErrorClass> = {
  'provider.rate-limit': 'limit',
  'provider.quota': 'credits',
  'provider.auth': 'auth',
  'provider.transport': 'transient',
  'provider.connect': 'transient',
  'provider.internal': 'transient',
  'provider.timeout': 'transient',
};

function opencodeStatusClass(status: unknown): ErrorClass | null {
  if (typeof status !== 'number') return null;
  if (status === 402) return 'credits';
  if (status === 429) return 'limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 409 || status >= 500) return 'transient';
  return null;
}

function classifyOpenCodeError(payload: Record<string, any>): ErrorClass | null {
  if (payload?.type !== 'session.execution.failed') return null;
  const error = payload.data?.error ?? payload.error;
  if (!error) return null;
  return OPENCODE_ERROR_CLASS[String(error.type)] ?? opencodeStatusClass(error.status);
}

// How many times stop() interrupts a session before it gives up, and how long each attempt
// waits for the server to list the session as idle.
const STOP_ATTEMPTS = 6;
const CONFIRM_POLLS = 10;

// Whether the server still lists the session as active.
async function isActive(sid: string): Promise<boolean> {
  return Object.keys((await oc('GET', '/api/session/active')) ?? {}).includes(sid);
}

// Interrupts the session up to `attempts` times, confirming after each one that the server
// no longer lists it. An interrupt that errors counts as an attempt and is retried.
// `keep` (when given) is asked before each attempt: false means the session is wanted again,
// so no more interrupts; the result is then whether the session is idle, as usual.
export async function interruptSession(sid: string, attempts: number, keep?: () => boolean): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (keep && !keep()) break;
    await oc('POST', `/api/session/${sid}/interrupt`).catch(() => {});
    for (let p = 0; p < CONFIRM_POLLS; p++) {
      await sleep(250);
      if (!(await isActive(sid).catch(() => true))) return true;
    }
  }
  return !(await isActive(sid).catch(() => true));
}

export const opencode: Adapter = {
  name: 'opencode',
  upgradeCommand: `${BIN} upgrade`,
  version: () => execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim(),
  classifyError: classifyOpenCodeError,

  async afterUpgrade() {
    tmux.killSession(SERVER_SESSION);
    writeConfig();
    await ensureServer();
  },

  // Follows events even if the first start fails (at boot, say, before the network is
  // up): followEvents retries the server for as long as the daemon runs.
  async start() {
    writeConfig();
    try {
      await ensureServer();
    } finally {
      followEvents();
    }
  },

  async launch(agent: Agent, opts: { resume?: boolean } = {}): Promise<LaunchSpec> {
    await ensureServer();
    if (opts.resume && agent.session_id) {
      // A session keeps the permissions it was made with, so one made before the secret denies (S-1891)
      // gets them at its resume. session.update takes the same permissions as a new session.
      await oc('PATCH', `/api/session/${agent.session_id}`, { permissions: sessionPermissions(agent.permission_mode, agent.cwd) });
      const argv = [BIN, '--server', SERVER, '--session', agent.session_id];
      return { argv, env: { OPENCODE_SERVER_PASSWORD: password() } };
    }
    let model = null;
    if (agent.model) {
      const [providerID, ...rest] = agent.model.split('/');
      model = { providerID, id: rest.join('/') };
    }
    const permissions = sessionPermissions(agent.permission_mode, agent.cwd);
    const s = await oc('POST', '/api/session', { title: agent.name, location: { directory: agent.cwd }, model, permissions, metadata: { stam_agent: agent.id } });
    const argv = [BIN, '--server', SERVER, '--session', s.id];
    return { argv, env: { OPENCODE_SERVER_PASSWORD: password() }, fields: { session_id: s.id } };
  },

  // The first prompt goes to the session through the server's API rather than the TUI's
  // --prompt flag, which would put it on a command line. OpenCode sends no event until
  // the first turn, so an agent started without a prompt counts as idle once its TUI is up.
  async afterLaunch(agent: Agent, prompt?: string, opts: { admit?: () => boolean } = {}) {
    await sleep(2000);
    if (prompt) {
      if (!tmux.hasSession(agent.id) || tmux.isDead(agent.id)) throw new Error('the OpenCode TUI exited');
      if (opts.admit && !opts.admit()) return;
      await oc('POST', `/api/session/${db.getAgent(agent.id)!.session_id}/prompt`, { text: prompt, delivery: 'queue' });
      return;
    }
    const a = db.getAgent(agent.id);
    if (a?.activity === 'starting' && a.activity_detail !== 'with prompt' && tmux.hasSession(agent.id) && !tmux.isDead(agent.id)) {
      db.updateAgent(agent.id, { activity: 'idle', activity_detail: 'ready' });
      schedulePush(agent.id);
    }
  },

  async compact(agent: Agent, instructions?: string) {
    setCompactInstructions(agent.id, instructions);
    await oc('POST', `/api/session/${agent.session_id}/compact`, {});
    return { relaunch: false };
  },

  // The server keeps one MCP client per directory, and connect replaces the one for the
  // directory it names (the server's own without one), so it names the agent's.
  mcpScope: (agent: Agent) => agent.cwd,

  async reconnectMcp(agent: Agent, opts: { proceed?: () => boolean } = {}): Promise<boolean> {
    if (opts.proceed && !opts.proceed()) return true;
    await oc('POST', `/api/experimental/mcp/stam/connect?${encodeURIComponent('location[directory]')}=${encodeURIComponent(agent.cwd)}`, {});
    return true;
  },

  // Whether the shared server still lists the agent's session as active: its TUI can die with
  // its tmux session while the turn runs on in the server (S-578). Throws when the server can't
  // be asked, so the caller treats the state as unknown, not as dead.
  async turnRunning(agent: Agent): Promise<boolean> {
    if (!agent.session_id) return false;
    return isActive(agent.session_id);
  },

  // OpenCode v2's session interrupt (POST /api/session/:id/interrupt, in the server's
  // openapi.json on v2.0.26; v1's /session/:id/abort is gone from the /api surface). The
  // server then sends session.execution.interrupted, which marks the agent idle. Confirmed
  // when the server no longer lists the session as active.
  async interrupt(agent: Agent): Promise<boolean> {
    if (!agent.session_id) return false;
    return interruptSession(agent.session_id, 1);
  },

  // The TUI dies with the tmux session, but the turn runs in the shared server: interrupt the
  // session there, retrying, until the server no longer lists it as active. Throws when it
  // still runs after the last attempt.
  async stop(agent: Agent, opts: { keep?: () => boolean } = {}): Promise<void> {
    if (!agent.session_id) return;
    if (await interruptSession(agent.session_id, STOP_ATTEMPTS, opts.keep)) return;
    if (opts.keep && !opts.keep()) return;
    throw new Error(`OpenCode still runs ${agent.name}'s session ${agent.session_id}`);
  },

  async pushPrompt(agent: Agent, text: string): Promise<boolean> {
    if (!agent.session_id) return false;
    await oc('POST', `/api/session/${agent.session_id}/prompt`, { text, delivery: 'queue' });
    return true;
  },
};
