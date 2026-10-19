#!/usr/bin/env node
// Unit tests for src/process.ts (S-869 step 1): the process file format's loader and validator.
// The two shipped files under processes/ load with no errors, every lane type names a real
// registry type, each ITSA status maps to at most one node, and every validation error in the
// contract is refused. A throwaway STAM_HOME, no daemon, no network, no models, no sleeps.
// Run with `node --test test/process.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, tempHome } from './tmphome.mjs';

const home = tempHome('stam-process-');
process.env.STAM_HOME = home;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const HERE = import.meta.dirname;
const PROCESSES = join(HERE, '..', 'processes');

let proc, agentTypes;
let knownTypes;
before(async () => {
  proc = await import('../src/process.ts');
  agentTypes = await import('../src/agent-types.ts');
  knownTypes = new Set(Object.keys(agentTypes.agentTypes()));
});

// A minimal valid file: a start with one trigger into an agent task carrying a status.
const BASE = [
  'process: x',
  'title: X',
  'lanes:',
  '  human: { type: human }',
  '  dev: { type: developer }',
  'nodes:',
  '  start:',
  '    kind: start',
  '    lane: human',
  '    triggers:',
  '      - { source: manual }',
  '  work:',
  '    kind: agent',
  '    lane: dev',
  '    statuses: [in_progress]',
  'edges:',
  '  - [start, work]',
].join('\n');

const errs = (text, file = 'processes/x.yaml') => proc.parseProcess(text, { file, knownTypes }).errors;
const has = (errors, re) => errors.some((e) => re.test(e));
// The node text a case inserts before `edges:`, so a case can add a node without rewriting BASE.
const withNode = (node) => BASE.replace('edges:', `${node}\nedges:`);

test('both shipped process files load with no errors', () => {
  const { processes, errors } = proc.loadProcesses(PROCESSES, { knownTypes });
  assert.deepEqual(errors, []);
  assert.deepEqual(processes.map((p) => p.id).sort(), ['dev-change', 'retro-loop']);
});

test('every lane type is a registry type, human, script, or cos', () => {
  const { processes, errors } = proc.loadProcesses(PROCESSES, { knownTypes });
  assert.deepEqual(errors, []);
  for (const p of processes)
    for (const [name, lane] of Object.entries(p.lanes)) {
      const ok = proc.BUILTIN_LANE_TYPES.includes(lane.type) || knownTypes.has(lane.type);
      assert.ok(ok, `${p.id}: lane "${name}" names unknown type "${lane.type}"`);
      if (lane.fallback) assert.ok(proc.BUILTIN_LANE_TYPES.includes(lane.fallback) || knownTypes.has(lane.fallback), `${p.id}: lane "${name}" falls back to unknown type "${lane.fallback}"`);
    }
});

test('each ITSA status maps to at most one node per process', () => {
  const { processes } = proc.loadProcesses(PROCESSES, { knownTypes });
  for (const p of processes) {
    const seen = new Set();
    for (const n of Object.values(p.nodes))
      for (const s of n.statuses) {
        assert.ok(!seen.has(s), `${p.id}: status "${s}" is mapped twice`);
        seen.add(s);
      }
  }
});

test('the dev-change pipeline is drawn faithfully', () => {
  const { processes } = proc.loadProcesses(PROCESSES, { knownTypes });
  const dev = processes.find((p) => p.id === 'dev-change');
  assert.deepEqual(Object.keys(dev.nodes), ['request', 'route', 'plan', 'code', 'review', 'verdict', 'merge', 'deploy', 'hold', 'ask', 'done']);
  for (const [node, lane] of [['request', 'human'], ['route', 'cos'], ['plan', 'manager'], ['code', 'developer'], ['review', 'reviewer'], ['merge', 'manager'], ['deploy', 'watcher']])
    assert.equal(dev.nodes[node].lane, lane, `${node} is on lane ${lane}`);
  assert.deepEqual(dev.nodes.merge.statuses, ['ready_to_merge', 'merging']);
  assert.deepEqual(dev.nodes.deploy.statuses, ['deploying']);
  assert.equal(dev.nodes.done.status, 'done');
  assert.deepEqual(dev.nodes.ask.statuses, ['needs_input', 'needs_approval', 'needs_review', 'needs_test']);
  assert.deepEqual(dev.nodes.code.boundary.map((b) => b.on), ['cost', 'error']);
  assert.ok(dev.nodes.request.triggers.length >= 2, 'the start lists its triggers');
});

