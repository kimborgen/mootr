#!/usr/bin/env node
// Unit tests for src/itsa-owners.ts (ITSAs, step 4): the first-prompt block, the owned-ITSAs
// line in the system prompt, notices to the parent ITSA's owner (blocked, human, closed,
// owner stopped, ownerNotices off, human or no parent owner), and unowning on archive.
// Throwaway STAM_HOME, no daemon. Run with `node --test test/itsa-owners.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-itsa-own-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `itsa-own-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, owners, loop, lead, w1;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const notices = (id) => db.listEvents(id).filter((e) => e.type === 'notice:queued').map((e) => e.data);
const active = (id) => db.updateAgent(id, { lifecycle: 'active', activity: 'idle' });

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  owners = await import('../src/itsa-owners.ts');
  loop = await import('../src/retro-loop.ts');
  await import('../src/settings.ts');
  db.open();
  owners.watchOwnerStops();
  agent('l1', 'lead');
  agent('w1', 'worker');
  active('l1');
  active('w1');
});
after(() => rmSync(home, { recursive: true, force: true }));

test('the owner block carries key, title, summary, body, parent chain, and links', async () => {
  const p = await itsa.create({ title: 'Parent', by: 'human', owner: 'lead' });
  const c = await itsa.create({ title: 'Child', parent: p.key, summary: 'SUM', body: 'BODY-TEXT', by: 'human', links: [{ url: 'https://example.com/x', system: 'url' }] });
  const b = await owners.ownerBlock(c.key);
  for (const s of [c.key, 'Child', 'SUM', 'BODY-TEXT', p.key, 'https://example.com/x']) assert.ok(b.block.includes(s), `block lacks ${s}:\n${b.block}`);
});

test('the list carries each ITSA\'s participants, for the Work page', async () => {
  const x = await itsa.create({ title: 'Listed', by: 'human', owner: 'lead', participants: ['worker'] });
  const row = (await itsa.list()).find((y) => y.id === x.id);
  assert.ok(row.participants.includes('l1') && row.participants.includes('w1'), JSON.stringify(row.participants));
});

test('the system prompt line names the open ITSAs an agent owns, and not closed ones', async () => {
  const a = await itsa.create({ title: 'Mine', by: 'human', owner: 'worker', status: 'in_progress' });
  const z = await itsa.create({ title: 'Finished', by: 'human', owner: 'worker', status: 'done' });
  const line = owners.ownedPrompt('w1');
  assert.ok(line.includes(a.key) && !line.includes(z.key), line);
  assert.equal(owners.ownedPrompt('l1'), owners.ownedPrompt('l1'));
});

test('the prompt lines list owned and participated ITSAs apart', async () => {
  const p = await itsa.create({ title: 'Shared', by: 'human', owner: 'lead', status: 'in_progress' });
  await itsa.addParticipant(p.key, 'worker', 'human');
  const line = owners.participatingPrompt('w1');
  assert.ok(line.includes(p.key) && line.includes('participate'), line);
  // An ITSA the agent owns is in the owned line, not repeated here.
  const own = await itsa.create({ title: 'Owned too', by: 'human', owner: 'worker', status: 'in_progress' });
  assert.ok(!owners.participatingPrompt('w1').includes(own.key));
  const block = owners.itsaPrompt('w1');
  assert.ok(block.includes('You own these ITSAs:') && block.includes('You participate in these ITSAs:'), block);
});

test("a spawn joins the parent's most recently updated open ITSA it owns, else one it takes part in", async () => {
  agent('p1', 'parent-one');
  active('p1');
  assert.equal(owners.parentItsaFor('p1'), undefined);
  const a = await itsa.create({ title: 'P-A', by: 'human', owner: 'parent-one', status: 'in_progress' });
  await new Promise((r) => setTimeout(r, 5));
  const b = await itsa.create({ title: 'P-B', by: 'human', owner: 'parent-one', status: 'in_progress' });
  assert.equal(owners.parentItsaFor('p1').key, b.key);
  // An update makes the older one the most recent.
  await itsa.set(a.key, { summary: 'touched' }, 'human');
  assert.equal(owners.parentItsaFor('p1').key, a.key);
  // Closed ones don't count; an open one it only takes part in does.
  await itsa.set(a.key, { status: 'done' }, 'human');
  await itsa.set(b.key, { status: 'done' }, 'human');
  const c = await itsa.create({ title: 'P-C', by: 'human', owner: 'lead', status: 'in_progress' });
  await itsa.addParticipant(c.key, 'parent-one', 'human');
  assert.equal(owners.parentItsaFor('p1').key, c.key);
  // The join adds the new agent as a participant, idempotently.
  assert.equal(await owners.joinParentLocal('w1', 'p1', 'human'), c.key);
  assert.ok(itsa.participants(c.key).includes('w1'));
  const events = itsa.events(c.key).length;
  await owners.joinParentLocal('w1', 'p1', 'human');
  assert.equal(itsa.events(c.key).length, events);
  // Nothing to join: a parent with no ITSA at all.
  agent('p2', 'parent-two');
  assert.equal(await owners.joinParentLocal('w1', 'p2', 'human'), null);
});

