#!/usr/bin/env node
// Unit tests for the requirements check engine (src/req-check.ts, S-503) against a throwaway
// STAM_HOME and a stubbed decisions endpoint (STAM_OPENROUTER_URL): no daemon, no network, no
// real model. Check that nothing runs while requirements are off, the scope filter, one call for
// N requirements, the cache (no second call), the verdict bands (violates, unsure, na,
// conforms), the actor notice by mode, the daily cap, splitting a large subject, and failing
// open. Run with `node --test test/req-check.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-reqcheck-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `reqcheck-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { model: 'test/decision-model' } }));

// The stub answers each question by a REQ:<name>=<verdict> marker in the state (conforms without
// one) and records every request.
const PROBS = {
  conforms: { conforms: 0.9, violates: 0.05, na: 0.05 },
  violates: { conforms: 0.05, violates: 0.9, na: 0.05 },
  unsure: { conforms: 0.35, violates: 0.6, na: 0.05 },
  na: { conforms: 0.05, violates: 0.05, na: 0.9 },
};
const requests = [];
let failNext = false;
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (failNext) {
      failNext = false;
      return res.writeHead(500).end('{}');
    }
    const state = JSON.stringify(body.state);
    const answers = {};
    for (const name of Object.keys(body.questions)) {
      const v = state.match(new RegExp(`REQ:${name}=(\\w+)`))?.[1] ?? 'conforms';
      answers[name] = { type: 'choice', choice: v === 'unsure' ? 'violates' : v, probabilities: PROBS[v], confidence: 0.9 };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/decision-model-1', answers, usage: { input_tokens: 40, output_tokens: 2, cost: 0.01 } }));
  });
});

