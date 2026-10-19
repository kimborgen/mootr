// The process runner's core (S-946, step 3a of docs/proposals/S-866-process-designer.md): when an
// ITSA's `stage` enters a script, human or end node, compute what entering it does. With process.run = dry-run
// the daemon only logs and records what it would do; with `on`, a script node runs and a human node opens its ask.
import { spawn as spawnProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative as relativePath, resolve as resolvePath } from 'node:path';
import type { ProcessDef, ProcessNode } from './process.ts';

export type EntryAction =
  | { do: 'run'; script: string; args: string[] }
  | { do: 'ask'; ask: string; status: string }
  | { do: 'close'; status: string }
  // Agent nodes (S-1037): computed and logged only; 4b makes them live. `machine` is left to the type's default.
  | { do: 'spawn'; type: string; itsa: string; node: string; prompt: string; parent: string | null; machine?: string }
  | { do: 'mail'; to: string; itsa: string; node: string }
  | { do: 'skip'; why: string };

// Lane types whose agent takes over the ITSA (owner), and the lane type held by a standing agent.
export const OWNER_TAKING_TYPES = ['developer', 'manager'];
export const STANDING_LANE_TYPES = ['cos'];

// What an agent node needs to know about the ITSA; the daemon fills it. Without it the runner acts on no agent node.
export interface AgentContext {
  id: string;
  key: string;
  // The ITSA's owner agent is alive.
  ownerLive: boolean;
  // The owner of the ITSA's parent ITSA, and the chief of staff (a standing agent's id or name).
  parentOwner: string | null;
  cos: string | null;
  // A live reviewer takes part in the ITSA.
  reviewerLive: boolean;
  // Whether an agent type exists here (the lane's `fallback` is used for one that doesn't).
  typeKnown?: (type: string) => boolean;
  // Whether an agent type is a reviewer type (default: the type named `reviewer`).
  isReviewerType?: (type: string) => boolean;
}

// The ITSA status each human-node `ask` opens.
export const ASK_STATUS: Record<string, string> = {
  approve: 'needs_approval',
  decide: 'needs_input',
  answer: 'needs_input',
  review: 'needs_review',
  test: 'needs_test',
};

export interface RunItsa {
  links: { system: string; url: string | null }[];
  agent?: AgentContext;
}

// The PR number of the ITSA's latest github link whose url is a pull request of `repo` (OWNER/NAME), or null.
export function prNumber(itsa: RunItsa, repo: string): string | null {
  for (const l of [...itsa.links].reverse()) {
    const m = l.system === 'github' ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(l.url ?? '') : null;
    if (m && m[1].toLowerCase() === repo.toLowerCase()) return m[2];
  }
  return null;
}

// What entering `nodeId` does; empty for a node kind the runner doesn't act on, or an unknown node.
export function entryActions(p: ProcessDef, nodeId: string, itsa: RunItsa, repo: string): EntryAction[] {
  const node: ProcessNode | undefined = p.nodes[nodeId];
  if (!node) return [];
  if (node.kind === 'script' && node.run) {
    const pr = prNumber(itsa, repo);
    return [{ do: 'run', script: node.run, args: pr ? [pr] : [] }];
  }
  if (node.kind === 'human' && node.ask && ASK_STATUS[node.ask]) return [{ do: 'ask', ask: node.ask, status: ASK_STATUS[node.ask] }];
  if (node.kind === 'end' && node.status) return [{ do: 'close', status: node.status }];
  if (node.kind === 'agent' && itsa.agent) return agentActions(p, node, itsa.agent);
  return [];
}

// What entering an agent node does: a mail to the standing agent that holds the lane, else a spawn of the lane's type
// (its `fallback` when the type is unknown here) for the ITSA, unless the ITSA already has the agent that spawn would add.
function agentActions(p: ProcessDef, node: ProcessNode, x: AgentContext): EntryAction[] {
  const lane = node.lane ? p.lanes[node.lane] : undefined;
  if (!node.lane || !lane) return [];
  if (STANDING_LANE_TYPES.includes(lane.type)) return x.cos ? [{ do: 'mail', to: x.cos, itsa: x.key, node: node.id }] : [{ do: 'skip', why: `no ${lane.type} to mail` }];
  const type = lane.fallback && x.typeKnown && !x.typeKnown(lane.type) ? lane.fallback : lane.type;
  if (OWNER_TAKING_TYPES.includes(type) && x.ownerLive) return [{ do: 'skip', why: `${x.key} already has a live owner` }];
  if ((x.isReviewerType ? x.isReviewerType(type) : type === 'reviewer') && x.reviewerLive) return [{ do: 'skip', why: `a live reviewer already takes part in ${x.key}` }];
  const parts = [node.brief];
  for (const n of Object.values(p.nodes)) if (n.id !== node.id && n.tell?.lanes.includes(node.lane)) parts.push(n.tell.text);
  const prompt = parts.filter(Boolean).join('\n\n');
  return [{ do: 'spawn', type, itsa: x.key, node: node.id, prompt, parent: x.parentOwner ?? x.cos, ...(lane.machine ? { machine: lane.machine } : {}) }];
}

