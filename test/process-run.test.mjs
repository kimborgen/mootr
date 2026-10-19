#!/usr/bin/env node
// Unit tests for the process runner's dry-run frame (S-946): entryActions on dev-change.yaml, and
// the stage listener with fake and real ITSA changes. Throwaway STAM_HOME, no daemon, no network.
// Run with `node --test test/process-run.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-process-run-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let run, itsa, proc, p;
before(async () => {
  run = await import('../src/process-run.ts');
  proc = await import('../src/process.ts');
  itsa = await import('../src/itsa.ts');
  const agentTypes = await import('../src/agent-types.ts');
  (await import('../src/db.ts')).open();
  const { processes } = proc.loadProcesses(join(import.meta.dirname, '..', 'processes'), { knownTypes: new Set(Object.keys(agentTypes.agentTypes())) });
  // The runner is under test, not this repo's deployment: the developer lane's machine, the github start subject and the
  // merge script are pinned here, since the exported dev-change.yaml names none of them (S-1966).
  p = structuredClone(processes.find((q) => q.id === 'dev-change'));
  p.lanes.developer.machine = 'host1';
  p.nodes.merge.run = 'scripts/merge-pr.mjs';
  p.nodes.request.triggers = p.nodes.request.triggers.map((t) => (t.source === 'github' ? { source: 'github', subjects: ['github:example/repo'], types: ['issues.opened'] } : t));
});
after(() => rmSync(home, { recursive: true, force: true }));

const REPO = 'example/repo';
const pr = (n, repo = REPO) => ({ links: [{ system: 'branch', url: '' }, { system: 'github', url: `https://github.com/${repo}/pull/${n}` }] });

test('entryActions: script node runs its script with the PR number', () => {
  assert.deepEqual(run.entryActions(p, 'merge', pr(291), REPO), [{ do: 'run', script: 'scripts/merge-pr.mjs', args: ['291'] }]);
  assert.deepEqual(run.entryActions(p, 'merge', { links: [] }, REPO), [{ do: 'run', script: 'scripts/merge-pr.mjs', args: [] }]);
});

test('prNumber: reads the pull url, only of the configured repo, and skips links without one', () => {
  assert.equal(run.prNumber(pr(7, 'other/repo'), REPO), null);
  assert.equal(run.prNumber({ links: [{ system: 'github', url: null }, { system: 'github', url: 'https://github.com/example/repo/issues/5' }] }, REPO), null);
  assert.equal(run.prNumber({ links: [...pr(3).links, ...pr(9, 'other/repo').links, ...pr(4).links] }, REPO), '4');
});

test('entryActions: human node opens the ask, end node closes', () => {
  assert.deepEqual(run.entryActions(p, 'ask', pr(1), REPO), [{ do: 'ask', ask: 'answer', status: 'needs_input' }]);
  assert.deepEqual(run.entryActions(p, 'hold', pr(1), REPO), [{ do: 'ask', ask: 'decide', status: 'needs_input' }]);
  assert.deepEqual(run.entryActions(p, 'done', pr(1), REPO), [{ do: 'close', status: 'done' }]);
});

test('entryActions: other nodes and unknown ids return nothing', () => {
  for (const id of ['request', 'route', 'code', 'review', 'verdict', 'deploy', 'nope']) assert.deepEqual(run.entryActions(p, id, pr(1), REPO), [], id);
});

function harness(mode = 'dry-run') {
  const posts = [];
  const logs = [];
  const fn = run.stageEntryListener({
    mode: () => mode,
    processesOf: () => [p],
    linksOf: () => pr(291).links,
    repo: () => REPO,
    record: (id, body) => void posts.push([id, body]),
    log: (l) => logs.push(l),
  });
  return { fn, posts, logs };
}
const ev = (to, id = 'i1') => ({ itsa: { id, kind: 'issue' }, from: null, to });

test('listener: one comment and log per entry, repeats ignored, re-entry after leaving counts', () => {
  const h = harness();
  h.fn(ev('merge'));
  h.fn(ev('merge'));
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0][1], /process dev-change: entering `merge` \(by unknown\) would run `scripts\/merge-pr\.mjs 291`/);
  assert.equal(h.logs.length, 1);
  h.fn(ev('code'));
  h.fn(ev('merge'));
  assert.equal(h.posts.length, 2);
});

test('listener: off posts nothing, on behaves as dry-run, other kinds and clears are quiet', () => {
  const off = harness('off');
  off.fn(ev('merge'));
  assert.equal(off.posts.length, 0);
  const on = harness('on');
  on.fn(ev('done'));
  on.fn(ev('verdict'));
  on.fn(ev(null));
  assert.equal(on.posts.length, 1);
});

test('listener: a failing lookup or record never throws', () => {
  const base = { mode: () => 'dry-run', repo: () => REPO, linksOf: () => [], log: () => {} };
  const bad = run.stageEntryListener({ ...base, processesOf: () => { throw new Error('boom'); }, record: () => {} });
  assert.doesNotThrow(() => bad(ev('merge')));
  const rej = run.stageEntryListener({ ...base, processesOf: () => [p], record: () => { throw new Error('no'); } });
  assert.doesNotThrow(() => rej(ev('merge')));
});

test('itsa.set on stage emits a fields change the listener turns into one comment', async () => {
  const options = ['route', 'plan', 'code', 'review', 'merge', 'deploy', 'hold', 'ask', 'done'].map((value) => ({ value }));
  await itsa.createField({ key: 'stage', label: 'Stage', type: 'choice', options }, 'human');
  const x = await itsa.create({ title: 'X', kind: 'issue', by: 'human' });
  const h = harness();
  itsa.onChange((c) => {
    if (c.type === 'fields' && 'stage' in c.to) h.fn({ itsa: { id: c.itsa.id, kind: c.itsa.kind }, from: c.from.stage, to: c.to.stage });
  });
  const db = (await import('../src/db.ts')).open();
  const mails = () => db.prepare('SELECT COUNT(*) AS n FROM mail').get().n;
  const before = mails();
  await itsa.set(x.id, { fields: { stage: 'merge' }, by: 'human' });
  await itsa.set(x.id, { fields: { stage: 'merge' }, by: 'human' });
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0][0], x.id);
  // The daemon records the line as an ITSA event, never as mail.
  itsa.addEvent(x.id, null, 'process-run', { text: h.posts[0][1] });
  assert.equal(mails(), before);
});

