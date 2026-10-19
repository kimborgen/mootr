// The process file format and its validator (S-869), free of node and daemon imports so the web
// editor (S-1083) runs the same rules the loader does. `parseProcessText` checks one file's text;
// src/process.ts wraps it with the daemon's ITSA statuses and adds the folder loader and the counts.
import { parse } from 'yaml';

// The eight node kinds, drawn and explained in docs/processes.md.
export type ProcessNodeKind = 'start' | 'end' | 'agent' | 'human' | 'script' | 'exclusive' | 'parallel' | 'wait';
export const NODE_KINDS: readonly ProcessNodeKind[] = ['start', 'end', 'agent', 'human', 'script', 'exclusive', 'parallel', 'wait'];
// A lane type that isn't a registry agent type. Any other type must be one the registry knows.
export const BUILTIN_LANE_TYPES = ['human', 'script', 'cos'];
export const HUMAN_ASKS = ['approve', 'decide', 'answer', 'review', 'test'];
export const END_STATUSES = ['done', 'canceled', 'wont_do'];
export const BOUNDARY_ONS = ['cost', 'timeout', 'error'];
// A node id: a lowercase letter, then letters, digits, dashes, or underscores.
export const NODE_ID = /^[a-z][a-z0-9_-]*$/;

export interface ProcessLane {
  type: string;
  label?: string;
  // The type that takes over when this lane's type is unavailable (a reviewer's fallback).
  fallback?: string;
  // The machine an agent of this lane is spawned on (a machine name, as `spawn_agent` takes it); the type's default when absent (S-1038).
  machine?: string;
}

// A start event. The runner subscribes to it (src/process-run.ts startTriggers) unless it is a timer, manual or `example: true`.
export interface ProcessTrigger {
  source: string;
  label?: string;
  // The globs or literals event_subscriptions matches on (src/watch.ts).
  subjects?: string[];
  types?: string[];
  actors?: string[];
  cron?: string;
  // Drawn only: the runner makes no subscription for it (S-947).
  example?: boolean;
}

// An interruption drawn on a task: cost, timeout, or error.
export interface ProcessBoundary {
  on: string;
  action?: string;
  minutes?: number;
  interrupting?: boolean;
}

export interface ProcessNode {
  id: string;
  kind: ProcessNodeKind;
  lane: string;
  label?: string;
  // The ITSA statuses that count as "at this node" for live counts; each on one node per process.
  statuses: string[];
  doneWhen?: string;
  // The text this step adds to its own lane's brief, and to other lanes' briefs (S-925).
  brief?: string;
  tell?: { lanes: string[]; text: string };
  ask?: string;
  run?: string;
  event?: string;
  status?: string;
  call?: string;
  boundary: ProcessBoundary[];
  triggers: ProcessTrigger[];
}

export interface ProcessEdge {
  from: string;
  to: string;
  when?: string;
  label?: string;
}

export interface ProcessDef {
  id: string;
  title: string;
  description?: string;
  appliesTo?: { kind?: string[] };
  lanes: Record<string, ProcessLane>;
  nodes: Record<string, ProcessNode>;
  edges: ProcessEdge[];
}

export interface ProcessError {
  file: string;
  message: string;
}

const isMapping = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
// The id a file must declare: its name without the extension (`processes/dev-change.yaml` -> dev-change).
export const fileId = (file: string): string => (file.split('/').pop() ?? file).replace(/\.ya?ml$/i, '');