export function describeAction(a: EntryAction): string {
  if (a.do === 'run') return `run \`${[a.script, ...a.args].join(' ')}\``;
  if (a.do === 'ask') return `open the ask (${a.ask}) as \`${a.status}\``;
  if (a.do === 'spawn') return `spawn a \`${a.type}\` for ${a.itsa}${a.machine ? ` on ${a.machine}` : ''} under ${a.parent ?? 'nobody'} (prompt: ${a.prompt.length} chars)`;
  if (a.do === 'mail') return `mail ${a.to} about ${a.itsa} at \`${a.node}\``;
  if (a.do === 'skip') return `skip: ${a.why}`;
  return `close the ITSA as \`${a.status}\``;
}

export type RunMode = 'off' | 'dry-run' | 'on';

export interface RunDeps {
  mode: () => RunMode;
  processesOf: () => ProcessDef[];
  linksOf: (itsaId: string) => RunItsa['links'];
  // The GitHub repo (OWNER/NAME) whose PR links count.
  repo: () => string;
  // What an agent node needs about the ITSA (S-1037); without it, agent nodes are not acted on.
  agentOf?: (itsaId: string) => AgentContext | undefined;
  // Performs an agent node's spawn or mail for real (S-1038); given, it is used only when the mode is `on` and the runner made the move.
  agent?: (itsaId: string, process: ProcessDef, action: Extract<EntryAction, { do: 'spawn' | 'mail' }>) => void;
  // Records the line on the ITSA's history. Never mail: a dry-run must not reach anyone.
  record: (itsaId: string, text: string) => void;
  // Runs a script node's action for real (S-949); given, it is used only when the mode is `on`.
  run?: (itsaId: string, process: ProcessDef, action: Extract<EntryAction, { do: 'run' }>) => void;
  // Opens a human node's ask for real (S-950); given, it is used only when the mode is `on` and the node's answer moves the token.
  ask?: (itsaId: string, process: ProcessDef, node: ProcessNode, action: Extract<EntryAction, { do: 'ask' }>, from: unknown, actor: string | undefined) => void;
  log: (line: string) => void;
}

export interface StageChange {
  itsa: { id: string; kind: string | null };
  from: unknown;
  to: unknown;
  // Who made the move.
  actor?: string;
}

// The actor the runner itself moves a stage as (the verdict move). A script node runs live only for an entry this actor
// made: when a manager's merge-pr.mjs marks the stage `merge` itself (as `system:merge-pr`), a second run would double it.
export const RUNNER_ACTOR = 'system:process';

// What `on` does with an entry, shared by its live check and the dry-run note so the two can't drift apart.
const onRunsEntry = (actor: string | undefined): boolean => actor === RUNNER_ACTOR;
const onOpensAsk = (p: ProcessDef, nodeId: string): boolean => answerEdge(p, nodeId) !== null;
const ASK_NOT_OPENED = 'not opened: its way out belongs to something else (the deploy watcher), so it stays dry-run';

// The listener for an ITSA's `stage` changes. One comment and one log line per entry: an event that
// repeats the node the ITSA is already recorded at is ignored. It never throws, and its
// own record is not a stage change, so it can't re-enter itself. `dry-run` mails nobody; `on` runs a script node (deps.run) and opens a
// human node's ask (deps.ask); an end node is still dry-run.
export function stageEntryListener(deps: RunDeps): (c: StageChange) => void {
  const at = new Map<string, string>();
  return (c) => {
    try {
      const to = typeof c.to === 'string' && c.to ? c.to : null;
      const id = c.itsa.id;
      if (!to) return void at.delete(id);
      if (at.get(id) === to) return;
      at.set(id, to);
      if (deps.mode() === 'off') return;
      const p = deps.processesOf().find((q) => q.appliesTo?.kind?.includes(c.itsa.kind ?? ''));
      if (!p) return;
      const actions = entryActions(p, to, { links: deps.linksOf(id), agent: deps.agentOf?.(id) }, deps.repo());
      if (!actions.length) return;
      const mode = deps.mode();
      const who = c.actor ?? 'unknown';
      const byRunner = onRunsEntry(c.actor);
      const askable = onOpensAsk(p, to);
      const liveRun = mode === 'on' && deps.run && byRunner;
      const liveAsk = mode === 'on' && deps.ask && askable;
      // Agent nodes (spawn, mail, skip) stay dry-run under `on` until 4b (S-1038).
      const liveAgent = mode === 'on' && deps.agent && byRunner;
      const isLive = (a: EntryAction) => (a.do === 'run' && liveRun) || (a.do === 'ask' && liveAsk) || ((a.do === 'spawn' || a.do === 'mail') && liveAgent);
      const hasRun = actions.some((a) => a.do === 'run');
      const hasAgent = actions.some((a) => a.do === 'spawn' || a.do === 'mail');
      const hasAsk = actions.some((a) => a.do === 'ask');
      const notes: string[] = [];
      if (mode === 'on') {
        if (deps.run && !liveRun && hasRun) notes.push(`not run: entered by ${who}, not the runner`);
        if (deps.agent && !liveAgent && hasAgent) notes.push(`not done: entered by ${who}, not the runner`);
        if (hasAsk && !liveAsk) notes.push(ASK_NOT_OPENED);
      } else if (mode === 'dry-run') {
        if (hasRun && !byRunner) notes.push(`under on: not run, entered by ${who}, not the runner`);
        if (hasAgent && !byRunner) notes.push(`under on: not done, entered by ${who}, not the runner`);
        if (hasAsk && !askable) notes.push(`under on: ${ASK_NOT_OPENED}`);
      }
      const text = `process ${p.id}: entering \`${to}\` (by ${who}) ${actions.map((a) => `${isLive(a) ? '' : 'would '}${describeAction(a)}`).join(', then ')}${notes.length ? ` (${notes.join('; ')})` : ''}`;
      deps.log(`process-run (${mode}) ${id}: ${text}`);
      deps.record(id, text);
      for (const a of actions) {
        if (a.do === 'run' && liveRun) deps.run!(id, p, a);
        if (a.do === 'ask' && liveAsk) deps.ask!(id, p, p.nodes[to], a, c.from, c.actor);
        if ((a.do === 'spawn' || a.do === 'mail') && liveAgent) deps.agent!(id, p, a);
      }
    } catch (e) {
      deps.log(`process-run: ${e instanceof Error ? e.message : e}`);
    }
  };
}

