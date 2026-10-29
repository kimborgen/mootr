// Renders the org parts of the system prompt with the TS daemon's own src/org.ts and src/instructions.ts, for
// go/internal/instructions' parity test (S-3776). DIR is a test home (never the live home) that the Go test filled:
// stam.db, settings.json, registry.json and skills/; FAKEHOME is the user home; ROOT is the checkout to load src/ from (the
// test's isolated copy, whose blocks/ holds its fixture type; the repo when left out). Stdin is JSON:
//
//   {"agents": ["id", ...], "skills": ["name", ...]}
//
// It prints, per agent, orgRest, typeSegments, typePrompt, orgPrompt, managerCostPrompt and tree.childrenOf, then costPrompt,
// reviewerProcessPrompt and typeSkillsBlock(skills).
//
//   node go/internal/instructions/testdata/orgref.mjs DIR FAKEHOME [ROOT] < input.json
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, fakeHome, rootDir] = process.argv.slice(2);
if (!dir || !fakeHome) {
  console.error('usage: orgref.mjs DIR FAKEHOME [ROOT]');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.HOME = resolve(fakeHome);
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_RELEASE_ID']) delete process.env[k];
// src/config.ts takes ROOT from its own path, so the modules load from the root given.
const root = rootDir ? pathToFileURL(resolve(rootDir) + '/') : new URL('../../../../', import.meta.url);
const config = await import(new URL('src/config.ts', root));
if (config.LIVE_HOME) {
  console.error('orgref: refusing the live home');
  process.exit(2);
}
const db = await import(new URL('src/db.ts', root));
const org = await import(new URL('src/org.ts', root));
const tree = await import(new URL('src/tree.ts', root));
const { typeSkillsBlock } = await import(new URL('src/instructions.ts', root));

const input = JSON.parse(readFileSync(0, 'utf8'));
const agents = {};
for (const id of input.agents) {
  const a = db.getAgent(id);
  agents[id] = {
    rest: org.orgRest(a),
    segments: org.typeSegments(a),
    type: org.typePrompt(a),
    org: org.orgPrompt(a),
    cost: org.managerCostPrompt(a),
    children: tree.childrenOf(id),
  };
}
const out = { agents, cost: org.costPrompt(), reviewer: org.reviewerProcessPrompt(), skills: typeSkillsBlock(input.skills) };
writeSync(1, JSON.stringify(out));
process.exit(0);