test('an ITSA created with stage already set emits a fields change', async () => {
  const seen = [];
  itsa.onChange((c) => c.type === 'fields' && seen.push(c.to.stage));
  await itsa.create({ title: 'Y', kind: 'issue', by: 'human', fields: { stage: 'code' } });
  assert.deepEqual(seen, ['code']);
});

// ---- start events (S-947) ----

test('startTriggers: only real stored-event triggers, none for examples, timers or manual', () => {
  const w = run.startTriggers([p]);
  assert.deepEqual(w, [{ subscriber_id: 'process:dev-change:request', filter: { source: 'github', subjects: ['github:example/repo'], types: ['issues.opened'] }, note: 'dev-change start: github' }]);
});

const evt = (id) => ({ id, source: 'github', type: 'issues.opened', actor: 'kim', url: 'https://github.com/example/repo/issues/5', summary: 'Issue 5', dedupe_key: `k${id}` });
function startHarness(mode) {
  const made = [];
  const logs = [];
  const fn = run.startListener({ mode: () => mode, processesOf: () => [p], cos: () => 'cos1', create: async (i) => void made.push(i), log: (l) => logs.push(l) });
  return { fn, made, logs };
}

test('startListener: dry-run only logs, on creates one ITSA at route for cos, off does nothing', () => {
  const dry = startHarness('dry-run');
  dry.fn('process:dev-change:request', evt(1));
  assert.equal(dry.made.length, 0);
  assert.match(dry.logs[0], /process-run \(dry-run\) dev-change: event 1/);
  const on = startHarness('on');
  on.fn('process:dev-change:request', evt(2));
  on.fn('process:dev-change:request', evt(2));
  assert.equal(on.made.length, 1);
  assert.deepEqual([on.made[0].kind, on.made[0].status, on.made[0].owner, on.made[0].fields], ['issue', 'todo', 'cos1', { stage: 'route' }]);
  assert.match(on.logs[0], /process-run \(on\)/);
  const off = startHarness('off');
  off.fn('process:dev-change:request', evt(3));
  off.fn('not-a-process', evt(4));
  assert.equal(off.made.length + off.logs.length, 0);
});

test('syncProcessSubscriptions is idempotent, drops what is gone, and ingest hands a match to the runner, not to mail', async () => {
  const watch = await import('../src/watch.ts');
  const db = (await import('../src/db.ts')).open();
  const rows = () => db.prepare("SELECT subscriber_id FROM event_subscriptions WHERE subscriber_kind = 'process'").all();
  const wanted = run.startTriggers([p]);
  watch.syncProcessSubscriptions(wanted);
  watch.syncProcessSubscriptions(wanted);
  assert.equal(rows().length, 1);
  const got = [];
  watch.onProcessStart((id, ev) => got.push([id, ev.id]));
  const mails = () => db.prepare('SELECT COUNT(*) AS n FROM mail').get().n;
  const before = mails();
  const input = { source: 'github', type: 'issues.opened', subject: 'github:example/repo', summary: 'Issue 5', dedupe_key: 'issue-5' };
  assert.equal(watch.ingest(input).matched, 1);
  assert.equal(watch.ingest(input).stored, false);
  await watch.flush();
  assert.deepEqual(got.map((g) => g[0]), ['process:dev-change:request']);
  assert.equal(mails(), before);
  watch.syncProcessSubscriptions([]);
  assert.equal(rows().length, 0);
});