// ---- start events (S-947): a start node's triggers become event subscriptions ----

export interface StartWanted {
  subscriber_id: string;
  filter: { source: string; subjects?: string[]; types?: string[]; actors?: string[] };
  note: string;
}

export const startSubscriberId = (processId: string, nodeId: string): string => `process:${processId}:${nodeId}`;

// The subscriptions the processes want: one per start-node trigger that is a stored event. A timer, a
// manual start, a cron, and a trigger marked `example: true` are drawn only.
export function startTriggers(processes: ProcessDef[]): StartWanted[] {
  const out: StartWanted[] = [];
  for (const p of processes) {
    for (const node of Object.values(p.nodes)) {
      if (node.kind !== 'start') continue;
      for (const t of node.triggers) {
        if (t.example || t.cron || t.source === 'timer' || t.source === 'manual') continue;
        const filter: StartWanted['filter'] = { source: t.source };
        for (const k of ['subjects', 'types', 'actors'] as const) if (t[k]?.length) filter[k] = t[k];
        out.push({ subscriber_id: startSubscriberId(p.id, node.id), filter, note: `${p.id} start: ${t.label ?? t.source}` });
      }
    }
  }
  return out;
}

export interface StartEvent {
  id: number;
  source: string;
  type: string;
  actor: string | null;
  url: string | null;
  summary: string;
  dedupe_key: string;
}

export interface StartDeps {
  mode: () => RunMode;
  processesOf: () => ProcessDef[];
  cos: () => string | null;
  create: (input: { title: string; kind: string | null; status: string; owner: string | null; body: string; fields: Record<string, unknown> }) => Promise<unknown>;
  log: (line: string) => void;
}

// What a matching start event does. `dry-run` logs it (there is no ITSA to hold a note yet, and nothing
// is mailed); `on` creates an ITSA at stage `route` for the chief of staff. One instance per event id:
// the event store drops a repeated dedupe_key before this runs, and `seen` guards a repeated call.
const SEEN_MAX = 1000;

