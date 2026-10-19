#!/usr/bin/env node
// Unit tests for src/requirements.ts (requirements, step 1): off-by-default (the entry points
// throw and no table is created), readable keys from the settings counter, the tree and its
// views, the version bump on text/scope changes, the approval rule for each
// settings.requirements.approval value (and no agent approving its own draft), links, list
// filters, verification/scope validation, and reading the last verdicts. Throwaway STAM_HOME,
// no daemon, no model calls. Run with `node --test test/requirements.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-req-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `requirements-test-${process.pid}`;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, settings, req;
let root, mid, leaf, other;

const APPROVAL = (v) => settings.setSetting('requirements', { ...settings.settings().requirements, enabled: true, approval: v });
const tableExists = (name) => !!db.open().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

before(async () => {
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  req = await import('../src/requirements.ts');
  db.open();
  db.createAgent({ id: 'a1', name: 'alice', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.createAgent({ id: 'a2', name: 'bob', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
});
after(() => rmSync(home, { recursive: true, force: true }));

test('off by default: the entry points refuse, and no table is created', async () => {
  assert.equal(settings.settings().requirements.enabled, false, 'requirements start off');
  const off = /requirements are off \(settings\.requirements\.enabled\)/;
  assert.throws(() => req.list(), off);
  assert.throws(() => req.get('R-1'), off);
  await assert.rejects(() => req.create({ title: 'Anything' }), off);
  await assert.rejects(() => req.set('R-1', { title: 'Anything' }), off);
  const e = (() => { try { req.list(); return null; } catch (x) { return x; } })();
  assert.ok(e instanceof req.RequirementsOffError, 'the refusal names requirements being off');
  for (const name of ['requirements', 'req_links', 'req_verdicts', 'req_waivers', 'req_counter'])
    assert.equal(tableExists(name), false, `${name} must not exist while requirements are off`);
});

test('keys are sequential in the settings prefix, and the tree is found by id or key', async () => {
  APPROVAL('human');
  assert.equal(req.enabled(), true);
  root = await req.create({ title: 'Root', text: 'The system shall work.', by: 'human' });
  mid = await req.create({ title: 'Mid', parent: root.key, by: 'alice' });
  leaf = await req.create({ title: 'Leaf', parent: mid.id, by: 'human' });
  other = await req.create({ title: 'Other root', by: 'human' });
  assert.deepEqual([root.key, mid.key, leaf.key, other.key], ['R-1', 'R-2', 'R-3', 'R-4']);
  assert.equal(req.must(root.id).key, root.key);
  assert.equal(req.must(root.key).id, root.id);
  assert.throws(() => req.must('R-999'), /no requirement R-999/);
});

test('a requirement defaults to draft/observe/0.8, and verification and scope are validated', async () => {
  const x = await req.create({ title: 'Defaults', by: 'human' });
  assert.equal(x.status, 'draft');
  assert.equal(x.mode, 'observe');
  assert.equal(x.threshold, 0.8);
  assert.equal(x.severity, 'minor', 'severity sets the default action, so it defaults to minor');
  assert.equal((await req.create({ title: 'Critical', by: 'human', severity: 'critical' })).severity, 'critical');
  assert.equal((await req.set(x.id, { severity: 'major' }, 'human')).requirement.severity, 'major');
  await assert.rejects(() => req.create({ title: 'Bad severity', by: 'human', severity: 'nope' }), /severity/);
  assert.equal(x.version, 1);
  assert.deepEqual(x.verification, null);
  assert.deepEqual(x.scope, null);

  const withVer = await req.create({ title: 'Verified', by: 'human', verification: ['review', { method: 'test', detail: 'npm test' }] });
  assert.deepEqual(withVer.verification, [{ method: 'review' }, { method: 'test', detail: 'npm test' }]);
  const withScope = await req.create({ title: 'Scoped', by: 'human', scope: { paths: ['src/**'], repos: ['stam2'] } });
  assert.deepEqual(withScope.scope, { paths: ['src/**'], repos: ['stam2'] });

  await assert.rejects(() => req.create({ title: 'Bad verification', by: 'human', verification: 'review' }), /verification is a list/);
  await assert.rejects(() => req.create({ title: 'Bad method', by: 'human', verification: ['vibes'] }), /verification method/);
  await assert.rejects(() => req.create({ title: 'Bad scope', by: 'human', scope: { nope: ['x'] } }), /unknown scope field nope/);
  await assert.rejects(() => req.create({ title: 'Bad threshold', by: 'human', threshold: 2 }), /threshold is a number from 0 to 1/);
});

test('get returns the parent chain and children; list filters by status, parent, and text', async () => {
  const v = req.get(root.key);
  assert.deepEqual(v.parent_chain, []);
  assert.deepEqual(v.children.map((c) => c.key), [mid.key]);
  const deep = req.get(leaf.id);
  assert.deepEqual(deep.parent_chain.map((p) => p.key), [root.key, mid.key]);

  await req.set(mid.id, { status: 'in_force' }, 'human');
  assert.deepEqual(req.list({ status: 'draft' }).map((x) => x.key).includes(mid.key), false);
  assert.deepEqual(req.list({ status: 'in_force' }).map((x) => x.key), [mid.key]);
  assert.deepEqual(req.list({ parent: root.id }).map((x) => x.key), [mid.key]);
  assert.ok(req.list({ parent: 'root' }).map((x) => x.key).includes(other.key));
  assert.deepEqual(req.list({ text: 'Other root' }).map((x) => x.key), [other.key]);
});

test('the version moves when text or scope changes, and not for other fields', async () => {
  const b = await req.set(root.id, { text: 'The system shall work well.' }, 'human');
  assert.equal(b.requirement.version, 2);
  assert.equal(b.changes.version.from, 1);

  const t = await req.set(root.id, { title: 'Root (renamed)' }, 'human');
  assert.equal(t.requirement.version, 2, 'a title change does not bump the version');

  const s = await req.set(root.id, { scope: { paths: ['src/**'] } }, 'human');
  assert.equal(s.requirement.version, 3);

  const same = await req.set(root.id, { text: 'The system shall work well.' }, 'human');
  assert.deepEqual(same.changes, {}, 'a no-op set changes nothing');
  assert.equal(same.requirement.version, 3);
});

test('the approval rule follows settings.requirements.approval, and no agent approves its own draft', async () => {
  // human (the default): only the human.
  APPROVAL('human');
  const a = await req.create({ title: 'Human says', by: 'bob' });
  await assert.rejects(() => req.set(a.id, { status: 'in_force' }, 'alice'), /only the human approves/);
  assert.equal((await req.set(a.id, { status: 'in_force' }, 'human')).requirement.status, 'in_force');
  await assert.rejects(() => req.create({ title: 'Straight to force', status: 'in_force', by: 'alice' }), /can't create a requirement as in_force/);
  // No status path slips past the gate: draft -> suspended/obsolete -> in_force, and create suspended.
  const susp = await req.create({ title: 'Suspended path', by: 'human' });
  await req.set(susp.id, { status: 'suspended' }, 'human');
  await assert.rejects(() => req.set(susp.id, { status: 'in_force' }, 'alice'), /only the human approves/);
  const obs = await req.create({ title: 'Obsolete path', by: 'human' });
  await req.set(obs.id, { status: 'obsolete' }, 'human');
  await assert.rejects(() => req.set(obs.id, { status: 'in_force' }, 'alice'), /only the human approves/);
  await assert.rejects(() => req.create({ title: 'Agent suspended', status: 'suspended', by: 'alice' }), /can't create a requirement as suspended/);
  const sus2 = await req.create({ title: 'Agent suspended', status: 'suspended', by: 'human' });
  await assert.rejects(() => req.set(sus2.id, { status: 'in_force' }, 'alice'), /own draft|only the human approves/);

  // cos: the chief of staff or the human, but not the cos on its own draft.
  APPROVAL('cos');
  settings.setSetting('chiefOfStaff', 'alice');
  const b = await req.create({ title: 'Cos says', by: 'bob' });
  assert.equal((await req.set(b.id, { status: 'in_force', ifRev: req.must(b.id).rev }, 'alice')).requirement.status, 'in_force');
  const c = await req.create({ title: 'Cos own', by: 'alice' });
  await assert.rejects(() => req.set(c.id, { status: 'in_force' }, 'alice'), /own draft/);
  await assert.rejects(() => req.set(c.id, { status: 'in_force' }, 'bob'), /chief of staff or the human/);
  assert.equal((await req.set(c.id, { status: 'in_force' }, 'human')).requirement.status, 'in_force');
  // A suspended one is gated too: a non-cos agent can't move it, the cos can.
  const cs = await req.create({ title: 'Cos suspended', status: 'suspended', by: 'human' });
  await assert.rejects(() => req.set(cs.id, { status: 'in_force' }, 'bob'), /chief of staff or the human/);
  assert.equal((await req.set(cs.id, { status: 'in_force', ifRev: req.must(cs.id).rev }, 'alice')).requirement.status, 'in_force');
  settings.setSetting('chiefOfStaff', null);

  // any: anyone, including the agent that wrote it.
  APPROVAL('any');
  const e = await req.create({ title: 'Anyone says', by: 'alice' });
  assert.equal((await req.set(e.id, { status: 'in_force', ifRev: req.must(e.id).rev }, 'alice')).requirement.status, 'in_force');
});

test('links are added, listed, and removed', async () => {
  const x = await req.create({ title: 'Linked', by: 'human' });
  const l1 = req.addLink(x.id, { target_kind: 'itsa', target: 'S-1', role: 'implements' });
  const l2 = req.addLink(x.id, { target: 'https://example.com/spec' });
  assert.deepEqual(req.links(x.id).map((l) => [l.target_kind, l.target, l.role]), [
    ['itsa', 'S-1', 'implements'],
    ['url', 'https://example.com/spec', 'implements'],
  ]);
  assert.deepEqual(req.get(x.id).links.map((l) => l.id), [l1.id, l2.id]);
  req.removeLink(x.id, l1.id);
  assert.deepEqual(req.links(x.id).map((l) => l.target), ['https://example.com/spec']);
  assert.throws(() => req.removeLink(x.id, 999), /no link 999 on R-/);
  assert.throws(() => req.addLink(x.id, { target: 'x', target_kind: 'nope' }), /target kind/);
  assert.throws(() => req.addLink(x.id, { target: 'x', role: 'nope' }), /link role/);
  assert.throws(() => req.addLink(x.id, { target: '' }), /needs a target/);
});

test('get carries the last 20 verdicts, newest first, and the cache index is unique', async () => {
  const x = await req.create({ title: 'Checked', by: 'human' });
  const d = db.open();
  const ins = d.prepare('INSERT INTO req_verdicts (req_id, req_version, subject, subject_hash, model, verdict, ts) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 25; i++) ins.run(x.id, 1, `mail:m${i}`, `h${i}`, 'decision-1', 'conforms', new Date(2026, 0, i + 1).toISOString());
  const vs = req.get(x.id).verdicts;
  assert.equal(vs.length, 20, 'only the last 20 verdicts come back');
  assert.equal(vs[0].subject, 'mail:m24');
  assert.equal(vs.at(-1).subject, 'mail:m5');
  assert.throws(() => ins.run(x.id, 1, 'mail:m0', 'h0', 'decision-1', 'violates', new Date().toISOString()), /UNIQUE/, 'the cache key is unique');
});

test('a key prefix is letters only: a hyphen is refused on save and falls back when read', async () => {
  const before = settings.settings().requirements;
  assert.match(settings.requirementsProblem({ requirements: { keyPrefix: 'REQ-A' } }), /letters only/);
  assert.equal(settings.requirementsProblem({ requirements: { keyPrefix: 'R2' } }) !== null, true);
  assert.equal(settings.requirementsProblem({ requirements: { keyPrefix: '' } }), null, 'empty takes the default');
  assert.deepEqual(settings.patchSettings({ requirements: { keyPrefix: 'R-2' } }), { problem: 'requirements.keyPrefix must be letters only, such as R', field: 'requirements' });
  assert.equal(settings.settings().requirements.keyPrefix, before.keyPrefix, 'the refused save changes nothing');
  settings.setSetting('requirements', { ...before, keyPrefix: 'REQ-A' });
  assert.equal(settings.settings().requirements.keyPrefix, 'R', 'a hand-edited hyphen falls back to the default');
  settings.setSetting('requirements', { ...before, keyPrefix: 'REQA' });
  const a = await req.create({ title: 'Letters A', by: 'human' });
  const b = await req.create({ title: 'Letters B', by: 'human' });
  assert.match(a.key, /^REQA-\d+$/);
  assert.notEqual(a.key, b.key);
  settings.setSetting('requirements', before);
});