test('schema.json parses and its node kinds match the loader', () => {
  const schema = JSON.parse(readFileSync(join(PROCESSES, 'schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema.$defs.node.properties.kind.enum, [...proc.NODE_KINDS]);
});

test('a valid file parses', () => {
  const r = proc.parseProcess(BASE, { file: 'processes/x.yaml', knownTypes });
  assert.deepEqual(r.errors, []);
  assert.equal(r.process.id, 'x');
  assert.deepEqual(r.process.nodes.work.statuses, ['in_progress']);
});

test('refuses an unknown node kind', () => {
  assert.ok(has(errs(BASE.replace('kind: agent', 'kind: decision')), /unknown kind/));
});

test('refuses a node whose lane is unknown', () => {
  assert.ok(has(errs(BASE.replace('lane: dev', 'lane: nobody')), /unknown lane/));
});

test('refuses a node with no lane', () => {
  assert.ok(has(errs(BASE.replace('    lane: dev\n', '')), /missing lane/));
});

test('refuses a lane whose type is not a registry type', () => {
  assert.ok(has(errs(BASE.replace('dev: { type: developer }', 'dev: { type: not-a-type }')), /unknown agent type/));
});

test('refuses a lane whose fallback is not a registry type, and keeps a known one', () => {
  assert.ok(has(errs(BASE.replace('dev: { type: developer }', 'dev: { type: developer, fallback: not-a-type }')), /unknown agent type "not-a-type" in fallback/));
  const r = proc.parseProcess(BASE.replace('dev: { type: developer }', 'dev: { type: developer, fallback: reviewer-opus }'), { file: 'processes/x.yaml', knownTypes });
  assert.deepEqual(r.errors, []);
  assert.equal(r.process.lanes.dev.fallback, 'reviewer-opus');
});

test('refuses an edge to an unknown node', () => {
  assert.ok(has(errs(BASE.replace('[start, work]', '[start, gone]')), /unknown node "gone"/));
});

test('refuses a start node with an incoming edge', () => {
  assert.ok(has(errs(BASE.replace('- [start, work]', '- [start, work]\n  - [work, start]')), /start node "start" has an incoming edge/));
});

test('refuses an end node with an outgoing edge', () => {
  const text = withNode('  finish:\n    kind: end\n    lane: dev\n    status: done').replace('[start, work]', '[start, work]\n  - [work, finish]\n  - [finish, work]');
  assert.ok(has(errs(text), /end node "finish" has an outgoing edge/));
});

test('refuses a start without triggers', () => {
  assert.ok(has(errs(BASE.replace('    triggers:\n      - { source: manual }\n', '')), /needs at least one trigger/));
});

test('refuses a trigger without a source', () => {
  assert.ok(has(errs(BASE.replace('{ source: manual }', '{ label: no source }')), /trigger 1 has no source/));
});

test('refuses a timer trigger without a cron', () => {
  assert.ok(has(errs(BASE.replace('{ source: manual }', '{ source: timer }')), /timer trigger needs a cron/));
});

test('refuses an unknown ITSA status', () => {
  assert.ok(has(errs(BASE.replace('[in_progress]', '[not_a_status]')), /unknown ITSA status "not_a_status"/));
});

test('refuses the same ITSA status on two nodes', () => {
  assert.ok(has(errs(withNode('  other:\n    kind: agent\n    lane: dev\n    statuses: [in_progress]')), /mapped on more than one node/));
});

test('refuses a process id that differs from the file name', () => {
  assert.ok(has(errs(BASE, 'processes/y.yaml'), /must equal the file name "y"/));
});

test('refuses a human node with an unknown ask', () => {
  const text = BASE.replace('kind: agent', 'kind: human').replace('statuses: [in_progress]', 'ask: maybe');
  assert.ok(has(errs(text), /ask must be/));
});

test('refuses an unknown boundary event', () => {
  assert.ok(has(errs(BASE.replace('    statuses: [in_progress]', '    statuses: [in_progress]\n    boundary:\n      - { on: weather }')), /boundary event needs on/));
});

test('refuses an end node with an unknown status', () => {
  const text = withNode('  finish:\n    kind: end\n    lane: dev\n    status: finished');
  assert.ok(has(errs(text), /status must be done, canceled, wont_do/));
});

test('refuses a node id that is not lowercase', () => {
  assert.ok(has(errs(withNode('  Finish:\n    kind: agent\n    lane: dev')), /the id must match/));
});

test('refuses an edge line that is not a pair', () => {
  assert.ok(has(errs(BASE.replace('- [start, work]', '- [start]')), /must be \[from, to\]/));
});

test('refuses text that is not valid YAML', () => {
  assert.ok(has(errs('process: [unclosed'), /not valid YAML/));
});

test('loadProcesses resolves a sub-process call, and refuses one that is not loaded', () => {
  const dir = tempDir('stam-process-files-');
  writeFileSync(join(dir, 'x.yaml'), BASE);
  writeFileSync(join(dir, 'y.yaml'), BASE.replace('process: x', 'process: y').replace('    statuses: [in_progress]', '    statuses: [in_progress]\n    call: x'));
  writeFileSync(join(dir, 'z.yaml'), BASE.replace('process: x', 'process: z').replace('    statuses: [in_progress]', '    statuses: [in_progress]\n    call: ghost'));
  const { processes, errors } = proc.loadProcesses(dir, { knownTypes });
  assert.equal(processes.length, 3);
  assert.ok(has(errors.map((e) => e.message), /call "ghost" is not a loaded process/));
  assert.ok(!has(errors.map((e) => e.message), /call "x"/), 'a call to a loaded process is fine');
});

test('a lane machine is kept when it is a machine name and refused otherwise', () => {
  const ok = proc.parseProcess(BASE.replace('dev: { type: developer }', 'dev: { type: developer, machine: storage }'), { file: 'processes/x.yaml', knownTypes });
  assert.equal(ok.process.lanes.dev.machine, 'storage');
  assert.ok(has(errs(BASE.replace('dev: { type: developer }', 'dev: { type: developer, machine: "a b" }')), /machine must be a machine name/));
});
