// Other machines' stam daemons. Each daemon owns the agents on its machine and their
// mail; a request about an agent elsewhere goes to the daemon that owns it. Peers are
// listed in settings.json as { name, url, token }. Requests between daemons carry
// `x-stam-local: 1`, which stops them from fanning out again.
import type { ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from './settings.ts';
import { MACHINE, RELEASE, STAM_HOME } from './config.ts';
import * as db from './db.ts';
import { timed } from './stall.ts';
import { envVar, withTwins } from './env.ts';

export interface Peer {
  name: string;
  url: string;
  token: string;
  // The token this peer's daemon accepts from daemons (its STAM_HOME/peer-token, S-545); `token` is the fallback.
  peerToken?: string;
  // The lease token that peer's daemon accepts (its STAM_HOME/mcp-lease-token, S-3176), for its MCP lease route.
  leaseToken?: string;
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
  // The caller's daemon's answer to what the agent may review (S-1065), sent with a verdict relay and read only from a
  // peer: its role there, and the branches it owns (its worktree's, and stam/<name>). The home can't see a peer's agents.
  reviewRole?: 'reviewer' | 'manager' | 'other';
  // null (or missing): unknown, which a verdict relay refuses.
  ownBranches?: string[] | null;
}

// The headers that name the agent a forwarded request acts as; none for a daemon's own calls.
export function viaHeaders(via?: Via): Record<string, string> {
  return via ? { 'x-stam-agent': via.agent, ...(via.boss ? { 'x-stam-agent-boss': '1' } : {}), ...(via.assistant ? { 'x-stam-agent-assistant': '1' } : {}), ...(via.scope ? { 'x-stam-branch-scope': via.scope } : {}), ...(via.reviewRole ? { 'x-stam-review-role': via.reviewRole, ...(Array.isArray(via.ownBranches) ? { 'x-stam-own-branches': JSON.stringify(via.ownBranches) } : {}) } : {}) } : {};
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
const PROBE_MS = Number(envVar('PEER_PROBE_MS')) || 30_000;
const CHECK_MS = Number(envVar('PEER_CHECK_MS')) || 2000;
const down = new Map<string, number>();
// The wait for a peer's answer to a per-agent lookup (peerHits and its retry).
const LOOKUP_MS = Number(envVar('PEER_LOOKUP_MS')) || 4000;
const checking = new Map<string, Promise<boolean>>();

// Told of each write this daemon sends a peer (S-4356), before it goes out and again once it settles: a write can apply
// even when its answer never arrives, so the second call happens on failure too.
const peerWriteListeners = new Set<() => void>();
export function onPeerWrite(listener: () => void): void {
  peerWriteListeners.add(listener);
}
const notifyPeerWrite = () => {
  for (const listener of peerWriteListeners) listener();
};

const peerFetch = (p: Peer, method: string, path: string, body: unknown, timeoutMs: number, human = false, via?: Via) => {
  const init = {
    method,
    headers: { authorization: `Bearer ${p.peerToken || p.token}`, 'content-type': 'application/json', 'x-stam-local': '1', ...(human ? { 'x-stam-human': '1' } : {}), ...viaHeaders(via) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  };
  const url = p.url.replace(/\/$/, '') + path;
  if (method === 'GET') return fetch(url, init);
  notifyPeerWrite();
  return fetch(url, init).finally(notifyPeerWrite);
};

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

// The error peerCall throws for a peer that is down: nothing was sent to it (S-3596).
export class PeerUnreachable extends Error {}
// The error peerCall throws for a peer that answered, but with a body that isn't JSON (S-3472): it is reachable.
export class PeerBadReply extends Error {}

// Node's fetch reports ECONNREFUSED on its cause; a refused connection never reached the peer's request (S-3596).
// A getter that throws reads as not refused, so the error goes on to redactError.
function refusedBeforeSend(e: unknown): boolean {
  try {
    const code = (e as { cause?: { code?: unknown }; code?: unknown } | undefined)?.cause?.code ?? (e as { code?: unknown } | undefined)?.code;
    return code === 'ECONNREFUSED';
  } catch {
    return false;
  }
}

// The tokens a call to the peer could expose (S-3994): the peer's own, which it got as the bearer or holds, and this
// daemon's shared, peer and lease tokens, read when needed so a rotation counts at once.
function callSecrets(p: Peer): string[] {
  const own = (file: string) => {
    try {
      return readFileSync(join(STAM_HOME, file), 'utf8').trim();
    } catch {
      return '';
    }
  };
  // Every non-empty token: config accepts one of any length, so none is too short to guard.
  return [p.token, p.peerToken, p.leaseToken, own('token'), own('peer-token'), own('mcp-lease-token')].filter((t): t is string => !!t);
}

// Text a peer or a proxy wrote, with every token the call could expose replaced by [redacted].
export function redactPeerText(p: Peer, text: string): string {
  for (const t of callSecrets(p)) text = text.split(t).join('[redacted]');
  return text;
}

function redactDeep(p: Peer, v: unknown): unknown {
  if (typeof v === 'string') return redactPeerText(p, v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(p, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactPeerText(p, k), redactDeep(p, x)]));
  return v;
}

// A peer's answer, parsed. One that isn't a success is redacted, every string and key at any depth, before any caller
// logs its error, mails it or answers with it (S-3994); a success is left as the peer sent it. A body that isn't JSON
// is a fixed error, as in the Go daemon: a SyntaxError quotes the body's start, which may hold a token.
function peerReply(p: Peer, res: Response, text: string): { status: number; data: any } {
  let data: unknown = {};
  if (text) {
    try {
      // A peer's whole reply is parsed on the loop; labelled for the stall watch (src/stall.ts).
      data = timed(`peer parse ${p.name}`, () => JSON.parse(text));
    } catch {
      throw new PeerBadReply(`${p.name} answered something that is not JSON`);
    }
  }
  return { status: res.status, data: res.ok ? data : redactDeep(p, data) };
}

export async function peerCall(p: Peer, method: string, path: string, body?: unknown, timeoutMs = 8000, human = false, via?: Via): Promise<{ status: number; data: any }> {
  // A down peer is probed first, so a slow real call after it comes back still gets its full timeout.
  if (down.has(p.name) && !(await checkUp(p))) throw new PeerUnreachable(`${p.name} is unreachable`);
  let res;
  try {
    res = await peerFetch(p, method, path, body, timeoutMs, human, via);
  } catch (e) {
    down.set(p.name, Date.now() + PROBE_MS);
    // A connection refused before anything was sent: the peer got nothing, so it is unreachable (S-3596).
    if (refusedBeforeSend(e)) throw new PeerUnreachable(`${p.name} is unreachable`);
    throw redactError(p, e);
  }
  down.delete(p.name);
  return peerReply(p, res, await res.text());
}

// A fetch error with every token the call could expose kept out (S-3994), always rebuilt, never the original: its name
// when it is a plain word, its message redacted, and at most its cause's error code. The cause itself and every other
// property stay behind (an invalid URL's cause quotes the URL in `input`). Anything that throws while it is read (a
// getter, a Proxy) gives a fixed error, and nothing more is read from it. A timeout stays a TimeoutError with its message.
function redactError(p: Peer, e: unknown): Error {
  try {
    const err = e as { name?: unknown; message?: unknown; cause?: { code?: unknown } };
    const name = err.name;
    const message = redactPeerText(p, String(err.message));
    const code = err.cause?.code;
    const plain = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v) && redactPeerText(p, v) === v;
    const r = new Error(message, plain(code, /^[A-Z0-9_]+$/) ? { cause: { code } } : undefined);
    r.name = plain(name, /^[A-Za-z]+$/) ? name : 'Error';
    return r;
  } catch {
    return new Error(`${p.name} request failed`);
  }
}

// The bounds on a refusal body peerRaw and peerStream buffer to redact, read at each call (S-3994).
// A value that isn't a positive number is the default.
const positive = (v: string | undefined, fallback: number) => (Number(v) > 0 ? Number(v) : fallback);
const refusalMax = () => positive(envVar('PEER_REFUSAL_MAX_BYTES'), 64 * 1024);
const refusalMs = () => positive(envVar('PEER_REFUSAL_MS'), 4000);

// A body read whole within max bytes and ms, or undefined when it is longer, slower, or fails to read; the stream is
// cancelled either way.
async function readBounded(res: Response, max: number, ms: number): Promise<Buffer | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), ms)));
  try {
    for (;;) {
      const next = await Promise.race([reader.read().catch(() => 'failed' as const), late]);
      if (next === 'late' || next === 'failed') return undefined;
      if (next.done) return Buffer.concat(chunks);
      size += next.value.byteLength;
      if (size > max) return undefined;
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

// A refusal's body redacted: a JSON one through its decoded strings and keys (so an escaped token is found), any other
// as text. JSON that parses but can't be redacted and written again (nested too deep for the walk) is undefined, the
// fixed refusal: text redaction would miss an escaped token in it.
function redactBody(p: Peer, text: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return redactPeerText(p, text);
  }
  try {
    return JSON.stringify(redactDeep(p, data));
  } catch {
    return undefined;
  }
}

// A refusal (a non-2xx answer) that peerRaw or peerStream relays, buffered and redacted as peerReply does a parsed one, so
// a relayed refusal that echoes a token reaches no caller with it (S-3994). Its length is dropped, since the text changed
// size. A body over the cap, not read whole in time, or failing to read is a fixed refusal with its status: a cut body
// could still hold a token's start. It never throws, so a slow refusal doesn't mark a live peer down. A success's bytes
// (a file, a diff, the event stream) are left as they come.
async function redactRefusal(p: Peer, res: Response): Promise<Response> {
  if (res.ok) return res;
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  if (res.status === 204 || res.status === 304) return new Response(null, { status: res.status, statusText: res.statusText, headers });
  const body = await readBounded(res, refusalMax(), refusalMs());
  let text = body && redactBody(p, body.toString('utf8'));
  if (text === undefined) {
    text = JSON.stringify({ error: `${p.name} refused with ${res.status}; its answer was too long or too slow to show safely` });
    headers.set('content-type', 'application/json');
  }
  return new Response(text, { status: res.status, statusText: res.statusText, headers });
}

// A GET whose reply is streamed on, such as a file's bytes (S-1525): the peer's response, or undefined when
// the peer is down (a probe first, so a stopped machine answers at once, not after a timeout).
export async function peerRaw(p: Peer, path: string, headers: Record<string, string>, human: boolean): Promise<Response | undefined> {
  if (down.has(p.name) && !(await checkUp(p))) return undefined;
  // The time limit covers the connection and the headers only, not the body that follows.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_MS * 2);
  let res: Response;
  try {
    res = await fetch(p.url.replace(/\/$/, '') + path, { headers: { authorization: `Bearer ${p.peerToken || p.token}`, 'x-stam-local': '1', 'accept-encoding': 'identity', ...(human ? { 'x-stam-human': '1' } : {}), ...headers }, signal: abort.signal });
    down.delete(p.name);
  } catch {
    down.set(p.name, Date.now() + PROBE_MS);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  // The peer answered: a refusal's body has its own bounds, and reading it never marks the peer down.
  return redactRefusal(p, res);
}

// A fire-and-forget note to a peer, such as the settings home's change push (S-390): it never marks
// the peer down or up, so a note sent while a peer is still starting doesn't hide it from lists.
export function peerNotify(p: Peer, method: string, path: string, body: unknown, timeoutMs: number): void {
  peerFetch(p, method, path, body, timeoutMs).then((r) => r.body?.cancel(), () => {});
}

// A background poll, such as the paid-spend refresh (S-395): it never marks the peer down or up, so
// a peer that is still starting when the poll runs isn't hidden from lists for a probe interval.
export async function peerPoll(p: Peer, path: string, timeoutMs: number): Promise<{ status: number; data: any }> {
  let res;
  try {
    res = await peerFetch(p, 'GET', path, undefined, timeoutMs);
  } catch (e) {
    throw redactError(p, e);
  }
  return peerReply(p, res, await res.text());
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
  const deadline = Date.now() + Number(envVar('PEER_START_TIMEOUT_MS') ?? 300_000);
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

// True while the deploy watcher holds: its hold, or a hold a lift set aside (deploy-hold.lifting-PID, S-1770) while it
// compares or after a put-back that failed. A STAM_HOME that can't be listed counts as held.
function deployHeld(): boolean {
  if (existsSync(join(STAM_HOME, 'deploy-hold'))) return true;
  try {
    return readdirSync(STAM_HOME).some((f) => f.startsWith('deploy-hold.lifting-'));
  } catch {
    return true;
  }
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
  if (deployHeld()) {
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
  const deadline = Date.now() + Number(envVar('PEER_DEPLOY_TIMEOUT_MS') ?? 600_000);
  const fail = (why: string, tail: string[] = []) => new Error(`${p.name} didn't deploy ${release}: ${why}${tail.length ? `\n${tail.join('\n')}` : ''}`);
  console.log(`peer:deploy ${p.name}: running ${p.deploy} for ${release}`);
  const { code, tail } = await runPeerCommand(p.deploy!, { ...process.env, ...withTwins({ STAM_RELEASE: release, STAM_PEER: p.name }) }, deadline);
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
  let fetched: Response;
  try {
    fetched = await fetch(p.url.replace(/\/$/, '') + path, { headers: { authorization: `Bearer ${p.peerToken || p.token}`, 'x-stam-local': '1', ...viaHeaders(via) }, signal: abort.signal });
  } catch (e) {
    throw redactError(p, e);
  }
  const up = await redactRefusal(p, fetched);
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

// One more ask for an agent no peer returned (S-2927, S-3232). Right after this daemon restarts, the single
// per-agent lookup of peerHits can miss though the peer knows the agent: the peer was busy and the ask timed
// out, which also marks the peer down. The miss read as "no agent". So a miss is asked again once, through
// the same cheap route, to each peer that was up when the call began (a peer this call's own timeout just
// marked down included, since peerCall probes it first; a peer already down before the call gets no second
// probe). Callers asking for the same id of the same peer during a retry, or within RETRY_COOLDOWN_MS of
// its end, share it, so a burst after a restart costs one retry per peer and id. Only a 200 naming an agent
// of another machine counts; a peer that can't answer, or an older one, adds nothing.
const RETRY_COOLDOWN_MS = Number(envVar('PEER_LOOKUP_RETRY_MS')) || 2000;
const retries = new Map<string, { at: number; run: Promise<db.Agent | undefined> }>();

function retryLookup(p: Peer, ref: string): Promise<db.Agent | undefined> {
  const key = `${p.name}\0${ref}`;
  const now = Date.now();
  for (const [k, r] of retries) if (r.at && now - r.at >= RETRY_COOLDOWN_MS) retries.delete(k);
  const have = retries.get(key);
  if (have) return have.run;
  const entry = { at: 0, run: undefined as unknown as Promise<db.Agent | undefined> };
  entry.run = peerCall(p, 'GET', `/api/agents/${encodeURIComponent(ref)}`, undefined, LOOKUP_MS)
    .then((r) => (r.status === 200 && typeof r.data?.id === 'string' && r.data.machine !== MACHINE ? (r.data as db.Agent) : undefined))
    .catch(() => undefined)
    .finally(() => {
      entry.at = Date.now();
    });
  retries.set(key, entry);
  return entry.run;
}

// findAgentPeer, and when no peer answered with the agent, one retry of each peer that was up before the
// call. An id no peer returns is still undefined: nothing is accepted on trust.
export async function findAgentPeerFresh(ref: string): Promise<{ peer: Peer; agent: db.Agent } | undefined> {
  const wasDown = new Set(peers().filter((p) => down.has(p.name)).map((p) => p.name));
  const first = await findAgentPeer(ref);
  if (first) return first;
  const hits = (await Promise.all(peers().filter((p) => !wasDown.has(p.name)).map(async (peer) => ({ peer, agent: await retryLookup(peer, ref) })))).filter((h): h is { peer: Peer; agent: db.Agent } => !!h.agent);
  for (const h of hits) db.rememberPeerAgent(h.agent);
  return pickAgent(ref, hits);
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
        const r = await peerCall(p, 'GET', `/api/agents/${encodeURIComponent(ref)}`, undefined, LOOKUP_MS);
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

// The other machine whose daemon knows an agent named `ref`, for a set-parent that names an agent no
// one here has (S-2453). Read only and never remembered, so a refusal changes no row. A peer that
// doesn't answer in time, or answers anything but that agent, is no match: undefined, not a guess.
export async function peerMachineOf(ref: string): Promise<string | undefined> {
  const found = await Promise.all(
    peers().map(async (p) => {
      try {
        const r = await peerCall(p, 'GET', `/api/agents/${encodeURIComponent(ref)}`, undefined, 4000);
        return r.status === 200 && typeof r.data?.id === 'string' ? String(r.data.machine || p.name) : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return found.find((m) => m !== undefined && m !== MACHINE);
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

// fanOutReport over several GETs that each peer answers in turn (S-4520), results concatenated: one page asked in
// parts. A peer's turn ends after the answer `done` says holds the rest already (a peer that ignored the parts'
// filter and sent everything), or after a request it didn't answer, or answered with an error: both count as
// unreachable, since the part's rows are unknown.
export async function fanOutParts<T>(paths: string[], via: Via | undefined, done: (rows: T[], part: number) => boolean): Promise<{ rows: T[]; unreachable: boolean }> {
  const lists = await Promise.all(
    peers().map(async (p) => {
      const rows: T[] = [];
      if (!paths.length) return { rows, unreachable: false };
      if (skipDown(p)) return { rows, unreachable: true };
      for (let i = 0; i < paths.length; i++) {
        let part: T[];
        try {
          const r = await peerCall(p, 'GET', paths[i], undefined, 4000, false, via);
          if (r.status !== 200 || !Array.isArray(r.data)) return { rows, unreachable: true };
          part = r.data as T[];
        } catch {
          return { rows, unreachable: true };
        }
        rows.push(...part);
        if (done(part, i)) break;
      }
      return { rows, unreachable: false };
    }),
  );
  return { rows: lists.flatMap((l) => l.rows), unreachable: lists.some((l) => l.unreachable) };
}

// Whether every peer answers a health probe now (S-637): auto-archive judges a thread only with the
// whole inbox in view, so it waits while one is down.
export async function peersReachable(): Promise<boolean> {
  return (await Promise.all(peers().map((p) => checkUp(p)))).every(Boolean);
}

// fanOut, also saying whether a peer couldn't be asked (down, or the request failed) (S-359). `strict` counts an
// answer that isn't a 200 with a list as not asked, so a partial answer isn't kept (S-4356).
export async function fanOutReport<T>(path: string, via?: Via, strict = false): Promise<{ rows: T[]; unreachable: boolean }> {
  const lists = await Promise.all(
    peers().map(async (p) => {
      if (skipDown(p)) return { rows: [] as T[], unreachable: true };
      try {
        const r = await peerCall(p, 'GET', path, undefined, 4000, false, via);
        if (strict && !(r.status === 200 && Array.isArray(r.data))) return { rows: [] as T[], unreachable: true };
        return { rows: r.status === 200 && Array.isArray(r.data) ? (r.data as T[]) : [], unreachable: false };
      } catch {
        return { rows: [] as T[], unreachable: true };
      }
    }),
  );
  return { rows: lists.flatMap((l) => l.rows), unreachable: lists.some((l) => l.unreachable) };
}