test('with itsa.required off, a spawn does not join', async () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ itsa: { required: false } }));
  agent('p3', 'parent-three');
  const x = await itsa.create({ title: 'P-D', by: 'human', owner: 'parent-three', status: 'in_progress' });
  assert.equal(await owners.joinParentLocal('w1', 'p3', 'human'), null);
  assert.ok(!itsa.participants(x.key).includes('w1'));
  writeFileSync(join(home, 'settings.json'), '{}');
});

test("openAgentIds lists owners and participants of open ITSAs, not closed ones", async () => {
  const o = await itsa.create({ title: 'Open', by: 'human', owner: 'lead', status: 'in_progress' });
  await itsa.addParticipant(o.key, 'worker', 'human');
  agent('z9', 'closed-owner');
  await itsa.create({ title: 'Closed', by: 'human', owner: 'closed-owner', status: 'done' });
  const ids = itsa.openAgentIds();
  assert.ok(ids.includes('l1') && ids.includes('w1'), JSON.stringify(ids));
  assert.ok(!ids.includes('z9'), JSON.stringify(ids));
});

test('a child entering blocked, a human status, or closed notices the parent owner once each', async () => {
  const p = await itsa.create({ title: 'P2', by: 'human', owner: 'lead' });
  const c = await itsa.create({ title: 'C2', parent: p.key, by: 'human', owner: 'worker', status: 'in_progress' });
  const before = notices('l1').length;
  await itsa.set(c.key, { status: 'in_progress' }, 'human'); // no change, no notice
  await itsa.set(c.key, { status: 'waiting' }, 'human'); // not noticed
  assert.equal(notices('l1').length, before);
  for (const st of ['blocked', 'needs_input', 'done']) await itsa.set(c.key, { status: st }, 'human');
  await new Promise((r) => setTimeout(r, 100));
  const n = notices('l1').slice(before);
  assert.equal(n.length, 3, JSON.stringify(n));
  assert.match(n[0], /blocked/);
  assert.match(n[1], /waits on the human/);
  assert.match(n[2], /closed/);
});

test('no notice for a parent owned by the human or nobody, or with ownerNotices off', async () => {
  const hp = await itsa.create({ title: 'HP', by: 'human', owner: 'human' });
  const hc = await itsa.create({ title: 'HC', parent: hp.key, by: 'human' });
  const np = await itsa.create({ title: 'NP', by: 'human' });
  const nc = await itsa.create({ title: 'NC', parent: np.key, by: 'human' });
  const op = await itsa.create({ title: 'OP', by: 'human', owner: 'lead' });
  const oc = await itsa.create({ title: 'OC', parent: op.key, by: 'human' });
  const before = db.listEvents('l1').length;
  await itsa.set(hc.key, { status: 'blocked' }, 'human');
  await itsa.set(nc.key, { status: 'blocked' }, 'human');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ itsa: { ownerNotices: 'off' } }));
  await new Promise((r) => setTimeout(r, 50));
  const s = (await import('../src/settings.ts')).settings();
  if (s.itsa.ownerNotices === 'off') {
    await itsa.set(oc.key, { status: 'blocked' }, 'human');
    assert.equal(db.listEvents('l1').length, before);
  }
  assert.equal(db.listEvents('l1').length, before);
  writeFileSync(join(home, 'settings.json'), '{}');
});