test('a real repo IssuesEvent reaches the start listener through ingest', async () => {
  const gh = await import('../src/sources/github.ts');
  const watch = await import('../src/watch.ts');
  const subj = gh.parseSubject('github:example/repo');
  assert.ok(subj, 'the repo subject is pollable');
  assert.equal(gh.parseSubject('github:example/repo#*'), null);
  const raw = (id, action) => ({ id: String(id), type: 'IssuesEvent', actor: { login: 'kim' }, payload: { action, issue: { number: 9, title: 'Fix it' } } });
  assert.equal(gh.repoEvent(raw(1, 'closed'), subj).type, 'issues.closed');
  const h = startHarness('on');
  watch.syncProcessSubscriptions(run.startTriggers([p]));
  watch.onProcessStart((id, ev) => h.fn(id, ev));
  for (const ev of [gh.repoEvent(raw(2, 'closed'), subj), gh.repoEvent(raw(3, 'opened'), subj), gh.repoEvent(raw(3, 'opened'), subj)]) watch.ingest(ev);
  assert.equal(h.made.length, 1);
  assert.match(h.made[0].title, /issues\.opened: #9 Fix it/);
});

test('syncProcessSubscriptions brings back a row that was removed', async () => {
  const watch = await import('../src/watch.ts');
  const db = (await import('../src/db.ts')).open();
  const wanted = run.startTriggers([p]);
  watch.syncProcessSubscriptions(wanted);
  db.prepare("DELETE FROM event_subscriptions WHERE subscriber_kind = 'process'").run();
  watch.syncProcessSubscriptions(wanted);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_subscriptions WHERE subscriber_kind = 'process'").get().n, 1);
  watch.syncProcessSubscriptions([]);
});

test('a type filter also matches the actions under it, and the process rows are not listed', async () => {
  const watch = await import('../src/watch.ts');
  const ev = (type) => ({ source: 'github', type, subjects: ['github:o/r'], actor: null });
  assert.equal(watch.matchesFilter({ types: ['issues'] }, ev('issues.opened')), true);
  assert.equal(watch.matchesFilter({ types: ['issues'] }, ev('issues')), true);
  assert.equal(watch.matchesFilter({ types: ['issues.opened'] }, ev('issues.closed')), false);
  assert.equal(watch.matchesFilter({ types: ['issue'] }, ev('issues.opened')), false);
  for (const [pat, type] of [['pull_request', 'pull_request.merged'], ['checks', 'checks.completed'], ['issue', 'issue.closed'], ['comment', 'comment.created']]) assert.equal(watch.matchesFilter({ types: [pat] }, ev(type)), false, pat);
  watch.syncProcessSubscriptions(run.startTriggers([p]));
  assert.deepEqual(watch.listSubscriptions('human').filter((s) => s.subscriber_kind === 'process'), []);
  watch.syncProcessSubscriptions([]);
});

// ---- evidence (S-948) ----

test('evalCondition: equality on named facts only', () => {
  const f = { verdict: 'approve' };
  assert.equal(run.evalCondition('verdict == approve', f), true);
  assert.equal(run.evalCondition('verdict == "approve"', f), true);
  assert.equal(run.evalCondition('verdict == changes', f), false);
  assert.equal(run.evalCondition('verdict != changes', f), true);
  for (const bad of ['deploy_unhealthy', 'other == approve', 'verdict', '', undefined, 'verdict == approve && x', 'process.exit(1)']) assert.equal(run.evalCondition(bad, f), false, String(bad));
});

test('winningEdge and verdictTriggers on dev-change', () => {
  assert.equal(run.winningEdge(p, 'verdict', { verdict: 'approve' }), 'merge');
  assert.equal(run.winningEdge(p, 'verdict', { verdict: 'changes' }), 'code');
  assert.equal(run.winningEdge(p, 'verdict', { verdict: 'maybe' }), null);
  assert.deepEqual(run.verdictGateways(p), [{ id: 'verdict', from: ['review'] }]);
  const [w] = run.verdictTriggers([p], 'example/repo');
  assert.equal(w.subscriber_id, 'process:dev-change:verdict');
  assert.deepEqual(w.filter, { source: 'github', subjects: ['github:example/repo#*'], types: ['checks.completed'] });
});

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const checks = (n, head, verdict, id = n) => ({ id, type: 'checks.completed', subjects: [`github:example/repo#${n}`], payload: { head, verdict } });
function verdictHarness(mode, stage = 'review') {
  const events = [], moves = [], logs = [];
  const fn = run.verdictListener({
    mode: () => mode,
    processesOf: () => [p],
    itsasOfPr: (n) => (n === '5' ? [{ id: 'closedish', kind: 'issue', stage: 'done' }, { id: 'i5', kind: 'issue', stage }] : []),
    record: (id, t) => events.push([id, t]),
    moveStage: async (id, s) => void moves.push([id, s]),
    log: (l) => logs.push(l),
  });
  return { fn, events, moves, logs };
}
const SUB = 'process:dev-change:verdict';

test('verdictListener: approve moves review to merge, changes back to code; dry-run only records', () => {
  const on = verdictHarness('on');
  on.fn(SUB, checks(5, HEAD, 'approve'));
  on.fn(SUB, checks(5, HEAD, 'approve'));
  assert.deepEqual(on.moves, [['i5', 'merge']]);
  on.fn(SUB, checks(5, HEAD, 'changes'));
  assert.deepEqual(on.moves.at(-1), ['i5', 'code']);
  const dry = verdictHarness('dry-run');
  dry.fn(SUB, checks(5, HEAD, 'changes'));
  assert.equal(dry.moves.length, 0);
  assert.match(dry.events[0][1], /review verdict changes on aaaaaaa would move stage review -> code/);
  assert.match(dry.logs[0], /process-run \(dry-run\) i5/);
});

test('verdictListener: another stage, no verdict, an unlinked PR and off do nothing; the ITSA at the right stage is chosen', () => {
  const h = verdictHarness('on');
  h.fn(SUB, checks(5, HEAD, null));
  h.fn(SUB, checks(6, HEAD, 'approve'));
  assert.equal(h.moves.length, 0);
  const other = verdictHarness('on', 'code');
  other.fn(SUB, checks(5, HEAD, 'approve'));
  assert.equal(other.moves.length, 0);
  const off = verdictHarness('off');
  off.fn(SUB, checks(5, HEAD, 'approve'));
  assert.equal(off.moves.length + off.events.length, 0);
});

test('reviewVerdict reads the newest stam/review status, and checks.completed carries it', async () => {
  const gh = await import('../src/sources/github.ts');
  const st = (state, at) => ({ context: 'stam/review', state, updated_at: at });
  assert.equal(gh.reviewVerdict([st('failure', '2026-01-01T00:00:00Z'), st('success', '2026-01-02T00:00:00Z')]), 'approve');
  assert.equal(gh.reviewVerdict([st('success', '2026-01-01T00:00:00Z'), st('failure', '2026-01-02T00:00:00Z')]), 'changes');
  assert.equal(gh.reviewVerdict([st('pending', '2026-01-01T00:00:00Z'), { context: 'stam/gates', state: 'success' }]), null);
  assert.equal(gh.reviewVerdict([]), null);
});

test('a checks.completed event reaches the verdict listener through ingest and the real itsa.set moves the stage', async () => {
  const watch = await import('../src/watch.ts');
  const x = await itsa.create({ title: 'V', kind: 'issue', by: 'human', fields: { stage: 'review' } });
  const moves = [];
  const fn = run.verdictListener({
    mode: () => 'on',
    processesOf: () => [p],
    itsasOfPr: () => [{ id: x.id, kind: 'issue', stage: itsa.get(x.id).fields.stage }],
    record: () => {},
    moveStage: async (id, s) => void (await itsa.set(id, { fields: { stage: s } }, 'system:process'), moves.push(s)),
    log: () => {},
  });
  watch.syncProcessSubscriptions(run.verdictTriggers([p], 'example/repo'));
  watch.onProcessStart((id, ev) => fn(id, ev));
  watch.ingest({ source: 'github', type: 'checks.completed', subject: 'github:example/repo#77', summary: 'PR #77 checks passed', dedupe_key: 'c77', payload: { head: HEAD, verdict: 'approve' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(moves, ['merge']);
  assert.equal(itsa.get(x.id).fields.stage, 'merge');
  watch.syncProcessSubscriptions([]);
});


// ---- S-948 follow-ups and S-949 ----

test('openItsasByLink finds the open ITSAs with a link to a url, not the closed ones', async () => {
  const url = 'https://github.com/example/repo/pull/501';
  const a = await itsa.create({ title: 'A', kind: 'issue', by: 'human', links: [{ system: 'github', external_id: '501', url }] });
  const b = await itsa.create({ title: 'B', kind: 'issue', by: 'human', links: [{ system: 'github', external_id: '501', url }] });
  await itsa.set(a.id, { status: 'done' }, 'human');
  assert.deepEqual(itsa.openItsasByLink('github', url).map((x) => x.id), [b.id]);
  assert.deepEqual(itsa.openItsasByLink('github', 'https://github.com/example/repo/pull/502'), []);
});

test('dispatchProcessEvent routes by the node kind', () => {
  const got = [];
  const on = { start: (id) => got.push(['start', id]), verdict: (id) => got.push(['verdict', id]) };
  for (const id of ['process:dev-change:request', 'process:dev-change:verdict', 'process:dev-change:code', 'process:nope:request', 'junk']) run.dispatchProcessEvent([p], id, {}, on);
  assert.deepEqual(got, [['start', 'process:dev-change:request'], ['verdict', 'process:dev-change:verdict']]);
});

import { mkdirSync, writeFileSync, symlinkSync, utimesSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(home, 'checkout');
mkdirSync(join(repo, 'scripts'), { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'scripts', 'merge-pr.mjs'), 'console.log("args", process.argv.slice(2).join(" "), "repo", process.env.STAM_GATE_REPO, "cwd", process.cwd()); console.error("merge refused: conflicts with main"); process.exit(Number(process.env.EXIT ?? 3));\n');
writeFileSync(join(repo, 'src', 'x.ts'), '');
writeFileSync(join(home, 'outside.mjs'), '');
symlinkSync(join(home, 'outside.mjs'), join(repo, 'scripts', 'escape.mjs'));

test('scriptPath: only real files under <checkout>/scripts/, symlinks resolved', () => {
  assert.equal(run.scriptPath(repo, 'scripts/merge-pr.mjs'), join(realpathSync(repo), 'scripts', 'merge-pr.mjs'));
  for (const bad of ['../etc/passwd', 'src/x.ts', '/bin/sh', 'scripts/../src/x.ts', 'scripts', 'scripts/', 'scripts/missing.mjs', 'scripts/escape.mjs']) assert.equal(run.scriptPath(repo, bad), null, bad);
});

function runnerHarness({ host = true, code = 0, signal = null, output = 'line1\nmerge refused: conflicts with main', owner = 'owner1', stageThrows = false } = {}) {
  const calls = [], stages = [], mails = [], logs = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const fn = run.scriptRunner({
    checkout: () => repo,
    host: () => host,
    spawn: async (script, args, checkout) => (calls.push([script, args, checkout]), await gate, { code, signal, output }),
    ownerOf: () => owner,
    setStage: async (id, st) => (stages.push([id, st]), stageThrows && Promise.reject(new Error('guard'))),
    mailOwner: async (o, subject, body) => void mails.push([o, subject, body]),
    log: (l) => logs.push(l),
  });
  return { fn, calls, stages, mails, logs, release };
}
const act = { do: 'run', script: 'scripts/merge-pr.mjs', args: ['291'] };
const settle = () => new Promise((r) => setTimeout(r, 5));
const MERGE = join(realpathSync(repo), 'scripts', 'merge-pr.mjs');

test('scriptRunner: success runs once from the checkout and does nothing else; a concurrent entry is ignored', async () => {
  const h = runnerHarness();
  h.fn('i1', p, act);
  h.fn('i1', p, act);
  await settle();
  assert.deepEqual(h.calls, [[MERGE, ['291'], repo]]);
  assert.ok(h.logs.some((l) => /already running/.test(l)));
  h.release();
  await settle();
  assert.deepEqual([h.stages, h.mails], [[], []]);
  h.fn('i1', p, act);
  await settle();
  assert.equal(h.calls.length, 2, 'after it finished, a new entry runs again');
});

test('scriptRunner: a real refusal sends the stage back to code and mails only the owner', async () => {
  const h = runnerHarness({ code: 3 });
  h.fn('i2', p, act);
  h.release();
  await settle();
  assert.deepEqual(h.stages, [['i2', 'code']]);
  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0][0], 'owner1');
  assert.match(h.mails[0][2], /conflicts with main/);
  const none = runnerHarness({ code: 3, owner: null });
  none.fn('i3', p, act);
  none.release();
  await settle();
  assert.deepEqual([none.stages, none.mails], [[['i3', 'code']], []]);
});

test('scriptRunner: a signal, a timeout, a usage exit or an infrastructure exit 1 leaves the stage and says there was no verdict', async () => {
  for (const r of [{ code: null, signal: 'SIGTERM' }, { code: 2, output: 'usage' }, { code: 1, output: 'merge refused: gh failed\nconflicts' }]) {
    const h = runnerHarness(r);
    h.fn('i7', p, act);
    h.release();
    await settle();
    assert.deepEqual(h.stages, [], JSON.stringify(r));
    assert.equal(h.mails.length, 1);
    assert.match(h.mails[0][1], /merge run ended without a verdict/);
  }
});

test('scriptRunner: a guard that throws on the stage move still mails the owner', async () => {
  const h = runnerHarness({ code: 3, stageThrows: true });
  h.fn('i8', p, act);
  h.release();
  await settle();
  assert.equal(h.mails.length, 1);
  assert.ok(h.logs.some((l) => /moving the stage back to code failed/.test(l)));
});

test('scriptRunner: skips off the ITSA home, outside scripts/, and without a PR', async () => {
  const away = runnerHarness({ host: false });
  away.fn('i4', p, act);
  const bad = runnerHarness();
  bad.fn('i4', p, { do: 'run', script: 'src/x.ts', args: ['1'] });
  bad.fn('i4', p, { do: 'run', script: 'scripts/merge-pr.mjs', args: [] });
  await settle();
  assert.equal(away.calls.length + bad.calls.length, 0);
  assert.equal(away.logs.length + bad.logs.length, 3);
});

test('runDetached: runs in the checkout with STAM_GATE_REPO, logs to a file, returns the tail, prunes old logs', async () => {
  const logDir = join(home, 'process-run');
  mkdirSync(logDir, { recursive: true });
  const stale = join(logDir, 'old.log');
  writeFileSync(stale, 'x');
  utimesSync(stale, new Date(Date.now() - 9 * 86_400_000), new Date(Date.now() - 9 * 86_400_000));
  const fresh = join(logDir, 'fresh.log');
  writeFileSync(fresh, 'x');
  const r = await run.runDetached({ node: process.execPath, script: join(repo, 'scripts', 'merge-pr.mjs'), args: ['291'], cwd: repo, logDir });
  assert.equal(r.code, 3);
  assert.match(r.output, new RegExp(`args 291 repo ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} cwd`));
  assert.match(r.output, /merge refused: conflicts with main/);
  assert.equal(run.isRefusal(r), true);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  assert.ok(readdirSync(logDir).some((f) => f.startsWith('merge-pr.mjs-291-')));
});

test('readTail returns only the last bytes', () => {
  const f = join(home, 'big.log');
  writeFileSync(f, 'a'.repeat(10_000) + 'END');
  const t = run.readTail(f);
  assert.equal(t.length, 4096);
  assert.ok(t.endsWith('END'));
  assert.equal(run.readTail(join(home, 'nope.log')), '');
});

test('stageEntryListener: on runs a script node only for the runner\'s own move; dry-run, off and other actors do not', () => {
  const ran = [];
  const mk = (mode) => run.stageEntryListener({ mode: () => mode, processesOf: () => [p], linksOf: () => pr(291).links, repo: () => REPO, record: () => {}, run: (id, proc, a) => ran.push([id, a.script, a.args]), log: () => {} });
  const at = (id, to, actor) => ({ ...ev(to, id), actor });
  mk('dry-run')(at('a', 'merge', run.RUNNER_ACTOR));
  mk('off')(at('b', 'merge', run.RUNNER_ACTOR));
  mk('on')(at('c', 'code', run.RUNNER_ACTOR));
  mk('on')(at('e', 'merge', 'system:merge-pr'));
  mk('on')(at('f', 'merge', 'some-manager'));
  mk('on')(at('g', 'merge', undefined));
  assert.deepEqual(ran, []);
  mk('on')(at('d', 'merge', run.RUNNER_ACTOR));
  assert.deepEqual(ran, [['d', 'scripts/merge-pr.mjs', ['291']]]);
});

test('stageEntryListener: the entry line names the actor, and dry-run says what on would not do for a non-runner entry', () => {
  const lines = (mode, actor, to = 'merge') => {
    const posts = [];
    run.stageEntryListener({ mode: () => mode, processesOf: () => [p], linksOf: () => pr(291).links, repo: () => REPO, record: (id, t) => posts.push(t), run: () => {}, log: () => {} })({ ...ev(to, 'x'), actor });
    return posts;
  };
  const [manager] = lines('dry-run', 'some-manager');
  assert.match(manager, /entering `merge` \(by some-manager\) would run `scripts\/merge-pr\.mjs 291` \(under on: not run, entered by some-manager, not the runner\)/);
  const [runner] = lines('dry-run', run.RUNNER_ACTOR);
  assert.match(runner, /entering `merge` \(by system:process\) would run/);
  assert.doesNotMatch(runner, /under on/);
  const [onMerge] = lines('on', 'system:merge-pr');
  assert.match(onMerge, /entering `merge` \(by system:merge-pr\) would run `scripts\/merge-pr\.mjs 291` \(not run: entered by system:merge-pr, not the runner\)/);
  const [askNoEdge] = lines('dry-run', 'some-manager', 'hold');
  assert.match(askNoEdge, /\(under on: not opened: its way out belongs to something else/);
  const [askEdge] = lines('dry-run', 'some-manager', 'ask');
  assert.doesNotMatch(askEdge, /under on: not opened/);
});


// ---- human nodes live (S-950) ----

test('answerEdge: ask has an answered edge to code, hold and others have none', () => {
  assert.equal(run.answerEdge(p, 'ask'), 'code');
  for (const id of ['hold', 'merge', 'code', 'nope']) assert.equal(run.answerEdge(p, id), null, id);
  assert.equal(run.evalCondition('answered', { answered: 'true' }), true);
  assert.equal(run.evalCondition('answered', {}), false);
});

function askHarness(mode, statusNow = 'in_progress', { blocked = [], comment = null } = {}) {
  const posts = [], moves = [], logs = [], recs = [];
  const fn = run.stageEntryListener({
    mode: () => mode, processesOf: () => [p], linksOf: () => [], repo: () => REPO, record: (id, t) => recs.push([id, t]), log: (l) => logs.push(l),
    ask: run.humanAsker({
      statusOf: () => statusNow,
      isHumanStatus: (st) => st.startsWith('needs_'),
      mayAsk: async (actor) => !blocked.includes(actor),
      latestComment: () => comment,
      post: async (id, body) => void posts.push(['post', id, body]),
      setStatus: async (id, st) => void posts.push(['status', id, st]),
      log: (l) => logs.push(l),
    }),
  });
  return { fn, posts, recs, logs };
}

test('entering ask under on posts the comment first, then moves to needs_input; hold and dry-run do not', async () => {
  const on = askHarness('on');
  on.fn({ ...ev('ask', 'a1'), from: 'code' });
  await settle();
  assert.deepEqual(on.posts.map((x) => x[0]), ['post', 'status']);
  assert.match(on.posts[0][2], /An agent needs your input.*moved from `code` to `ask`/);
  assert.deepEqual(on.posts[1], ['status', 'a1', 'needs_input']);
  const hold = askHarness('on');
  hold.fn(ev('hold', 'a2'));
  await settle();
  assert.equal(hold.posts.length, 0);
  assert.match(hold.recs[0][1], /would open the ask.*not opened/);
  const dry = askHarness('dry-run');
  dry.fn(ev('ask', 'a3'));
  await settle();
  assert.equal(dry.posts.length, 0);
  assert.match(dry.recs[0][1], /would open the ask \(answer\)/);
  const already = askHarness('on', 'needs_approval');
  already.fn(ev('ask', 'a4'));
  await settle();
  assert.equal(already.posts.length, 0);
});

test('an ask is opened only when the actor may mail the human, and it quotes the latest comment', async () => {
  const blockedRun = askHarness('on', 'in_progress', { blocked: ['haiku-dev'], comment: 'Which option do you want?\nA or B' });
  blockedRun.fn({ ...ev('ask', 'b1'), from: 'code', actor: 'haiku-dev' });
  await settle();
  assert.equal(blockedRun.posts.length, 0);
  assert.ok(blockedRun.logs.some((l) => /may not mail the human/.test(l)));
  const ok = askHarness('on', 'in_progress', { blocked: ['haiku-dev'], comment: 'Which option do you want?\nA or B' });
  ok.fn({ ...ev('ask', 'b2'), from: 'code', actor: 'good-dev' });
  await settle();
  assert.deepEqual(ok.posts.map((x) => x[0]), ['post', 'status']);
  assert.match(ok.posts[0][2], /The latest comment:\n\n> Which option do you want\?\n> A or B/);
});

test('answerListener: the human answering moves ask to code; an agent, a human status, or dry-run do not', () => {
  const moves = [], recs = [];
  const mk = (mode, stage = 'ask') => run.answerListener({ mode: () => mode, processesOf: () => [p], stageOf: () => stage, isHumanStatus: (st) => st.startsWith('needs_'), record: (id, t) => recs.push(t), moveStage: async (id, st) => void moves.push([id, st]), log: () => {}, human: 'human' });
  const c = (actor, from, to) => ({ itsa: { id: 'x1', kind: 'issue' }, actor, from, to });
  mk('on')(c('someone', 'needs_input', 'in_progress'));
  mk('on')(c('human', 'in_progress', 'needs_input'));
  mk('on')(c('human', 'needs_input', 'needs_review'));
  mk('on', 'code')(c('human', 'needs_input', 'in_progress'));
  mk('off')(c('human', 'needs_input', 'in_progress'));
  assert.deepEqual(moves, []);
  mk('dry-run')(c('human', 'needs_input', 'in_progress'));
  assert.equal(moves.length, 0);
  assert.match(recs[0], /would move to code/);
  mk('on')(c('human', 'needs_input', 'in_progress'));
  assert.deepEqual(moves, [['x1', 'code']]);
});

test('with the real flow: the ask posts quietly, mails the human once on needs_input, and the human act() moves the stage on', async () => {
  const human = await import('../src/itsa-human.ts');
  const db = (await import('../src/db.ts')).open();
  const mailer = await import('../src/mail.ts');
  human.watchHumanStatuses();
  const x = await itsa.create({ title: 'Ask me', kind: 'issue', by: 'human', status: 'in_progress', fields: { stage: 'ask' } });
  const toHuman = () => db.prepare("SELECT kind FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'human' AND m.about_itsa = ?").all(x.id).map((r) => r.kind);
  const ask = run.humanAsker({
    statusOf: (id) => itsa.find(id).status,
    isHumanStatus: (st) => !!itsa.statusOf(st)?.human,
    mayAsk: async () => true,
    latestComment: () => null,
    post: (id, body) => itsa.post(id, { by: run.RUNNER_ACTOR, body, agents_only: true }),
    setStatus: (id, st) => itsa.set(id, { status: st }, run.RUNNER_ACTOR),
    log: (l) => console.error(l),
  });
  ask(x.id, p, p.nodes.ask, { do: 'ask', ask: 'answer', status: 'needs_input' }, 'code');
  for (let i = 0; i < 50 && itsa.find(x.id).status !== 'needs_input'; i++) await settle();
  assert.equal(itsa.find(x.id).status, 'needs_input');
  await settle();
  await settle();
  assert.deepEqual(toHuman().filter((k) => k !== 'ask'), [], 'the comment did not reach the human');
  assert.equal(toHuman().filter((k) => k === 'ask').length, 1, 'the human got exactly one ask');
  const moves = [];
  const onAnswer = run.answerListener({ mode: () => 'on', processesOf: () => [p], stageOf: (id) => itsa.get(id).fields.stage, isHumanStatus: (st) => !!itsa.statusOf(st)?.human, record: () => {}, moveStage: async (id, st) => void (await itsa.set(id, { fields: { stage: st } }, run.RUNNER_ACTOR), moves.push(st)), log: () => {}, human: mailer.HUMAN });
  itsa.onChange((c) => c.type === 'status' && c.itsa.id === x.id && onAnswer({ itsa: { id: c.itsa.id, kind: c.itsa.kind }, actor: c.actor, from: c.from, to: c.to }));
  await human.act(x.id, 'answer', 'use option B');
  await settle();
  assert.deepEqual(moves, ['code']);
  assert.equal(itsa.get(x.id).fields.stage, 'code');
});

const agent = (o = {}) => ({ links: [], agent: { id: 'i1', key: 'S-9', ownerLive: false, parentOwner: 'par1', cos: 'cos1', reviewerLive: false, ...o } });

test('entryActions: agent node spawns the lane type for the ITSA, brief plus other nodes\' tell, parent = parent ITSA owner else cos', () => {
  const [a] = run.entryActions(p, 'code', agent(), REPO);
  assert.deepEqual({ ...a, prompt: undefined }, { do: 'spawn', type: 'developer', itsa: 'S-9', node: 'code', prompt: undefined, parent: 'par1', machine: 'host1' });
  assert.equal(a.prompt, p.nodes.code.brief);
  assert.equal(run.entryActions(p, 'code', agent({ parentOwner: null }), REPO)[0].parent, 'cos1');
  const [r] = run.entryActions(p, 'plan', agent(), REPO);
  assert.equal(r.type, 'manager');
  assert.ok(r.prompt.includes(p.nodes.review.tell.text));
});

test('entryActions: a standing lane (cos) gets a mail naming the ITSA and node, not a spawn', () => {
  assert.deepEqual(run.entryActions(p, 'route', agent(), REPO), [{ do: 'mail', to: 'cos1', itsa: 'S-9', node: 'route' }]);
});

test('entryActions: skips an owner-taking type when the ITSA has a live owner, a reviewer when one takes part', () => {
  assert.equal(run.entryActions(p, 'code', agent({ ownerLive: true }), REPO)[0].do, 'skip');
  assert.equal(run.entryActions(p, 'plan', agent({ ownerLive: true }), REPO)[0].do, 'skip');
  assert.equal(run.entryActions(p, 'review', agent({ ownerLive: true }), REPO)[0].do, 'spawn');
  assert.equal(run.entryActions(p, 'review', agent({ reviewerLive: true }), REPO)[0].do, 'skip');
});

test('entryActions: an unknown lane type falls back to the lane fallback', () => {
  const [a] = run.entryActions(p, 'review', agent({ typeKnown: (t) => t !== 'reviewer' }), REPO);
  assert.equal(a.type, 'reviewer-opus');
});

test('listener: an agent node entry is recorded as would-spawn in dry-run and on, and nothing is sent', () => {
  for (const mode of ['dry-run', 'on']) {
    const posts = [];
    const fn = run.stageEntryListener({ mode: () => mode, processesOf: () => [p], linksOf: () => [], repo: () => REPO, agentOf: () => agent().agent, record: (id, t) => posts.push([id, t]), log: () => {}, run: () => assert.fail('no run'), ask: () => assert.fail('no ask') });
    fn(ev('code'));
    assert.equal(posts.length, 1);
    assert.match(posts[0][1], /entering `code` \(by unknown\) would spawn a `developer` for S-9 on host1 under par1/);
  }
});

test('entryActions: the reviewer skip follows the resolved type being a reviewer type', () => {
  const isReviewerType = (t) => t === 'reviewer-opus';
  assert.equal(run.entryActions(p, 'review', agent({ reviewerLive: true, typeKnown: (t) => t !== 'reviewer', isReviewerType }), REPO)[0].do, 'skip');
  assert.equal(run.entryActions(p, 'review', agent({ reviewerLive: true, isReviewerType }), REPO)[0].do, 'spawn');
});

function agentHarness(o = {}) {
  const spawned = [], mails = [], recs = [], logs = [], notes = [];
  const fn = run.agentRunner({
    spawn: async (i) => { if (o.fail) throw new Error('no room'); spawned.push(i); return 'dev-1'; },
    mail: async (to, s, b) => void mails.push([to, s, b]),
    nameOf: (a) => (a === 'par1' ? 'parent-mgr' : a),
    working: async (m) => (o.workingBy ? o.workingBy(m) : o.working ?? 0),
    maxSpawnsPerHour: () => o.cap ?? 3,
    spawnsLastHour: () => o.spawns ?? 0,
    entryOf: () => 'e1',
    claimed: (id, node, entry) => !!o.claimed?.includes(`${id}#${node}#${entry}`),
    claim: (id, kind, node, entry, text) => void recs.push([id, node, kind]),
    note: (id, text) => void notes.push(text),
    log: (l) => logs.push(l),
  });
  return { fn, spawned, mails, recs, logs, notes };
}
const settleAgent = () => new Promise((r) => setTimeout(r, 5));
const spawnOf = () => run.entryActions(p, 'code', agent(), REPO)[0];

test('agentRunner: spawns with {{parent}} rendered and records it', async () => {
  const h = agentHarness();
  h.fn('i1', p, spawnOf());
  await settleAgent();
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].type, 'developer');
  assert.equal(h.spawned[0].parent, 'par1');
  assert.ok(h.spawned[0].prompt.includes('mail parent-mgr your branch'));
  assert.ok(!h.spawned[0].prompt.includes('{{parent}}'));
  assert.deepEqual(h.recs, [['i1', 'code', 'spawn']]);
});

test('agentRunner: a standing lane gets a mail, not a spawn', async () => {
  const h = agentHarness();
  h.fn('i1', p, run.entryActions(p, 'route', agent(), REPO)[0]);
  await settleAgent();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.mails[0][0], 'cos1');
  assert.match(h.mails[0][1], /S-9 entered route/);
  assert.deepEqual(h.recs, [['i1', 'route', 'mail']]);
});

test('agentRunner: the hourly cap, the working limit and a repeat refuse and spawn nothing', async () => {
  for (const o of [{ spawns: 3 }, { working: run.MAX_WORKING_AGENTS }, { claimed: ['i1#code#e1'] }]) {
    const h = agentHarness(o);
    h.fn('i1', p, spawnOf());
    await settleAgent();
    assert.equal(h.spawned.length, 0, JSON.stringify(o));
    assert.equal(h.logs.length, 1);
    assert.equal(h.notes.length, 1, 'the refusal is on the ITSA');
    assert.equal(h.recs.length, 0);
  }
});

test('agentRunner: a failed spawn mails the parent once and records the failure', async () => {
  const h = agentHarness({ fail: true });
  h.fn('i1', p, spawnOf());
  await settleAgent();
  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0][0], 'par1');
  assert.match(h.mails[0][2], /no room/);
  assert.match(h.notes[0], /failed/);
});

