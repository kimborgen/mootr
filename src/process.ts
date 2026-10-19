// Processes (S-869, step 1): the visual process designer's file format. One process is one YAML
// file under processes/ at the repo root. The format and its validator live in
// src/process-validate.ts (shared with the web editor); this file adds the folder loader
// (loadProcesses reads the folder and resolves the cross-file `call` references), the live counts
// (processCounts) and the brief text. See docs/processes.md and processes/schema.json.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isClosedStatus, statuses as itsaStatuses, type ChangeGuard } from './itsa.ts';
import { parseProcessText } from './process-validate.ts';
import type { ProcessDef, ProcessError, ProcessNode } from './process-validate.ts';

export * from './process-validate.ts';
export { parseProcessText };

// One process file: its definition when it is valid, and every problem found otherwise. The
// errors are strings, one per problem, each naming the file so a folder of them reads together.
export function parseProcess(yamlText: string, opts: { file: string; knownTypes?: Set<string> }): { process?: ProcessDef; errors: string[] } {
  return parseProcessText(yamlText, { ...opts, knownStatuses: new Set(itsaStatuses().map((s) => s.name)) });
}

// Every `processes/*.yaml` in a folder, in file order, with each file's own errors and the
// cross-file ones: a `call` that names no other loaded process. A folder that can't be read
// throws; a file that can't be parsed is an error, not a crash.
export function loadProcesses(dir: string, opts: { knownTypes?: Set<string> } = {}): { processes: ProcessDef[]; errors: ProcessError[] } {
  const processes: ProcessDef[] = [];
  const errors: ProcessError[] = [];
  const fileOf = new Map<string, string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const result = parseProcess(readFileSync(join(dir, f), 'utf8'), { file: join(dir, f), knownTypes: opts.knownTypes });
    for (const message of result.errors) errors.push({ file: f, message });
    if (result.process) {
      processes.push(result.process);
      fileOf.set(result.process.id, f);
    }
  }
  const ids = new Set(processes.map((p) => p.id));
  for (const p of processes)
    for (const n of Object.values(p.nodes))
      if (n.call && !ids.has(n.call)) errors.push({ file: fileOf.get(p.id) ?? p.id, message: `node "${n.id}": call "${n.call}" is not a loaded process` });
  return { processes, errors };
}

// One ITSA as the live counts need it: its identity, its status, its kind, and its owner's name
// when the daemon knows one. The daemon maps listed ITSAs into this shape.
export interface CountItsa {
  key: string;
  id: string;
  title: string;
  status: string;
  owner: string | null;
  kind?: string | null;
  // The ITSA's `stage` field (S-924), when the field exists and is set.
  stage?: string | null;
}

// What sits at one node: the full number, and up to COUNTS_CAP of them, drawn.
export interface NodeCount {
  count: number;
  itsas: Omit<CountItsa, 'kind' | 'stage'>[];
}

// The most ITSAs one node lists; `count` stays the full number.
export const COUNTS_CAP = 50;

// The live counts the designer draws, one map per process id: every node that names `statuses`
// has an entry (0 is a real answer), holding the ITSAs whose status is one of them. An ITSA in a
// closed status never counts, and a process's `appliesTo.kind`, when set, limits which ITSAs
// count in it. A node with several statuses lists them in that order. An ITSA whose `stage` names
// a node of the process sits at that node (S-924); otherwise its status decides, as before. A
// node with no `statuses` still has an entry when a stage names it.
export function processCounts(processes: ProcessDef[], itsas: CountItsa[]): Record<string, Record<string, NodeCount>> {
  const all: Record<string, Record<string, NodeCount>> = {};
  const open = itsas.filter((x) => !isClosedStatus(x.status));
  for (const p of processes) {
    const kinds = p.appliesTo?.kind;
    const forProcess = kinds?.length ? open.filter((x) => x.kind != null && kinds.includes(x.kind)) : open;
    const byNode = new Map<string, CountItsa[]>();
    const byStatus = new Map<string, CountItsa[]>();
    for (const x of forProcess) {
      if (x.stage && p.nodes[x.stage] && stageable(p.nodes[x.stage]!)) byNode.set(x.stage, [...(byNode.get(x.stage) ?? []), x]);
      else byStatus.set(x.status, [...(byStatus.get(x.status) ?? []), x]);
    }
    const nodes: Record<string, NodeCount> = {};
    for (const node of Object.values(p.nodes)) {
      if (!node.statuses.length && !byNode.has(node.id)) continue;
      const at = [...(byNode.get(node.id) ?? []), ...node.statuses.flatMap((status) => byStatus.get(status) ?? [])];
      nodes[node.id] = { count: at.length, itsas: at.slice(0, COUNTS_CAP).map(({ kind: _kind, stage: _stage, ...x }) => x) };
    }
    all[p.id] = nodes;
  }
  return all;
}

