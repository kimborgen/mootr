// Renders the ITSA, workspace and requirements slots of the system prompt with the TS daemon's own
// src/itsa-owners.ts, src/workspace-prompt.ts, src/workspace-share.ts and src/requirements.ts, for
// go/internal/instructions' parity test (S-3776). DIR is a test home (never the live home) that the Go test filled:
// stam.db and settings.json; FAKEHOME is the user home. Stdin is JSON:
//
//   {"agents": ["id", ...], "index": [{"path": "/dir", "max": 1200}, ...]}
//
// It prints, per agent, itsaPrompt, workspacePrompt and grantedPaths, then the requirements prompt and
// workspaceIndex(path, max) for each index entry.
//
//   node go/internal/instructions/testdata/slotsref.mjs DIR FAKEHOME < input.json
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, fakeHome] = process.argv.slice(2);
if (!dir || !fakeHome) {
  console.error('usage: slotsref.mjs DIR FAKEHOME');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.HOME = resolve(fakeHome);
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_RELEASE_ID']) delete process.env[k];
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('slotsref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const { itsaPrompt } = await import('../../../../src/itsa-owners.ts');
const { workspacePrompt, workspaceIndex } = await import('../../../../src/workspace-prompt.ts');
const { grantedPaths } = await import('../../../../src/workspace-share.ts');
const { prompt: requirementsPrompt } = await import('../../../../src/requirements.ts');

const input = JSON.parse(readFileSync(0, 'utf8'));
const agents = {};
for (const id of input.agents) {
  const a = db.getAgent(id);
  agents[id] = { itsa: itsaPrompt(id), workspace: workspacePrompt(a), granted: grantedPaths(id) };
}
const out = { agents, requirements: requirementsPrompt(), index: input.index.map((x) => workspaceIndex(x.path, x.max)) };
writeSync(1, JSON.stringify(out));
process.exit(0);
