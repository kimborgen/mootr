// The shape of `GET /api/processes` (S-872): a process is a YAML-defined pipeline (S-871) with
// lanes, nodes, edges, and per-node ITSA counts. The read-only view (S-873) draws it; these types
// are the contract between the loader, the route, and the view.

export type NodeKind = 'start' | 'end' | 'agent' | 'human' | 'script' | 'exclusive' | 'parallel' | 'wait'

// A start node's trigger: where work enters the process (src/process.ts ProcessTrigger). `source`
// is a watch source (mail, github, slack, feedback, retro, itsa, timer, manual); the fields it
// carries narrow it, and `cron` belongs to a timer.
export interface ProcessTrigger {
  source: string
  label?: string
  actors?: string[]
  subjects?: string[]
  types?: string[]
  cron?: string
  // Drawn only: the runner makes no subscription for it.
  example?: boolean
}

// A boundary event on a task: `on` names the event (cost, timeout, error), `action` what it does
// (pause, block, ...). Drawn as a small marker on the node's edge.
export interface ProcessBoundary { on: string; action?: string; minutes?: number; interrupting?: boolean }

export interface ProcessNode {
  // The node's id, which is also its key in `nodes` (src/process.ts carries it on the node too).
  id?: string
  kind: NodeKind
  lane: string
  label?: string
  // The ITSA statuses this node holds; a node without any shows no count badge.
  statuses?: string[]
  // When the node's work is done, from the loader's `done_when`.
  doneWhen?: string
  boundary?: ProcessBoundary[]
  // A sub-process this node calls; drawn with a ⊞ marker.
  call?: string
  // A human node's ask kind (approve, decide, answer, review, test).
  ask?: string
  // An end node's closing status.
  status?: string
  triggers?: ProcessTrigger[]
  // A wait node's event name.
  event?: string
  // A script node's command.
  run?: string
  // The text this step adds to its own lane's brief, and to other lanes' briefs (S-925).
  brief?: string
  tell?: { lanes: string[]; text: string }
}

export interface ProcessEdge { from: string; to: string; when?: string; label?: string }

export interface ProcessLane { type: string; label?: string; fallback?: string; machine?: string }

// One ITSA on a node, as the view lists it and the Work page shows it.
export interface ProcessItsa { key: string; id: string; title: string; status: string; owner: string | null }

// counts has an entry only for nodes with `statuses`.
export interface ProcessCount { count: number; itsas: ProcessItsa[] }

export interface Process {
  id: string
  title: string
  description?: string
  appliesTo?: { kind?: string[] }
  lanes: Record<string, ProcessLane>
  nodes: Record<string, ProcessNode>
  edges: ProcessEdge[]
  counts?: Record<string, ProcessCount>
  // The file's text, as the daemon read it: the editor diffs against it and patches it (comments kept).
  source?: string
}

// A process file that failed to load: the route still answers, and the view lists these.
export interface ProcessError { file: string; message: string }

// `types` is the registry's agent types (the daemon adds it; an older daemon omits it, and the editor then skips the type check).
export interface ProcessesResponse { processes: Process[]; errors: ProcessError[]; types?: string[] }
