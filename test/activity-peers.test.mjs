#!/usr/bin/env node
// The activity summary across machines (S-1079), unit level, no daemon. Three processes run the summary's modules
// on throwaway homes with shares of the realistic-scale fixture (test/activity-fixture.mjs, 60 agents, 3 days):
//   union  every agent and the ITSAs, printing its summary (what a single machine would answer)
//   far    the even-numbered agents and the ITSAs (the ITSA home), serving its digests and attribution over HTTP
//   near   this process: the odd-numbered agents and no ITSAs, with far as its peer
// Checks: near's summary equals the union's for everything, a tree, an agent on each machine and an ITSA; a second
// read fetches no digests that did not change, and one that changed comes again; a peer that is gone is named in
// machines.missing, with near's own data. `node --test test/activity-peers.test.mjs`; PEER_AGENTS=700 PEER_REPORT=1
// runs the same at scale and prints the longest slice on each side and the digests' bytes; the end-to-end version on
// real daemons is test/e2e-activity-peers.sh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';
import { settled } from './activity-settled.mjs';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const COST = { accounts: { claude: { match: { harness: 'claude' } }, codex: { match: { harness: 'codex' } }, openrouter: { match: { harness: 'opencode' }, paid: true } } };
const homes = { union: tempHome('stam-peers-union-'), far: tempHome('stam-peers-far-'), near: tempHome('stam-peers-near-') };
const STAM_USD = { union: '3.5', far: '1.25', near: '2.25' };
const baseEnv = (name) => ({ ...process.env, STAM_USD: STAM_USD[name], STAM_HOME: homes[name], STAM_MACHINE: name, SEED_NOW: String(NOW), STAM_TMUX_SOCKET: `activity-peers-${process.pid}`, STAM_ACTIVITY_PEER_MS: '1', STAM_ACTIVITY_REMOTE_MS: '1', STAM_PEER_PROBE_MS: '100', STAM_PEER_CHECK_MS: '200', STAM_EMBEDDER: 'stub' });
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(homes.union, 'settings.json'), JSON.stringify({ cost: COST, itsa: { home: 'union' } }));
writeFileSync(join(homes.far, 'settings.json'), JSON.stringify({ cost: COST, itsa: { home: 'far' } }));

