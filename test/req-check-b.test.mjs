#!/usr/bin/env node
// Unit tests for the requirements check engine's second part (S-503): a branch diff split by
// file with the conformity line and hold in the merge queue's data, tool calls denied by an
// `enforce` requirement (and failing open), external events, on-demand checks, and the cap
// notice going to the chief of staff. Throwaway STAM_HOME, a stubbed decisions endpoint, a
// throwaway git repo, no daemon, no real model. Run with `node --test test/req-check-b.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-reqcheckb-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_TMUX_SOCKET = `reqcheckb-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');

const PROBS = {
  conforms: { conforms: 0.9, violates: 0.05, na: 0.05 },
  violates: { conforms: 0.05, violates: 0.9, na: 0.05 },
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
      answers[name] = { type: 'choice', choice: v, probabilities: PROBS[v], confidence: 0.9 };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test/decision-model-1', answers, usage: { input_tokens: 40, output_tokens: 2, cost: 0.001 } }));
  });
});

let db, settings, req, rc, mail, queue;
const repo = join(home, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const setReq = (patch) => settings.setSetting('requirements', { ...settings.settings().requirements, ...patch });
const mk = (title, text, extra = {}) => req.create({ title, text, status: 'in_force', verification: ['decision'], by: 'human', ...extra });
const waitFor = async (fn) => {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('timed out waiting for state');
};

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(join(repo, 'web'), { recursive: true });
  mkdirSync(join(repo, 'src'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'web/a.css'), 'a { color: #fff; } /* webfile */\n');
  writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1; // srcfile REQ:SRCKEY=violates\n');
  git('add', '-A');
  git('commit', '-qm', 'feature');
  git('checkout', '-q', 'main');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { model: 'test/decision-model' }, itsa: { repos: { r: repo } } }));
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  req = await import('../src/requirements.ts');
  rc = await import('../src/req-check.ts');
  mail = await import('../src/mail.ts');
  queue = await import('../src/itsa-queue.ts');
  db.open();
  db.createAgent({ id: 'a1', name: 'alice', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  setReq({ enabled: true, dailyCapUsd: 100 });
});
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

test('a branch diff is split by file: each requirement reads only the files its globs match', async () => {
  const web = await mk('Web', 'UI shall use tokens.', { scope: { paths: ['web/**'] }, mode: 'enforce', severity: 'major' });
  const src = await mk('Src', 'Source shall be tested.', { scope: { paths: ['src/**'] }, mode: 'enforce', severity: 'major' });
  const before = requests.length;
  const out = await rc.manual({ subject: 'branch:r/feature' });
  assert.equal(out.results.length, 2);
  const calls = requests.slice(before);
  assert.equal(calls.length, 2, 'one call per distinct file set');
  const stateOf = (key) => JSON.stringify(calls.find((c) => key in c.questions).state);
  assert.ok(stateOf(web.key).includes('webfile') && !stateOf(web.key).includes('srcfile'), 'the web requirement sees only the web file');
  assert.ok(stateOf(src.key).includes('srcfile') && !stateOf(src.key).includes('webfile'), 'the src requirement sees only the src file');
  // Once per head commit: the same head makes no new call.
  const n = requests.length;
  const again = await rc.manual({ subject: 'branch:r/feature' });
  assert.equal(requests.length, n);
  assert.ok(again.results.every((r) => r.cached));
  globalThis.keys = { web: web.key, src: src.key };
});

test('the merge queue data carries a conformity line, and a hold for enforce at major or above', async () => {
  const head = git('rev-parse', 'feature').trim();
  // Nothing marks a violation yet: the src requirement conforms.
  let c = queue.conformity('r', 'feature', head);
  assert.equal(c.checked, true);
  assert.deepEqual(c.lines.map((l) => [l.key, l.verdict]), [[globalThis.keys.web, 'conforms'], [globalThis.keys.src, 'conforms']]);
  assert.equal(c.hold, false);
  // A requirement whose question the stub answers `violates` (the file carries REQ:<key>=violates).
  const bad = await mk('Marked', 'Marked shall hold.', { scope: { paths: ['src/**'] }, mode: 'enforce', severity: 'major' });
  git('checkout', '-q', 'feature');
  writeFileSync(join(repo, 'src/b.ts'), `export const b = 1; // REQ:${bad.key}=violates\n`);
  git('commit', '-qam', 'mark');
  git('checkout', '-q', 'main');
  await rc.manual({ subject: 'branch:r/feature' });
  const head2 = git('rev-parse', 'feature').trim();
  c = queue.conformity('r', 'feature', head2);
  assert.equal(c.lines.find((l) => l.key === bad.key).verdict, 'violates');
  assert.equal(c.hold, true, 'enforce + major + violates holds');
  // Minor severity or observe mode never holds.
  await req.set(bad.key, { severity: 'minor' }, 'human');
  assert.equal(queue.conformity('r', 'feature', head2).hold, false);
  await req.set(bad.key, { severity: 'critical', mode: 'inform' }, 'human');
  assert.equal(queue.conformity('r', 'feature', head2).hold, false);
  // An unchecked head has no line.
  assert.equal(queue.conformity('r', 'feature', 'deadbeef').checked, false);
});

