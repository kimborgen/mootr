#!/usr/bin/env node
// Unit tests for src/steps.ts (decision steps): validation and CRUD, event triggers
// running after the event commits (mail to the human, ITSA created and status changed,
// agent spawned), flag, notify (held back by the human's mail settings), and annotate,
// failing open on a model error, checkTool's approve-if-yes and deny-if-yes, the preview
// on the last N examples, the log, and the cost row. Throwaway STAM_HOME and an
// in-process stub of OpenRouter's decisions endpoint (free). The stub answers P(yes) from
// a `P=0.NN` marker anywhere in the state, 500s on `FAIL`, waits 200 ms per call (`DELAY=ms`
// overrides it), and answers `BAD=x` as x.
// Run with `node --test test/steps.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-steps-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `steps-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');

const calls = [];
const stub = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    const text = JSON.stringify(body.state);
    // DELAY=ms waits that long; BAD=x answers x (malformed probabilities, out of 0..1).
    const delay = Number(text.match(/DELAY=(\d+)/)?.[1] ?? 200);
    setTimeout(() => {
      if (text.includes('FAIL')) return res.writeHead(500).end('{}');
      const bad = text.match(/BAD=(-?[\d.]+)/)?.[1];
      const p = bad !== undefined ? Number(bad) : Number(text.match(/P=(0\.\d+)/)?.[1] ?? 0.1);
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: 'noul', noul: p }]));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'stub', answers, usage: { input_tokens: 10, output_tokens: 1, cost: 0.001 } }));
    }, delay);
  });
});