test('an owner shut down notices the parent owner; archive unowns, resets active to ready, and notices once', async () => {
  writeFileSync(join(home, 'settings.json'), '{}');
  agent('w2', 'worker-two');
  active('w2');
  const p = await itsa.create({ title: 'P3', by: 'human', owner: 'lead' });
  const c = await itsa.create({ title: 'C3', parent: p.key, by: 'human', owner: 'worker-two', status: 'in_progress' });
  const before = notices('l1').length;
  db.updateAgent('w2', { lifecycle: 'shut_down', activity: 'unknown', activity_detail: 'shut down' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(notices('l1').length, before + 1);
  assert.match(notices('l1').at(-1), /shut down/);
  const w = db.getAgent('w2');
  await owners.unownAgent(w, 'archived');
  const after = itsa.must(c.key);
  assert.equal(after.owner, null);
  assert.equal(after.status, 'ready');
  assert.ok(itsa.events(c.key).some((e) => e.type === 'status' && /ready/.test(e.data ?? '')));
  assert.equal(notices('l1').length, before + 2);
  assert.match(notices('l1').at(-1), /unowned/);
});

test('a failed launch gives the ITSA back to its previous owner, only if the failed agent still owns it', async () => {
  const x = await itsa.create({ title: 'Handover', by: 'human', owner: 'lead' });
  await owners.assignOwner(x.key, 'w1', 'human');
  assert.equal(itsa.must(x.key).owner, 'w1');
  await owners.restoreOwner(x.key, 'w1', 'l1', 'human');
  assert.equal(itsa.must(x.key).owner, 'l1');
  // Someone else took it meanwhile: leave that alone.
  await owners.assignOwner(x.key, 'w1', 'human');
  await itsa.set(x.key, { owner: 'human' }, 'human');
  await owners.restoreOwner(x.key, 'w1', 'l1', 'human');
  assert.equal(itsa.must(x.key).owner, 'human');
});

test('a shutdown with no activity change (unknown to unknown) still notices the parent owner, once', async () => {
  agent('w3', 'worker-three');
  db.updateAgent('w3', { lifecycle: 'active', activity: 'unknown' });
  const p = await itsa.create({ title: 'P4', by: 'human', owner: 'lead' });
  await itsa.create({ title: 'C4', parent: p.key, by: 'human', owner: 'worker-three', status: 'in_progress' });
  const before = notices('l1').length;
  db.updateAgent('w3', { lifecycle: 'shut_down', activity: 'unknown', activity_detail: 'shut down' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(notices('l1').length, before + 1);
  // A restart's shutdown is not a stop.
  db.updateAgent('w3', { lifecycle: 'active', activity: 'idle' });
  db.updateAgent('w3', { lifecycle: 'shut_down', activity: 'unknown', activity_detail: 'restarting: x' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(notices('l1').length, before + 1);
});

test('rollback is a compare-and-set: a concurrent reassignment is never overwritten', async () => {
  const x = await itsa.create({ title: 'Race', by: 'human', owner: 'lead' });
  const prev = await owners.assignOwner(x.key, 'w1', 'human');
  assert.equal(prev, 'l1');
  await Promise.all([owners.restoreOwner(x.key, 'w1', 'l1', 'human'), itsa.set(x.key, { owner: 'human' }, 'human')]);
  assert.equal(itsa.must(x.key).owner, 'human');
  // And alone it restores, reporting that it did.
  await owners.assignOwner(x.key, 'w1', 'human');
  assert.equal(await owners.restoreOwner(x.key, 'w1', 'l1', 'human'), true);
  assert.equal(await owners.restoreOwner(x.key, 'w1', 'l1', 'human'), false);
  assert.equal(itsa.must(x.key).owner, 'l1');
});

test('two concurrent unowns of one agent unown each ITSA once and send one notice', async () => {
  agent('w4', 'worker-four');
  active('w4');
  const p = await itsa.create({ title: 'P5', by: 'human', owner: 'lead' });
  const a = await itsa.create({ title: 'C5a', parent: p.key, by: 'human', owner: 'worker-four', status: 'in_progress' });
  const b = await itsa.create({ title: 'C5b', parent: p.key, by: 'human', owner: 'worker-four', status: 'blocked' });
  const before = notices('l1').length;
  const w = db.getAgent('w4');
  await Promise.all([owners.unownAgent(w, 'archived'), owners.unownAgent(w, 'archived')]);
  assert.equal(itsa.must(a.key).owner, null);
  assert.equal(itsa.must(b.key).owner, null);
  const n = notices('l1').slice(before).filter((t) => /unowned/.test(t));
  assert.equal(n.length, 1, JSON.stringify(n));
  const events = itsa.events(a.key).filter((e) => e.type === 'owner');
  assert.equal(events.length, 1);
});

test('a failed resume leaves the pending unown in place', async () => {
  const lifecycle = await import('../src/lifecycle.ts');
  // A harness stam doesn't know makes the launch fail.
  db.createAgent({ id: 'w5', name: 'worker-five', role: 'dev', machine: 'x', harness: 'nonexistent', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: 'sess-5' });
  db.updateAgent('w5', { lifecycle: 'archived' });
  const sql = db.open();
  sql.prepare('INSERT OR REPLACE INTO itsa_pending_unown (agent_id, name, how, created_at) VALUES (?, ?, ?, ?)').run('w5', 'worker-five', 'archived', new Date().toISOString());
  await assert.rejects(lifecycle.resume(db.getAgent('w5')));
  assert.equal(db.getAgent('w5').lifecycle, 'archived');
  assert.equal(owners.hasPendingUnown('w5'), true);
  // Dropping is what a successful resume does.
  owners.dropPendingUnown('w5');
  assert.equal(owners.hasPendingUnown('w5'), false);
});

test('a shut-down for a compaction-resume (S-273) is not a stop: no notice to the parent owner', async () => {
  agent('w9', 'worker-nine');
  active('w9');
  const p = await itsa.create({ title: 'P6', by: 'human', owner: 'lead' });
  await itsa.create({ title: 'C6', parent: p.key, by: 'human', owner: 'worker-nine', status: 'in_progress' });
  const before = notices('l1').length;
  const pending = JSON.stringify({ type: 'recover', reason: 'harness exited', compact: true, tokens: 320000 });
  db.updateAgent('w9', { lifecycle: 'shut_down', activity: 'unknown', activity_detail: 'compacting, then resuming', pending_action: pending });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(notices('l1').length, before);
});

const kid = (id, name, parent) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: parent, session_id: null });

test('an archived owner hands its open ITSAs to a live manager: status kept, an event, a notice only for active ones', async () => {
  writeFileSync(join(home, 'settings.json'), '{}');
  kid('hm', 'handoff-mgr', null);
  active('hm');
  kid('hd', 'handoff-dev', 'hm');
  db.updateAgent('hd', { lifecycle: 'archived' });
  const a = await itsa.create({ title: 'H-active', by: 'human', owner: 'handoff-dev', status: 'in_progress' });
  const r = await itsa.create({ title: 'H-review', by: 'human', owner: 'handoff-dev', status: 'in_review' });
  const d = await itsa.create({ title: 'H-done', by: 'human', owner: 'handoff-dev', status: 'done' });
  const before = notices('hm').length;
  await owners.unownAgent(db.getAgent('hd'), 'archived');
  assert.equal(itsa.must(a.key).owner, 'hm');
  assert.equal(itsa.must(a.key).status, 'in_progress');
  assert.equal(itsa.must(r.key).owner, 'hm');
  assert.equal(itsa.must(r.key).status, 'in_review');
  assert.equal(itsa.must(d.key).owner, null);
  assert.ok(itsa.events(r.key).some((e) => e.type === 'handoff' && /ownership passed to @handoff-mgr/.test(e.data)));
  assert.ok((await itsa.get(a.key)).participants.includes('hm'));
  const n = notices('hm').slice(before);
  assert.equal(n.length, 1, JSON.stringify(n));
  assert.ok(n[0].includes(a.key) && !n[0].includes(r.key), n[0]);
});

test('an archived manager passes the ITSAs on to the grandparent', async () => {
  kid('gm', 'grand-mgr', null);
  active('gm');
  kid('gp', 'archived-mgr', 'gm');
  db.updateAgent('gp', { lifecycle: 'archived' });
  kid('gd', 'grand-dev', 'gp');
  db.updateAgent('gd', { lifecycle: 'archived' });
  const x = await itsa.create({ title: 'G', by: 'human', owner: 'grand-dev', status: 'in_review' });
  await owners.unownAgent(db.getAgent('gd'), 'archived');
  assert.equal(itsa.must(x.key).owner, 'gm');
});

test('with no live ancestor and no chief of staff the ITSA is unowned, with the old notice', async () => {
  kid('np', 'dead-parent', null);
  db.updateAgent('np', { lifecycle: 'archived' });
  kid('nd', 'orphan-dev', 'np');
  db.updateAgent('nd', { lifecycle: 'archived' });
  const x = await itsa.create({ title: 'N', by: 'human', owner: 'orphan-dev', status: 'in_progress' });
  await owners.unownAgent(db.getAgent('nd'), 'archived');
  assert.equal(itsa.must(x.key).owner, null);
  assert.equal(itsa.must(x.key).status, 'ready');
});

test('with no live ancestor the chief of staff takes the ITSA', async () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ chiefOfStaff: 'handoff-mgr' }));
  kid('cd', 'cos-dev', null);
  db.updateAgent('cd', { lifecycle: 'archived' });
  const x = await itsa.create({ title: 'C', by: 'human', owner: 'cos-dev', status: 'in_review' });
  await owners.unownAgent(db.getAgent('cd'), 'archived');
  assert.equal(itsa.must(x.key).owner, 'hm');
  writeFileSync(join(home, 'settings.json'), '{}');
});