test('listener: under on, a spawn happens only for the runner\'s own move; dry-run and other actors do not', () => {
  for (const [mode, actor, expected] of [['on', run.RUNNER_ACTOR, 1], ['on', 'someone', 0], ['dry-run', run.RUNNER_ACTOR, 0]]) {
    const acted = [];
    const posts = [];
    const fn = run.stageEntryListener({ mode: () => mode, processesOf: () => [p], linksOf: () => [], repo: () => REPO, agentOf: () => agent().agent, record: (id, t) => posts.push(t), agent: (id, pp, a) => acted.push(a.do), log: () => {} });
    fn({ ...ev('code'), actor });
    assert.equal(acted.length, expected, `${mode} ${actor}`);
    assert.equal(posts.length, 1);
    assert.match(posts[0], new RegExp(`entering \`code\` \\(by ${actor}\\) ${expected ? '' : 'would '}spawn a`));
  }
});

test('agentRunner: two entries in the same tick can\'t both pass the cap or the working limit', async () => {
  const claimed = [];
  const mk = (extra) => run.agentRunner({
    spawn: () => new Promise((r) => setTimeout(() => r('dev'), 5)),
    mail: async () => {}, nameOf: (a) => a, working: async () => run.MAX_WORKING_AGENTS - 1, maxSpawnsPerHour: () => 1,
    spawnsLastHour: () => claimed.length, entryOf: (id) => id, claimed: () => false,
    claim: (id, kind, node, entry, text) => claimed.push(text), note: () => {}, log: () => {}, ...extra,
  });
  const a = spawnOf();
  const fn = mk({});
  fn('i1', p, a);
  fn('i2', p, a);
  await settleAgent();
  assert.equal(claimed.length, 1, 'cap of 1 holds across two same-tick entries');
  const claimed2 = [];
  const fn2 = mk({ maxSpawnsPerHour: () => 9, spawnsLastHour: () => 0, claim: (id, kind, node, entry, text) => claimed2.push(text) });
  fn2('i1', p, a);
  fn2('i2', p, a);
  await settleAgent();
  assert.equal(claimed2.length, 1, 'one slot left under the working limit');
});