let db, steps, itsa, mail;
before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${stub.address().port}`;
  db = await import('../src/db.ts');
  steps = await import('../src/steps.ts');
  itsa = await import('../src/itsa.ts');
  mail = await import('../src/mail.ts');
  db.open();
  db.createAgent({ id: 'boss', name: 'boss', role: 'manager', machine: 'x', harness: 'external', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.createAgent({ id: 'dev1', name: 'dev1', role: 'developer', machine: 'x', harness: 'external', model: null, effort: null, cwd: '/tmp', parent_id: 'boss', session_id: null });
  db.updateAgent('boss', { lifecycle: 'active' });
  // S-548 sends a non-manager's mail to the human to its parent; dev1's type is manager so its mail reaches the human (its role stays developer).
  db.updateAgent('dev1', { type: 'manager' });
  steps.watch();
});
after(() => {
  stub.close();
  rmSync(home, { recursive: true, force: true });
  // mail.ts schedules idle pushes; nothing else keeps the process alive past the tests.
  setTimeout(() => process.exit(0), 100).unref();
});

const setHumanMail = (when) => writeFileSync(join(home, 'settings.json'), JSON.stringify({ humanMail: { when } }));
const only = (fn) => {
  // Each test turns on just its own steps.
  for (const s of steps.list()) steps.update(s.id, { enabled: false });
  return fn();
};

test('a step is validated, created with defaults, updated, and deleted', () => {
  assert.throws(() => steps.create({ name: 'x', question: 'q', trigger: { kind: 'event', event: 'nope' } }), /trigger/);
  assert.throws(() => steps.create({ name: 'x', question: 'q', trigger: { kind: 'tool', tool: 'bad name!' } }), /trigger/);
  assert.throws(() => steps.create({ name: '', question: 'q', trigger: { kind: 'tool', tool: 'send_mail' } }), /name/);
  assert.throws(() => steps.create({ name: 'x', question: 'q', trigger: { kind: 'tool', tool: 'send_mail' }, threshold: 2 }), /threshold/);
  assert.throws(() => steps.create({ name: 'x', question: 'q', trigger: { kind: 'tool', tool: 'send_mail' }, action: 'flag' }), /approve-if-yes, deny-if-yes/);
  const s = steps.create({ name: 'mail check', question: 'Is it short?', trigger: { kind: 'event', event: 'mail-to-human' } });
  assert.equal(s.threshold, 0.5);
  assert.equal(s.action, 'flag');
  assert.equal(s.enabled, true);
  const u = steps.update(s.id, { threshold: 0.8, enabled: false });
  assert.equal(u.threshold, 0.8);
  assert.equal(u.enabled, false);
  assert.equal(u.question, 'Is it short?');
  // A trigger change to a tool picks the tool actions' default.
  assert.equal(steps.update(s.id, { trigger: { kind: 'tool', tool: 'mcp__stam__send_mail' } }).action, 'approve-if-yes');
  steps.remove(s.id);
  assert.equal(steps.get(s.id), undefined);
  assert.throws(() => steps.must(s.id), /no step/);
});

test('mail to the human runs its step after the send returns, with who sent it', () =>
  only(async () => {
    const s = steps.create({ name: 'flag long', question: 'Is it long?', trigger: { kind: 'event', event: 'mail-to-human' }, action: 'flag' });
    const before = calls.length;
    const m = await mail.sendMail({ from: 'dev1', to: ['human'], subject: 'Result', body: 'done P=0.9', new_thread: true });
    // The send didn't wait for the model (the stub takes 200 ms).
    assert.equal(steps.log(s.id).length, 0);
    await steps.settled();
    const [d] = steps.log(s.id);
    assert.equal(d.subject, `mail:${m.id}`);
    assert.equal(d.answer, true);
    assert.equal(d.action, 'flagged');
    assert.equal(d.p, 0.9);
    const sent = calls.slice(before).find((c) => c.questions.answer);
    assert.equal(sent.questions.answer.type, 'noul');
    assert.equal(sent.questions.answer.instructions, 'Is it long?');
    assert.deepEqual(sent.state.by, { name: 'dev1', role: 'developer', parent: 'boss' });
    assert.equal(sent.state.event, 'mail-to-human');
    assert.equal(sent.state.payload.body, 'done P=0.9');
    // The cost is recorded under the step's purpose.
    const u = db.open().prepare("SELECT cost_usd FROM usage WHERE agent_id = 'stam' AND model = ?").get(`decide:step:${s.id}`);
    assert.ok(u && u.cost_usd > 0);
  }));

test('a "no" takes no action, and the human mail settings hold back notify', () =>
  only(async () => {
    const s = steps.create({ name: 'notify', question: 'Urgent?', trigger: { kind: 'event', event: 'mail-to-human' }, action: 'notify', threshold: 0.7 });
    setHumanMail('necessary');
    await mail.sendMail({ from: 'dev1', to: ['human'], subject: 'a', body: 'P=0.6', new_thread: true });
    await mail.sendMail({ from: 'dev1', to: ['human'], subject: 'b', body: 'P=0.95', new_thread: true });
    await steps.settled();
    const [held, no] = steps.log(s.id);
    assert.deepEqual([no.answer, no.action], [false, 'none']);
    assert.deepEqual([held.answer, held.action], [true, 'none']);
    setHumanMail('everything');
    await mail.sendMail({ from: 'dev1', to: ['human'], subject: 'c', body: 'P=0.95', new_thread: true });
    await steps.settled();
    assert.equal(steps.log(s.id)[0].action, 'notified');
    const note = db.threads('human', 20).flatMap((t) => t.mails).find((m) => m.subject.startsWith('[stam] Step notify'));
    assert.ok(note, 'no notice mail to the human');
    assert.match(note.body, /Urgent\?/);
    // stam's own notice doesn't trigger the step again.
    assert.equal(steps.log(s.id).length, 3);
    setHumanMail('necessary');
  }));

test('ITSA created and status changed run their steps; annotate notes the ITSA', () =>
  only(async () => {
    const created = steps.create({ name: 'new issue', question: 'Is it a bug?', trigger: { kind: 'event', event: 'itsa-created' }, action: 'annotate' });
    const status = steps.create({ name: 'closed', question: 'Closed?', trigger: { kind: 'event', event: 'itsa-status' }, action: 'flag' });
    const x = await itsa.create({ title: 'Crash on start P=0.8', by: 'dev1' });
    await itsa.set(x.key, { status: 'in_progress' }, 'dev1');
    await steps.settled();
    const [c] = steps.log(created.id);
    assert.deepEqual([c.subject, c.action], [`itsa:${x.key}`, 'annotated']);
    const ev = itsa.events(x.key).find((e) => e.type === 'step.note');
    assert.ok(ev, 'no step note on the ITSA');
    assert.equal(JSON.parse(ev.data).step, created.id);
    const [st] = steps.log(status.id);
    assert.equal(st.subject, `itsa:${x.key}`);
    assert.equal(st.p, 0.8);
    const sent = calls.findLast((call) => call.state.event === 'itsa-status');
    assert.deepEqual([sent.state.payload.from, sent.state.payload.to], [x.status, 'in_progress']);
    assert.equal(steps.decisionsOn(`itsa:${x.key}`).length, 2);
  }));

test('a model error fails open and is logged; the event still happened', () =>
  only(async () => {
    const s = steps.create({ name: 'fragile', question: 'Fine?', trigger: { kind: 'event', event: 'itsa-created' }, action: 'notify' });
    const x = await itsa.create({ title: 'FAIL here', by: 'human' });
    assert.ok(itsa.find(x.key));
    await steps.settled();
    const [d] = steps.log(s.id);
    assert.deepEqual([d.action, d.answer, d.p], ['failed-open', null, null]);
    assert.ok(d.error);
  }));

test('agent-spawned steps run from emit with the spawner as actor', () =>
  only(async () => {
    const s = steps.create({ name: 'spawn', question: 'Expensive model?', trigger: { kind: 'event', event: 'agent-spawned' } });
    db.createAgent({ id: 'kid', name: 'kid', role: 'tester', machine: 'x', harness: 'external', model: 'P=0.77', effort: null, cwd: '/tmp', parent_id: 'dev1', session_id: null });
    steps.emit('agent-spawned', steps.spawnSubject(db.getAgent('kid'), 'dev1'));
    await steps.settled();
    const [d] = steps.log(s.id);
    assert.deepEqual([d.subject, d.p, d.answer], ['agent:kid', 0.77, true]);
    assert.equal(calls.findLast((c) => c.state.event === 'agent-spawned').state.by.name, 'dev1');
  }));

test('checkTool: deny-if-yes and approve-if-yes, with a clear error; fails open', () =>
  only(async () => {
    assert.deepEqual(await steps.checkTool('dev1', 'send_mail', { body: 'P=0.9' }), { allow: true });
    const deny = steps.create({ name: 'no spam', question: 'Is this spam?', trigger: { kind: 'tool', tool: 'send_mail' }, action: 'deny-if-yes' });
    assert.equal((await steps.checkTool('dev1', 'send_mail', { body: 'P=0.2' })).allow, true);
    const r = await steps.checkTool('dev1', 'send_mail', { body: 'P=0.9' });
    assert.equal(r.allow, false);
    assert.deepEqual(r.step, { id: deny.id, name: 'no spam' });
    assert.equal(r.question, 'Is this spam?');
    assert.equal(r.p, 0.9);
    assert.match(r.error, /no spam.*Is this spam\?.*yes/);
    assert.deepEqual(steps.log(deny.id).map((d) => d.action), ['denied', 'allowed']);
    const approve = steps.create({ name: 'scoped', question: 'Is the path inside the repo?', trigger: { kind: 'tool', tool: 'Write' }, action: 'approve-if-yes' });
    assert.equal((await steps.checkTool('dev1', 'Write', { path: 'P=0.3' })).allow, false);
    assert.equal((await steps.checkTool('dev1', 'Write', { path: 'P=0.6' })).allow, true);
    assert.equal((await steps.checkTool('dev1', 'Write', { path: 'FAIL' })).allow, true);
    assert.equal(steps.log(approve.id)[0].action, 'failed-open');
    // Another tool's steps don't apply.
    assert.equal((await steps.checkTool('dev1', 'Read', { path: 'P=0.1' })).allow, true);
  }));

test('preview runs on the last N real examples, takes no action, and logs nothing', () =>
  only(async () => {
    const s = steps.create({ name: 'preview', question: 'Done?', trigger: { kind: 'event', event: 'mail-to-human' }, action: 'notify', enabled: false });
    const r = await steps.preview(s.id, 2);
    assert.equal(r.examples.length, 2);
    // Newest first: the last mail the earlier tests sent was 'c' (P=0.95).
    assert.equal(r.examples[0].summary, 'c');
    assert.deepEqual([r.examples[0].p, r.examples[0].answer], [0.95, true]);
    assert.ok(r.examples.every((e) => e.subject.startsWith('mail:')));
    assert.equal(steps.log(s.id).length, 0);
    const it = await steps.preview(steps.create({ name: 'p2', question: 'q', trigger: { kind: 'event', event: 'itsa-status' }, enabled: false }).id, 5);
    assert.ok(it.examples.length >= 1);
    const sp = await steps.preview(steps.create({ name: 'p3', question: 'q', trigger: { kind: 'event', event: 'agent-spawned' }, enabled: false }).id, 50);
    assert.equal(sp.examples.length, 3);
    const tool = await steps.preview(steps.create({ name: 'p4', question: 'q', trigger: { kind: 'tool', tool: 'Write' }, enabled: false }).id, 5);
    assert.ok(tool.examples.length > 0 && tool.examples.every((e) => e.subject === 'tool:Write'));
    assert.equal(tool.note, undefined);
  }));

test('a tool with no enabled step runs without a model call; the history keeps the last 50 per tool', () =>
  only(async () => {
    const before = calls.length;
    assert.deepEqual(await steps.checkTool('dev1', 'Grep', { q: 'P=0.99' }), { allow: true });
    assert.equal(calls.length, before);
    for (let i = 0; i < 55; i++) await steps.checkTool('dev1', 'Edit', { n: i, body: `P=0.1 ${i}`, self: 'dev1' });
    assert.equal(calls.length, before);
    assert.equal(db.open().prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE tool = ?').get('Edit').n, 50);
    assert.equal(JSON.parse(db.open().prepare('SELECT args FROM tool_calls WHERE tool = ? ORDER BY id DESC LIMIT 1').get('Edit').args).n, 54);
  }));

test('a tool step previews the last recorded calls of its tool, and says so when there are none', () =>
  only(async () => {
    const s = steps.create({ name: 'edit preview', question: 'Is it short?', trigger: { kind: 'tool', tool: 'Edit' }, enabled: false });
    const r = await steps.preview(s.id, 3);
    assert.equal(r.examples.length, 3);
    assert.ok(r.examples.every((e) => e.subject === 'tool:Edit'));
    assert.equal(r.note, undefined);
    assert.match(r.examples[0].summary, /^dev1: n: 54 · body: P=0\.1 54$/);
    assert.equal(steps.log(s.id).length, 0);
    const none = await steps.preview(steps.create({ name: 'never', question: 'q', trigger: { kind: 'tool', tool: 'NeverCalled' }, enabled: false }).id, 3);
    assert.deepEqual(none.examples, []);
    assert.match(none.note, /no recorded calls of NeverCalled/);
  }));

test('a malformed probability fails open, against deny-if-yes and approve-if-yes', () =>
  only(async () => {
    const { noul } = await import('../src/decide.ts');
    for (const v of [2, -1, NaN, '0.5']) assert.equal(noul({ model: 'm', answers: { a: { noul: v } }, usage: {} }, 'a'), null, `noul(${v})`);
    assert.equal(noul({ model: 'm', answers: { a: { noul: 0.5 } }, usage: {} }, 'a'), 0.5);
    const deny = steps.create({ name: 'bad deny', question: 'q', trigger: { kind: 'tool', tool: 'Bad' }, action: 'deny-if-yes' });
    const approve = steps.create({ name: 'bad approve', question: 'q', trigger: { kind: 'tool', tool: 'Bad' }, action: 'approve-if-yes' });
    assert.deepEqual(await steps.checkTool('dev1', 'Bad', { body: 'BAD=2' }), { allow: true });
    assert.deepEqual(await steps.checkTool('dev1', 'Bad', { body: 'BAD=-1' }), { allow: true });
    assert.deepEqual(steps.log(deny.id).map((d) => [d.action, d.p]), [['failed-open', null], ['failed-open', null]]);
    assert.deepEqual(steps.log(approve.id).map((d) => d.action), ['failed-open', 'failed-open']);
  }));

test('stored arguments stay valid JSON within 4 KB and keep their shape', () => {
  const ascii = steps.storedArgs({ to: ['a'], body: 'x'.repeat(50_000) });
  assert.ok(Buffer.byteLength(ascii) <= 4096);
  const a = JSON.parse(ascii);
  assert.deepEqual(Object.keys(a), ['to', 'body']);
  assert.deepEqual(a.to, ['a']);
  assert.match(a.body, /…\[truncated\]$/);
  const multi = steps.storedArgs({ body: '界'.repeat(20_000), n: 3 });
  assert.ok(Buffer.byteLength(multi) <= 4096);
  const m = JSON.parse(multi);
  assert.equal(m.n, 3);
  assert.ok(m.body.startsWith('界界'));
  assert.match(m.body, /…\[truncated\]$/);
  const many = steps.storedArgs(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, 'v'.repeat(10)])));
  assert.ok(Buffer.byteLength(many) <= 4096);
  assert.ok(JSON.parse(many)._truncated.startsWith('{"k0"'));
  assert.equal(steps.storedArgs({ small: 'ok' }), '{"small":"ok"}');
});

test('a tool check has an overall budget: steps not reached in time fail open with "budget"', () =>
  only(async () => {
    // Three steps, created in order: the first answers in 4 s, the second times out at the
    // 3 s left, the third is past the 7 s budget and is never asked.
    const mk = (name, action) => steps.create({ name, question: 'q', trigger: { kind: 'tool', tool: 'Slow' }, action });
    const a = mk('first', 'approve-if-yes');
    await new Promise((r) => setTimeout(r, 5));
    const b = mk('second', 'approve-if-yes');
    await new Promise((r) => setTimeout(r, 5));
    const c = mk('third', 'deny-if-yes');
    const t0 = Date.now();
    const r = await steps.checkTool('dev1', 'Slow', { body: 'P=0.9 DELAY=4000' });
    const took = Date.now() - t0;
    assert.deepEqual(r, { allow: true });
    assert.ok(took < 7_600, `took ${took} ms`);
    assert.deepEqual(steps.log(a.id).map((d) => d.action), ['allowed']);
    assert.equal(steps.log(b.id)[0].action, 'failed-open');
    assert.equal(steps.log(c.id)[0].action, 'failed-open');
    assert.equal(steps.log(c.id)[0].error, 'budget');
    assert.equal(steps.log(c.id)[0].answer, null);
  }));

