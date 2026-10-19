#!/usr/bin/env node
// The activity_info tool and `stam activity --summary` (S-1010) against a test daemon: an in-process
// HTTP server that answers /api/activity?by=summary with the real activity summary (src/activity-summary.ts)
// over the realistic-scale fixture (test/activity-fixture.mjs, seeded small), /api/agents/:id from the
// registry, and /api/usage with a stub. Free and deterministic: no model, no real daemon.
// `node --test test/activity-info.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';
import { settled } from './activity-settled.mjs';

const home = tempHome('stam-activity-info-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `activity-info-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ cost: { accounts: { claude: { match: { harness: 'claude' } } } } }));

// The URL must be set before src/config.ts loads (it reads STAM_URL once), so the server goes up first.
const calls = [];
const usageBody = { days: 7, accounts: [] };
// The display mode the summary route names (the daemon's settings cost.display.mode).
let displayMode = 'api';
let db, summary, mcp, server, url, fixture, caller, row;
const serve = (db, summary, fixture) =>
  async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!req.headers['x-stam-human']) calls.push(req.url); // the agent's calls; the CLI's are checked by its output
    const send = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    try {
      if (u.pathname === '/api/usage') return send(200, usageBody);
      if (u.pathname === '/api/activity' && u.searchParams.get('by') === 'summary') {
        // An OpenCode server's shared token names its agent with `as` (usageViewer); without it the route
        // has no viewer and refuses the caller's scope, so every call must carry it.
        // The CLI speaks for the human (x-stam-human) and is let through.
        if (!u.searchParams.get('as') && !req.headers['x-stam-human']) return send(403, { error: 'no as= for the shared token' });
        const s = await summary.activitySummary({ days: Number(u.searchParams.get('days') ?? 7), scope: u.searchParams.get('scope'), now: fixture.now });
        return send(200, { ...s, display_mode: displayMode });
      }
      const m = u.pathname.match(/^\/api\/agents\/(.+)$/);
      if (m) {
        const a = db.getAgent(decodeURIComponent(m[1]));
        return a ? send(200, a) : send(404, { error: 'no agent' });
      }
      send(404, { error: 'no route' });
    } catch (e) {
      send(e.status ?? 500, { error: e.message });
    }
  };

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  process.env.STAM_URL = url;
  process.env.STAM_TOKEN = 'test';

  db = await import('../src/db.ts');
  summary = await import('../src/activity-summary.ts');
  const { seedScale } = await import('./activity-fixture.mjs');
  fixture = seedScale(db, { agents: 60, days: 7 });
  summary.resetSummary();
  server.removeAllListeners('request');
  server.on('request', serve(db, summary, fixture));
  mcp = await import('../src/mcp.ts');

  // A caller whose config and type have closed issues in the fleet: the first row of by_model_type.
  const fleet = await settled({ days: 7, now: fixture.now });
  row = fleet.configs.by_model_type[0];
  caller = db.listAgents().find((a) => `${a.harness} · ${a.model || 'unknown'}` === row.model && a.type === row.type);
  assert.ok(caller, 'the fixture has an agent of the top config and type');
  // An agent's process has STAM_AGENT_ID, so its calls are not sent as the human (client.ts); the fake then
  // refuses a summary call without `as`, as the route does for a shared OpenCode token.
  process.env.STAM_AGENT_ID = caller.id;
});

after(() => {
  server?.close();
});

const info = async (args) => JSON.parse((await mcp.callTool('activity_info', { self: caller.id, ...args })).content[0].text);
const LEAF_KEYS = ['leaves', 'cost_modes', 'groups', 'working_by_day', 'parts', 'children'];
const noLeaves = (x) => {
  const s = JSON.stringify(x);
  for (const k of LEAF_KEYS) assert.ok(!s.includes(`"${k}":`), `no ${k} in the compact answer`);
};

