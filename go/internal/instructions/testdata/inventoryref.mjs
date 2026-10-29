// Builds inventories with the TS daemon's own src/inventory.ts, for go/internal/instructions' parity test (S-3776).
// DIR is a test home (never the live home) that the Go test filled: stam.db, settings.json, registry.json, templates
// and skills; FAKEHOME is the user home. The stub embedder is on, and no summary model is set. Stdin is JSON:
//
//   {"agents": ["id", ...], "types": [{"name": "t", "harness": "h or empty"}, ...], "warm": ["id", ...]}
//
// It warms lessons for the agents in warm, then prints withSummaries(agentInventory) per agent and
// withSummaries(typeInventory) per type, or {"error": message} where it throws.
//
//   node go/internal/instructions/testdata/inventoryref.mjs DIR FAKEHOME < input.json
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, fakeHome] = process.argv.slice(2);
if (!dir || !fakeHome) {
  console.error('usage: inventoryref.mjs DIR FAKEHOME');
  process.exit(2);
}
for (const k of Object.keys(process.env)) if (k.startsWith('MOOTR_')) delete process.env[k];
process.env.STAM_HOME = resolve(dir);
process.env.HOME = resolve(fakeHome);
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_RELEASE_ID', 'STAM_OPENROUTER_URL']) delete process.env[k];
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('inventoryref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const { warmLessons } = await import('../../../../src/retro-lessons.ts');
const { agentInventory, typeInventory, withSummaries } = await import('../../../../src/inventory.ts');

const input = JSON.parse(readFileSync(0, 'utf8'));
for (const id of input.warm) await warmLessons(db.getAgent(id));
const agents = {};
for (const id of input.agents) agents[id] = withSummaries(agentInventory(db.getAgent(id)));
const types = input.types.map(({ name, harness }) => {
  try {
    return withSummaries(typeInventory(name, harness || undefined));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
});
writeSync(1, JSON.stringify({ agents, types }));
process.exit(0);
