#!/usr/bin/env node
// Unit tests for src/usage-drill.ts (S-657): the spend series and the drill scope the redesigned
// Usage page reads. Seeded throwaway STAM_HOME, no daemon, no network, no models:
// `node --test test/usage-drill.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-usage-drill-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `usage-drill-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    cost: {
      accounts: { claude: { match: { harness: 'claude' } }, openrouter: { match: { harness: 'opencode' }, paid: true } },
    },
  }),
);

let db, drill, usage, ic;
before(async () => {
  db = await import('../src/db.ts');
  drill = await import('../src/usage-drill.ts');
  usage = await import('../src/usage.ts');
  ic = await import('../src/issue-costs.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function agent(id, harness = 'claude', model = 'claude-haiku-5-5', parent = null) {
  db.createAgent({ id, name: id, role: 'test', machine: 'x', harness, model, effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
  db.open().prepare('UPDATE agents SET created_at = ? WHERE id = ?').run(new Date(NOW - 3 * DAY).toISOString(), id);
}
function useRow(agentId, day, harness, model, account, cost, tin = 0, tout = 0, tcr = 0, tcw = 0) {
  db.open()
    .prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(agentId, day, harness, model, account, cost, tin, tout, tcr, tcw);
}
function sample(agentId, ms, account, harness, model, cost, tin = 0) {
  db.open()
    .prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?,?,?,?,?,?,?,0,0,0)')
    .run(agentId, account, harness, model, new Date(ms).toISOString(), cost, tin);
}
function itsaRow(id, key, parent, status, owner) {
  const at = new Date(NOW - 3 * DAY).toISOString();
  db.open()
    .prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, key, parent, 'issue', `${key} title`, status, owner, 'A', at, at);
}
function itsaEvent(id, ts, type, data) {
  db.open().prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?,?,?,?,?)').run(id, ts, 'A', type, JSON.stringify(data));
}
function clear() {
  const d = db.open();
  for (const t of ['usage', 'usage_samples', 'itsa_events', 'itsa_participants', 'itsas', 'agents', 'window_readings', 'subscriptions']) d.exec(`DELETE FROM ${t}`);
  usage.resetSnapshotMemo();
  ic.resetTypicalMemo();
}
beforeEach(clear);

// R > K, plus an unrelated Z. R spent yesterday and today, and 10-09 (the previous period for
// days=2); K and Z spent today only.
function seed() {
  agent('R');
  agent('K', 'claude', 'claude-haiku-5-5', 'R');
  agent('Z', 'opencode', 'deepseek-v4');
  useRow('R', dayOf(NOW - 3 * DAY), 'claude', 'claude-haiku-5-5', 'claude', 7);
  useRow('R', dayOf(NOW - DAY), 'claude', 'claude-haiku-5-5', 'claude', 4);
  useRow('R', dayOf(NOW), 'claude', 'claude-haiku-5-5', 'claude', 10);
  useRow('K', dayOf(NOW), 'claude', 'claude-haiku-5-5', 'claude', 2);
  useRow('Z', dayOf(NOW), 'opencode', 'deepseek-v4', 'openrouter', 3);
}
const rowsByT = (s) => Object.fromEntries(s.rows.map((r) => [r.t, r]));
const groupsById = (s) => Object.fromEntries(s.groups.map((g) => [g.id, g]));

test('series > day rows by agent, top groups, total and the previous period', () => {
  seed();
  const s = drill.spendSeries({ days: 2, group: 'agent', now: NOW });
  assert.equal(s.bucket, 'day');
  assert.equal(s.group, 'agent');
  assert.equal(s.total.cost_usd, 19); // R 14 + K 2 + Z 3
  assert.equal(s.previous.cost_usd, 7); // R on 10-09
  const byT = rowsByT(s);
  assert.equal(byT['2026-10-11'].cost_usd, 4);
  assert.equal(byT['2026-10-12'].cost_usd, 15);
  assert.equal(byT['2026-10-12'].groups.R.cost_usd, 10);
  assert.equal(byT['2026-10-12'].groups.K.cost_usd, 2);
  assert.equal(byT['2026-10-11'].groups.K.cost_usd, 0); // every legend group in every row
  assert.equal(byT['2026-10-12'].tokens_in, 0);
  assert.deepEqual(s.groups.map((g) => g.id).sort(), ['K', 'R', 'Z']);
});

test('series > more than five groups split into Other', () => {
  for (let i = 1; i <= 7; i++) {
    agent(`a${i}`);
    useRow(`a${i}`, dayOf(NOW), 'claude', 'm', 'claude', i);
  }
  const s = drill.spendSeries({ days: 2, group: 'agent', now: NOW });
  assert.equal(s.groups.length, 6); // top 5 + Other
  assert.equal(s.groups.at(-1).id, 'other');
  const other = groupsById(s).other;
  assert.equal(other.name, 'Other');
  const byT = rowsByT(s);
  assert.equal(byT['2026-10-12'].groups.other.cost_usd, 3); // a2 2 + a1 1
  assert.equal(s.total.cost_usd, 28);
});

test('series > the previous period is bucketed by the current legend, with the rest in Other', () => {
  // Current period: a1 and a2. Previous period (10-07..10-09): a1 and p1, which only spent then.
  agent('a1');
  agent('a2');
  agent('p1');
  useRow('a1', dayOf(NOW), 'claude', 'm', 'claude', 5);
  useRow('a2', dayOf(NOW), 'claude', 'm', 'claude', 3);
  useRow('a1', '2026-10-09', 'claude', 'm', 'claude', 2);
  useRow('p1', '2026-10-09', 'claude', 'm', 'claude', 9);
  useRow('p1', '2026-10-08', 'claude', 'm', 'claude', 4);
  const s = drill.spendSeries({ days: 2, group: 'agent', now: NOW });
  assert.deepEqual(s.groups.map((g) => g.id), ['a1', 'a2', 'other']); // Other joins the legend for the fold
  const prev = Object.fromEntries(s.previous_rows.map((r) => [r.t, r]));
  assert.deepEqual(s.previous_rows.map((r) => r.t), ['2026-10-07', '2026-10-08', '2026-10-09']);
  assert.equal(prev['2026-10-09'].groups.a1.cost_usd, 2);
  assert.equal(prev['2026-10-09'].groups.other.cost_usd, 9); // p1 is not in the current legend
  assert.equal(prev['2026-10-08'].groups.other.cost_usd, 4);
  assert.equal(prev['2026-10-09'].cost_usd, 11);
  assert.equal(s.previous.cost_usd, 15); // the rows add up to the previous total
  assert.equal(s.previous_rows.reduce((a, r) => a + r.cost_usd, 0), 15);
  assert.equal(rowsByT(s)['2026-10-12'].groups.other.cost_usd, 0); // Other is in every current row too
});

test('series > every bucket of both periods has a row, zero when nothing was spent', () => {
  agent('R');
  useRow('R', dayOf(NOW), 'claude', 'm', 'claude', 5);
  const s = drill.spendSeries({ days: 2, group: 'agent', now: NOW });
  assert.deepEqual(s.rows.map((r) => r.t), ['2026-10-10', '2026-10-11', '2026-10-12']);
  assert.equal(rowsByT(s)['2026-10-10'].cost_usd, 0);
  assert.equal(rowsByT(s)['2026-10-10'].groups.R.cost_usd, 0);
  assert.deepEqual(s.previous_rows.map((r) => r.t), ['2026-10-07', '2026-10-08', '2026-10-09']);
  const h = drill.spendSeries({ days: 1, group: 'agent', now: NOW });
  assert.equal(h.bucket, 'hour');
  assert.equal(h.rows.length, 25);
  assert.equal(h.previous_rows.length, 24);
});

test('series > days=6 draws 7 calendar days and 7 previous days (the page asks for N-1)', () => {
  agent('R');
  useRow('R', dayOf(NOW), 'claude', 'm', 'claude', 5);
  const s = drill.spendSeries({ days: 6, group: 'agent', now: NOW });
  assert.equal(s.rows.length, 7);
  assert.equal(s.previous_rows.length, 7);
  assert.equal(s.rows[0].t, '2026-10-06');
  assert.equal(s.rows.at(-1).t, '2026-10-12');
  assert.equal(s.previous_rows[0].t, '2026-09-29');
  assert.equal(s.previous_rows.at(-1).t, '2026-10-05');
});

test('series > group=tree rolls a child into its root', () => {
  seed();
  const s = drill.spendSeries({ days: 2, group: 'tree', now: NOW });
  const g = groupsById(s);
  assert.equal(g.R.name, 'R');
  assert.equal(rowsByT(s)['2026-10-12'].groups.R.cost_usd, 12); // R 10 + K 2
  assert.equal(rowsByT(s)['2026-10-12'].groups.Z.cost_usd, 3);
  assert.equal(s.total.cost_usd, 19);
  assert.equal(s.previous.cost_usd, 7);
});

test('series > group=model splits one model by harness', () => {
  agent('C1', 'claude', 'm');
  agent('O1', 'opencode', 'm');
  useRow('C1', dayOf(NOW), 'claude', 'm', 'claude', 1);
  useRow('O1', dayOf(NOW), 'opencode', 'm', 'openrouter', 2);
  const s = drill.spendSeries({ days: 2, group: 'model', now: NOW });
  const byId = Object.fromEntries(s.groups.map((g) => [g.id, g]));
  assert.deepEqual(Object.keys(byId).sort(), ['claude · m', 'opencode · m']);
  assert.equal(byId['claude · m'].name, 'm');
  assert.equal(byId['claude · m'].harness, 'claude');
  assert.equal(byId['opencode · m'].name, 'm');
  assert.equal(byId['opencode · m'].harness, 'opencode');
  assert.equal(rowsByT(s)['2026-10-12'].groups['opencode · m'].cost_usd, 2);
});

test('series > days=1 is hourly, from usage_samples', () => {
  agent('R');
  agent('Z', 'opencode', 'deepseek-v4');
  sample('R', NOW - 3 * HOUR, 'claude', 'claude', 'claude-haiku-5-5', 5);
  sample('R', NOW - 2.5 * HOUR, 'claude', 'claude', 'claude-haiku-5-5', 1);
  sample('Z', NOW - 7 * HOUR, 'openrouter', 'opencode', 'deepseek-v4', 2);
  sample('R', NOW - 30 * HOUR, 'claude', 'claude', 'claude-haiku-5-5', 4); // the previous day
  const s = drill.spendSeries({ days: 1, group: 'agent', now: NOW });
  assert.equal(s.bucket, 'hour');
  assert.equal(s.total.cost_usd, 8); // 5 + 1 + 2
  assert.equal(s.previous.cost_usd, 4);
  const byT = rowsByT(s);
  assert.equal(byT['2026-10-12T09:00:00.000Z'].groups.R.cost_usd, 6); // 09:00 and 09:30 share the hour
  assert.equal(byT['2026-10-12T05:00:00.000Z'].groups.Z.cost_usd, 2);
});

test('series > group=itsa splits a sample by issue attribution', () => {
  agent('A');
  itsaRow('p', 'P-1', null, 'in_progress', 'A');
  itsaRow('c', 'C-1', 'p', 'in_progress', 'A');
  itsaEvent('p', new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  itsaEvent('c', new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  sample('A', NOW - HOUR, '', 'claude', 'claude-haiku-5-5', 10);
  const s = drill.spendSeries({ days: 1, group: 'itsa', now: NOW });
  assert.equal(s.total.cost_usd, 10);
  assert.deepEqual(s.groups.map((g) => g.id).sort(), ['C-1', 'P-1']);
  // A owns both, so the sample splits evenly: 5 each.
  assert.equal(rowsByT(s)['2026-10-12T11:00:00.000Z'].groups['P-1'].cost_usd, 5);
  assert.equal(rowsByT(s)['2026-10-12T11:00:00.000Z'].groups['C-1'].cost_usd, 5);
});

test('series > a DAG agent groups under its smallest root without poisoning its ancestors', () => {
  agent('a');
  agent('b');
  agent('P', 'claude', 'm', 'b'); // P's root is b
  agent('X', 'claude', 'm', 'a'); // X has parents a and P: smallest root is a
  db.addParent('X', 'P');
  // X's row is on an earlier day than P's, so rootOf(X) is walked first: with the old memo it
  // cached P under a, and P grouped under a instead of its own root b.
  useRow('X', dayOf(NOW - DAY), 'claude', 'm', 'claude', 1);
  useRow('P', dayOf(NOW), 'claude', 'm', 'claude', 10);
  useRow('b', dayOf(NOW), 'claude', 'm', 'claude', 100);
  const s = drill.spendSeries({ days: 2, group: 'tree', now: NOW });
  const byT = rowsByT(s);
  assert.equal(byT[dayOf(NOW - DAY)].groups.a.cost_usd, 1); // X only, under its smallest root a
  assert.equal(byT[dayOf(NOW)].groups.b.cost_usd, 110); // b + P, not a
  assert.equal(byT[dayOf(NOW)].groups.a.cost_usd, 0);
});

test('series > previous is the same number of calendar days as the current period', () => {
  agent('R');
  // Current covers 10-10..10-12 (3 days); previous must cover 10-07..10-09 (3 days).
  for (const [d, c] of Object.entries({ '2026-10-07': 2, '2026-10-08': 4, '2026-10-09': 6, '2026-10-10': 1, '2026-10-11': 1, '2026-10-12': 1 })) {
    useRow('R', d, 'claude', 'm', 'claude', c);
  }
  const s = drill.spendSeries({ days: 2, group: 'agent', now: NOW });
  assert.equal(s.rows.length, 3);
  assert.equal(s.total.cost_usd, 3);
  assert.equal(s.previous.cost_usd, 12);
});

test('series > group=itsa aligns to calendar days, keeps an Unattributed group, and totals the same', () => {
  agent('A');
  agent('B'); // no ITSA: its samples land on Unattributed
  itsaRow('p', 'P-1', null, 'in_progress', 'A');
  itsaEvent('p', new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  sample('A', Date.parse('2026-10-10T01:00:00.000Z'), '', 'claude', 'm', 4); // early on the first day
  sample('A', Date.parse('2026-10-11T10:00:00.000Z'), '', 'claude', 'm', 3);
  sample('B', Date.parse('2026-10-12T06:00:00.000Z'), '', 'claude', 'm', 2);
  const s = drill.spendSeries({ days: 2, group: 'itsa', now: NOW });
  assert.equal(s.total.cost_usd, 9); // 4 + 3 + 2
  const byId = Object.fromEntries(s.groups.map((g) => [g.id, g]));
  assert.equal(byId.unattributed.name, 'Unattributed');
  assert.equal(rowsByT(s)['2026-10-10'].groups['P-1'].cost_usd, 4); // the day's early sample is in
  assert.equal(rowsByT(s)['2026-10-11'].groups['P-1'].cost_usd, 3);
  assert.equal(rowsByT(s)['2026-10-12'].groups.unattributed.cost_usd, 2);
});

test('series > hidden agents and unreadable ITSAs collapse into Other', () => {
  seed();
  const s = drill.spendSeries({ days: 2, group: 'agent', now: NOW, visible: new Set(['R', 'K']) });
  const g = groupsById(s);
  assert.ok(g.Z === undefined, 'Z should be hidden');
  assert.equal(rowsByT(s)['2026-10-12'].groups.other.cost_usd, 3);
  assert.equal(s.total.cost_usd, 19); // the total still adds up

  clear();
  agent('A');
  itsaRow('p', 'P-1', null, 'in_progress', 'A');
  itsaRow('c', 'C-1', null, 'in_progress', 'A');
  itsaEvent('p', new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  itsaEvent('c', new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  sample('A', NOW - HOUR, '', 'claude', 'claude-haiku-5-5', 10);
  const t = drill.spendSeries({ days: 1, group: 'itsa', now: NOW, mayItsa: (key) => key === 'C-1' });
  assert.deepEqual(t.groups.map((g) => g.id).sort(), ['C-1', 'other']);
});

test('scope > a tree: totals, agents, models and the by-agent series', () => {
  seed();
  const r = drill.drillScope({ days: 2, kind: 'tree', ref: 'R', now: NOW });
  assert.deepEqual(r.scope, { kind: 'tree', id: 'R', name: 'R' });
  assert.equal(r.totals.cost_usd, 16); // R 14 + K 2
  const by = Object.fromEntries(r.by_agent.map((a) => [a.id, a]));
  assert.equal(by.R.cost_usd, 14);
  assert.equal(by.K.cost_usd, 2);
  assert.equal(by.R.role, 'test');
  assert.equal(by.R.harness, 'claude');
  assert.equal(r.by_model.length, 1);
  assert.equal(r.by_model[0].harness, 'claude');
  assert.equal(r.by_model[0].model, 'claude-haiku-5-5');
  assert.equal(r.by_model[0].cost_usd, 16);
  assert.equal(r.timeseries.group, 'agent');
  assert.equal(rowsByT(r.timeseries)['2026-10-12'].groups.K.cost_usd, 2);
  assert.ok(Array.isArray(r.windows));
});

test('scope > one agent and one model and one harness', () => {
  seed();
  const z = drill.drillScope({ days: 14, kind: 'agent', ref: 'Z', now: NOW });
  assert.equal(z.totals.cost_usd, 3);
  assert.deepEqual(z.by_agent.map((a) => a.id), ['Z']);
  assert.equal(z.by_agent[0].harness, 'opencode');

  const m = drill.drillScope({ days: 14, kind: 'model', ref: 'claude-haiku-5-5', now: NOW });
  assert.equal(m.totals.cost_usd, 23); // R 21 + K 2
  assert.deepEqual(m.by_agent.map((a) => a.id).sort(), ['K', 'R']);

  const h = drill.drillScope({ days: 14, kind: 'harness', ref: 'opencode', now: NOW });
  assert.equal(h.totals.cost_usd, 3);
});

test('scope > an empty scope is empty arrays, not an error', () => {
  seed();
  const r = drill.drillScope({ days: 2, kind: 'model', ref: 'nope', now: NOW });
  assert.equal(r.totals.cost_usd, 0);
  assert.deepEqual(r.by_agent, []);
  assert.deepEqual(r.by_model, []);
  // Every bucket of the span still has a row, all zero.
  assert.equal(r.timeseries.rows.length, 3);
  assert.ok(r.timeseries.rows.every((x) => x.cost_usd === 0));
  assert.deepEqual(r.windows, []);
});

test('scope > a viewer sees only its own agents', () => {
  seed();
  const r = drill.drillScope({ days: 2, kind: 'tree', ref: 'R', now: NOW, visible: new Set(['R']) });
  assert.equal(r.totals.cost_usd, 14); // K is filtered out
  assert.deepEqual(r.by_agent.map((a) => a.id), ['R']);
});

test('scope > an ITSA splits own from children and lists its child ITSAs', () => {
  agent('A');
  itsaRow('p', 'P-1', null, 'in_progress', 'A');
  itsaRow('c', 'C-1', 'p', 'in_progress', 'A');
  itsaEvent('p', new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  itsaEvent('c', new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  sample('A', NOW - HOUR, '', 'claude', 'claude-haiku-5-5', 10);
  const r = drill.drillScope({ days: 1, kind: 'itsa', ref: 'P-1', now: NOW });
  assert.equal(r.scope.key, 'P-1');
  assert.equal(r.totals.own.cost_usd, 5); // half the sample is P-1's own
  assert.equal(r.totals.children.cost_usd, 5); // the other half is C-1's
  assert.equal(r.totals.total.cost_usd, 10);
  assert.deepEqual(r.itsas.map((i) => i.key), ['C-1']);
  assert.equal(r.itsas[0].owner, 'A');
  assert.equal(r.itsas[0].cost_usd, 5);
  assert.equal(r.by_agent[0].id, 'A');
  assert.equal(r.by_agent[0].cost_usd, 10); // the whole sample lands inside P-1's subtree
  assert.equal(r.typical, null);
});

test('scope > a parent of a peer agent, and an adopting parent, are managers: their spend sets no config (S-1620)', () => {
  const created = new Date(NOW - 3 * DAY).toISOString();
  const closed = new Date(NOW - HOUR).toISOString();
  agent('G');
  agent('G2');
  agent('K2');
  agent('F');
  db.rememberPeerAgent({ id: 'peerkid', name: 'peerkid', machine: 'there', parents: ['G'] });
  db.open().prepare('INSERT INTO agent_parents (child_id, parent_id) VALUES (?, ?)').run('K2', 'G2');
  sample('F', NOW - 2 * HOUR, '', 'claude', 'claude-haiku-5-5', 2);
  for (const [id, key, owner] of [['m1', 'M-1', 'G'], ['m2', 'M-2', 'G2']]) {
    itsaRow(id, key, null, 'done', owner);
    db.open().prepare('UPDATE itsas SET closed_at = ? WHERE id = ?').run(closed, id);
    itsaEvent(id, created, 'created', { status: 'in_progress' });
    itsaEvent(id, closed, 'status', { from: 'in_progress', to: 'done' });
    db.open().prepare('INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run(id, 'F');
    sample(owner, NOW - 2 * HOUR, '', 'claude', 'claude-opus-5-5', 30);
    usage.resetSnapshotMemo();
    ic.resetTypicalMemo();
    const r = drill.drillScope({ days: 1, kind: 'itsa', ref: key, now: NOW });
    assert.equal(r.typical?.config, 'claude · claude-haiku-5-5', `${key}: the manager's Opus share is ignored`);
  }
});

test('series > a peer root groups under its remembered name, not its id (S-1620)', () => {
  agent('L', 'claude', 'claude-haiku-5-5');
  db.rememberPeerAgent({ id: 'peer-root-id', name: 'Peer Boss', machine: 'there', parents: [] });
  db.open().prepare('INSERT INTO agent_parents (child_id, parent_id) VALUES (?, ?)').run('L', 'peer-root-id');
  useRow('L', dayOf(NOW), 'claude', 'claude-haiku-5-5', 'claude', 4);
  const s = drill.spendSeries({ days: 2, group: 'tree', now: NOW });
  const g = groupsById(s);
  assert.equal(g['peer-root-id'].name, 'Peer Boss');
});

test('scope > a quiet day is a zero row, and an ITSA can ask for its own span', () => {
  seed();
  const r = drill.drillScope({ days: 6, kind: 'tree', ref: 'R', now: NOW });
  assert.equal(r.timeseries.rows.length, 7);
  assert.ok(r.timeseries.rows.some((x) => x.cost_usd === 0));
  agent('A');
  itsaRow('p', 'P-1', null, 'in_progress', 'A');
  itsaEvent('p', new Date(NOW - 5 * HOUR).toISOString(), 'created', { status: 'in_progress' });
  sample('A', NOW - 2 * HOUR, '', 'claude', 'claude-haiku-5-5', 10);
  const h = drill.drillScope({ days: 7, kind: 'itsa', ref: 'P-1', now: NOW, since: NOW - 5 * HOUR, bucket: 'hour' });
  assert.equal(h.bucket, 'hour');
  assert.equal(h.timeseries.rows.length, 6); // 5 hours ago through this hour
  assert.equal(h.totals.total.cost_usd, 10);
  assert.ok(h.timeseries.rows[0].t.endsWith(':00:00.000Z'));
});

test('scope > an ITSA span is clamped to the retained samples, so since=0 stays small', () => {
  agent('A');
  itsaRow('p', 'P-1', null, 'in_progress', 'A');
  itsaEvent('p', new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  const r = drill.drillScope({ days: 7, kind: 'itsa', ref: 'P-1', now: NOW, since: 0, bucket: 'hour' });
  assert.ok(r.timeseries.rows.length <= 35 * 24 + 1);
  assert.ok(r.timeseries.rows.length > 30 * 24);
  const d = drill.drillScope({ days: 7, kind: 'itsa', ref: 'P-1', now: NOW, since: -3e13, bucket: 'day' });
  assert.ok(d.timeseries.rows.length <= 36);
});

test('scope > MAX_DAYS covers all time and is what the routes cap days at', () => {
  assert.ok(drill.MAX_DAYS >= 365);
});

test('scope > an ITSA drops hidden agents and unreadable child ITSAs', () => {
  agent('A');
  agent('B');
  itsaRow('p', 'P-1', null, 'in_progress', 'A');
  itsaRow('c', 'C-1', 'p', 'in_progress', 'A');
  itsaRow('d', 'D-1', 'p', 'in_progress', 'B');
  for (const [id, key] of [['p', 'P-1'], ['c', 'C-1'], ['d', 'D-1']]) itsaEvent(id, new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  sample('A', NOW - HOUR, '', 'claude', 'm', 10); // A owns P-1 and C-1: split 5/5
  sample('B', NOW - HOUR, '', 'claude', 'm', 4); // B owns D-1
  const r = drill.drillScope({ days: 1, kind: 'itsa', ref: 'P-1', now: NOW, visible: new Set(['A']), mayItsa: (k) => k !== 'D-1' });
  assert.deepEqual(r.by_agent.map((a) => a.id), ['A']); // B is hidden
  assert.equal(r.by_agent[0].cost_usd, 10);
  assert.deepEqual(r.itsas.map((i) => i.key), ['C-1']); // D-1 is unreadable
  assert.equal(r.totals.total.cost_usd, 14); // the ITSA's totals still include D-1
});

test('scope > an ITSA totals and by_agent share the calendar-day window', () => {
  agent('A');
  itsaRow('p', 'P-1', null, 'in_progress', 'A');
  itsaEvent('p', new Date(NOW - 3 * DAY).toISOString(), 'created', { status: 'in_progress' });
  sample('A', Date.parse('2026-10-10T01:00:00.000Z'), '', 'claude', 'm', 4); // before from (10-10T12), same calendar day
  sample('A', NOW - HOUR, '', 'claude', 'm', 6);
  const r = drill.drillScope({ days: 2, kind: 'itsa', ref: 'P-1', now: NOW });
  assert.equal(r.totals.total.cost_usd, 10); // both samples
  assert.equal(r.totals.own.cost_usd, 10);
  assert.equal(r.by_agent[0].cost_usd, 10);
});

test('scope > model accepts a bare name, a harness · model id, or harness plus model', () => {
  agent('C1', 'claude', 'm');
  agent('O1', 'opencode', 'm');
  agent('C2', 'claude', 'other');
  useRow('C1', dayOf(NOW), 'claude', 'm', 'claude', 3);
  useRow('O1', dayOf(NOW), 'opencode', 'm', 'openrouter', 5);
  useRow('C2', dayOf(NOW), 'claude', 'other', 'claude', 7);

  const bare = drill.drillScope({ days: 2, kind: 'model', ref: 'm', now: NOW });
  assert.equal(bare.totals.cost_usd, 8); // C1 + O1
  assert.deepEqual(bare.scope, { kind: 'model', id: 'm', name: 'm' });

  const composite = drill.drillScope({ days: 2, kind: 'model', ref: 'claude · m', now: NOW });
  assert.equal(composite.totals.cost_usd, 3);
  assert.deepEqual(composite.scope, { kind: 'model', id: 'claude · m', name: 'm', harness: 'claude' });

  const both = drill.drillScope({ days: 2, kind: 'model', ref: 'm', harness: 'opencode', now: NOW });
  assert.equal(both.totals.cost_usd, 5);
  assert.equal(both.scope.harness, 'opencode');
});
