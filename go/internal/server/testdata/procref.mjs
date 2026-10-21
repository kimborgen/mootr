// What src/daemon.ts GET /api/processes answers (processRoute) over a fixed set of ITSAs, for go/internal/server's processes
// test (S-2952, PR 7): the checkout's processes/ parsed against the registry's agent types and the default ITSA statuses, the
// live counts of the ITSAs in testdata/proc-itsas.json, and the next-step text of each agent type. Never the live home.
//
//   node go/internal/server/testdata/procref.mjs DIR ITSAS.json
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const home = resolve(process.argv[2]);
mkdirSync(home, { recursive: true });
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('procref: refusing the live home');
  process.exit(2);
}
const { loadProcesses, processCounts, renderNextSteps, stageRefusal, closeNodeOf } = await import('../../../../src/process.ts');
const { agentTypes } = await import('../../../../src/agent-types.ts');
const { fallbackNextSteps, nextSteps } = await import('../../../../src/process-brief-fallback.ts');
const itsas = JSON.parse(readFileSync(process.argv[3], 'utf8'));

const types = Object.keys(agentTypes()).sort();
const dir = join(config.ROOT, 'processes');
const { processes, errors } = loadProcesses(dir, { knownTypes: new Set(types) });
const counts = processCounts(processes, itsas);
const source = (id) => {
  try {
    return readFileSync(join(dir, `${id}.yaml`), 'utf8');
  } catch {
    return undefined;
  }
};
const response = { processes: processes.map((p) => ({ ...p, counts: counts[p.id] ?? {}, source: source(p.id) })), errors, types };
const steps = {};
for (const t of types) steps[t] = processes.map((p) => renderNextSteps(p, t));
const fallbacks = {};
for (const t of [...types, 'nobody']) fallbacks[t] = fallbackNextSteps(t);
const briefs = {};
for (const t of [...types, 'nobody']) briefs[t] = nextSteps(t, dir);
const refusals = [];
for (const p of processes) {
  const ids = Object.keys(p.nodes);
  for (const from of [...ids, '', 'ghost']) for (const to of [...ids, '', 'ghost']) refusals.push([p.id, from, to, stageRefusal(p, from || null, to || null)]);
}
const closeNodes = processes.map((p) => [p.id, closeNodeOf(p)]);
writeFileSync(join(home, 'expect.json'), JSON.stringify({ response, steps, fallbacks, briefs, refusals, closeNodes, files: readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort() }));
process.exit(0);