test('activity_info: compact by default, scoped to the caller, with the typical block', async () => {
  const text = (await mcp.callTool('activity_info', { self: caller.id })).content[0].text;
  const r = JSON.parse(text);
  assert.equal(r.labels, undefined);
  assert.deepEqual(Object.keys(r).sort(), ['agents', 'bottlenecks', 'categories', 'clock', 'configs', 'days', 'scope', 'tiles', 'trees', 'typical', 'unit'].sort());
  assert.equal(r.scope.kind, 'agent');
  assert.equal(r.scope.id, caller.id);
  assert.equal(r.days, 7);
  assert.deepEqual(Object.keys(r.clock), ['total_h', 'working_h', 'friction_h', 'others_h', 'you_h', 'idle_h']);
  for (const v of Object.values(r.clock)) assert.ok(Number.isFinite(v) && Math.round(v * 10) / 10 === v, `${v} is hours to 1 decimal`);
  assert.equal(r.unit, 'USD (API)');
  assert.equal(r.tiles.cost.unit, 'USD (API)');
  assert.equal(r.tiles.cost.value, r.tiles.cost.api_usd);
  assert.ok(r.bottlenecks.length <= 5 && r.categories.length <= 5);
  for (const b of r.bottlenecks) {
    assert.deepEqual(Object.keys(b), ['label', 'hours', 'agents', 'top', 'longest_h']);
    assert.ok(b.top.length <= 2 && b.top.every((t) => t.length === 2));
  }
  for (const c of r.categories) assert.deepEqual(Object.keys(c), ['label', 'hours', 'cost']);
  assert.deepEqual(Object.keys(r.configs.by_model_type[0]), ['model', 'type', 'n', 'cost_median', 'working_h_median', 'lead_h_median', 'review_rounds_median']);
  for (const t of r.trees) assert.deepEqual(Object.keys(t), ['name', 'agents', 'working_h', 'cost']);
  noLeaves(r);
  assert.deepEqual(r.typical.for, { type: caller.type, model: `${caller.harness} · ${caller.model || 'unknown'}` });
  // The compact rows are the detail rows in hours and the api cost (the mode of this test's usage stub).
  const full = await info({ detail: true });
  for (const x of r.configs.by_model_type) {
    const d = full.configs.by_model_type.find((y) => y.model === x.model && y.type === x.type);
    assert.equal(x.n, d.n);
    assert.equal(x.cost_median, d.cost_usd.median);
    assert.equal(x.working_h_median, Math.round((d.working_s.median / 3600) * 10) / 10);
  }
  const own = full.configs.by_model_type.find((y) => y.model === row.model && y.type === row.type);
  if (own) assert.equal(r.typical.scope.n, own.n);
  assert.ok(calls.includes(`/api/activity?by=summary&days=7&scope=${encodeURIComponent(`agent:${caller.id}`)}&as=${caller.id}`));
  assert.ok(calls.includes(`/api/activity?by=summary&days=7&as=${caller.id}`), 'the fleet is read as the everything summary');
  // Every summary call names the caller, so an OpenCode server's shared token is not refused (the 403 fake above).
  for (const c of calls.filter((x) => x.includes('by=summary'))) assert.match(c, new RegExp(`[?&]as=${caller.id}(&|$)`), c);
  assert.ok(text.length < 3000, `${text.length} bytes for a manager-sized scope, under 3 KB`);
});

test('activity_info: detail true gives the whole summary, with its leaves and cost modes', async () => {
  const r = await info({ detail: true });
  assert.equal(r.labels, undefined);
  assert.equal(r.display_mode, undefined);
  assert.ok(r.clock.groups && r.tiles && r.bottlenecks && r.configs && r.trees);
  assert.ok(r.configs.by_model_type[0].cost_modes, 'cost modes are kept');
  assert.deepEqual(Object.keys(r.typical.fleet), ['n', 'cost_usd', 'working_s', 'lead_s', 'review_rounds']);
  assert.equal(r.typical.fleet.n, row.n);
  assert.equal(r.typical.fleet.working_s, row.working_s.median);
  assert.equal(r.typical.fleet.cost_usd, row.cost_usd.median);
  assert.equal(r.typical.fleet.lead_s, row.lead_s.median);
  assert.equal(r.typical.fleet.review_rounds, row.review_rounds.median);
});

test('activity_info: the compact answer makes exactly the summary, fleet and registry calls, no usage call', async () => {
  const from = calls.length;
  await info({});
  const made = calls.slice(from);
  assert.deepEqual(made, [
    `/api/activity?by=summary&days=7&scope=${encodeURIComponent(`agent:${caller.id}`)}&as=${caller.id}`,
    `/api/activity?by=summary&days=7&as=${caller.id}`,
    `/api/agents/${caller.id}`,
  ]);
});

test('activity_info: compare false gives the compact summary alone; a tree scope is the scope', async () => {
  const r = await info({ compare: false, scope: `tree:${caller.id}`, days: 3 });
  assert.equal(r.typical, undefined);
  assert.equal(r.labels, undefined);
  assert.equal(r.scope.kind, 'tree');
  assert.equal(r.days, 3);
  noLeaves(r);
});

test('activity_info: the cost is in the display mode, with its unit', async () => {
  displayMode = 'five_hour';
  try {
    const full = await info({ detail: true, compare: false });
    const r = await info({ compare: false });
    assert.equal(r.unit, '% of 5-hour window');
    assert.equal(r.tiles.cost.unit, '% of 5-hour window');
    assert.equal(r.tiles.cost.value, full.tiles.cost.modes.five_hour);
    assert.equal(r.tiles.cost.api_usd, full.tiles.cost.cost_usd);
    if (full.tiles.cost_per_working_hour) assert.equal(r.tiles.cost_per_working_hour.value, full.tiles.cost_per_working_hour.modes.five_hour);
    assert.equal(r.trees[0]?.cost, full.trees[0]?.modes.five_hour);
  } finally {
    displayMode = 'api';
  }
});

test("activity_info: an unknown scope is refused with the route's message", async () => {
  await assert.rejects(mcp.callTool('activity_info', { self: caller.id, scope: 'itsa:S-99999' }), /no ITSA S-99999/);
});