export function startListener(deps: StartDeps): (subscriberId: string, ev: StartEvent) => void {
  const seen = new Set<string>();
  return (subscriberId, ev) => {
    try {
      const m = /^process:([^:]+):([^:]+)$/.exec(subscriberId);
      const mode = deps.mode();
      if (!m || mode === 'off') return;
      const p = deps.processesOf().find((q) => q.id === m[1]);
      if (!p) return;
      const key = `${subscriberId}#${ev.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
      const kind = p.appliesTo?.kind?.[0] ?? null;
      const what = `${ev.source} ${ev.type}: ${ev.summary}`;
      if (mode === 'dry-run') return deps.log(`process-run (dry-run) ${p.id}: event ${ev.id} (${what}) would start a ${kind ?? 'work'} ITSA at stage route`);
      deps.log(`process-run (on) ${p.id}: event ${ev.id} (${what}) starts a ${kind ?? 'work'} ITSA at stage route`);
      const body = [`Started by ${p.id} from event ${ev.id}.`, '', `- source: ${ev.source}`, `- type: ${ev.type}`, ev.actor ? `- by: ${ev.actor}` : '', ev.url ? `- url: ${ev.url}` : '', '', ev.summary].filter((l, i, a) => l || a[i - 1] !== '').join('\n');
      deps
        .create({ title: ev.summary.slice(0, 120) || what, kind, status: 'todo', owner: deps.cos(), body, fields: { stage: 'route' } })
        .catch((e) => deps.log(`process-run: starting ${p.id} from event ${ev.id} failed: ${e instanceof Error ? e.message : e}`));
    } catch (e) {
      deps.log(`process-run: ${e instanceof Error ? e.message : e}`);
    }
  };
}

// ---- evidence moves the token (S-948): a review verdict evaluates the verdict gateway ----

// A condition is `FACT == VALUE`, `FACT != VALUE` or a bare flag `FACT` (true when the fact is `true`): equality on named facts only. An unknown fact or a
// form it doesn't read never matches.
export function evalCondition(when: string | undefined, facts: Record<string, string>): boolean {
  // A bare name is a flag: true when the fact is `true`.
  const flag = /^\s*([a-z_][a-z0-9_]*)\s*$/.exec(when ?? '');
  if (flag) return facts[flag[1]] === 'true';
  const m = /^\s*([a-z_][a-z0-9_]*)\s*(==|!=)\s*"?([A-Za-z0-9_.-]+)"?\s*$/.exec(when ?? '');
  if (!m || !Object.hasOwn(facts, m[1])) return false;
  return m[2] === '==' ? facts[m[1]] === m[3] : facts[m[1]] !== m[3];
}

// The gateways a verdict can decide: exclusive nodes named `verdict`, with the nodes that lead into them.
export function verdictGateways(p: ProcessDef): { id: string; from: string[] }[] {
  const n = p.nodes.verdict;
  if (!n || n.kind !== 'exclusive') return [];
  return [{ id: n.id, from: p.edges.filter((e) => e.to === n.id).map((e) => e.from) }];
}

// The subscriptions the verdict gateways want: the repo's PR check completions, which carry the verdict.
export function verdictTriggers(processes: ProcessDef[], repo: string): StartWanted[] {
  const out: StartWanted[] = [];
  for (const p of processes) for (const g of verdictGateways(p)) {
    out.push({ subscriber_id: startSubscriberId(p.id, g.id), filter: { source: 'github', subjects: [`github:${repo}#*`], types: ['checks.completed'] }, note: `${p.id} verdict: review statuses` });
  }
  return out;
}

// The target of the first out-edge of `gateway` whose condition holds for `facts`, or null.
export function winningEdge(p: ProcessDef, gateway: string, facts: Record<string, string>): string | null {
  return p.edges.find((e) => e.from === gateway && evalCondition(e.when, facts))?.to ?? null;
}

export interface VerdictEvent {
  id: number;
  type: string;
  subjects: string[];
  payload: unknown;
}

export interface VerdictDeps {
  mode: () => RunMode;
  processesOf: () => ProcessDef[];
  // The open ITSAs linked to PR `n`, with their kind and stage.
  itsasOfPr: (n: string) => { id: string; kind: string | null; stage: string | null }[];
  record: (itsaId: string, text: string) => void;
  moveStage: (itsaId: string, stage: string) => Promise<unknown>;
  log: (line: string) => void;
}

// What a `checks.completed` that carries a `stam/review` verdict does. The poller reads the statuses of the
// PR's current head, so the verdict is tied to it (a verdict for a head the PR has moved past never arrives
// as the current one). `dry-run` records an ITSA event and logs; `on` sets
// `stage` along the winning edge, through `itsa.set` so the stage guard applies.
export function verdictListener(deps: VerdictDeps): (subscriberId: string, ev: VerdictEvent) => void {
  const done = new Set<string>();
  return (subscriberId, ev) => {
    try {
      const m = /^process:([^:]+):([^:]+)$/.exec(subscriberId);
      const pr = ev.subjects.map((s) => /#(\d+)$/.exec(s)?.[1]).find(Boolean);
      const pay = (ev.payload ?? {}) as { head?: unknown; verdict?: unknown };
      const head = typeof pay.head === 'string' ? pay.head : null;
      if (!m || !pr || !head) return;
      const verdict = pay.verdict === 'approve' || pay.verdict === 'changes' ? pay.verdict : null;
      const mode = deps.mode();
      if (ev.type !== 'checks.completed' || !verdict || mode === 'off') return;
      const p = deps.processesOf().find((q) => q.id === m[1]);
      const gateway = p && verdictGateways(p).find((g) => g.id === m[2]);
      // The open ITSA whose stage leads into the gateway: a PR can be linked to more than one.
      const x = p && gateway && deps.itsasOfPr(pr).find((q) => q.stage && gateway.from.includes(q.stage) && p.appliesTo?.kind?.includes(q.kind ?? ''));
      if (!p || !gateway || !x || !x.stage) return;
      const to = winningEdge(p, gateway.id, { verdict });
      if (!to) return;
      const key = `${x.id}#${head}#${verdict}`;
      if (done.has(key)) return;
      done.add(key);
      if (done.size > SEEN_MAX) done.delete(done.values().next().value as string);
      const text = `process ${p.id}: review verdict ${verdict} on ${head.slice(0, 7)} ${mode === 'on' ? 'moves' : 'would move'} stage ${x.stage} -> ${to}`;
      deps.log(`process-run (${mode}) ${x.id}: ${text}`);
      if (mode === 'dry-run') return deps.record(x.id, text);
      deps.moveStage(x.id, to).catch((e) => deps.log(`process-run: moving ${x.id} to ${to} failed: ${e instanceof Error ? e.message : e}`));
    } catch (e) {
      deps.log(`process-run: ${e instanceof Error ? e.message : e}`);
    }
  };
}

// ---- agent nodes live (S-1038) ----

// The most working agents a machine runs before a process spawn is refused (CLAUDE.md rule 6).
export const MAX_WORKING_AGENTS = 8;

export interface AgentRunDeps {
  // Spawns through the daemon's own path; resolves to the new agent's name.
  spawn: (input: { type: string; itsa: string; prompt: string; parent: string | null; machine?: string }) => Promise<string>;
  mail: (to: string, subject: string, body: string) => Promise<unknown>;
  // The parent's name for {{parent}} in the prompt, else the id.
  nameOf: (agent: string) => string;
  // How many agents work on a machine (this one when absent); rejects when it can't be read.
  working: (machine?: string) => Promise<number>;
  maxSpawnsPerHour: () => number;
  // Durable counts from the ITSA events `claim` writes: spawns (not mails) in the last hour.
  spawnsLastHour: () => number;
  // The id of the stage change being entered (the ITSA's latest `fields` event), and whether it already has a claim for the node.
  entryOf: (itsaId: string) => string;
  claimed: (itsaId: string, node: string, entry: string) => boolean;
  // Writes the durable claim for a spawn or a mail, before it starts: a spawn counts toward the cap, a mail does not.
  claim: (itsaId: string, kind: 'spawn' | 'mail', node: string, entry: string, text: string) => void;
  // A plain line on the ITSA's history (the outcome).
  note: (itsaId: string, text: string) => void;
  log: (line: string) => void;
}

export interface PeerSpawnDeps<P extends { name: string }, V> {
  peerOf: (machine: string) => P | undefined;
  // The id of an agent by id or name, if it exists here.
  agentId: (ref: string) => string | undefined;
  viaFor: (agentId: string) => V;
  // The relayed spawn (starts and updates the peer, remembers the new agent): the daemon's `spawnOnPeer`.
  spawnOnPeer: (peer: P, body: Record<string, unknown>, human: boolean, via: V | undefined) => Promise<{ status: number; data: any }>;
}

// A spawn on another machine, as the parent the process named. Throws on a missing peer or a refusal; returns the new agent's name.
export async function spawnOnMachine<P extends { name: string }, V>(deps: PeerSpawnDeps<P, V>, machine: string, body: { type: string; itsa: string; prompt: string; parent?: string }): Promise<string> {
  const peer = deps.peerOf(machine);
  if (!peer) throw new Error(`no peer machine ${machine}`);
  const parent = body.parent ? deps.agentId(body.parent) : undefined;
  const r = await deps.spawnOnPeer(peer, { ...body, by: parent }, false, parent ? deps.viaFor(parent) : undefined);
  if (r.status >= 300 || !r.data?.id) throw new Error(`${peer.name} refused the spawn: ${r.data?.error ?? r.status}`);
  return String(r.data.name ?? r.data.id);
}

// Performs a spawn or a mail for real. A refusal (cap, working limit, repeat) is logged and leaves the ITSA where it is; a
// failed spawn mails the parent once and is not retried.
export function agentRunner(deps: AgentRunDeps): (itsaId: string, p: ProcessDef, a: Extract<EntryAction, { do: 'spawn' | 'mail' }>) => void {
  const inFlight = new Map<string, number>();
  return (id, p, a) => {
    void (async () => {
      try {
        const node = a.node;
        // Each refusal goes to the log and to the ITSA's history.
        const refuse = (why: string) => {
          deps.log(`process-run: ${id}: ${why}`);
          deps.note(id, `process ${p.id}: ${why}`);
        };
        // The entry is read first: the stage-change event it names is the latest one only until the next change.
        const entry = deps.entryOf(id);
        if (a.do === 'mail') {
          if (deps.claimed(id, node, entry)) return refuse(`${node}: this entry was already acted on; ignored`);
          deps.claim(id, 'mail', node, entry, `process ${p.id}: mailing ${a.to} about ${a.itsa} at \`${a.node}\``);
          await deps.mail(a.to, `${a.itsa} entered ${a.node}`, `The process ${p.id} moved ${a.itsa} to \`${a.node}\`. It is yours: take the next step.`);
          return;
        }
        const where = a.machine ?? 'this machine';
        // The one read that may wait (a peer's list); everything after it, up to the claim, runs without an await, so two
        // entries can't both pass the same check, and the first one's in-flight spawn is already counted for the second.
        let working: number;
        try {
          working = await deps.working(a.machine);
        } catch (e) {
          return refuse(`not spawning a ${a.type} on ${where}: can't read how many agents work there (${e instanceof Error ? e.message : e})`);
        }
        if (deps.claimed(id, node, entry)) return refuse(`${node}: this entry was already acted on; ignored`);
        const cap = deps.maxSpawnsPerHour();
        if (deps.spawnsLastHour() >= cap) return refuse(`not spawning a ${a.type}: ${cap} process spawns in the last hour`);
        const key = a.machine ?? '';
        const busy = working + (inFlight.get(key) ?? 0);
        if (busy >= MAX_WORKING_AGENTS) return refuse(`not spawning a ${a.type}: ${busy} agents already working on ${where}`);
        const prompt = a.prompt.replaceAll('{{parent}}', a.parent ? deps.nameOf(a.parent) : 'your parent');
        deps.claim(id, 'spawn', node, entry, `process ${p.id}: spawning a ${a.type} for ${a.itsa}`);
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        try {
          const name = await deps.spawn({ type: a.type, itsa: a.itsa, prompt, parent: a.parent, ...(a.machine ? { machine: a.machine } : {}) });
          deps.note(id, `process ${p.id}: spawned ${name} (${a.type}) for ${a.itsa}`);
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          deps.log(`process-run: ${id}: spawning a ${a.type} failed: ${why}`);
          deps.note(id, `process ${p.id}: spawning a ${a.type} for ${a.itsa} failed: ${why}`);
          if (a.parent) await deps.mail(a.parent, `Process spawn for ${a.itsa} failed`, `The process ${p.id} could not spawn a ${a.type} for ${a.itsa}: ${why}\n\nIt will not retry; the ITSA is unchanged.`);
        } finally {
          inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
        }
      } catch (e) {
        deps.log(`process-run: ${id}: agent node failed: ${e instanceof Error ? e.message : e}`);
      }
    })();
  };
}

// ---- script nodes live (S-949) ----

export interface ScriptResult {
  code: number | null;
  signal?: string | null;
  // The last 4 KB of the script's output.
  output: string;
}

export interface ScriptDeps {
  // The git checkout the scripts run from: a release directory has no .git, so its merge-pr.mjs could not work.
  checkout: () => string;
  // Whether this machine runs scripts that need `gh` (the ITSA home).
  host: () => boolean;
  spawn: (script: string, args: string[], checkout: string) => Promise<ScriptResult>;
  ownerOf: (itsaId: string) => string | null;
  setStage: (itsaId: string, stage: string) => Promise<unknown>;
  mailOwner: (owner: string, subject: string, body: string) => Promise<unknown>;
  log: (line: string) => void;
}

// The script's real path when it lies under `<root>/scripts/` once symlinks are resolved, or null for anything else
// (an absolute path, `..`, another folder, a link out, a missing file).
export function scriptPath(root: string, script: string): string | null {
  try {
    const dir = realpathSync(resolvePath(root, 'scripts'));
    const full = realpathSync(resolvePath(root, script));
    const rel = relativePath(dir, full);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null;
  } catch {
    return null;
  }
}

const tail = (text: string, lines = 20): string => text.trim().split('\n').slice(-lines).join('\n');

// merge-pr.mjs exits with this status for a verdict on the PR (review missing, conflict, gates failed). Any other failure
// (the lock wait ran out, a gh or network error), a timeout or a signal is not a verdict on the PR.
export const REFUSED_EXIT = 3;
export function isRefusal(r: ScriptResult): boolean {
  return r.code === REFUSED_EXIT && !r.signal;
}

// Runs a script node's action: `node SCRIPT ARGS` for the ITSA, off the daemon's thread. One run per ITSA and script at a
// time: a second entry while one runs is ignored. Exit 0 does nothing more (merge-pr.mjs marks the stage, and the
// deploy watcher moves it on). A real refusal sends the stage back to `code` and mails the ITSA's owner the last lines of
// output, and nobody else. A run that ended any other way leaves the stage and tells the owner it had no verdict.
export function scriptRunner(deps: ScriptDeps): (itsaId: string, p: ProcessDef, a: Extract<EntryAction, { do: 'run' }>) => void {
  const running = new Set<string>();
  return (id, p, a) => {
    const key = `${id}#${a.script}`;
    void (async () => {
      try {
        const checkout = deps.checkout();
        const full = scriptPath(checkout, a.script);
        if (!full) return deps.log(`process-run: ${id}: refused ${a.script}: only scripts under ${checkout}/scripts/ run`);
        if (!deps.host()) return deps.log(`process-run: ${id}: ${a.script} needs gh and runs only on the ITSA home; skipped here`);
        if (!a.args.length) return deps.log(`process-run: ${id}: ${a.script} skipped: the ITSA has no pull request link`);
        if (running.has(key)) return deps.log(`process-run: ${id}: ${a.script} is already running; this entry is ignored`);
        running.add(key);
        try {
          const r = await deps.spawn(full, a.args, checkout);
          const cmd = `${a.script} ${a.args.join(' ')}`;
          if (r.code === 0) return deps.log(`process-run: ${id}: ${cmd} finished`);
          const refused = isRefusal(r);
          deps.log(`process-run: ${id}: ${cmd} ${refused ? 'refused' : 'ended without a verdict'} (exit ${r.code}${r.signal ? `, ${r.signal}` : ''})`);
          if (refused && p.nodes.code) {
            try {
              await deps.setStage(id, 'code');
            } catch (e) {
              deps.log(`process-run: ${id}: moving the stage back to code failed: ${e instanceof Error ? e.message : e}`);
            }
          }
          const owner = deps.ownerOf(id);
          if (!owner) return;
          const what = refused ? `${a.script} refused PR ${a.args.join(' ')}: stage is back to code` : `merge run ended without a verdict: ${cmd}`;
          const lead = refused ? `The process ${p.id} ran \`${cmd}\` and it exited ${r.code}. The stage is back to \`code\`.` : `The process ${p.id} ran \`${cmd}\` and it ended (exit ${r.code}${r.signal ? `, ${r.signal}` : ''}) without a verdict. The stage is unchanged.`;
          try {
            await deps.mailOwner(owner, what, `${lead}\n\n\`\`\`\n${tail(r.output)}\n\`\`\``);
          } catch (e) {
            deps.log(`process-run: ${id}: mailing the owner failed: ${e instanceof Error ? e.message : e}`);
          }
        } finally {
          running.delete(key);
        }
      } catch (e) {
        deps.log(`process-run: ${id}: ${a.script} failed to run: ${e instanceof Error ? e.message : e}`);
      }
    })();
  };
}

export interface DetachedOptions {
  node: string;
  script: string;
  args: string[];
  cwd: string;
  logDir: string;
  // Log files older than this many days are removed before a run (default 7).
  keepDays?: number;
  now?: () => number;
}

// Starts `node SCRIPT ARGS` detached from the daemon, in the git checkout, with STAM_GATE_REPO naming it (merge-pr.mjs and
// gate.mjs read it, since a release directory has no .git). Its output goes to a log file, so a daemon restart doesn't kill the
// run; the result carries the last 4 KB of that log. Old logs are pruned first.
export function runDetached(o: DetachedOptions): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    try {
      mkdirSync(o.logDir, { recursive: true });
      const now = (o.now ?? Date.now)();
      const cutoff = now - (o.keepDays ?? 7) * 86_400_000;
      for (const f of readdirSync(o.logDir)) {
        if (!f.endsWith('.log')) continue;
        try {
          if (statSync(join(o.logDir, f)).mtimeMs < cutoff) rmSync(join(o.logDir, f));
        } catch {}
      }
      const logFile = join(o.logDir, `${basename(o.script)}-${o.args.join('-')}-${now}.log`);
      const fd = openSync(logFile, 'a');
      const child = spawnProcess(o.node, ['--no-warnings', o.script, ...o.args], { cwd: o.cwd, env: { ...process.env, STAM_GATE_REPO: o.cwd }, detached: true, stdio: ['ignore', fd, fd] });
      closeSync(fd);
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, output: readTail(logFile) }));
      child.unref();
    } catch (e) {
      reject(e);
    }
  });
}