test('a tool call is denied by an enforce requirement scoped to the tool, naming it', async () => {
  const r = await mk('No kill', 'Never run pkill -f.', { scope: { tools: ['Bash'] }, mode: 'enforce' });
  const inform = await mk('Informing', 'Bash shall be polite.', { scope: { tools: ['Bash'] }, mode: 'inform' });
  const other = await mk('Other tool', 'Edit shall be careful.', { scope: { tools: ['Edit'] }, mode: 'enforce' });
  const before = requests.length;
  const ok = await rc.checkTool('a1', 'Bash', { command: 'ls' }, 5000);
  assert.equal(ok.allow, true);
  assert.deepEqual(Object.keys(requests.at(-1).questions), [r.key], 'only the enforce requirement for this tool is asked');
  assert.equal(requests.length, before + 1);
  const denied = await rc.checkTool('a1', 'Bash', { command: `pkill -f x REQ:${r.key}=violates` }, 5000);
  assert.equal(denied.allow, false);
  assert.equal(denied.requirement, r.key);
  assert.match(denied.error, new RegExp(`Denied by requirement ${r.key} \\(likely not met, p 0\\.90\\): Never run pkill -f\\.`));
  assert.match(denied.error, /indication from a model check, not proof/);
  assert.match(denied.error, /say so to the requirement's owner/);
  // A tool no enforce requirement names isn't asked at all.
  const n = requests.length;
  assert.equal((await rc.checkTool('a1', 'Read', { path: 'x' }, 5000)).allow, true);
  assert.equal(requests.length, n);
  void inform; void other;
});

test('a tool check fails open: a model error, no time, or requirements off allow the call', async () => {
  failNext = true;
  assert.equal((await rc.checkTool('a1', 'Bash', { command: 'fresh REQ:R-1=violates' }, 5000)).allow, true, 'model error');
  const n = requests.length;
  assert.equal((await rc.checkTool('a1', 'Bash', { command: 'no time' }, 0)).allow, true, 'no time left');
  assert.equal(requests.length, n);
  setReq({ enabled: false });
  assert.equal((await rc.checkTool('a1', 'Bash', { command: 'off' }, 5000)).allow, true, 'off');
  assert.equal(requests.length, n);
  setReq({ enabled: true });
});

test('an external event is checked after it is stored', async () => {
  const r = await mk('Events', 'A PR shall have a body in the house format.', { scope: { sources: ['github'] } });
  const before = requests.length;
  rc.checkEvent({ id: 7, source: 'github', type: 'pull_request.opened', subjects: ['github:o/r#1'], actor: 'someone', url: null, summary: 'PR opened', payload: { body: 'x' }, dedupe_key: 'k', created_at: new Date().toISOString() });
  await waitFor(() => requests.length > before);
  const q = requests.at(-1).questions;
  assert.deepEqual(Object.keys(q), [r.key]);
  await waitFor(() => req.verdicts(r.key, 1).length === 1);
  assert.equal(req.verdicts(r.key, 1)[0].subject, 'event:7');
  // A source no requirement names is not asked.
  const n = requests.length;
  await rc.checkEvent({ id: 8, source: 'slack', type: 'message', subjects: [], actor: null, url: null, summary: 's', payload: null, dedupe_key: 'k2', created_at: new Date().toISOString() });
  assert.equal(requests.length, n);
});

test('a manual check takes text or a subject, limits to keys, and rejects bad input', async () => {
  const plain = await mk('Plain', 'Everything shall be plain.');
  const other = await mk('Plain two', 'Everything shall be simple.');
  const out = await rc.manual({ text: `pasted REQ:${plain.key}=violates`, keys: plain.key });
  assert.ok(out.subject.startsWith('text:'));
  assert.deepEqual(out.results.map((r) => [r.key, r.verdict]), [[plain.key, 'violates']], 'only the named requirement, path-scoped ones are out of scope');
  const all = await rc.manual({ text: 'pasted words' });
  assert.deepEqual(all.results.map((r) => r.key).sort(), [plain.key, other.key].sort());
  const notified = mail.queuedNoticeCount('a1');
  await req.set(plain.key, { mode: 'inform' }, 'human');
  await rc.manual({ text: `tell nobody REQ:${plain.key}=violates` });
  assert.equal(mail.queuedNoticeCount('a1'), notified, 'a manual check tells nobody');
  await assert.rejects(() => rc.manual({}), /give a text, or a subject/);
  await assert.rejects(() => rc.manual({ subject: 'mail:nope' }), /no mail nope/);
  await assert.rejects(() => rc.manual({ subject: 'branch:r/missing' }), /can't read the diff/);
  setReq({ enabled: false });
  await assert.rejects(() => rc.manual({ text: 'x' }), /requirements are off/);
  setReq({ enabled: true });
});

test('the cap notice goes to the chief of staff when there is one, else to the human', async () => {
  db.createAgent({ id: 'cos1', name: 'boss', role: 'chief', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  settings.setSetting('chiefOfStaff', 'boss');
  setReq({ dailyCapUsd: rc.spentToday() });
  const mailed = () => db.open().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'mail:received' AND agent_id = 'cos1'").get().n;
  const before = mailed();
  assert.deepEqual(await rc.check({ kind: 'mail', ref: 'mail:capb', content: { body: 'cap one' }, actor: { name: 'alice', role: 'dev', parent: null } }), []);
  await waitFor(() => mailed() > before);
  assert.equal(mailed(), before + 1, 'the chief of staff got the notice');
  await rc.check({ kind: 'mail', ref: 'mail:capb2', content: { body: 'cap two' }, actor: { name: 'alice', role: 'dev', parent: null } });
  assert.equal(mailed(), before + 1, 'once a day');
  setReq({ dailyCapUsd: 100 });
});

test('review: no requirement table read for unmatched tool', async () => {
  const d = db.open();
  const original = d.prepare;
  const reads = [];
  d.prepare = function(sql) { if (/\bFROM requirements\b/i.test(sql)) reads.push(sql); return original.call(this,sql); };
  try { assert.equal((await rc.checkTool('a1','UnconfiguredTool',{},5000)).allow,true); }
  finally { d.prepare = original; }
  console.log('REVIEW unmatched tool requirements reads',reads);
  assert.equal(reads.length,0);
});
test('review: suspended requirement cannot hold queue', async () => {
  const r = await mk('Suspended probe','Must comply.',{scope:{paths:['src/**']},mode:'enforce',severity:'major'});
  git('checkout','-q','feature');
  writeFileSync(join(repo,'src/b.ts'),`export const b = 1; // REQ:${r.key}=violates\n`);
  git('commit','-qam','suspend-probe'); git('checkout','-q','main');
  await rc.manual({subject:'branch:r/feature'});
  const head = git('rev-parse','feature').trim();
  assert.equal(queue.conformity('r','feature',head).hold,true);
  await req.set(r.key,{status:'suspended'},'human');
  console.log('REVIEW suspended queue',queue.conformity('r','feature',head));
  assert.equal(queue.conformity('r','feature',head).hold,false);
});

test('cold start: the first unmatched tool call does no table read, then the index is built', async () => {
  req.dropEnforcedTools();
  const d = db.open();
  const original = d.prepare;
  const reads = [];
  d.prepare = function (sql) { if (/\bFROM requirements\b/i.test(sql)) reads.push(sql); return original.call(this, sql); };
  try { assert.equal((await rc.checkTool('a1', 'UnconfiguredTool', {}, 5000)).allow, true); }
  finally { d.prepare = original; }
  assert.equal(reads.length, 0, 'no table read on the tool path');
  await waitFor(() => req.enforcedToolsReady());
  assert.ok(req.enforcedTools().has('Bash'), 'built right after');
  // Dropped again, daemon start warms it.
  req.dropEnforcedTools();
  rc.warm();
  assert.equal(req.enforcedToolsReady(), true);
});