let db, settings, req, rc, mail;
let rOne, rTwo, rUi;
const agent = (id, name, role) => db.createAgent({ id, name, role, machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const mailSubject = (body, extra = {}) => ({
  kind: 'mail', ref: `mail:${body.slice(0, 8)}${requests.length}`, content: { subject: 'S', body }, actor: { name: 'alice', role: 'dev', parent: null }, actorId: 'a1', ...extra,
});
const results = async (s, o) => Object.fromEntries((await rc.check(s, o)).map((r) => [r.key, r]));
const setReq = (patch) => settings.setSetting('requirements', { ...settings.settings().requirements, ...patch });

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}`;
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  req = await import('../src/requirements.ts');
  rc = await import('../src/req-check.ts');
  mail = await import('../src/mail.ts');
  db.open();
  agent('a1', 'alice', 'dev');
});
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

test('off by default: no table read, no call', async () => {
  assert.equal(settings.settings().requirements.enabled, false);
  assert.deepEqual(await rc.check(mailSubject('REQ:R-1=violates')), []);
  assert.equal(requests.length, 0);
  const t = db.open().prepare("SELECT name FROM sqlite_master WHERE name = 'requirements'").get();
  assert.equal(t, undefined, 'no requirements table while off');
});

test('the scope filter is plain code over subject kind, paths, repo, actor, ITSA subtree, tool, source', () => {
  const r = (scope) => ({ scope });
  const s = { kind: 'mail-to-human', actor: { name: 'alice', role: 'dev', parent: null }, paths: ['src/a/b.ts', 'README.md'], repo: 'stam2', itsa: ['S-5', 'S-1'], tool: 'Bash', source: 'github' };
  const yes = (scope) => assert.equal(rc.inScope(r(scope), s), true, JSON.stringify(scope));
  const no = (scope) => assert.equal(rc.inScope(r(scope), s), false, JSON.stringify(scope));
  assert.equal(rc.inScope({ scope: null }, s), true, 'no scope applies to everything');
  yes({});
  yes({ subjects: ['mail-to-human'] });
  yes({ subjects: ['mail'] });
  no({ subjects: ['itsa'] });
  no({ subjects: ['mail-to-human'], paths: ['test/**'] });
  yes({ paths: ['src/**/*.ts'] });
  yes({ paths: ['**/*.md'] });
  no({ paths: ['src/*.ts'] });
  yes({ repos: ['stam2'] });
  no({ repos: ['other'] });
  yes({ roles: ['dev', 'manager'] });
  no({ roles: ['reviewer'] });
  yes({ agents: ['alice'] });
  no({ agents: ['bob'] });
  yes({ itsa: ['S-1'] });
  no({ itsa: ['S-9'] });
  yes({ tools: ['Bash'] });
  no({ tools: ['Edit'] });
  yes({ sources: ['github'] });
  no({ sources: ['slack'] });
  // A scope field the subject has no fact for doesn't match.
  assert.equal(rc.inScope(r({ paths: ['**'] }), { ...s, paths: undefined }), false);
  assert.equal(rc.inScope(r({ repos: ['stam2'] }), { ...s, repo: undefined }), false);
  assert.equal(rc.inScope(r({ subjects: ['mail'] }), { ...s, kind: 'itsa' }), false);
});

test('verdict bands: violates at the threshold, unsure from 0.5, na when it leads, else conforms', () => {
  assert.equal(rc.verdictOf({ conforms: 0.05, violates: 0.9, na: 0.05 }, 0.8), 'violates');
  assert.equal(rc.verdictOf({ conforms: 0.35, violates: 0.6, na: 0.05 }, 0.8), 'unsure');
  assert.equal(rc.verdictOf({ conforms: 0.35, violates: 0.6, na: 0.05 }, 0.5), 'violates');
  assert.equal(rc.verdictOf({ conforms: 0.05, violates: 0.05, na: 0.9 }, 0.8), 'na');
  assert.equal(rc.verdictOf({ conforms: 0.9, violates: 0.05, na: 0.05 }, 0.8), 'conforms');
  assert.equal(rc.verdictOf({ conforms: 0.5, violates: 0.49, na: 0.01 }, 0.8), 'conforms');
});

test('one decide call asks every requirement in scope, with one choice question each', async () => {
  setReq({ enabled: true, dailyCapUsd: 100 });
  const mk = (title, text, extra = {}) => req.create({ title, text, status: 'in_force', verification: ['decision'], by: 'human', ...extra });
  rOne = await mk('One', 'Mail shall be short.', { mode: 'observe' });
  rTwo = await mk('Two', 'Mail shall state the outcome first.', { mode: 'inform', scope: { subjects: ['mail'] } });
  rUi = await mk('UI', 'UI shall use tokens.', { scope: { paths: ['web/**'] } });
  await mk('Drafted', 'Not in force.', { status: 'draft' });
  await mk('Other method', 'Test only.', { verification: ['test'] });
  const before = requests.length;
  const out = await results(mailSubject('plain body'));
  assert.equal(requests.length, before + 1, 'one call');
  const q = requests.at(-1).questions;
  assert.deepEqual(Object.keys(q).sort(), [rOne.key, rTwo.key], 'only in-force decision requirements in scope');
  assert.equal(q[rOne.key].type, 'choice');
  assert.equal(q[rOne.key].instructions, 'Requirement: Mail shall be short.');
  assert.deepEqual(Object.keys(q[rOne.key].criteria), ['conforms', 'violates', 'na']);
  assert.equal(out[rOne.key].verdict, 'conforms');
  assert.equal(out[rTwo.key].cached, false);
  const spend = db.open().prepare("SELECT json_extract(data,'$.purpose') AS p FROM events WHERE type = 'decide' ORDER BY id DESC").get();
  assert.equal(spend.p, 'decide:req:mail');
});

test('a cache hit makes no second call; a new requirement version asks again', async () => {
  const s = mailSubject('cache me');
  await rc.check(s);
  const n = requests.length;
  const again = await results(s);
  assert.equal(requests.length, n, 'no call for the same version, subject, and model');
  assert.equal(again[rOne.key].cached, true);
  assert.equal(again[rTwo.key].cached, true);
  await req.set(rOne.key, { text: 'Mail shall be very short.' }, 'human');
  const after = await results(s);
  assert.equal(requests.length, n + 1, 'only the changed requirement version missed the cache');
  assert.deepEqual(Object.keys(requests.at(-1).questions), [rOne.key]);
  assert.equal(after[rOne.key].cached, false);
  assert.equal(after[rTwo.key].cached, true);
});

test('the unsure band and the other bands come from the stored probabilities', async () => {
  const out = await results(mailSubject(`bands REQ:${rOne.key}=unsure REQ:${rTwo.key}=na`));
  assert.equal(out[rOne.key].verdict, 'unsure');
  assert.equal(out[rOne.key].action, 'recorded', 'observe only records');
  assert.equal(out[rTwo.key].verdict, 'na');
  const v = await results(mailSubject(`bands2 REQ:${rOne.key}=violates`));
  assert.equal(v[rOne.key].verdict, 'violates');
  const row = db.open().prepare('SELECT * FROM req_verdicts WHERE req_id = ? ORDER BY id DESC').get(rOne.id);
  assert.equal(row.verdict, 'violates');
  assert.equal(row.p_violates, 0.9);
  assert.ok(row.cost > 0);
});

test('inform tells the actor as an indication; observe tells nobody', async () => {
  const before = mail.queuedNoticeCount('a1');
  await rc.check(mailSubject(`obs REQ:${rOne.key}=violates`));
  assert.equal(mail.queuedNoticeCount('a1'), before, 'observe: no notice');
  await rc.check(mailSubject(`inf REQ:${rTwo.key}=violates`));
  assert.equal(mail.queuedNoticeCount('a1'), before + 1, 'inform: one notice');
  const ev = db.open().prepare("SELECT data FROM events WHERE type = 'notice:queued' ORDER BY id DESC").get();
  assert.match(JSON.parse(ev.data).text, /A model check of your mail:/);
  // A silent (manual) check and a repeat from the cache tell nobody.
  const s = mailSubject(`inf2 REQ:${rTwo.key}=violates`);
  await rc.check({ ...s, silent: true });
  await rc.check(s);
  assert.equal(mail.queuedNoticeCount('a1'), before + 1);
});

test('a large subject is split into parts, and a long list of requirements into calls', async () => {
  const big = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(200)}`).join('\n');
  const before = requests.length;
  const out = await results(mailSubject(big), { limits: { questionTokens: 1000, callTokens: 4000 } });
  const calls = requests.slice(before);
  assert.ok(calls.length > 1, `split into several calls (${calls.length})`);
  for (const c of calls) {
    assert.match(JSON.stringify(c.state), /"part":"\d+\/\d+"/);
    assert.ok(JSON.stringify(c.state).length / 4 <= 1000, 'each part fits the question limit');
  }
  assert.ok(out[rOne.key] && out[rTwo.key], 'a verdict per requirement after merging the parts');
  // Many requirements split by the call limit.
  for (let i = 0; i < 6; i++) await req.create({ title: `Bulk ${i}`, text: `Bulk requirement ${i} ${'y'.repeat(600)}`, status: 'in_force', verification: ['decision'], by: 'human' });
  const b = requests.length;
  await rc.check(mailSubject('small body'), { limits: { questionTokens: 32768, callTokens: 700 } });
  assert.ok(requests.length - b > 1, 'questions split across calls');
  for (const c of requests.slice(b)) assert.ok(Object.keys(c.questions).length >= 1);
});