// The last `bytes` of a file, or '' when it can't be read.
export function readTail(file: string, bytes = 4096): string {
  try {
    const size = statSync(file).size;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, bytes));
      readSync(fd, buf, 0, buf.length, Math.max(0, size - bytes));
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

// Routes a process subscription's event to the listener for its node's kind: start → a new instance (S-947),
// exclusive → a verdict (S-948). Anything else is ignored.
export function dispatchProcessEvent<E>(processes: ProcessDef[], subscriberId: string, ev: E, on: { start: (id: string, ev: E) => void; verdict: (id: string, ev: E) => void }): void {
  const [, processId, nodeId] = /^process:([^:]+):([^:]+)$/.exec(subscriberId) ?? [];
  const kind = processes.find((q) => q.id === processId)?.nodes[nodeId]?.kind;
  if (kind === 'start') on.start(subscriberId, ev);
  else if (kind === 'exclusive') on.verdict(subscriberId, ev);
}

// ---- human nodes live (S-950): entering one opens the ask, and the answer moves the token ----

// The node a human node's answer leads to: the target of its out-edge with the flag condition `answered`, or null when the node
// has none (a `hold` leaves on `hold_cleared`, which the deploy watcher owns, so it is never opened here).
export function answerEdge(p: ProcessDef, nodeId: string): string | null {
  if (p.nodes[nodeId]?.kind !== 'human') return null;
  return p.edges.find((e) => e.from === nodeId && evalCondition(e.when, { answered: 'true' }))?.to ?? null;
}

