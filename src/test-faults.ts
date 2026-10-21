// The test-only fault switch (S-2596): a test makes one release misbehave without patching its source.
// `STAM_HOME/test-faults.json`, keyed by release id (config.ts RELEASE), read only in a test home (test-env.ts):
//   { "boot_fail": ["SHA"],                              // runDaemon() exits 1 at once for these releases (a deploy that dies under the service)
//     "extra_tools": { "SHA": [{ "name", "group", "description", "text" }] } }  // `stam mcp` lists these tools, each answering `text`
// Read at start, so the file is written before the release starts. Kept free of db and daemon imports: mcp.ts loads it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_HOME, RELEASE, STAM_HOME } from './config.ts';
import { testHome } from './test-env.ts';

export type FaultTool = { name: string; group: string; description: string; text: string };
type Faults = { boot_fail?: string[]; extra_tools?: Record<string, FaultTool[]> };

function faults(): Faults {
  if (!RELEASE || !testHome(STAM_HOME, LIVE_HOME)) return {};
  try {
    return JSON.parse(readFileSync(join(STAM_HOME, 'test-faults.json'), 'utf8'));
  } catch {
    return {};
  }
}

export const bootFails = (): boolean => Boolean(RELEASE && faults().boot_fail?.includes(RELEASE));

export const extraTools = (): FaultTool[] => (RELEASE ? (faults().extra_tools?.[RELEASE] ?? []) : []);