test('agentRunner: the once-only rule is per stage-change entry, so a quick re-entry spawns again', async () => {
  const done = new Set();
  const spawned = [];
  let entry = 'e1';
  const fn = run.agentRunner({
    spawn: async (i) => (spawned.push(i), 'dev'), mail: async () => {}, nameOf: (a) => a, working: async () => 0, maxSpawnsPerHour: () => 9,
    spawnsLastHour: () => 0, entryOf: () => entry, claimed: (id, node, e) => done.has(`${id}#${node}#${e}`),
    claim: (id, kind, node, e) => done.add(`${id}#${node}#${e}`), note: () => {}, log: () => {},
  });
  fn('i1', p, spawnOf());
  fn('i1', p, spawnOf());
  await settleAgent();
  assert.equal(spawned.length, 1, 'same entry twice');
  entry = 'e2';
  fn('i1', p, spawnOf());
  await settleAgent();
  assert.equal(spawned.length, 2, 'next entry');
});

test('entryActions: a lane\'s machine is on the spawn action and passed to the spawn', async () => {
  assert.equal(p.lanes.developer.machine, 'host1');
  assert.equal(run.entryActions(p, 'code', agent(), REPO)[0].machine, 'host1');
  assert.equal(run.entryActions(p, 'plan', agent(), REPO)[0].machine, undefined);
  const h = agentHarness();
  const seen = [];
  const fn = run.agentRunner({ ...{ spawn: async (i) => (seen.push(i), 'dev'), mail: async () => {}, nameOf: (a) => a, working: async () => 0, maxSpawnsPerHour: () => 9, spawnsLastHour: () => 0, entryOf: () => 'e', claimed: () => false, claim: () => {}, note: () => {}, log: () => {} } });
  fn('i1', p, run.entryActions(p, 'code', agent(), REPO)[0]);
  await settleAgent();
  assert.equal(seen[0].machine, 'host1');
  void h;
});