export interface AskDeps {
  // The ITSA's status now, or null when it is gone.
  statusOf: (itsaId: string) => string | null;
  isHumanStatus: (status: string) => boolean;
  // Whether `actor`, who moved the ITSA into the node, may have it ask the human: the runner itself, a system sender, the human,
  // or an agent whose model may mail the human (the same rule `itsa.set` applies to a move into a human status).
  mayAsk: (actor: string | undefined) => Promise<boolean>;
  // The ITSA's latest comment or update by anyone but a system sender, so the human sees the real question, or null.
  latestComment: (itsaId: string) => string | null;
  // Posts the comment that says why, without mailing the human (the move to a human status mails them once, with it).
  post: (itsaId: string, body: string) => Promise<unknown>;
  setStatus: (itsaId: string, status: string) => Promise<unknown>;
  log: (line: string) => void;
}

// Opens a human node's ask through the existing flow: the comment first, then the move to the human status for `ask`, which
// mails the human once. An ITSA already waiting on the human is left alone. A failed comment stops it; a failed move is logged.
export function humanAsker(deps: AskDeps): NonNullable<RunDeps['ask']> {
  const opening = new Set<string>();
  return (id, p, node, a, from, actor) => {
    void (async () => {
      if (opening.has(id)) return;
      opening.add(id);
      try {
        const status = deps.statusOf(id);
        if (!status) return;
        if (deps.isHumanStatus(status)) return deps.log(`process-run: ${id}: already waits on the human (${status}); the ask is not opened again`);
        if (!(await deps.mayAsk(actor))) return deps.log(`process-run: ${id}: ${actor ?? 'someone'} moved it to \`${node.id}\` but may not mail the human, so the ask is not opened; its parent decides`);
        const where = typeof from === 'string' && from ? ` The ITSA moved from \`${from}\` to \`${node.id}\`.` : '';
        const quoted = deps.latestComment(id);
        const body = `Process ${p.id}: ${node.label ?? node.id}.${where} It waits on you (${a.ask}); answer, approve or request changes on this ITSA.${quoted ? `\n\nThe latest comment:\n\n${quoted.trim().split('\n').map((l) => `> ${l}`).join('\n')}` : ''}`;
        try {
          await deps.post(id, body);
        } catch (e) {
          return deps.log(`process-run: ${id}: the ask comment failed, so the status stays: ${e instanceof Error ? e.message : e}`);
        }
        try {
          await deps.setStatus(id, a.status);
        } catch (e) {
          deps.log(`process-run: ${id}: moving to ${a.status} failed: ${e instanceof Error ? e.message : e}`);
        }
      } catch (e) {
        deps.log(`process-run: ${id}: ${e instanceof Error ? e.message : e}`);
      } finally {
        opening.delete(id);
      }
    })();
  };
}