// The lane of a process an agent type acts in: the lane of that type, or whose fallback it is.
const laneOfType = (p: ProcessDef, type: string): string | undefined =>
  Object.entries(p.lanes).find(([, l]) => l.type === type)?.[0] ?? Object.entries(p.lanes).find(([, l]) => l.fallback === type)?.[0];

// The next-step text of a type's brief (S-925): in node order, the `brief` of every node in the
// type's lane and the `tell` text of every node that names the lane, joined by blank lines. ''
// when the process has no lane for the type or no step text for it.
export function renderNextSteps(p: ProcessDef, type: string): string {
  const lane = laneOfType(p, type);
  if (!lane) return '';
  const parts: string[] = [];
  for (const n of Object.values(p.nodes)) {
    if (n.lane === lane && n.brief) parts.push(n.brief);
    if (n.tell?.lanes.includes(lane)) parts.push(n.tell.text);
  }
  return parts.join('\n\n');
}

// The nodes an ITSA's `stage` can name: every node but the events that start a flow and the
// gateways that only route it (the stage field's options are these node ids).
export const stageable = (n: ProcessNode): boolean => n.kind !== 'start' && n.kind !== 'exclusive' && n.kind !== 'parallel';

// Why a `stage` move is refused (S-924), or null when it is allowed. Setting it from empty,
// clearing it, and keeping the same value always pass; a value the process has no node for
// passes too (the field's own options are checked by the field). A move back to a node that
// comes earlier (one that reaches `from` along the edges) passes too: a red gate sends work from
// merge back to code. Otherwise `to` must follow `from` along the edges, through gateways only.
export function stageRefusal(p: ProcessDef, from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to || from === to) return null;
  if (!p.nodes[from] || !p.nodes[to]) return null;
  const reaches = (a: string, b: string): boolean => {
    const visited = new Set<string>([a]);
    const stack = [a];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of p.edges) if (e.from === id && !visited.has(e.to)) (visited.add(e.to), stack.push(e.to));
    }
    return visited.has(b);
  };
  if (reaches(to, from)) return null;
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of p.edges) {
      if (e.from !== id) continue;
      if (e.to === to) return null;
      const next = p.nodes[e.to];
      if (next && !stageable(next) && !seen.has(next.id)) {
        seen.add(next.id);
        queue.push(next.id);
      }
    }
  }
  const allowed = [...new Set(p.edges.filter((e) => e.from === from).map((e) => e.to))].join(', ') || 'none';
  return `${p.id} does not allow stage ${from} -> ${to} (from ${from}: ${allowed})`;
}

// The node a closed ITSA of the process ends at: its `end` node that closes the ITSA (S-1398), or null.
export const closeNodeOf = (p: ProcessDef): string | null => Object.values(p.nodes).find((n) => n.kind === 'end' && n.status && isClosedStatus(n.status))?.id ?? null;

// The change guard the daemon registers (S-924): refuses a `stage` field move the ITSA's process
// doesn't allow. `processesOf` returns the loaded processes; one that throws never blocks a change.
export function stageGuard(processesOf: () => ProcessDef[]): ChangeGuard {
  return (_cur, next) => {
    const to = next.fields?.to.stage;
    if (typeof to !== 'string') return;
    const from = next.fields?.from.stage;
    let p: ProcessDef | undefined;
    try {
      p = processesOf().find((q) => q.appliesTo?.kind?.includes(next.kind ?? ''));
    } catch {
      return;
    }
    // A close ends the process (S-1398): the move to its end node is allowed from any stage, once the ITSA is closed.
    if (p && isClosedStatus(next.status) && to === closeNodeOf(p)) return;
    const why = p && stageRefusal(p, typeof from === 'string' ? from : null, to);
    if (why) throw new Error(why);
  };
}