// One process file: its definition when it is valid, and every problem found otherwise. The
// errors are strings, one per problem, each naming the file so a folder of them reads together.
// `knownStatuses` is the ITSA status names the daemon (or the browser's store) knows.
export function parseProcessText(yamlText: string, opts: { file: string; knownTypes?: Set<string>; knownStatuses: Set<string> }): { process?: ProcessDef; errors: string[] } {
  const { file, knownTypes, knownStatuses } = opts;
  const errors: string[] = [];
  const add = (message: string) => errors.push(`${file}: ${message}`);
  let raw: any;
  try {
    raw = parse(yamlText);
  } catch (e) {
    return { errors: [`${file}: not valid YAML: ${e instanceof Error ? e.message : e}`] };
  }
  if (!isMapping(raw)) return { errors: [`${file}: the file must be a mapping`] };

  const id = typeof raw.process === 'string' ? raw.process.trim() : '';
  const expected = fileId(file);
  if (!id) add('process: missing');
  else if (id !== expected) add(`process "${id}" must equal the file name "${expected}"`);

  const lanes: Record<string, ProcessLane> = {};
  if (!isMapping(raw.lanes)) add('lanes: missing');
  else
    for (const [name, l] of Object.entries<any>(raw.lanes)) {
      if (!isMapping(l)) {
        add(`lane "${name}": must be a mapping`);
        continue;
      }
      const type = typeof l.type === 'string' ? l.type.trim() : '';
      if (!type) add(`lane "${name}": missing type`);
      else if (!BUILTIN_LANE_TYPES.includes(type) && knownTypes && !knownTypes.has(type)) add(`lane "${name}": unknown agent type "${type}"`);
      const lane: ProcessLane = { type };
      if (typeof l.label === 'string') lane.label = l.label;
      if (typeof l.fallback === 'string') {
        const fallback = l.fallback.trim();
        if (fallback && !BUILTIN_LANE_TYPES.includes(fallback) && knownTypes && !knownTypes.has(fallback)) add(`lane "${name}": unknown agent type "${fallback}" in fallback`);
        if (fallback) lane.fallback = fallback;
      }
      if (l.machine !== undefined) {
        const machine = typeof l.machine === 'string' ? l.machine.trim() : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(machine)) add(`lane "${name}": machine must be a machine name`);
        else lane.machine = machine;
      }
      lanes[name] = lane;
    }

  const statusOwner = new Map<string, string>();
  const nodes: Record<string, ProcessNode> = {};
  if (!isMapping(raw.nodes)) add('nodes: missing');
  else
    for (const [nodeId, n] of Object.entries<any>(raw.nodes)) {
      if (!NODE_ID.test(nodeId)) add(`node "${nodeId}": the id must match ${NODE_ID}`);
      if (!isMapping(n)) {
        add(`node "${nodeId}": must be a mapping`);
        continue;
      }
      const node = normalizeNode(nodeId, n, lanes, knownStatuses, statusOwner, add);
      if (node) nodes[nodeId] = node;
    }

  const edges: ProcessEdge[] = [];
  if (!Array.isArray(raw.edges)) add('edges: missing');
  else
    for (const [i, e] of raw.edges.entries()) {
      if (!Array.isArray(e) || e.length < 2 || e.length > 3 || typeof e[0] !== 'string' || typeof e[1] !== 'string') {
        add(`edge ${i + 1}: must be [from, to] or [from, to, options]`);
        continue;
      }
      const [from, to] = e;
      if (!nodes[from]) add(`edge ${from} -> ${to}: unknown node "${from}"`);
      if (!nodes[to]) add(`edge ${from} -> ${to}: unknown node "${to}"`);
      const edge: ProcessEdge = { from, to };
      if (e.length === 3) {
        if (!isMapping(e[2])) add(`edge ${from} -> ${to}: options must be a mapping`);
        else {
          if (typeof e[2].when === 'string') edge.when = e[2].when;
          if (typeof e[2].label === 'string') edge.label = e[2].label;
        }
      }
      edges.push(edge);
    }

  const incoming = new Set(edges.map((e) => e.to));
  const outgoing = new Set(edges.map((e) => e.from));
  for (const n of Object.values(nodes)) {
    if (n.kind === 'start' && incoming.has(n.id)) add(`start node "${n.id}" has an incoming edge`);
    if (n.kind === 'end' && outgoing.has(n.id)) add(`end node "${n.id}" has an outgoing edge`);
  }

  const def: ProcessDef = { id, title: typeof raw.title === 'string' ? raw.title : '', lanes, nodes, edges };
  if (typeof raw.description === 'string') def.description = raw.description;
  if (isMapping(raw.applies_to)) {
    const kind = strings(raw.applies_to.kind);
    if (kind.length) def.appliesTo = { kind };
  }
  return errors.length ? { errors } : { process: def, errors };
}