export interface AnswerChange {
  itsa: { id: string; kind: string | null };
  actor: string;
  from: unknown;
  to: unknown;
}

export interface AnswerDeps {
  mode: () => RunMode;
  processesOf: () => ProcessDef[];
  // The ITSA's current stage.
  stageOf: (itsaId: string) => string | null;
  isHumanStatus: (status: string) => boolean;
  record: (itsaId: string, text: string) => void;
  moveStage: (itsaId: string, stage: string) => Promise<unknown>;
  log: (line: string) => void;
  human: string;
}

// When the human answers (an Approve, an Answer or a Request changes moves the ITSA out of a human status) and its stage is a human
// node with an `answered` edge, the stage follows that edge. `dry-run` records it; `on` moves it, as the runner. An agent's move out
// of a human status settles the ask without the human, so it does not count.
export function answerListener(deps: AnswerDeps): (c: AnswerChange) => void {
  return (c) => {
    try {
      const mode = deps.mode();
      if (mode === 'off' || c.actor !== deps.human) return;
      if (typeof c.from !== 'string' || typeof c.to !== 'string' || !deps.isHumanStatus(c.from) || deps.isHumanStatus(c.to)) return;
      const p = deps.processesOf().find((q) => q.appliesTo?.kind?.includes(c.itsa.kind ?? ''));
      const stage = deps.stageOf(c.itsa.id);
      const to = p && stage ? answerEdge(p, stage) : null;
      if (!p || !stage || !to) return;
      const text = `process ${p.id}: the human answered (${c.from} -> ${c.to}), so stage ${stage} ${mode === 'on' ? 'moves' : 'would move'} to ${to}`;
      deps.log(`process-run (${mode}) ${c.itsa.id}: ${text}`);
      deps.record(c.itsa.id, text);
      if (mode === 'on') deps.moveStage(c.itsa.id, to).catch((e) => deps.log(`process-run: moving ${c.itsa.id} to ${to} failed: ${e instanceof Error ? e.message : e}`));
    } catch (e) {
      deps.log(`process-run: ${e instanceof Error ? e.message : e}`);
    }
  };
}