test('agentRunner: the working limit is read for the target machine, in-flight spawns are per machine, and an unreadable count refuses', async () => {
  const asked = [];
  const h = agentHarness({ workingBy: async (m) => (asked.push(m), m === 'host1' ? run.MAX_WORKING_AGENTS : 0) });
  h.fn('i1', p, run.entryActions(p, 'code', agent(), REPO)[0]);
  h.fn('i2', p, run.entryActions(p, 'plan', agent(), REPO)[0]);
  await settleAgent();
  assert.deepEqual(asked.sort(), ['host1', undefined]);
  assert.equal(h.spawned.length, 1, 'host1 is full, the local manager spawn goes');
  assert.equal(h.spawned[0].type, 'manager');
  assert.match(h.notes[0], /8 agents already working on host1/);
  const bad = agentHarness({ workingBy: async () => { throw new Error('host1 is unreachable'); } });
  bad.fn('i1', p, run.entryActions(p, 'code', agent(), REPO)[0]);
  await settleAgent();
  assert.equal(bad.spawned.length, 0);
  assert.match(bad.notes[0], /can't read how many agents work there \(host1 is unreachable\)/);
});

test('spawnOnMachine: a missing peer and a refusal throw, a spawn returns the name and goes as the parent', async () => {
  const calls = [];
  const deps = (reply) => ({
    peerOf: (m) => (m === 'storage' ? { name: 'storage' } : undefined),
    agentId: (r) => (r === 'par1' ? 'id-par1' : undefined),
    viaFor: (id) => ({ agent: id }),
    spawnOnPeer: async (peer, body, human, via) => (calls.push({ peer: peer.name, body, human, via }), reply),
  });
  const body = { type: 'developer', itsa: 'S-9', prompt: 'x', parent: 'par1' };
  await assert.rejects(run.spawnOnMachine(deps({}), 'nowhere', body), /no peer machine nowhere/);
  await assert.rejects(run.spawnOnMachine(deps({ status: 409, data: { error: 'held' } }), 'storage', body), /storage refused the spawn: held/);
  calls.length = 0;
  assert.equal(await run.spawnOnMachine(deps({ status: 200, data: { id: 'a1', name: 'dev-9' } }), 'storage', body), 'dev-9');
  assert.deepEqual(calls[0].via, { agent: 'id-par1' });
  assert.equal(calls[0].body.by, 'id-par1');
});

test('listener: entering done on a close does nothing but a record, in every mode (S-1398)', () => {
  for (const mode of ['off', 'dry-run', 'on']) {
    const acted = [];
    const posts = [];
    const fn = run.stageEntryListener({
      mode: () => mode, processesOf: () => [p], linksOf: () => [], repo: () => REPO,
      run: () => acted.push('run'), ask: () => acted.push('ask'), agent: () => acted.push('agent'),
      record: (id, t) => posts.push(t), log: () => {},
    });
    fn({ itsa: { id: 'c1', kind: 'issue' }, from: 'review', to: 'done', actor: 'system:process' });
    assert.deepEqual(acted, [], mode);
    assert.equal(posts.length, mode === 'off' ? 0 : 1, mode);
  }
});
