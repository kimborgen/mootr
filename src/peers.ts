// Other machines' stam daemons. Each daemon owns the agents on its machine and their
// mail; a request about an agent elsewhere goes to the daemon that owns it. Peers are
// listed in settings.json as { name, url, token }. Requests between daemons carry
// `x-stam-local: 1`, which stops them from fanning out again.
import type { ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from './settings.ts';
import { MACHINE, RELEASE, STAM_HOME } from './config.ts';
import * as db from './db.ts';
import { timed } from './stall.ts';

export interface Peer {
  name: string;
  url: string;
  token: string;
  // The token this peer's daemon accepts from daemons (its STAM_HOME/peer-token, S-545); `token` is the fallback.
  peerToken?: string;
  // A shell command that starts the machine when it is down, such as a script that boots it.
  start?: string;
  // A shell command that deploys a release to the machine (S-236); it gets STAM_RELEASE and STAM_PEER.
  deploy?: string;
}

// The agent a forwarded request acts as (S-239): the agent whose own token the forwarding daemon
// verified, and whether it is that daemon's chief of staff or assistant (the peer can't tell).
export interface Via {
  agent: string;
  boss: boolean;
  // Whether it is the assistant, not the chief of staff: only the assistant kills, renames, reparents, forgets there.
  assistant?: boolean;
  // The caller's daemon's answer to who owns a branch (branch-scope.ts, S-581): sent with a pr_open or a
  // branch link, and read only from a peer.
  scope?: 'tree' | 'foreign' | 'none';
}

// The headers that name the agent a forwarded request acts as; none for a daemon's own calls.
function viaHeaders(via?: Via): Record<string, string> {
  return via ? { 'x-stam-agent': via.agent, ...(via.boss ? { 'x-stam-agent-boss': '1' } : {}), ...(via.assistant ? { 'x-stam-agent-assistant': '1' } : {}), ...(via.scope ? { 'x-stam-branch-scope': via.scope } : {}) } : {};
}

export function peers(): Peer[] {
  return settings().peers ?? [];
}

export function peerByName(name: string): Peer | undefined {
  return peers().find((p) => p.name === name);
}

// A peer that failed is skipped by lists until a probe in the background reaches it again, every
// 30 seconds, so a stopped machine slows only the request that found it down, not one request
// per retry. A direct call to a down peer probes it first (S-256), with the short CHECK_MS.
const PROBE_MS = Number(process.env.STAM_PEER_PROBE_MS) || 30_000;
const CHECK_MS = Number(process.env.STAM_PEER_CHECK_MS) || 2000;
const down = new Map<string, number>();
const checking = new Map<string, Promise<boolean>>();

const peerFetch = (p: Peer, method: string, path: string, body: unknown, timeoutMs: number, human = false, via?: Via) =>
  fetch(p.url.replace(/\/$/, '') + path, {
    method,
    headers: { authorization: `Bearer ${p.peerToken || p.token}`, 'content-type': 'application/json', 'x-stam-local': '1', ...(human ? { 'x-stam-human': '1' } : {}), ...viaHeaders(via) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

// Whether the peer answers /api/health, shared by callers that arrive while one is in flight.
// Any answer means the peer is back, whatever its status.
function checkUp(p: Peer): Promise<boolean> {
  let c = checking.get(p.name);
  if (!c) {
    c = peerFetch(p, 'GET', '/api/health', undefined, CHECK_MS).then(
      () => {
        down.delete(p.name);
        return true;
      },
      () => {
        down.set(p.name, Date.now() + PROBE_MS);
        return false;
      },
    );
    c.finally(() => checking.delete(p.name));
    checking.set(p.name, c);
  }
  return c;
}

export async function peerCall(p: Peer, method: string, path: string, body?: unknown, timeoutMs = 8000, human = false, via?: Via): Promise<{ status: number; data: any }> {
  // A down peer is probed first, so a slow real call after it comes back still gets its full timeout.
  if (down.has(p.name) && !(await checkUp(p))) throw new Error(`${p.name} is unreachable`);
  let res;
  try {
    res = await peerFetch(p, method, path, body, timeoutMs, human, via);
  } catch (e) {
    down.set(p.name, Date.now() + PROBE_MS);
    throw e;
  }
  down.delete(p.name);
  const text = await res.text();
  // A peer's whole reply is parsed on the loop; labelled for the stall watch (src/stall.ts).
  return { status: res.status, data: text ? timed(`peer parse ${p.name}`, () => JSON.parse(text)) : {} };
}

// A GET whose reply is streamed on, such as a file's bytes (S-1525): the peer's response, or undefined when
// the peer is down (a probe first, so a stopped machine answers at once, not after a timeout).
export async function peerRaw(p: Peer, path: string, headers: Record<string, string>, human: boolean): Promise<Response | undefined> {
  if (down.has(p.name) && !(await checkUp(p))) return undefined;
  // The time limit covers the connection and the headers only, not the body that follows.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_MS * 2);
  try {
    const res = await fetch(p.url.replace(/\/$/, '') + path, { headers: { authorization: `Bearer ${p.peerToken || p.token}`, 'x-stam-local': '1', 'accept-encoding': 'identity', ...(human ? { 'x-stam-human': '1' } : {}), ...headers }, signal: abort.signal });
    down.delete(p.name);
    return res;
  } catch {
    down.set(p.name, Date.now() + PROBE_MS);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// A fire-and-forget note to a peer, such as the settings home's change push (S-390): it never marks
// the peer down or up, so a note sent while a peer is still starting doesn't hide it from lists.
export function peerNotify(p: Peer, method: string, path: string, body: unknown, timeoutMs: number): void {
  peerFetch(p, method, path, body, timeoutMs).then((r) => r.body?.cancel(), () => {});
}

// A background poll, such as the paid-spend refresh (S-395): it never marks the peer down or up, so
// a peer that is still starting when the poll runs isn't hidden from lists for a probe interval.
export async function peerPoll(p: Peer, path: string, timeoutMs: number): Promise<{ status: number; data: any }> {
  const res = await peerFetch(p, 'GET', path, undefined, timeoutMs);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

// Lists skip a down peer at once, and start the background probe once its retry time has passed.
function skipDown(p: Peer): boolean {
  const next = down.get(p.name);
  if (next === undefined) return false;
  if (next <= Date.now() && !checking.has(p.name)) void checkUp(p);
  return true;
}

// Starting a stopped peer (S-234). A spawn on a peer that doesn't answer runs its `start`
// command once (concurrent callers share the run), then polls its /api/health until it answers
// or the deadline (STAM_PEER_START_TIMEOUT_MS, 5 minutes by default) passes.
const POLL_MS = 2000;
const starting = new Map<string, Promise<void>>();

// Any answer from the peer's daemon counts as up; only a connection error counts as down.
async function answers(p: Peer): Promise<boolean> {
  return (await peerHealth(p)) !== undefined;
}

// The release a peer's daemon reports (null for a checkout), or undefined when it doesn't answer.
async function peerHealth(p: Peer): Promise<{ release: string | null } | undefined> {
  try {
    const res = await fetch(p.url.replace(/\/$/, '') + '/api/health', { headers: { authorization: `Bearer ${p.peerToken || p.token}`, 'x-stam-local': '1' }, signal: AbortSignal.timeout(2000) });
    return { release: ((await res.json()) as { release?: string | null }).release ?? null };
  } catch {
    return undefined;
  }
}

export async function ensureUp(p: Peer): Promise<void> {
  if (await answers(p)) return;
  if (!starting.has(p.name)) starting.set(p.name, startPeer(p).finally(() => starting.delete(p.name)));
  return starting.get(p.name);
}

// Runs a peer's shell command until it exits or the deadline passes. code is its exit code, or
// 'late' when it was killed at the deadline; tail holds its last output lines.
async function runPeerCommand(cmd: string, env: NodeJS.ProcessEnv, deadline: number): Promise<{ code: number | null | 'late'; tail: string[] }> {
  const tail: string[] = [];
  // Its own process group, so the deadline kills what the command started (a `box up` ssh) and not just the shell (S-1473).
  const child = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
  for (const out of [child.stdout, child.stderr]) {
    out?.on('data', (d: Buffer) => {
      tail.push(...d.toString().split('\n').filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 10));
    });
  }
  const exited = new Promise<number | null>((r) => child.on('exit', r));
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), Math.max(0, deadline - Date.now()))));
  const code = await Promise.race([exited, late]);
  clearTimeout(timer);
  if (code === 'late') {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      child.kill();
    }
  }
  return { code, tail };
}

// Polls check every 2 s until it holds (true) or the deadline passes (false).
async function until(check: () => Promise<boolean>, deadline: number): Promise<boolean> {
  while (!(await check())) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
  }
  return true;
}