// One node's fields, checked against the lanes and the known statuses. Returns null when the
// kind is unknown, since the rest of the node then means nothing. `bad` records a problem and
// `statusOwner` remembers which node claimed each status, so two can't claim the same one.
function normalizeNode(
  id: string,
  n: Record<string, any>,
  lanes: Record<string, ProcessLane>,
  knownStatuses: Set<string>,
  statusOwner: Map<string, string>,
  bad: (message: string) => void,
): ProcessNode | null {
  const kind = String(n.kind ?? '').trim();
  if (!NODE_KINDS.includes(kind as ProcessNodeKind)) {
    bad(`node "${id}": unknown kind "${kind}"`);
    return null;
  }
  const node: ProcessNode = { id, kind: kind as ProcessNodeKind, lane: '', statuses: [], boundary: [], triggers: [] };
  if (typeof n.lane === 'string' && n.lane.trim()) node.lane = n.lane.trim();
  else bad(`node "${id}": missing lane`);
  if (node.lane && !lanes[node.lane]) bad(`node "${id}": unknown lane "${node.lane}"`);
  if (typeof n.label === 'string') node.label = n.label;
  for (const status of strings(n.statuses)) {
    if (!knownStatuses.has(status)) bad(`node "${id}": unknown ITSA status "${status}"`);
    else if (statusOwner.has(status)) bad(`status "${status}" is mapped on more than one node ("${statusOwner.get(status)}" and "${id}")`);
    else statusOwner.set(status, id);
    node.statuses.push(status);
  }
  if (typeof n.done_when === 'string') node.doneWhen = n.done_when;
  if (typeof n.brief === 'string' && n.brief.trim()) node.brief = n.brief.trim();
  if (n.tell !== undefined) {
    const lanesTold = isMapping(n.tell) ? strings(n.tell.lanes) : [];
    if (!isMapping(n.tell) || typeof n.tell.text !== 'string' || !n.tell.text.trim() || !lanesTold.length) bad(`node "${id}": tell needs lanes and text`);
    else {
      for (const l of lanesTold) if (!lanes[l]) bad(`node "${id}": tell names unknown lane "${l}"`);
      node.tell = { lanes: lanesTold, text: n.tell.text.trim() };
    }
  }
  if (typeof n.call === 'string') node.call = n.call;
  if (typeof n.run === 'string') node.run = n.run;
  if (typeof n.event === 'string') node.event = n.event;
  if (n.kind === 'end') {
    if (typeof n.status !== 'string' || !END_STATUSES.includes(n.status)) bad(`end node "${id}": status must be ${END_STATUSES.join(', ')}`);
    else node.status = n.status;
  }
  if (n.kind === 'human') {
    if (typeof n.ask !== 'string' || !HUMAN_ASKS.includes(n.ask)) bad(`human node "${id}": ask must be ${HUMAN_ASKS.join(', ')}`);
    else node.ask = n.ask;
  }
  for (const [i, t] of (Array.isArray(n.triggers) ? n.triggers : []).entries()) {
    if (!isMapping(t) || typeof t.source !== 'string' || !t.source.trim()) {
      bad(`node "${id}": trigger ${i + 1} has no source`);
      continue;
    }
    const trigger: ProcessTrigger = { source: t.source.trim() };
    if (typeof t.label === 'string') trigger.label = t.label;
    for (const key of ['subjects', 'types', 'actors'] as const) {
      const values = strings(t[key]);
      if (values.length) trigger[key] = values;
    }
    if (typeof t.cron === 'string') trigger.cron = t.cron;
    if (t.example === true) trigger.example = true;
    if (trigger.source === 'timer' && !trigger.cron) bad(`node "${id}": a timer trigger needs a cron`);
    node.triggers.push(trigger);
  }
  if (n.kind === 'start' && !node.triggers.length) bad(`start node "${id}" needs at least one trigger`);
  for (const b of Array.isArray(n.boundary) ? n.boundary : []) {
    if (!isMapping(b) || typeof b.on !== 'string' || !BOUNDARY_ONS.includes(b.on)) {
      bad(`node "${id}": a boundary event needs on: ${BOUNDARY_ONS.join(', ')}`);
      continue;
    }
    const boundary: ProcessBoundary = { on: b.on };
    if (typeof b.action === 'string') boundary.action = b.action;
    if (typeof b.minutes === 'number') boundary.minutes = b.minutes;
    if (typeof b.interrupting === 'boolean') boundary.interrupting = b.interrupting;
    node.boundary.push(boundary);
  }
  return node;
}