test('the daily cap stops new calls, records nothing, and sends one notice a day', async () => {
  const spent = rc.spentToday();
  assert.ok(spent > 0, 'earlier checks recorded spend');
  setReq({ dailyCapUsd: spent });
  const n = requests.length;
  const verdicts = db.open().prepare('SELECT COUNT(*) AS n FROM req_verdicts').get().n;
  const s = mailSubject('fresh over cap');
  assert.deepEqual(await rc.check(s), []);
  assert.deepEqual(await rc.check(mailSubject('fresh over cap again')), []);
  assert.equal(requests.length, n, 'no call over the cap');
  assert.equal(db.open().prepare('SELECT COUNT(*) AS n FROM req_verdicts').get().n, verdicts, 'nothing recorded');
  assert.equal(db.open().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'req:cap'").get().n, 1, 'one cap notice a day');
  // Cached verdicts still answer over the cap.
  const cached = await results(mailSubject('cache me'));
  assert.equal(cached[rTwo.key]?.cached, true);
  setReq({ dailyCapUsd: 100 });
});

test('a failing model fails open: no throw, no verdict, no notice', async () => {
  failNext = true;
  const before = mail.queuedNoticeCount('a1');
  const out = await rc.check(mailSubject(`fail REQ:${rTwo.key}=violates`));
  assert.deepEqual(out, []);
  assert.equal(mail.queuedNoticeCount('a1'), before);
  const bad = await rc.check({ ...mailSubject('x'), content: { toString() { throw new Error('boom'); }, big: 1n } });
  assert.deepEqual(bad, []);
  assert.ok(db.open().prepare("SELECT 1 FROM events WHERE type = 'req:error'").get(), 'logged as req:error');
});

test('review probe: serialized question limit', async () => {
  setReq({ dailyCapUsd: 100 });
  const start = requests.length;
  await rc.check(mailSubject('"'.repeat(160000)), { keys: [rOne.key] });
  const sizes = requests.slice(start).map(c => Math.ceil((JSON.stringify(c.state).length + JSON.stringify(c.questions[rOne.key]).length)/4));
  console.log('REVIEW serialized per-question tokens', sizes);
  assert.ok(sizes.every(n => n <= 32768));
});
test('review probe: concurrent cap', async () => {
  const spent = rc.spentToday();
  setReq({ dailyCapUsd: spent + 0.005 });
  const start = requests.length;
  await Promise.all(Array.from({length: 10}, (_,i) => rc.check(mailSubject(`concurrent-${i}`), {keys:[rOne.key]})));
  console.log('REVIEW calls with only $0.005 remaining', requests.length-start, 'extra spend', rc.spentToday()-spent);
  assert.ok(requests.length-start <= 1);
});
test('review probe: incomplete split cached', async () => {
  setReq({dailyCapUsd:rc.spentToday()+0.005});
  const s = mailSubject('a'.repeat(8000) + ` REQ:${rOne.key}=violates`);
  const out = await results(s, {keys:[rOne.key],limits:{questionTokens:1000,callTokens:4000}});
  setReq({dailyCapUsd:100});
  const start = requests.length;
  const again = await results(s, {keys:[rOne.key],limits:{questionTokens:1000,callTokens:4000}});
  console.log('REVIEW partial verdict',out[rOne.key], 'after raising cap',again[rOne.key], 'new calls',requests.length-start);
  assert.equal(again[rOne.key].verdict,'violates');
});
