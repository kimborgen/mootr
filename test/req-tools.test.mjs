#!/usr/bin/env node
// Unit tests for the requirements tools' backing (S-504): the tool list on and off
// (toolCatalog and the `when` flag), the template only while on, waivers, the verdict number a
// check returns, and the approval ask for an agent's draft (a `requirement-approval` ITSA in
// needs_approval; Approve puts the requirement in force and closes it, Request changes does
// not). Throwaway STAM_HOME, no daemon, no model. Run with `node --test test/req-tools.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-reqtools-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_TMUX_SOCKET = `reqtools-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, settings, req, mcp, approval, itsa, human;
const setReq = (patch) => settings.setSetting('requirements', { ...settings.settings().requirements, ...patch });
const waitFor = async (fn) => {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('timed out waiting for state');
};
const reqNames = (cat) => cat.groups.flatMap((g) => g.tools.map((t) => t.name)).filter((n) => n.startsWith('req_')).sort();

before(async () => {
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  req = await import('../src/requirements.ts');
  mcp = await import('../src/mcp.ts');
  approval = await import('../src/req-approval.ts');
  itsa = await import('../src/itsa.ts');
  human = await import('../src/itsa-human.ts');
  db.open();
  db.createAgent({ id: 'a1', name: 'alice', role: 'dev', machine: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  approval.watch();
  human.watchHumanStatuses();
});
after(() => rmSync(home, { recursive: true, force: true }));

test('the req_* tools are in the catalogue only while requirements are on', () => {
  assert.deepEqual(reqNames(mcp.toolCatalog()), [], 'off by default');
  assert.deepEqual(reqNames(mcp.toolCatalog({ requirements: false })), []);
  assert.deepEqual(reqNames(mcp.toolCatalog({ requirements: true })), ['req_check', 'req_create', 'req_get', 'req_set', 'req_waive']);
  const flagged = mcp.tools.filter((t) => t.name.startsWith('req_'));
  assert.equal(flagged.length, 5);
  assert.ok(flagged.every((t) => t.when === 'requirements'), 'each is gated by the feature');
  assert.ok(mcp.tools.filter((t) => !t.name.startsWith('req_')).every((t) => !t.when), 'no other tool is gated');
});

test('the template is part of the instructions only while requirements are on, and is short', () => {
  assert.equal(req.prompt(), '');
  setReq({ enabled: true });
  const t = req.prompt();
  assert.match(t, /req_check/);
  assert.match(t, /req_waive/);
  assert.match(t, /not proof/);
  assert.match(t, /can't approve drafts/);
  assert.ok(t.split(/\s+/).length <= 120, `${t.split(/\s+/).length} words`);
});

test('a waiver needs a real verdict, a kind, and a reason; the verdict stays', async () => {
  const r = await req.create({ title: 'W', text: 'Shall.', status: 'in_force', verification: ['decision'], by: 'human' });
  const id = req.recordVerdict({ req_id: r.id, req_version: 1, subject: 'text:x', subject_hash: 'h', model: 'm', verdict: 'violates', p_conforms: 0.05, p_violates: 0.9, p_na: 0.05, action: 'none', cost: 0 });
  assert.ok(Number.isInteger(id), 'recordVerdict returns the verdict number');
  assert.equal(req.recordVerdict({ req_id: r.id, req_version: 1, subject: 'text:x', subject_hash: 'h', model: 'm', verdict: 'violates', p_conforms: 0, p_violates: 1, p_na: 0, action: 'none', cost: 0 }), id, 'a duplicate returns the stored number');
  await assert.rejects(() => req.waive({ verdict_id: 9999, kind: 'false_positive', reason: 'x' }), /no verdict 9999/);
  await assert.rejects(() => req.waive({ verdict_id: id, kind: 'nope', reason: 'x' }), /kind must be one of/);
  await assert.rejects(() => req.waive({ verdict_id: id, kind: 'false_positive' }), /needs a reason/);
  await assert.rejects(() => req.waive({ verdict_id: 'abc', kind: 'false_positive', reason: 'x' }), /verdict_id/);
  const w = await req.waive({ verdict_id: id, kind: 'accepted_deviation', reason: 'fine here', by: 'a1' });
  assert.equal(w.kind, 'accepted_deviation');
  assert.equal(w.by, 'a1');
  assert.equal(req.verdicts(r.key, 5)[0].verdict, 'violates', 'the verdict is unchanged');
  const row = db.open().prepare('SELECT * FROM req_waivers WHERE id = ?').get(w.id);
  assert.equal(row.reason, 'fine here');
});

test('an agent draft raises an ask in the human attention list; Approve puts it in force and closes the ask', async () => {
  const draft = await req.create({ title: 'Draft', text: 'Drafts shall be approved.', rationale: 'why', verification: ['decision'], by: 'a1' });
  assert.equal(draft.status, 'draft');
  const made = await approval.ask(draft, 'a1');
  assert.ok('key' in made, JSON.stringify(made));
  const x = itsa.must(made.key);
  assert.equal(x.kind, 'requirement-approval');
  assert.equal(x.status, 'needs_approval');
  assert.equal(x.owner, 'a1');
  assert.ok(human.attention().some((a) => a.id === x.id), 'it is in the attention list');
  assert.equal(itsa.links(x.id)[0].external_id, draft.key);
  await human.act(x.id, 'approve', '');
  await waitFor(() => req.must(draft.key).status === 'in_force');
  await waitFor(() => itsa.must(x.id).status === 'done');
  assert.ok(!human.attention().some((a) => a.id === x.id), 'the ask left the list');
});

test('Request changes leaves the draft a draft', async () => {
  const draft = await req.create({ title: 'Draft two', text: 'More shall be said.', verification: ['decision'], by: 'a1' });
  const made = await approval.ask(draft, 'a1');
  const x = itsa.must(made.key);
  await human.act(x.id, 'changes', 'reword it');
  await waitFor(() => itsa.must(x.id).status === 'in_progress');
  assert.equal(req.must(draft.key).status, 'draft');
});

test('no ask for the human\'s own draft, an in-force one, or under another approval setting; a refused ask leaves no ITSA', async () => {
  const mine = await req.create({ title: 'Mine', by: 'human' });
  assert.deepEqual(await approval.ask(mine, 'human'), { error: 'no ask needed' });
  const inForce = await req.create({ title: 'Forced', status: 'in_force', by: 'human' });
  assert.deepEqual(await approval.ask(inForce, 'a1'), { error: 'no ask needed' });
  setReq({ approval: 'any' });
  const draft = await req.create({ title: 'Anyone', by: 'a1' });
  assert.deepEqual(await approval.ask(draft, 'a1'), { error: 'no ask needed' });
  setReq({ approval: 'human' });
  // A model that may not mail the human can't raise the ask; the half-made ITSA is canceled.
  db.createAgent({ id: 'a2', name: 'bob', role: 'dev', machine: 'x', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  const d2 = await req.create({ title: 'Haiku draft', by: 'a2' });
  const r = await approval.ask(d2, 'a2');
  assert.ok('error' in r && /may not/.test(r.error), JSON.stringify(r));
  const open = db.open().prepare("SELECT COUNT(*) AS n FROM itsas WHERE kind = 'requirement-approval' AND status NOT IN ('done', 'canceled', 'in_progress')").get().n;
  assert.equal(open, 0, 'no orphan ask is left open');
});

test('an approval applies to the draft that was shown: a draft edited since is not put in force, and the same ask is raised again', async () => {
  const d = await req.create({ title: 'Snapshot', text: 'Original harmless requirement.', verification: ['decision'], by: 'a1' });
  const made = await approval.ask(d, 'a1');
  const x = itsa.must(made.key);
  // The agent edits the draft after the ask, without refreshing it (the way the review probe does).
  await req.set(d.key, { text: 'Replacement never shown in the approval ask.' }, 'a1');
  await human.act(x.id, 'approve', '');
  // Not approved: the draft stays a draft, and the same ITSA waits on the human again with the new text.
  await waitFor(() => itsa.must(x.id).status === 'needs_approval' && itsa.must(x.id).body.includes('Replacement never shown'));
  assert.equal(req.must(d.key).status, 'draft');
  assert.equal(db.open().prepare("SELECT COUNT(*) AS n FROM itsas WHERE kind = 'requirement-approval' AND title LIKE ?").get(`%${d.key}%`).n, 1, 'one ask, not two');
  // Approving what is now shown puts that text in force.
  await human.act(x.id, 'approve', '');
  await waitFor(() => req.must(d.key).status === 'in_force');
  assert.equal(req.must(d.key).text, 'Replacement never shown in the approval ask.');
  await waitFor(() => itsa.must(x.id).status === 'done');
});

test('an edit to a draft with an open ask refreshes the ask; ifRev refuses a stale write', async () => {
  const d = await req.create({ title: 'Live edit', text: 'First text.', verification: ['decision'], by: 'a1' });
  const x = itsa.must((await approval.ask(d, 'a1')).key);
  const before = req.must(d.key).rev;
  await req.set(d.key, { text: 'Second text.' }, 'a1');
  await approval.refresh(d.key, 'a1');
  const now = itsa.must(x.id);
  assert.equal(now.status, 'needs_approval');
  assert.match(now.body, /Second text\./, 'the ITSA carries the new statement');
  await assert.rejects(() => req.set(d.key, { status: 'in_force', ifRev: before }, 'human'), /changed since it was shown/);
  assert.equal(req.must(d.key).status, 'draft');
  await human.act(x.id, 'approve', '');
  await waitFor(() => req.must(d.key).status === 'in_force');
  assert.equal(req.must(d.key).text, 'Second text.');
});
