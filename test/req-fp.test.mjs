#!/usr/bin/env node
// Unit tests for requirements false positives and the approval gaps (S-505), against a throwaway
// STAM_HOME and a stubbed decisions endpoint (STAM_OPENROUTER_URL): no daemon, no network, no real
// model, and every wait is on state. Waivers (a waived verdict stays, marked, and no longer counts
// or tells), precision per requirement (the drop to observe, the one notice, the rate in get),
// the preview (records nothing, tells nobody, cost purpose, cap), the edit counter an approval is
// bound to, the chief-of-staff ask, and the ask closing when a requirement goes in force another
// way. Run with `node --test test/req-fp.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-reqfp-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_TMUX_SOCKET = `reqfp-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { model: 'test/decision-model' } }));

// The stub answers each question by a REQ:<name>=<verdict> marker in the state (conforms without
// one) and records every request.
const PROBS = {
  conforms: { conforms: 0.9, violates: 0.05, na: 0.05 },
  violates: { conforms: 0.05, violates: 0.9, na: 0.05 },
};
const requests = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const state = JSON.stringify(body.state);
    const answers = {};
    for (const name of Object.keys(body.questions)) {
      const v = state.match(new RegExp(`REQ:${name}=(\\w+)`))?.[1] ?? 'conforms';
      answers[name] = { type: 'choice', choice: v, probabilities: PROBS[v], confidence: 0.9 };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/decision-model-1', answers, usage: { input_tokens: 40, output_tokens: 2, cost: 0.01 } }));
  });
});