test('activityInfoOf: the fleet is dropped when its medians equal the scope\'s, kept when they differ', async () => {
  const { activityInfoOf } = await import('../src/activity-info.ts');
  const spread = (median) => ({ n: 2, median, p75: median });
  const modes = (api) => ({ api, five_hour: api * 5, seven_day: api * 2, subscription: null, paid_usd: 0 });
  const summary = (medianUsd, bottlenecks = []) => ({
    scope: { kind: 'agent', id: 'x', name: 'x' }, days: 7, agents: 1,
    clock: { total_s: 3600, working_s: 1800, friction_s: 0, others_s: 0, you_s: 900, idle_s: 900 },
    tiles: { cost: { cost_usd: medianUsd, modes: modes(medianUsd) }, cost_per_working_hour: null },
    bottlenecks, working_by_category: [], trees: [],
    configs: { n: 1, by_model_type: [{ model: 'claude · m', type: 'developer', n: 2, cost_usd: spread(medianUsd), cost_modes: { api: spread(medianUsd), five_hour: spread(medianUsd * 5), seven_day: spread(medianUsd * 2), subscription: spread(null), paid_usd: spread(0) }, working_s: spread(3600), waiting_s: spread(0), lead_s: spread(7200), review_rounds: spread(1) }] },
  });
  const caller = { type: 'developer', harness: 'claude', model: 'm' };
  const same = activityInfoOf(summary(2), { fleet: summary(2), caller });
  assert.equal(same.typical.fleet, undefined);
  assert.equal(same.typical.scope.cost_median, 2);
  assert.equal(same.typical.scope.lead_h_median, 2);
  const differ = activityInfoOf(summary(2), { fleet: summary(3), caller });
  assert.equal(differ.typical.fleet.cost_median, 3);
  assert.equal(differ.typical.scope.cost_median, 2);
  // The display mode picks the cost: five_hour is the row's five_hour median, and the unit names it.
  const fh = activityInfoOf(summary(2), { caller: null, mode: 'five_hour' });
  assert.equal(fh.tiles.cost.value, 10);
  assert.equal(fh.tiles.cost.api_usd, 2);
  // At most five bottlenecks, each with at most two top agents.
  const b = (i) => ({ label: `L${i}`, group: 'friction', seconds: 3600, agents: 1, top: [{ id: 'a', name: 'a', seconds: 3600 }, { id: 'b', name: 'b', seconds: 1 }, { id: 'c', name: 'c', seconds: 1 }], longest: null, key: `k${i}` });
  const many = activityInfoOf(summary(2, [1, 2, 3, 4, 5, 6].map(b)), {});
  assert.equal(many.bottlenecks.length, 5);
  assert.equal(many.bottlenecks[0].top.length, 2);
  assert.equal(many.bottlenecks[0].longest_h, null);
  // detail keeps the summary's fields and its typical block in full.
  const full = activityInfoOf(summary(2), { fleet: summary(2), caller, detail: true });
  assert.equal(full.tiles.cost.modes.api, 2);
  assert.equal(full.typical.fleet.cost_usd, 2);
});

test('usage_info points at activity_info', async () => {
  const r = JSON.parse((await mcp.callTool('usage_info', { self: caller.id })).content[0].text);
  assert.equal(r.see_also, 'For time and bottlenecks, call activity_info.');
  assert.deepEqual(r.accounts, usageBody.accounts);
});

test('stam activity --summary: text names the clock split, bottlenecks and trees; --json is the summary', async () => {
  const cli = (args) =>
    new Promise((resolve) => {
      // The CLI speaks for the human: no STAM_AGENT_ID, so its calls carry x-stam-human.
      const env = { ...process.env, STAM_HOME: home, STAM_URL: url, STAM_TOKEN: 'test' };
      delete env.STAM_AGENT_ID;
      const child = spawn(process.execPath, ['--no-warnings', 'src/cli.ts', 'activity', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => resolve({ code, out, err }));
    });
  const text = await cli(['--summary', '--days', '7']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /everything · 7 days · \d+ agents/);
  assert.match(text.out, /^clock [\d.]+ h: Working [\d.]+ h \(\d+%\)/m);
  assert.match(text.out, /^Bottlenecks$/m);
  assert.match(text.out, /^Trees$/m);
  const lines = text.out.split('\n');
  const bottlenecks = lines.slice(lines.indexOf('Bottlenecks') + 1, lines.indexOf('Trees')).filter((l) => l.startsWith('  '));
  assert.ok(bottlenecks.length >= 1 && bottlenecks.length <= 5, `${bottlenecks.length} bottlenecks`);
  const json = await cli(['--summary', '--scope', `agent:${caller.id}`, '--json']);
  assert.equal(json.code, 0, json.err);
  const s = JSON.parse(json.out);
  assert.equal(s.scope.kind, 'agent');
  assert.equal(s.by, 'summary');
});