async function startPeer(p: Peer): Promise<void> {
  const deadline = Date.now() + Number(process.env.STAM_PEER_START_TIMEOUT_MS ?? 300_000);
  const fail = (why: string, tail: string[] = []) => new Error(`${p.name} is unreachable and didn't start: ${why}${tail.length ? `\n${tail.join('\n')}` : ''}`);
  if (!p.start) throw fail('no start command in settings.json (peers[].start)');
  console.log(`peer:start ${p.name}: running ${p.start}`);
  const { code, tail } = await runPeerCommand(p.start, process.env, deadline);
  if (code === 'late') throw fail('its start command ran past the deadline', tail);
  if (code !== 0) {
    console.log(`peer:start ${p.name}: start command exited ${code}`);
    throw fail(`its start command exited with ${code}`, tail);
  }
  if (!(await until(() => answers(p), deadline))) {
    console.log(`peer:start ${p.name}: no answer before the deadline`);
    throw fail("it didn't answer /api/health before the deadline", tail);
  }
  down.delete(p.name);
  console.log(`peer:start ${p.name}: up`);
}

// Peers on another release (S-236). A peer whose release differs from this daemon's runs its
// `deploy` command once (concurrent callers share the run) with STAM_RELEASE and STAM_PEER set,
// then polls its /api/health until it reports this release or the deadline
// (STAM_PEER_DEPLOY_TIMEOUT_MS, 10 minutes by default) passes.
const deploying = new Map<string, Promise<void>>();