let db, settings, req, rc, mail, itsa, approval, human, queue;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const setReq = (patch) => settings.setSetting('requirements', { ...settings.settings().requirements, ...patch });
const waitFor = async (fn) => {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('timed out waiting for state');
};
let seq = 0;
// A mail-shaped subject whose verdict on `key` the stub decides by the marker.
const subject = (key, verdict, extra = {}) => ({
  kind: 'mail', ref: `mail:fp${++seq}`, content: { subject: 'S', body: `n${seq} REQ:${key}=${verdict}` }, actor: { name: 'alice', role: 'dev', parent: null }, actorId: 'a1', ...extra,
});
const mkReq = (title, extra = {}) => req.create({ title, text: `${title} shall hold.`, status: 'in_force', verification: ['decision'], by: 'human', scope: { subjects: ['mail'] }, mode: 'inform', ...extra });
// n violating verdicts, stored silently (nobody is told), returning their numbers oldest first.
const verdictOn = async (r, s) => (await rc.check(s)).find((x) => x.key === r.key);
const flags = async (r, n) => {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await verdictOn(r, subject(r.key, 'violates', { silent: true }))).id);
  return ids;
};
const waive = (id, kind = 'false_positive') => req.waive({ verdict_id: id, kind, reason: `because ${id}`, by: 'human' });
const notices = (id) => mail.queuedNoticeCount(id);
const events = (type) => db.open().prepare('SELECT data FROM events WHERE type = ? ORDER BY id').all(type).map((e) => JSON.parse(e.data));

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}`;
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  req = await import('../src/requirements.ts');
  rc = await import('../src/req-check.ts');
  mail = await import('../src/mail.ts');
  itsa = await import('../src/itsa.ts');
  approval = await import('../src/req-approval.ts');
  human = await import('../src/itsa-human.ts');
  queue = await import('../src/itsa-queue.ts');
  db.open();
  agent('a1', 'alice');
  agent('a2', 'olive');
  settings.setSetting('requirements', { ...settings.settings().requirements, enabled: true, approval: 'human', dailyCapUsd: 100 });
  approval.watch();
  human.watchHumanStatuses();
});
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

test('waivers: a waived verdict stays, marked, but leaves the merge queue line and hold, and the actor is not told again', async () => {
  const r = await mkReq('Hold', { mode: 'enforce', severity: 'major', scope: { subjects: ['branch', 'mail'] } });
  // Padding keeps the one waiver under the precision limit (1 of 5 is 20%).
  await flags(r, 4);
  const sha = 'abc1234';
  const [bad] = [req.recordVerdict({ req_id: r.id, req_version: r.version, subject: `branch:stam2/x@${sha}`, subject_hash: 'h1', model: 'm', verdict: 'violates', p_conforms: 0.05, p_violates: 0.9, p_na: 0.05, action: 'none', cost: 0 })];
  assert.equal(queue.conformity('stam2', 'x', sha).hold, true, 'an unwaived enforce violation holds the merge');
  assert.equal(queue.conformity('stam2', 'x', sha).lines.length, 1);

  await waive(bad, 'accepted_deviation');
  const c = queue.conformity('stam2', 'x', sha);
  assert.deepEqual([c.hold, c.lines.length, c.checked], [false, 0, false], 'waived: no line, no hold');
  const row = req.get(r.key).verdicts.find((v) => v.id === bad);
  assert.equal(row.verdict, 'violates', 'the verdict stays as it was');
  assert.equal(row.waiver.kind, 'accepted_deviation');
  assert.equal(row.waiver.reason, `because ${bad}`);

  // The actor hears of a fresh violation once, and isn't told again for a subject that was waived:
  // after the text changes, the same subject gets a new verdict, and still no notice.
  const s = subject(r.key, 'violates');
  const before = notices('a1');
  const first = await verdictOn(r, s);
  assert.equal(first.action, 'notified');
  assert.equal(notices('a1'), before + 1);
  await waive(first.id);
  await req.set(r.key, { text: 'Hold shall hold, reworded.' }, 'human');
  const again = await verdictOn(r, s);
  assert.equal(again.cached, false, 'a new version is a new verdict');
  assert.equal(again.action, 'none');
  assert.equal(notices('a1'), before + 1, 'not told again for the waived subject');
  assert.equal((await verdictOn(r, s)).cached, true);
  assert.equal(notices('a1'), before + 1);
  // A different subject is still told.
  await rc.check(subject(r.key, 'violates'));
  assert.equal(notices('a1'), before + 2);
});

test('list with latest: the newest verdict per subject at the current version, with its waiver kind', async () => {
  const r = await mkReq('Latest list');
  const a = subject(r.key, 'violates', { silent: true });
  const first = (await verdictOn(r, a)).id;
  // The same subject with new content: a newer verdict on it replaces the first in the list.
  const second = (await verdictOn(r, { ...a, content: { subject: 'S', body: `again REQ:${r.key}=conforms` } })).id;
  const other = (await verdictOn(r, subject(r.key, 'violates', { silent: true }))).id;
  await waive(other);
  const row = req.list({ latest: true }).find((x) => x.key === r.key);
  assert.deepEqual(row.latest.map((v) => [v.id, v.verdict, v.waived]).sort((x, y) => x[0] - y[0]), [[second, 'conforms', null], [other, 'violates', 'false_positive']]);
  assert.ok(!row.latest.some((v) => v.id === first));
  assert.equal(req.list().find((x) => x.key === r.key).latest, undefined, 'only when asked');
  // A new text starts at a new version: the old verdicts drop out of the list.
  await req.set(r.key, { text: 'Latest list shall hold, reworded.' }, 'human');
  assert.deepEqual(req.list({ latest: true }).find((x) => x.key === r.key).latest, []);
});

test('a cached waived verdict is marked in a check result', async () => {
  const r = await mkReq('Marked');
  const s = subject(r.key, 'violates', { silent: true });
  const ids = await flags(r, 5);
  const first = await verdictOn(r, s);
  await waive(first.id);
  const again = await verdictOn(r, s);
  assert.equal(again.cached, true);
  assert.equal(again.waived, 'false_positive');
  assert.ok(ids.length === 5);
});

test('precision: more than 30% of the last 20 flags waived as false positives drops it to observe, with one notice to its owner', async () => {
  const r = await mkReq('Precise', { owner: 'a2' });
  const ids = await flags(r, 10);
  const before = notices('a2');
  for (const id of ids.slice(0, 3)) await waive(id);
  let p = req.get(r.key).precision;
  assert.deepEqual([p.violates, p.false_positives, p.rate], [10, 3, 0.3]);
  assert.equal(req.must(r.key).mode, 'inform', '30% exactly is not more than 30%');
  assert.equal(notices('a2'), before);
  await waive(ids[3]);
  assert.equal(req.must(r.key).mode, 'observe', '40% drops it');
  p = req.get(r.key).precision;
  assert.deepEqual([p.false_positives, p.accepted_deviations, p.rate, p.window], [4, 0, 0.4, 20]);
  const demoted = events('req:demoted').filter((e) => e.requirement === r.key);
  assert.equal(demoted.length, 1);
  assert.deepEqual([demoted[0].from, demoted[0].false_positives, demoted[0].violates], ['inform', 4, 10]);
  assert.equal(notices('a2'), before + 1, 'the owner is told once');
  const text = JSON.parse(db.open().prepare("SELECT data FROM events WHERE type = 'notice:queued' ORDER BY id DESC").get().data).text;
  assert.match(text, /dropped to observe/);
  assert.match(text, /reword/);
  // Another waiver changes nothing more: no second demotion, no second notice.
  await waive(ids[4]);
  assert.equal(events('req:demoted').filter((e) => e.requirement === r.key).length, 1);
  assert.equal(notices('a2'), before + 1);
});

test('precision counts only the last 20 flags at the current version, and accepted deviations are not false positives', async () => {
  const r = await mkReq('Windowed', { owner: 'a2' });
  const ids = await flags(r, 25);
  // The 5 oldest are outside the window of 20: waiving them moves nothing.
  for (const id of ids.slice(0, 5)) await waive(id);
  assert.equal(req.get(r.key).precision.violates, 20);
  assert.equal(req.get(r.key).precision.false_positives, 0);
  assert.equal(req.must(r.key).mode, 'inform');
  // Deviations are accepted, not wrong: they show in the counts but not in the rate.
  for (const id of ids.slice(5, 15)) await waive(id, 'accepted_deviation');
  const p = req.get(r.key).precision;
  assert.deepEqual([p.false_positives, p.accepted_deviations, p.rate], [0, 10, 0]);
  assert.equal(req.must(r.key).mode, 'inform');
  // A reworded requirement starts a new count.
  await req.set(r.key, { text: 'Windowed shall hold, in other words.' }, 'human');
  assert.equal(req.get(r.key).precision.violates, 0);
  assert.equal(req.get(r.key).precision.rate, null);
});

test('precision: it needs demoteMinFlags flags (default 5) at the version: 1 of 1 does not demote, 2 of 5 does', async () => {
  assert.equal(settings.settings().requirements.demoteMinFlags, 5);
  const r = await mkReq('Minimum', { owner: 'a2' });
  const ids = await flags(r, 1);
  const before = notices('a2');
  await waive(ids[0]);
  assert.equal(req.get(r.key).precision.rate, 1, 'a rate of 100%, on too few flags');
  assert.equal(req.must(r.key).mode, 'inform', '1 of 1 is not enough evidence');
  assert.equal(notices('a2'), before);
  ids.push(...(await flags(r, 3)));
  assert.equal(req.must(r.key).mode, 'inform', 'still only 4 flags');
  await waive(ids[1]);
  assert.equal(req.must(r.key).mode, 'inform', '2 of 4: below the minimum');
  ids.push(...(await flags(r, 1)));
  await waive(ids[2]);
  const p = req.get(r.key).precision;
  assert.deepEqual([p.violates, p.false_positives], [5, 3]);
  assert.equal(req.must(r.key).mode, 'observe', '3 of 5 at the minimum drops it');
  // 2 of 5 (40%) drops it too.
  const r2 = await mkReq('Two of five');
  const f = await flags(r2, 5);
  await waive(f[0]);
  assert.equal(req.must(r2.key).mode, 'inform', '1 of 5 is 20%');
  await waive(f[1]);
  assert.equal(req.must(r2.key).mode, 'observe', '2 of 5 is 40%');
  // The minimum is a setting.
  setReq({ demoteMinFlags: 1 });
  const r3 = await mkReq('Min one');
  await waive((await flags(r3, 1))[0]);
  assert.equal(req.must(r3.key).mode, 'observe');
  setReq({ demoteMinFlags: 5 });
});

test('precision: a human owner is told in the requirement\'s ITSA thread, or not at all, and never by separate mail', async () => {
  const mails = () => db.open().prepare('SELECT COUNT(*) AS n FROM mail').get().n;
  setReq({ demoteMinFlags: 1 });
  const lone = await mkReq('No thread', { owner: 'human' });
  const [a] = await flags(lone, 1);
  const before = mails();
  await waive(a);
  assert.equal(req.must(lone.key).mode, 'observe', 'demoted all the same');
  assert.equal(mails(), before, 'no thread, no mail');

  const threaded = await mkReq('Has thread', { owner: 'human' });
  const ask = await itsa.create({ title: 'Approve requirement', status: 'waiting', kind: approval.APPROVAL_KIND, owner: 'a1', participants: ['a1'], links: [{ system: 'requirement', external_id: threaded.key, url: `stam:requirement/${threaded.key}` }], by: 'a1' });
  const [b] = await flags(threaded, 1);
  await waive(b);
  assert.equal(req.must(threaded.key).mode, 'observe');
  const posted = db.open().prepare('SELECT body, itsa_id FROM mail WHERE itsa_id = ?').all(ask.id);
  assert.equal(posted.length, 1, 'one entry in its thread');
  assert.match(posted[0].body, /dropped to observe/);
  assert.match(posted[0].body, /refines/, 'rewording goes through a refines draft');
  assert.doesNotMatch(posted[0].body, /req_set/, 'req_set refuses an agent that loosens a live rule');
  setReq({ demoteMinFlags: 5 });
});

test('preview: the last n real subjects of the scope, nothing recorded, nobody told, cost as decide:req:preview', async () => {
  const d = db.open();
  for (let i = 1; i <= 3; i++)
    d.prepare("INSERT INTO mail (id, from_id, from_name, subject, body, created_at) VALUES (?, 'a1', 'alice', ?, ?, ?)").run(`pv${i}`, `Preview mail ${i}`, `body ${i} REQ:R-PV=${i === 2 ? 'violates' : 'conforms'}`, `2099-01-01T10:0${i}:00.000Z`);
  // A draft, in inform mode: a preview needs no in-force requirement and must not act as one.
  const r = await req.create({ title: 'Previewed', text: 'Preview shall hold.', status: 'draft', verification: ['decision'], by: 'human', scope: { subjects: ['mail'] }, mode: 'inform', owner: 'a2' });
  d.prepare("UPDATE mail SET body = REPLACE(body, 'R-PV', ?)").run(r.key);
  const vBefore = d.prepare('SELECT COUNT(*) AS n FROM req_verdicts WHERE req_id = ?').get(r.id).n;
  const nBefore = [notices('a1'), notices('a2')];
  const eventsBefore = d.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'req:%'").get().n;
  const out = await rc.preview(r.key, 2);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows.map((x) => x.subject), ['mail:pv3', 'mail:pv2'], 'newest first');
  assert.deepEqual(out.rows.map((x) => x.verdict), ['conforms', 'violates']);
  assert.equal(out.rows[1].would_act, true, 'a violation in inform mode would tell the actor');
  assert.equal(out.rows[1].summary, 'Preview mail 2');
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM req_verdicts WHERE req_id = ?').get(r.id).n, vBefore, 'nothing recorded');
  assert.deepEqual([notices('a1'), notices('a2')], nBefore, 'nobody told');
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'req:%'").get().n, eventsBefore, 'no req: event');
  const purposes = d.prepare("SELECT json_extract(data, '$.purpose') AS p FROM events WHERE type = 'decide' ORDER BY id DESC LIMIT 2").all().map((x) => x.p);
  assert.deepEqual(purposes, ['decide:req:preview', 'decide:req:preview']);
  // The default is 20 and the most 50.
  assert.equal((await rc.preview(r.key)).n, 20);
  assert.equal((await rc.preview(r.key, 500)).n, 50);
});

test('preview: the daily cap applies, and it does not announce the cap', async () => {
  const r = await mkReq('Capped preview');
  const calls = requests.length;
  setReq({ dailyCapUsd: 0.0001 });
  try {
    const out = await rc.preview(r.key, 3);
    assert.ok(out.rows.length > 0 && out.rows.every((x) => x.error && !x.verdict), JSON.stringify(out));
    assert.match(out.note, /daily cap/);
    assert.equal(requests.length, calls, 'the model was not asked');
    assert.equal(events('req:cap').length, 0, 'a preview tells nobody about the cap');
  } finally {
    setReq({ dailyCapUsd: 100 });
  }
});

test('an approval is bound to the edit counter: edits in the same millisecond still count', async () => {
  const d = await req.create({ title: 'Counter', text: 'One.', verification: ['decision'], by: 'a1' });
  const rev0 = req.must(d.key).rev;
  const stamps = new Set();
  for (let i = 0; i < 20; i++) {
    const x = (await req.set(d.key, { title: `Counter ${i}` }, 'a1')).requirement;
    assert.equal(x.rev, rev0 + i + 1, 'every edit bumps rev by one');
    stamps.add(x.updated_at);
  }
  assert.ok(stamps.size < 20, 'edits did share a millisecond, which is why updated_at could not be the binding');
  await assert.rejects(() => req.set(d.key, { status: 'in_force', ifRev: rev0 + 19 }, 'human'), /changed since it was shown/);
  assert.equal(req.must(d.key).status, 'draft');
  const ok = await req.set(d.key, { status: 'in_force', ifRev: rev0 + 20 }, 'human');
  assert.equal(ok.requirement.status, 'in_force');
});

test('approval cos: the ask goes to the chief of staff by mail, through the same ITSA, with no human status', async () => {
  agent('c1', 'cosy');
  settings.setSetting('chiefOfStaff', 'cosy');
  setReq({ approval: 'cos' });
  const d = await req.create({ title: 'For the CoS', text: 'Chief shall decide.', verification: ['decision'], by: 'a1' });
  const made = await approval.ask(d, 'a1');
  assert.equal(made.to, 'chief of staff');
  const x = itsa.must(made.key);
  assert.equal(x.kind, 'requirement-approval');
  assert.equal(x.owner, 'c1');
  assert.equal(itsa.statusOf(x.status).human, false, `${x.status} is not a human status`);
  assert.ok(itsa.participants(x.id).includes('c1'));
  const asked = db.open().prepare('SELECT m.body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.itsa_id = ? AND r.agent_id = ?').all(x.id, 'c1');
  assert.equal(asked.length, 1, 'one mail to the chief of staff');
  assert.match(asked[0].body, /@cosy/);
  assert.match(asked[0].body, /Chief shall decide\./);
  assert.match(asked[0].body, new RegExp(`req_set key=${d.key} status=in_force`));
  assert.equal(db.open().prepare("SELECT COUNT(*) AS n FROM itsa_events WHERE itsa_id = ? AND type = 'status'").get(x.id).n, 0, 'it never changed status, so never reached the human');

  // An edit while the ask is open refreshes it for the chief of staff and keeps it off the human.
  await req.set(d.key, { text: 'Chief shall decide, reworded.' }, 'a1');
  await approval.refresh(d.key, 'a1');
  assert.match(itsa.must(x.id).body, /reworded/);
  assert.equal(itsa.statusOf(itsa.must(x.id).status).human, false);

  // The chief of staff approves with req_set; the ask then closes as done with a comment.
  const rev = req.must(d.key).rev;
  const r = await req.set(d.key, { status: 'in_force', ifRev: rev }, 'c1');
  assert.equal(r.requirement.status, 'in_force');
  await approval.approvedElsewhere(d.key, 'c1');
  assert.equal(itsa.must(x.id).status, 'done');
  assert.ok(db.open().prepare('SELECT body FROM mail WHERE itsa_id = ?').all(x.id).some((m) => /was put in force by cosy; closing this ask/.test(m.body)));
});

test('an agent moves a requirement to in_force only by naming the revision, and with no other edit in the call', async () => {
  settings.setSetting('chiefOfStaff', 'cosy');
  setReq({ approval: 'cos' });
  const d = await req.create({ title: 'Reviewer case', text: 'Text A shall hold.', verification: ['decision'], by: 'a1' });
  await approval.ask(d, 'a1');
  const shownRev = req.must(d.key).rev;
  await req.set(d.key, { text: 'Text B, never shown to the chief of staff.' }, 'a1');
  // Without if_rev the chief of staff would put B in force unseen: refused.
  await assert.rejects(() => req.set(d.key, { status: 'in_force' }, 'c1'), /naming the revision|if_rev/);
  // The revision it was shown is stale now.
  await assert.rejects(() => req.set(d.key, { status: 'in_force', ifRev: shownRev }, 'c1'), /changed since it was shown/);
  // One call can't edit the text and approve it.
  await assert.rejects(() => req.set(d.key, { text: 'Text C', status: 'in_force', ifRev: req.must(d.key).rev }, 'c1'), /one call/);
  assert.equal(req.must(d.key).status, 'draft');
  assert.equal(req.must(d.key).text, 'Text B, never shown to the chief of staff.');
  // Naming the current revision works.
  assert.equal((await req.set(d.key, { status: 'in_force', ifRev: req.must(d.key).rev }, 'c1')).requirement.status, 'in_force');
  // The human sees the current text, so needs no rev.
  const h = await req.create({ title: 'Human direct', text: 'x shall y.', verification: ['decision'], by: 'a1' });
  assert.equal((await req.set(h.key, { status: 'in_force' }, 'human')).requirement.status, 'in_force');
  setReq({ approval: 'human' });
});

test('an MCP-shaped body (status, if_rev, and who is asking) is a valid approval; an edit in it is not', async () => {
  settings.setSetting('chiefOfStaff', 'cosy');
  setReq({ approval: 'cos' });
  const d = await req.create({ title: 'Shaped', text: 'Shaped shall hold.', verification: ['decision'], by: 'a1' });
  // The body the shim sends and the route hands to set whole: identity metadata is not an edit.
  const body = { status: 'in_force', ifRev: req.must(d.key).rev, by: 'c1', self: 'c1' };
  assert.equal((await req.set(d.key, body, body.by)).requirement.status, 'in_force');
  const e = await req.create({ title: 'Shaped two', text: 'Two shall hold.', verification: ['decision'], by: 'a1' });
  await assert.rejects(() => req.set(e.key, { status: 'in_force', ifRev: req.must(e.key).rev, title: 'Renamed', by: 'c1' }, 'c1'), /one call/);
  setReq({ approval: 'human' });
});

test('an agent cannot change the text or scope of an in-force or suspended requirement under human or cos approval', async () => {
  settings.setSetting('chiefOfStaff', 'cosy');
  for (const approval_ of ['human', 'cos']) {
    setReq({ approval: approval_ });
    const live = await mkReq(`Live ${approval_}`, { owner: 'a2' });
    const text = req.must(live.key).text;
    for (const patch of [{ text: 'Reworded by an agent.' }, { scope: { subjects: ['itsa'] } }, { text: 'Reworded again.', status: 'in_force' }]) {
      await assert.rejects(() => req.set(live.key, patch, 'a1'), /can't change the (text|scope).*refines/, `${approval_}: ${JSON.stringify(patch)}`);
    }
    assert.equal(req.must(live.key).text, text);
    assert.equal(req.must(live.key).status, 'in_force', 'not moved back to draft either');
    assert.equal(req.must(live.key).version, 1);
    // A no-op, and fields that are not the statement, are fine; so is the human.
    assert.deepEqual((await req.set(live.key, { text }, 'a1')).changes, {});
    assert.equal((await req.set(live.key, { rationale: 'Why, by an agent.' }, 'a1')).requirement.rationale, 'Why, by an agent.');
    assert.equal((await req.set(live.key, { text: 'Reworded by the human.' }, 'human')).requirement.version, 2);
    // Suspended is the same.
    await req.set(live.key, { status: 'suspended' }, 'human');
    await assert.rejects(() => req.set(live.key, { text: 'Sneaky.' }, 'a1'), /while it is suspended/);
    // A draft is the author's to edit.
    const draft = await req.create({ title: `Draft ${approval_}`, text: 'First.', by: 'a1' });
    assert.equal((await req.set(draft.key, { text: 'Second.' }, 'a1')).requirement.version, 2);
  }
  // Under `any` agents may edit.
  setReq({ approval: 'any' });
  const open = await mkReq('Live any');
  assert.equal((await req.set(open.key, { text: 'Edited under any.' }, 'a1')).requirement.version, 2);
  setReq({ approval: 'human' });
});

test('under human or cos approval an agent can only create a draft; the human, or any caller under any, may create in force', async () => {
  settings.setSetting('chiefOfStaff', 'cosy');
  for (const approval_ of ['human', 'cos']) {
    setReq({ approval: approval_ });
    for (const [by, status] of [['c1', 'in_force'], ['a1', 'in_force'], ['c1', 'suspended'], ['a1', 'suspended']])
      await assert.rejects(() => req.create({ title: 'Cos own', text: 'Cos authored text', status, verification: ['decision'], by }), /can't create a requirement as .*create a draft/, `${approval_}: ${by} ${status}`);
    assert.equal((await req.create({ title: 'An agent draft', by: 'c1' })).status, 'draft');
    assert.equal((await req.create({ title: 'By the human', status: 'in_force', by: 'human' })).status, 'in_force');
  }
  setReq({ approval: 'any' });
  assert.equal((await req.create({ title: 'Any', status: 'in_force', by: 'a1' })).status, 'in_force');
  setReq({ approval: 'human' });
});

test('the chief of staff can not approve text it edited: the creator and whoever last changed the text or scope are both barred', async () => {
  settings.setSetting('chiefOfStaff', 'cosy');
  setReq({ approval: 'cos' });
  const d = await req.create({ title: 'Edited by cos', text: 'Original shall hold.', verification: ['decision'], by: 'a1' });
  assert.equal(req.must(d.key).text_by, 'a1');
  await req.set(d.key, { text: 'Wording only the chief of staff saw.' }, 'c1');
  assert.equal(req.must(d.key).text_by, 'c1');
  await assert.rejects(() => req.set(d.key, { status: 'in_force', ifRev: req.must(d.key).rev }, 'c1'), /text it last changed/);
  // A scope change counts as well; the creator stays barred from its own draft.
  await req.set(d.key, { scope: { subjects: ['itsa'] } }, 'a2');
  assert.equal(req.must(d.key).text_by, 'a2');
  await assert.rejects(() => req.set(d.key, { status: 'in_force', ifRev: req.must(d.key).rev }, 'a2'), /text it last changed|only the chief of staff/);
  // After a different agent's edit, the chief of staff may approve it.
  assert.equal((await req.set(d.key, { status: 'in_force', ifRev: req.must(d.key).rev }, 'c1')).requirement.status, 'in_force');
  // An obsolete requirement edited by the chief of staff can not be revived by it.
  const o = await req.create({ title: 'Obsolete', text: 'Old shall hold.', verification: ['decision'], by: 'a1' });
  await req.set(o.key, { status: 'obsolete' }, 'human');
  await req.set(o.key, { text: 'New wording by cos.' }, 'c1');
  await assert.rejects(() => req.set(o.key, { status: 'in_force', ifRev: req.must(o.key).rev }, 'c1'), /text it last changed/);
  // A non-statement edit by the chief of staff does not make it the text's author.
  const n = await req.create({ title: 'Rationale only', text: 'Plain shall hold.', verification: ['decision'], by: 'a1' });
  await req.set(n.key, { rationale: 'Because.' }, 'c1');
  assert.equal(req.must(n.key).text_by, 'a1');
  assert.equal((await req.set(n.key, { status: 'in_force', ifRev: req.must(n.key).rev }, 'c1')).requirement.status, 'in_force');
  // Under any, anyone may.
  setReq({ approval: 'any' });
  const e = await req.create({ title: 'Any edit', text: 'x shall y.', by: 'a1' });
  await req.set(e.key, { text: 'z shall w.' }, 'a2');
  assert.equal((await req.set(e.key, { status: 'in_force', ifRev: req.must(e.key).rev }, 'a2')).requirement.status, 'in_force');
  setReq({ approval: 'human' });
});

test('an agent can not loosen a live rule: mode, threshold, severity of an in-force or suspended requirement; stam still demotes', async () => {
  settings.setSetting('chiefOfStaff', 'cosy');
  for (const approval_ of ['human', 'cos']) {
    setReq({ approval: approval_ });
    const live = await mkReq(`Rule ${approval_}`, { mode: 'enforce', severity: 'major', owner: 'a2' });
    for (const patch of [{ mode: 'observe' }, { threshold: 0.99 }, { severity: 'info' }])
      await assert.rejects(() => req.set(live.key, patch, 'a1'), /can't change the (mode|threshold|severity) of .*while it is in_force/, `${approval_}: ${JSON.stringify(patch)}`);
    assert.deepEqual([req.must(live.key).mode, req.must(live.key).threshold, req.must(live.key).severity], ['enforce', 0.8, 'major']);
    assert.equal((await req.set(live.key, { mode: 'enforce' }, 'a1')).requirement.mode, 'enforce', 'a no-op is fine');
    assert.equal((await req.set(live.key, { mode: 'inform' }, 'human')).requirement.mode, 'inform', 'the human may');
    await req.set(live.key, { status: 'suspended' }, 'human');
    await assert.rejects(() => req.set(live.key, { severity: 'info' }, 'a1'), /while it is suspended/);
    const draft = await req.create({ title: `Draft ${approval_}`, by: 'a1' });
    assert.equal((await req.set(draft.key, { mode: 'enforce', threshold: 0.9, severity: 'critical' }, 'a1')).requirement.mode, 'enforce', 'a draft is the author\'s');
    // Stam's own demotion is not an agent and still works.
    const flagged = await mkReq(`Flagged ${approval_}`, { mode: 'enforce', owner: 'a2' });
    const ids = await flags(flagged, 5);
    for (const id of ids.slice(0, 3)) await waive(id);
    assert.equal(req.must(flagged.key).mode, 'observe');
  }
  setReq({ approval: 'any' });
  const open = await mkReq('Rule any');
  assert.equal((await req.set(open.key, { mode: 'enforce' }, 'a1')).requirement.mode, 'enforce');
  setReq({ approval: 'human' });
});

test('concurrent waivers demote once: one req:demoted event and one notice', async () => {
  const r = await mkReq('Racing', { owner: 'a2' });
  const ids = await flags(r, 6);
  const before = notices('a2');
  const events0 = events('req:demoted').filter((e) => e.requirement === r.key).length;
  await Promise.all(ids.map((id) => waive(id)));
  assert.equal(req.must(r.key).mode, 'observe');
  assert.equal(events('req:demoted').filter((e) => e.requirement === r.key).length, events0 + 1, 'one event');
  assert.equal(notices('a2'), before + 1, 'one notice');
});

test('approval cos: with no chief of staff, or when the chief of staff wrote the draft, the human is asked', async () => {
  const mine = await req.create({ title: 'CoS draft', text: 'x shall y.', verification: ['decision'], by: 'c1' });
  const a = await approval.ask(mine, 'c1');
  assert.equal(a.to, 'human', 'the chief of staff does not approve its own draft');
  assert.equal(itsa.must(a.key).status, 'needs_approval');

  settings.setSetting('chiefOfStaff', null);
  const d = await req.create({ title: 'No CoS', text: 'x shall z.', verification: ['decision'], by: 'a1' });
  const b = await approval.ask(d, 'a1');
  assert.equal(b.to, 'human');
  assert.equal(itsa.must(b.key).status, 'needs_approval');
  settings.setSetting('chiefOfStaff', 'cosy');
  setReq({ approval: 'human' });
});

test('a requirement put in force another way closes its open ask as done, with a one-line comment', async () => {
  const d = await req.create({ title: 'Direct', text: 'Direct shall be.', verification: ['decision'], by: 'a1' });
  const x = itsa.must((await approval.ask(d, 'a1')).key);
  assert.equal(x.status, 'needs_approval');
  await req.set(d.key, { status: 'in_force' }, 'human');
  await approval.approvedElsewhere(d.key, 'human');
  assert.equal(itsa.must(x.id).status, 'done');
  const notes = db.open().prepare('SELECT body FROM mail WHERE itsa_id = ?').all(x.id).map((m) => m.body);
  assert.ok(notes.some((b) => /^[^\n]*was put in force by your user; closing this ask\.$/.test(b)), JSON.stringify(notes));
  // With no open ask, nothing happens and nothing throws.
  await approval.approvedElsewhere(d.key, 'human');
});

test('readable subjects: a verdict says its mail, ITSA, branch, or pasted text readably, and get keeps an asked-for old verdict', async () => {
  const r = await mkReq('Readable', { scope: { subjects: ['mail', 'manual'] } });
  const sent = await mail.sendMail({ from: 'a1', to: ['a2'], subject: 'Deploy plan for Friday', body: 'b' });
  const m = db.getMail(sent.id);
  const it = await itsa.create({ title: 'Readable work', by: 'human' });
  const rec = (subject, extra = {}) => req.recordVerdict({ req_id: r.id, req_version: r.version, subject, subject_hash: `h-${subject}`, model: 'm', verdict: 'conforms', p_conforms: 0.9, p_violates: 0.05, p_na: 0.05, action: 'none', cost: 0, ...extra });
  const old = rec(`mail:${m.id}`);
  rec(`itsa:${it.key}`);
  rec('branch:stam2/stam/req-matrix@abc1234');
  rec('tool:Bash');
  rec('text:0123abcd');
  rec('mail:nope');
  const text = 'A pasted paragraph that goes on well past sixty characters, so it is cut short';
  await rc.manual({ text, keys: r.key });
  const by = new Map(req.get(r.key).verdicts.map((v) => [v.subject, v]));
  assert.deepEqual([by.get(`mail:${m.id}`).label, by.get(`mail:${m.id}`).open], ['Deploy plan for Friday', { kind: 'thread', id: m.thread_id ?? m.id }]);
  assert.deepEqual([by.get(`itsa:${it.key}`).label, by.get(`itsa:${it.key}`).open], [`${it.key} Readable work`, { kind: 'itsa', id: it.id }]);
  assert.equal(by.get('branch:stam2/stam/req-matrix@abc1234').label, 'stam/req-matrix');
  assert.equal(by.get('tool:Bash').label, 'tool Bash');
  assert.equal(by.get('text:0123abcd').label, 'pasted text', 'an old text verdict never shows its hash');
  assert.equal(by.get('mail:nope').label, 'mail nope');
  const pasted = [...by.values()].find((v) => v.subject.startsWith('text:') && v.subject !== 'text:0123abcd');
  assert.equal(pasted.label, req.clip(text));
  assert.ok(pasted.label.length <= 60 && pasted.label.endsWith('…'));
  // Twenty newer verdicts push the first out of the list; asking for it by id brings it back.
  for (let i = 0; i < 20; i++) rec(`tool:t${i}`);
  assert.ok(!req.get(r.key).verdicts.some((v) => v.id === old));
  assert.equal(req.get(r.key, { verdict: old }).verdicts.find((v) => v.id === old)?.label, 'Deploy plan for Friday');
  assert.ok(!req.get(r.key, { verdict: 999999 }).verdicts.some((v) => v.id === 999999), 'another requirement\'s or a missing verdict is not added');
});