test('a handoff write that fails unowns that ITSA and still hands off the rest', async () => {
  writeFileSync(join(home, 'settings.json'), '{}');
  kid('fm', 'fail-mgr', null);
  active('fm');
  kid('fd', 'fail-dev', 'fm');
  db.updateAgent('fd', { lifecycle: 'archived' });
  const bad = await itsa.create({ title: 'boom', by: 'human', owner: 'fail-dev', status: 'in_review' });
  const good = await itsa.create({ title: 'fine', by: 'human', owner: 'fail-dev', status: 'in_review' });
  const sql = db.open();
  sql.exec("CREATE TRIGGER boom BEFORE UPDATE ON itsas WHEN NEW.owner = 'fm' AND NEW.title = 'boom' BEGIN SELECT RAISE(ABORT, 'peer dropped'); END");
  try {
    await owners.unownAgent(db.getAgent('fd'), 'archived');
  } finally {
    sql.exec('DROP TRIGGER boom');
  }
  assert.equal(itsa.must(bad.key).owner, null);
  assert.equal(itsa.must(good.key).owner, 'fm');
});

test('an unown that fails for a reason other than a guard still throws, so the peer retries', async () => {
  agent('lo', 'lone');
  active('lo');
  const x = await itsa.create({ title: 'stuck', by: 'human', owner: 'lone', status: 'in_progress' });
  const sql = db.open();
  sql.exec("CREATE TRIGGER stuck BEFORE UPDATE ON itsas WHEN NEW.title = 'stuck' BEGIN SELECT RAISE(ABORT, 'peer dropped'); END");
  try {
    await assert.rejects(owners.unownAgent(db.getAgent('lo'), 'archived'), /peer dropped/);
  } finally {
    sql.exec('DROP TRIGGER stuck');
  }
  assert.equal(itsa.must(x.key).owner, 'lo');
});

