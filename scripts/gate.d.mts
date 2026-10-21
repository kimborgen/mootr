// Types for the parseGates export of gate.mjs, which src/pr-open.ts imports (S-1292). The script is plain JS run by node.
export interface Gate {
  label: string;
  argv: string[];
  dir: string;
  env?: Record<string, string>;
  web?: boolean;
  lane?: string;
}
// The gates a PR body names, in order; throws RefusalError (a GateError) for a Gates line it refuses.
export function parseGates(body: string | null | undefined, tests?: Set<string>): Gate[];
// The test a `run` name picks in test/run.sh (its `e2e-` prefix stripped).
export function runTestName(name: string): string;
// The test/run.sh names the path gates add for the changed paths and modes (S-2250), under ROWS (this checkout's when none) (S-2480).
export function pathGateTests(paths: string[], rows?: unknown[], modes?: string[]): string[];
// The gates the path rows add for the paths, each with the reasons (the rule and the paths that matched it) (S-2480).
export function addPathGates(
  gates: Gate[],
  paths: string[],
  modePaths?: string[],
  rows?: unknown[],
): { gates: Gate[]; added: { gate: string; reasons: { why: string; paths: string[] }[] }[] };
// The test names in test/run.sh's LIGHT list (S-2480).
export function lightTests(runSh: string): string[];
// What the merge gate adds for a PR on BASE (a sha of main) and HEAD (a sha), with main's rules (S-2480).
export function predictPr(opts: { repo: string; cache: string; base: string; head: string; ms?: number }): Promise<{
  changed: string[];
  modes: string[];
  note: string | null;
  rows: unknown[];
  added: { gate: string; reasons: { why: string; paths: string[] }[] }[];
  tests: string[];
}>;
// The merge queue's helpers, which src/pr-merge.ts reads for pr_merge's status (S-2279).
// The gate lock's path ($STAM_GATE_LOCK, else the live home's gate.lock), and the ticket queue beside it.
export function lockFile(env: Record<string, string | undefined>): string;
export function queueDir(lock: string): string;
// The live tickets in arrival order; stale ones are removed.
export function tickets(queue: string, keep?: string): string[];
export function ticketBodyOf(queue: string, name: string): { pid: number; start: string; boot: string; pr: string } | null;
// A ticket's 1-based place among the live ones, and the PR of the first; null when it isn't live.
export function queuePosition(queue: string, ticket: string): { rank: number; first: string } | null;
// The merge train's record beside the lock (S-3067), which pr_merge status reads: the train's PRs, step and start, and its process.
export function trainFile(lock: string): string;
// A process's identity as a ticket records it: its start time ('' when it is gone, a zombie, or /proc is missing) and the boot id.
export function processIdentity(pid: number): { pid: number; start: string; boot: string };