// The union's summary of a scope, from a process of its own.
function unionSummary(scope, viewer) {
  const r = spawnSync('node', ['test/activity-peer-stub.mjs', 'summary', 'all'], { env: { ...baseEnv('union'), SCOPE: scope ?? '', VIEWER: viewer ?? '' }, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

let far;
let farUrl;
let summary;
let db;
before(async () => {
  far = spawn('node', ['test/activity-peer-stub.mjs', 'serve', 'even'], { env: baseEnv('far'), stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    far.stdout.once('data', (d) => resolve(Number(String(d).trim())));
    far.once('exit', (c) => reject(new Error(`the far machine exited with ${c}`)));
  });
  farUrl = `http://127.0.0.1:${port}`;
  writeFileSync(join(homes.near, 'settings.json'), JSON.stringify({ cost: COST, itsa: { home: 'far' }, peers: [{ name: 'far', url: farUrl, token: 'test-peer-token' }] }));
  Object.assign(process.env, baseEnv('near'));
  db = await import('../src/db.ts');
  const { seedScale, splitFixture } = await import('./activity-fixture.mjs');
  seedScale(db, { agents: Number(process.env.PEER_AGENTS ?? 60), days: 3, now: NOW });
  splitFixture(db, 'odd', { itsas: false });
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd) VALUES ('stam', '2026-10-15', 'claude', 'm', 'claude', ?, 0, 0, 0, 0, 0)").run(Number(STAM_USD.near));
  summary = await import('../src/activity-summary.ts');
});
after(() => far?.kill());

const stats = async () => (await fetch(`${farUrl}/stats`)).json();
const ask = (scope, days = 3, viewer) => settled({ days, scope, now: NOW + 60_000, viewer });

// Seconds are carried to the millisecond and dollars to 1e-7, so a sum can land a step across a rounding edge.
function close(a, b, path = '') {
  const parts = path.split('/');
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `keys at ${path}`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}/${k}`);
  } else if (typeof a === 'number' && typeof b === 'number') {
    // Counts are exact; dollars to a few millionths; every other number is seconds.
    const tol = parts.some((k) => k.includes('usd')) ? 1e-5 : ['agents', 'n', 'review_rounds'].includes(parts[parts.length - 1]) ? 0 : 1;
    assert.ok(Math.abs(a - b) <= tol, `${path}: ${a} vs ${b}`);
  } else assert.deepEqual(a, b, path);
}
const SKIP = new Set(['modes', 'cost_modes', 'labels', 'machines', 'until', 'note', 'since']);
const strip = (x) => (Array.isArray(x) ? x.map(strip) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !SKIP.has(k)).map(([k, v]) => [k, strip(v)])) : x);

for (const scope of [undefined, 'tree:a0001', 'agent:a0002', 'agent:a0003', 'itsa:S-2']) {
  test(`near's summary of ${scope ?? 'everything'} equals the union's`, async () => {
    const got = await ask(scope);
    assert.deepEqual(got.machines, { included: ['near', 'far'], missing: [] });
    close(strip(got), strip(unionSummary(scope)));
  });
}

// An agent's token reads its own tree and its ancestors' trees whatever machine the agents are on, and the ITSAs it
// belongs to, judged on the ITSA home's data though this machine has none (S-1079 review).
const asViewer = [['a0001', 'tree:a0001'], ['a0001', 'tree:a0000'], ['a0001', undefined], ['a0006', 'tree:a0006'], ['a0003', 'agent:a0003']];
for (const [viewer, scope] of asViewer) {
  test(`${viewer} reads ${scope ?? 'everything'} as the union lets it`, async () => {
    const want = unionSummary(scope, viewer);
    if (want.error) await assert.rejects(ask(scope, 3, viewer), (e) => e.status === want.status);
    else close(strip(await ask(scope, 3, viewer)), strip(want));
  });
}
// A viewer on the peer machine: a0002 (a root, even, so on far) reads its own tree, whose closed issues near counts as the union does.
test('a viewer on the peer machine counts the closed issues its tree worked, as the union does (S-1197)', async () => {
  const all = await ask('tree:a0002');
  assert.ok(all.configs.n > 0, 'its tree worked closed issues');
  const got = await ask('tree:a0002', 3, 'a0002');
  assert.equal(got.configs.n, all.configs.n);
  close(got.configs, unionSummary('tree:a0002', 'a0002').configs);
});

test('an agent reads the ITSAs it belongs to on a machine without ITSAs, and no others', async () => {
  const r = spawnSync('node', ['test/activity-peer-stub.mjs', 'members', 'even'], { env: baseEnv('union'), encoding: 'utf8', timeout: 120_000 });
  const { key, member, outsider } = JSON.parse(r.stdout);
  const got = await ask(`itsa:${key}`, 3, member);
  assert.equal(got.scope.key, key);
  close(strip(got), strip(unionSummary(`itsa:${key}`, member)));
  await assert.rejects(ask(`itsa:${key}`, 3, outsider), (e) => e.status === 403);
});

test('a second read fetches only what changed', async () => {
  await ask();
  const before = await stats();
  await ask();
  assert.equal((await stats()).served, before.served, 'no digest changed, none comes again');
  const one = await ask('agent:a0002');
  await fetch(`${farUrl}/mutate?agent=a0002`);
  const again = await ask('agent:a0002');
  const after = await stats();
  assert.equal(after.served, before.served + 1, 'the digest that changed comes once');
  assert.ok(again.clock.total_s > one.clock.total_s, `the new hour shows: ${one.clock.total_s} then ${again.clock.total_s}`);
});

test('report', { skip: !process.env.PEER_REPORT }, async () => {
  const f = await stats();
  console.log(`far: ${f.served} digests in ${f.pages} pages, ${f.bytes} bytes; longest slice ${f.metrics.max_slice_ms} ms at ${f.metrics.max_slice_at}`);
  const n = summary.summaryMetrics();
  console.log(`near: longest slice ${n.max_slice_ms} ms at ${n.max_slice_at}; last merge ${n.last_merge_ms} ms`);
});

test('a peer that is gone is named, and the answer is near\'s own', async () => {
  far.kill();
  await new Promise((r) => far.once('exit', r));
  const got = await ask();
  assert.deepEqual(got.machines, { included: ['near'], missing: ['far'] });
  const own = Number(process.env.PEER_AGENTS ?? 60) / 2;
  assert.ok(got.agents > own / 2 && got.agents < own * 1.5, `${got.agents} agents of near's own (about ${own})`);
  assert.ok(got.clock.total_s > 0);
});