test('an unown the change guard refuses is logged and skipped; the agent\'s other ITSAs are still unowned', async () => {
  loop.watchProposals();
  agent('gr', 'guarded');
  active('gr');
  const retros = await itsa.create({ title: 'Retros for unown', kind: 'retros', by: 'human' });
  const refused = await itsa.create({ title: 'answers a retro', kind: 'issue', parent: retros.id, body: 'Answers: S-1\n\ndiff --git a/CLAUDE.md b/CLAUDE.md', owner: 'guarded', status: 'in_progress', by: 'human' });
  const other = await itsa.create({ title: 'plain work', kind: 'issue', owner: 'guarded', status: 'in_progress', by: 'human' });
  await owners.unownAgent(db.getAgent('gr'), 'archived');
  assert.equal(itsa.must(refused.key).owner, 'gr');
  assert.equal(itsa.must(other.key).owner, null);
  assert.equal(itsa.must(other.key).status, 'ready');
});

test('a failing home is retried with a backoff that doubles up to an hour', () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => owners.retryDelay(30_000, n)), [30_000, 60_000, 120_000, 240_000]);
  assert.equal(owners.retryDelay(30_000, 50), 3_600_000);
});

test('retryPendingUnowns: a 403 ends the retry; a 400 or 503 keeps the row and backs off; success resets the backoff', async () => {
  const { createServer } = await import('node:http');
  const hits = [];
  const plan = { u403: [403], u400: [400, 400, 400], u503: [503, 200, 503, 200] };
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const id = JSON.parse(b).id;
      hits.push(id);
      const status = plan[id].shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? {} : { error: `stub ${status}` }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ itsa: { home: 'far' }, peers: [{ name: 'far', url: `http://127.0.0.1:${server.address().port}`, token: 't' }] }));
  const pending = () => db.open().prepare('SELECT agent_id FROM itsa_pending_unown ORDER BY agent_id').all().map((r) => r.agent_id);
  for (const id of ['u403', 'u400', 'u503']) {
    agent(id, id);
    db.updateAgent(id, { lifecycle: 'archived' });
    owners.queueUnown({ id, name: id }, 'archived');
  }
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    await owners.retryPendingUnowns();
    assert.deepEqual(hits.sort(), ['u400', 'u403', 'u503']);
    assert.deepEqual(pending(), ['u400', 'u503'], 'the 403 row is dropped, the others stay');
    hits.length = 0;
    await owners.retryPendingUnowns();
    assert.deepEqual(hits, [], 'rows in backoff are skipped');
    skew += 31_000;
    await owners.retryPendingUnowns();
    assert.deepEqual(hits.sort(), ['u400', 'u503']);
    assert.deepEqual(pending(), ['u400'], 'the 503 row went through on success');
    // The success reset u503's backoff: queued again, it fails once and is due again after one base delay, not two.
    owners.queueUnown({ id: 'u503', name: 'u503' }, 'archived');
    hits.length = 0;
    await owners.retryPendingUnowns();
    assert.deepEqual(hits, ['u503'], 'u400 is on its second, longer backoff');
    hits.length = 0;
    skew += 31_000;
    await owners.retryPendingUnowns();
    assert.ok(hits.includes('u503'), 'u503 is tried again after the base delay');
  } finally {
    Date.now = realNow;
    server.close();
    writeFileSync(join(home, 'settings.json'), '{}');
  }
});

