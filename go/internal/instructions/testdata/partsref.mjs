// Builds each agent's Instructions view parts with the TS daemon's own src/agent-instructions.ts, for
// go/internal/instructions' parity test (S-3776). DIR is a test home (never the live home) that the Go test filled:
// stam.db, settings.json, registry.json, templates and skills; FAKEHOME is the user home. The stub embedder is on.
// Stdin is JSON:
//
//   {"agents": ["id", ...], "warm": ["id", ...]}
//
// It warms lessons for the agents in warm (src/retro-lessons.ts warmLessons), then prints agentInstructionParts for
// each agent.
//
//   node go/internal/instructions/testdata/partsref.mjs DIR FAKEHOME < input.json
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, fakeHome] = process.argv.slice(2);
if (!dir || !fakeHome) {
  console.error('usage: partsref.mjs DIR FAKEHOME');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.HOME = resolve(fakeHome);
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_RELEASE_ID']) delete process.env[k];
for (const k of Object.keys(process.env)) if (k.startsWith('MOOTR_')) delete process.env[k];
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('partsref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const { warmLessons } = await import('../../../../src/retro-lessons.ts');
const { agentInstructionParts } = await import('../../../../src/agent-instructions.ts');

const input = JSON.parse(readFileSync(0, 'utf8'));
for (const id of input.warm) await warmLessons(db.getAgent(id));
const agents = {};
for (const id of input.agents) agents[id] = agentInstructionParts(db.getAgent(id)).parts;
writeSync(1, JSON.stringify({ agents }));
process.exit(0);