// Returns a warning when the peer couldn't be brought to this release (the spawn still goes on),
// nothing when it is on this release or can't be deployed to.
export async function ensureCurrent(p: Peer): Promise<string | undefined> {
  const mine = RELEASE;
  if ((await peerHealth(p))?.release === mine) return undefined;
  if (!mine) return undefined;
  // A staged merge (S-470) is live on alpha only until its hold is removed. Deploying it to a peer now would
  // send it there early, racing the deploy watcher, so the spawn goes on on the peer's release with a warning.
  if (existsSync(join(STAM_HOME, 'deploy-staged.json'))) {
    console.log(`peer:deploy ${p.name}: not deployed, a staged merge waits for its hold`);
    return `${p.name} isn't on ${mine}: a staged merge waits for its hold, so ${p.name} keeps its release`;
  }
  // The deploy watcher owns the moves storage makes (S-525): while its hold is in place, or once it has put storage on
  // another release, a spawn doesn't move the peer past what the watcher deployed.
  if (existsSync(join(STAM_HOME, 'deploy-hold'))) {
    console.log(`peer:deploy ${p.name}: not deployed, a deploy hold is in place`);
    return `${p.name} isn't on ${mine}: a deploy hold is in place, so ${p.name} keeps its release`;
  }
  const storageSha = join(STAM_HOME, 'deploy-storage-sha');
  // The marker holds a full sha and RELEASE is its 10-char prefix, so compare by prefix.
  if (existsSync(storageSha) && !readFileSync(storageSha, 'utf8').trim().startsWith(mine)) {
    console.log(`peer:deploy ${p.name}: not deployed, the deploy watcher owns its release`);
    return `${p.name} isn't on ${mine}: the deploy watcher owns ${p.name}'s release, so ${p.name} keeps its release`;
  }
  if (!p.deploy) {
    console.log(`peer:deploy ${p.name}: on another release and has no deploy command`);
    return undefined;
  }
  if (!deploying.has(p.name)) deploying.set(p.name, deployPeer(p, mine).finally(() => deploying.delete(p.name)));
  try {
    await deploying.get(p.name);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function deployPeer(p: Peer, release: string): Promise<void> {
  const deadline = Date.now() + Number(process.env.STAM_PEER_DEPLOY_TIMEOUT_MS ?? 600_000);
  const fail = (why: string, tail: string[] = []) => new Error(`${p.name} didn't deploy ${release}: ${why}${tail.length ? `\n${tail.join('\n')}` : ''}`);
  console.log(`peer:deploy ${p.name}: running ${p.deploy} for ${release}`);
  const { code, tail } = await runPeerCommand(p.deploy!, { ...process.env, STAM_RELEASE: release, STAM_PEER: p.name }, deadline);
  if (code === 'late') throw fail('its deploy command ran past the deadline', tail);
  if (code !== 0) {
    console.log(`peer:deploy ${p.name}: deploy command exited ${code}`);
    throw fail(`its deploy command exited with ${code}`, tail);
  }
  if (!(await until(async () => (await peerHealth(p))?.release === release, deadline))) {
    console.log(`peer:deploy ${p.name}: no ${release} before the deadline`);
    throw fail(`it doesn't report ${release} on /api/health before the deadline`, tail);
  }
  console.log(`peer:deploy ${p.name}: now on ${release}`);
}

// Pipes a peer's event stream (a GET that stays open) to `res` until either side closes.
// The peer's daemon drops a client that lags too far, and the browser reconnects.
export async function peerStream(p: Peer, path: string, res: ServerResponse, via?: Via): Promise<void> {
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const up = await fetch(p.url.replace(/\/$/, '') + path, { headers: { authorization: `Bearer ${p.peerToken || p.token}`, 'x-stam-local': '1', ...viaHeaders(via) }, signal: abort.signal });
  res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  // Reads from the peer only as fast as the browser takes it.
  const drained = () => new Promise<void>((r) => (res.once('drain', r), res.once('close', r)));
  try {
    for await (const chunk of up.body as any) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await drained();
    }
  } catch {}
  abort.abort();
  res.end();
}

// Finds which peer owns an agent, by id or name.
export async function findAgentPeer(ref: string): Promise<{ peer: Peer; agent: db.Agent } | undefined> {
  const r = await locateAgent(ref);
  return typeof r === 'object' ? r : undefined;
}

// An agent a name means: `peer` is undefined when it is on this daemon.
export type AgentHit = { peer?: Peer; agent: Pick<db.Agent, 'id' | 'name' | 'machine' | 'lifecycle'> };

// The one agent a name means, out of its exact matches (by id or name; never a partial name).
// A live agent (not archived, not shut down) beats one that isn't. Two that still match is an
// error that lists them with their ids, rather than a guess (S-288).
export class AmbiguousAgentError extends Error {}

// An id that an agent here and an agent on another machine both have can't say which one is meant
// (S-577): an id addresses one agent, so callers refuse it rather than resolve it to the local one,
// naming both as `name (machine)` and telling the caller to use the name. Names are unique, so only
// exact ids are checked, against the remembered peer registry (peer_agents); a row for this very
// machine is not a twin (a peer that relayed a lookup could have stored our own agent).
export function refuseAmbiguousId(id: string, local: { name: string; machine: string }): void {
  const twin = db.peerAgentById(id);
  if (twin && twin.machine !== local.machine) throw new AmbiguousAgentError(`${id} matches an agent on more than one machine: ${local.name} (${local.machine}) and ${twin.name} (${twin.machine}); address it by name, not by id`);
}

export function pickAgent<T extends AgentHit>(ref: string, hits: T[]): T | undefined {
  // An exact id names one agent, live or not; lifecycle only decides between name matches.
  const byId = hits.filter((h) => h.agent.id === ref);
  if (byId.length === 1) return byId[0];
  const live = hits.filter((h) => isLive(h.agent));
  const pool = live.length ? live : hits;
  if (pool.length > 1) throw new AmbiguousAgentError(`${ref} matches more than one agent: ${pool.map((h) => `${h.agent.name} (${h.agent.id}, ${h.agent.machine}, ${h.agent.lifecycle})`).join(', ')}`);
  return pool[0];
}

export const isLive = (a: Pick<db.Agent, 'lifecycle'>) => !['archived', 'shut_down'].includes(a.lifecycle);

// The HTTP answer that refuses a request for an ambiguous name, with the candidates (S-288), or
// undefined for any other error.
export function ambiguousRefusal(e: unknown): string | undefined {
  if (!(e instanceof AmbiguousAgentError)) return undefined;
  return `HTTP/1.1 409 Conflict\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(e.message)}\r\nconnection: close\r\n\r\n${e.message}`;
}

// The exact matches for `ref` on every peer. `unreachable` when a peer that didn't answer may hold one.
export async function peerHits(ref: string): Promise<{ hits: { peer: Peer; agent: db.Agent }[]; unreachable: boolean }> {
  const results = await Promise.all(
    peers().map(async (p) => {
      try {
        const r = await peerCall(p, 'GET', `/api/agents/${encodeURIComponent(ref)}`, undefined, 4000);
        return r.status === 200 ? { peer: p, agent: r.data as db.Agent } : r.status === 404 ? 'absent' : 'unreachable';
      } catch {
        return 'unreachable';
      }
    }),
  );
  const hits = results.filter((h): h is { peer: Peer; agent: db.Agent } => typeof h === 'object');
  // Only another machine's agent is remembered (S-577): a peer that relayed the lookup back to us
  // can return our own agent, which must not be stored as a twin of itself.
  for (const h of hits) if (h.agent.machine !== MACHINE) db.rememberPeerAgent(h.agent);
  return { hits, unreachable: results.includes('unreachable') };
}

// Like findAgentPeer, but tells an agent no peer has ('absent': every peer answered 404)
// from one that may sit on a peer that didn't answer ('unreachable').
export async function locateAgent(ref: string): Promise<{ peer: Peer; agent: db.Agent } | 'absent' | 'unreachable'> {
  const { hits, unreachable } = await peerHits(ref);
  const found = pickAgent(ref, hits);
  return found ?? (unreachable ? 'unreachable' : 'absent');
}

// The same GET on every peer, results concatenated. Unreachable peers are skipped.
// `via` is the verified agent the request acts for (S-259), so each peer checks it too.
export async function fanOut<T>(path: string, via?: Via): Promise<T[]> {
  return (await fanOutReport<T>(path, via)).rows;
}

// Whether every peer answers a health probe now (S-637): auto-archive judges a thread only with the
// whole inbox in view, so it waits while one is down.
export async function peersReachable(): Promise<boolean> {
  return (await Promise.all(peers().map((p) => checkUp(p)))).every(Boolean);
}

// fanOut, also saying whether a peer couldn't be asked (down, or the request failed) (S-359).
export async function fanOutReport<T>(path: string, via?: Via): Promise<{ rows: T[]; unreachable: boolean }> {
  const lists = await Promise.all(
    peers().map(async (p) => {
      if (skipDown(p)) return { rows: [] as T[], unreachable: true };
      try {
        const r = await peerCall(p, 'GET', path, undefined, 4000, false, via);
        return { rows: r.status === 200 && Array.isArray(r.data) ? (r.data as T[]) : [], unreachable: false };
      } catch {
        return { rows: [] as T[], unreachable: true };
      }
    }),
  );
  return { rows: lists.flatMap((l) => l.rows), unreachable: lists.some((l) => l.unreachable) };
}