test('guardPeerReport: 403 when no peer holds the agent, 503 when the action fails, 403 kept for a ForbiddenError', async () => {
  const code = async (fn) => (await fn().then(() => null, (e) => e)).status;
  assert.equal(await code(() => owners.guardPeerReport(false, 'x1', ['archived'], 'it', () => 1)), 403);
  assert.equal(await code(() => owners.guardPeerReport(true, 'nobody-here', ['archived'], 'it', () => 1)), 403);
  // A peer-held agent: a stub peer that holds it archived.
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ id: 'far1', name: 'far1', machine: 'far', lifecycle: 'archived' }))));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [{ name: 'far', url: `http://127.0.0.1:${server.address().port}`, token: 't' }] }));
  try {
    assert.equal(await owners.guardPeerReport(true, 'far1', ['archived'], 'it', () => 'ok'), 'ok');
    assert.equal(await code(() => owners.guardPeerReport(true, 'far1', ['archived'], 'it', () => { throw new Error('database is locked'); })), 503);
    assert.equal(await code(() => owners.guardPeerReport(true, 'far1', ['archived'], 'it', () => { throw new itsa.ForbiddenError('no'); })), 403);
    assert.equal(await code(() => owners.guardPeerReport(true, 'far1', ['active'], 'it', () => 1)), 403, 'held in another state');
    server.close();
    // The peer is gone: it may hold the agent, so the answer is "try again".
    assert.equal(await owners.peerHolds('far1', ['archived']), 'unknown');
    assert.equal(await code(() => owners.guardPeerReport(true, 'far1', ['archived'], 'it', () => 1)), 503);
  } finally {
    server.close();
    writeFileSync(join(home, 'settings.json'), '{}');
  }
});

test('peerHolds: an agent no peer has, or one this machine holds itself, is refused finally', async () => {
  assert.equal(await owners.peerHolds('nobody-here', ['archived']), 'no');
  agent('mine1', 'mine-local');
  db.updateAgent('mine1', { machine: (await import('../src/config.ts')).MACHINE, lifecycle: 'archived' });
  assert.equal(await owners.peerHolds('mine1', ['archived']), 'no');
});

test('a spawn with itsa: a reviewer joins as a participant and the owner stays, a developer takes ownership (S-501)', async () => {
  agent('r1', 'rev');
  agent('d1', 'dev');
  const x = await itsa.create({ title: 'Spawned for', by: 'human', owner: 'lead' });
  const rb = await owners.ownerBlock(x.key, true);
  assert.match(rb.block, /participant/);
  assert.doesNotMatch(rb.block, /now own/);
  const prev = await owners.attachSpawned(x.id, 'r1', true, rb.owner, 'l1');
  assert.equal(prev, 'l1');
  assert.equal(itsa.find(x.id).owner, 'l1');
  assert.ok(itsa.participants(x.id).includes('r1'));
  const db_ = await owners.ownerBlock(x.key);
  assert.match(db_.block, /now own/);
  assert.equal(await owners.attachSpawned(x.id, 'd1', false, db_.owner, 'l1'), 'l1');
  assert.equal(itsa.find(x.id).owner, 'd1');
});

