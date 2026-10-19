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
export function parseGates(body: string | null | undefined): Gate[];
// The test a `run` name picks in test/run.sh (its `e2e-` prefix stripped).
export function runTestName(name: string): string;