test('a spawn with participate: an owner or participant may add the child, which joins without owning; a stranger is refused (S-2424)', async () => {
  agent('st1', 'stranger');
  agent('kd1', 'kid');
  const x = await itsa.create({ title: 'Joinable', by: 'human', owner: 'lead', participants: ['worker'] });
  await assert.doesNotReject(owners.mayParticipate([x.key], { agent: 'w1', boss: false }));
  await assert.doesNotReject(owners.mayParticipate([x.key], { agent: 'l1', boss: false }));
  await assert.rejects(owners.mayParticipate([x.key], { agent: 'st1', boss: false }), (e) => e instanceof itsa.ForbiddenError && /stranger can't change/.test(e.message));
  await assert.rejects(owners.mayParticipate(['NOPE-99'], { agent: 'w1', boss: false }));
  await owners.joinItsa(x.key, 'kd1', 'w1', { agent: 'w1', boss: false });
  assert.ok(itsa.participants(x.id).includes('kd1'));
  assert.equal(itsa.find(x.id).owner, 'l1');
});

test('a failed spawn undoes its joins, and a row present before it, or added by someone else in the meantime, stays (S-2441)', async () => {
  agent('fn1', 'failed-new');
  agent('ot1', 'other');
  active('fn1');
  active('ot1');
  const x = await itsa.create({ title: 'Rolled back', by: 'human', owner: 'lead', participants: ['worker'] });
  const y = await itsa.create({ title: 'Joined too', by: 'human', owner: 'lead' });
  const spawn = { agent: 'l1', boss: false };
  // The spawn joins both, then fails: another agent joins x while the spawn is in flight.
  await owners.joinItsa(x.key, 'fn1', 'l1', spawn);
  await owners.joinItsa(y.key, 'fn1', 'l1', spawn);
  await itsa.addParticipant(x.key, 'ot1', 'human');
  assert.ok(itsa.participants(x.id).includes('fn1') && itsa.participants(y.id).includes('fn1'));
  await owners.leaveItsa(x.key, 'fn1', 'l1', spawn);
  await owners.leaveItsa(y.key, 'fn1', 'l1', spawn);
  assert.ok(!itsa.participants(x.id).includes('fn1'));
  assert.ok(itsa.participants(x.id).includes('w1') && itsa.participants(x.id).includes('ot1'), JSON.stringify(itsa.participants(x.id)));
  assert.ok(!itsa.participants(y.id).includes('fn1'));
  assert.equal(itsa.find(x.id).owner, 'l1');
});

test('removeParticipant on a row that is not there changes nothing and records no event', async () => {
  const x = await itsa.create({ title: 'Nobody extra', by: 'human', owner: 'lead' });
  const before = itsa.events(x.key).length;
  const r = await itsa.removeParticipant(x.key, 'w1', 'human');
  assert.equal(r.removed, false);
  assert.equal(itsa.events(x.key).length, before);
});

test('a failed spawn that took an ITSA as owner hands it back and undoes the owner row (S-2441)', async () => {
  agent('fo1', 'failed-owner');
  active('fo1');
  const x = await itsa.create({ title: 'Taken then failed', by: 'human', owner: 'lead' });
  await owners.attachSpawned(x.id, 'fo1', false, 'l1', 'l1');
  assert.equal(itsa.find(x.id).owner, 'fo1');
  assert.ok(itsa.participants(x.id).includes('fo1'));
  assert.equal(await owners.restoreOwner(x.key, 'fo1', 'l1', 'l1'), true);
  await owners.leaveItsa(x.key, 'fo1', 'l1');
  assert.equal(itsa.find(x.id).owner, 'l1');
  assert.ok(!itsa.participants(x.id).includes('fo1'));
});

// S-3015: a reviewer leaves the ITSAs it joined when its review ends or it is archived. The owner's row, and every
// other participant's, stays; an agent that isn't a reviewer type is never removed.
test('a reviewer whose review ended leaves the ITSAs it joined, keeping the owner and the other participants', async () => {
  agent('rv1', 'reviewer-one');
  db.updateAgent('rv1', { type: 'reviewer' });
  const x = await itsa.create({ title: 'Reviewed', by: 'human', owner: 'lead', participants: ['rv1', 'worker'] });
  const removed = await owners.releaseReviewer('rv1', 'rv1');
  assert.equal(removed, 1);
  const got = itsa.participants(x.id);
  assert.ok(!got.includes('rv1'), JSON.stringify(got));
  assert.ok(got.includes('l1') && got.includes('w1'), JSON.stringify(got));
  assert.ok(itsa.events(x.key).some((e) => e.type === 'participants'));
});

test('a reviewer keeps the ITSA it still owns', async () => {
  agent('rv2', 'reviewer-two');
  db.updateAgent('rv2', { type: 'reviewer' });
  const x = await itsa.create({ title: 'Owned by reviewer', by: 'human', owner: 'rv2', participants: ['rv2'] });
  await owners.releaseReviewer('rv2', 'rv2');
  assert.ok(itsa.participants(x.id).includes('rv2'));
});

test('archiving a reviewer removes its participation; a non-reviewer participant is kept', async () => {
  agent('rv3', 'reviewer-three');
  db.updateAgent('rv3', { type: 'reviewer' });
  agent('dv3', 'dev-three');
  db.updateAgent('dv3', { type: 'developer' });
  const x = await itsa.create({ title: 'Archived reviewer', by: 'human', owner: 'lead', participants: ['rv3', 'dv3'] });
  await owners.unownAgent({ ...db.getAgent('rv3'), type: 'reviewer' }, 'archived');
  assert.ok(!itsa.participants(x.id).includes('rv3'));
  assert.equal(itsa.find(x.id).owner, 'l1');
  await owners.unownAgent({ ...db.getAgent('dv3'), type: 'developer' }, 'archived');
  assert.ok(itsa.participants(x.id).includes('dv3'));
});

test('a reviewer that fails to leave its ITSAs still archives: the unown goes through and the error is only logged', async () => {
  agent('rv4', 'reviewer-four');
  db.updateAgent('rv4', { type: 'reviewer' });
  const x = await itsa.create({ title: 'Stuck reviewer row', by: 'human', owner: 'lead', participants: ['rv4'], status: 'in_progress' });
  const own = await itsa.create({ title: 'Stuck reviewer owned', by: 'human', owner: 'rv4', status: 'in_progress' });
  const sql = db.open();
  sql.exec("CREATE TRIGGER rv4_stuck BEFORE UPDATE OF left_at ON itsa_participants WHEN NEW.agent_id = 'rv4' BEGIN SELECT RAISE(ABORT, 'row locked'); END");
  try {
    await owners.unownAgent({ ...db.getAgent('rv4'), type: 'reviewer' }, 'archived');
  } finally {
    sql.exec('DROP TRIGGER rv4_stuck');
  }
  assert.ok(itsa.participants(x.id).includes('rv4'));
  assert.equal(itsa.find(x.id).owner, 'l1');
  assert.equal(itsa.must(own.key).owner, null);
});

// S-3015: a leave keeps the row for the spend and reviewer counts; a join makes the reviewer a member again; an unown
// queued with its type sends that type even after the agent's row is gone.
test('a leave keeps the row for the spend, and a join makes the reviewer a member again (S-3015)', async () => {
  agent('rv6', 'reviewer-six');
  db.updateAgent('rv6', { type: 'reviewer' });
  const x = await itsa.create({ title: 'Left kept', by: 'human', owner: 'lead', participants: ['rv6'] });
  await owners.releaseReviewer('rv6', 'rv6');
  assert.ok(!itsa.participants(x.id).includes('rv6'));
  const { readAttributionData } = await import('../src/issue-costs.ts');
  assert.ok(readAttributionData(false).participants.some((p) => p.itsa_id === x.id && p.agent_id === 'rv6'));
  assert.ok(!(await itsa.list()).find((y) => y.id === x.id).participants.includes('rv6'), 'the list leaves out a reviewer that left');
  await itsa.addParticipant(x.id, 'rv6', 'human');
  assert.ok(itsa.participants(x.id).includes('rv6'));
  assert.ok((await itsa.list()).find((y) => y.id === x.id).participants.includes('rv6'));
});

test('an unown queued with its type sends that type after the agent is gone (S-3015)', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (b) seen.push(JSON.parse(b));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ itsa: { home: 'far' }, peers: [{ name: 'far', url: `http://127.0.0.1:${server.address().port}`, token: 't' }] }));
  try {
    owners.queueUnown({ id: 'fg1', name: 'forgotten-one', type: 'reviewer' }, 'forgotten');
    await owners.unownAgent({ id: 'fg1', name: 'forgotten-one' }, 'forgotten');
    assert.equal(seen.at(-1).type, 'reviewer');
  } finally {
    server.close();
    writeFileSync(join(home, 'settings.json'), '{}');
  }
});
