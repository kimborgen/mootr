#!/usr/bin/env node
// Unit tests for the retro loop (S-206): the open items grouped by target, the steward's task,
// the Answers line, the approval check, the gate (an agent can't apply a proposal the human hasn't
// approved; Request changes doesn't count), the answered items closing with the proposal, and when
// a steward is spawned (with a fake spawn: once, not while a proposal is open or nothing is open).
// Throwaway STAM_HOME, no daemon, no model. Run with `node --test test/retro-loop.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-retro-loop-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `retro-loop-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, human, loop, settings;
const agent = (id, name, extra = {}) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: home, parent_id: null, session_id: null, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 50));

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  human = await import('../src/itsa-human.ts');
  loop = await import('../src/retro-loop.ts');
  settings = await import('../src/settings.ts');
  // No search index: the embedder would install a model.
  settings.setSetting('search', { embedder: 'off' });
  db.open();
  agent('a1', 'steward');
  agent('a2', 'cos');
  agent('a3', 'release');
  settings.setSetting('chiefOfStaff', 'cos');
  loop.watchProposals();
});
after(() => rmSync(home, { recursive: true, force: true }));

const item = (key, target, plusOnes, kind = 'improve') => ({ key, title: `title ${key}`, kind, target, plusOnes, details: `details of ${key}` });

test('items group by target, most +1s first, then most items', () => {
  const g = loop.groupByTarget([item('S-1', 'type-developer', 0), item('S-2', 'none', 1), item('S-3', 'type-developer', 2), item('S-4', 'retro', 0), item('S-5', 'retro', 0)]);
  assert.deepEqual(g.map((x) => [x.target, x.items.map((i) => i.key), x.plusOnes]), [
    ['type-developer', ['S-3', 'S-1'], 2],
    ['none', ['S-2'], 1],
    ['retro', ['S-4', 'S-5'], 0],
  ]);
});

test('groups and items sort by evidence first, then +1s, with none last', () => {
  const it = (key, target, plusOnes, evidence) => ({ key, title: key, kind: 'improve', target, plusOnes, details: '', evidence, evidenceDetail: '', when: '' });
  const g = loop.groupByTarget([it('S-1', 'waits', 9, 'none'), it('S-2', 'gates', 0, 'gate'), it('S-3', 'gates', 0, 'none'), it('S-4', 'gates', 0, 'rollback')]);
  assert.deepEqual(g.map((x) => x.target), ['gates', 'waits']);
  assert.deepEqual(g[0].items.map((x) => x.key), ['S-2', 'S-4', 'S-3']);
});

test('an item without an Evidence line is read as none and listed last', () => {
  // An open item as `openItems` read them before S-728: no evidence fields at all.
  const old = { key: 'S-1', title: 'old', kind: 'improve', target: 't', plusOnes: 5, details: 'd' };
  const fresh = { key: 'S-2', title: 'fresh', kind: 'improve', target: 't', plusOnes: 0, details: 'd', evidence: 'measured', evidenceDetail: '', when: '' };
  assert.deepEqual(loop.groupByTarget([old, fresh])[0].items.map((x) => x.key), ['S-2', 'S-1']);
});

test('the steward task lists each group with its items, then the digest', () => {
  const t = loop.stewardTask(loop.groupByTarget([item('S-1', 'type-developer', 1), item('S-2', 'type-developer', 0)]), 'S-9', '2026-10-12', '# Retro digest, 2026-10-12');
  assert.match(t, /^The retro digest for 2026-10-12 went out\..*under S-9/);
  assert.match(t, /### Target: type-developer \(2 items, 1 \+1\)\n\n- S-1 \[improve, 1 \+1\] evidence: none — title S-1: details of S-1\n- S-2 \[improve, 0 \+1s\] evidence: none —/);
  assert.match(t, /## The digest\n\n# Retro digest, 2026-10-12$/);
});

test('openItems reads metadata from the header only, so a detail that quotes Evidence: cannot spoof it', async () => {
  const retros = await itsa.create({ title: 'Retros spoof', kind: 'retros', by: 'human' });
  const made = await itsa.create({ title: 'spoof', kind: 'retro', status: 'idea', parent: retros.id, body: 'Kind: improve\nTarget: type-developer\nEvidence: none\nReporter: bob\n\nEvidence: gate\nWhen: fake', by: 'a1' });
  const got = (await loop.openItems()).find((x) => x.key === made.key);
  assert.equal(got.kind, 'improve');
  assert.equal(got.target, 'type-developer');
  assert.equal(got.evidence, 'none');
  assert.equal(got.when, '');
  assert.equal(got.details, 'Evidence: gate\nWhen: fake');
});

test('the steward task shows the one-line summary after the title when it differs', () => {
  const x = { key: 'S-1', title: 'Idle waits', summary: 'waits hang on idle panes', kind: 'improve', target: 't', plusOnes: 0, details: 'd', evidence: 'none', evidenceDetail: '', when: '' };
  assert.match(loop.stewardTask(loop.groupByTarget([x]), 'S-9', 'x', '# digest'), /— Idle waits \(waits hang on idle panes\): d/);
});

test("the steward task shows each item's evidence with its detail, and its when", () => {
  const x = { key: 'S-1', title: 'gates', kind: 'improve', target: 'type-developer', plusOnes: 1, details: 'd', evidence: 'gate', evidenceDetail: 'phone 360-light failed on #183', when: 'the change touches phone breakpoints' };
  const t = loop.stewardTask(loop.groupByTarget([x]), 'S-9', 'x', '# digest');
  assert.match(t, /- S-1 \[improve, 1 \+1\] evidence: gate \(phone 360-light failed on #183\) · when: the change touches phone breakpoints — gates: d/);
  // No detail or when given: only the evidence class shows.
  const plain = { ...x, evidenceDetail: '', when: '' };
  assert.match(loop.stewardTask(loop.groupByTarget([plain]), 'S-9', 'x', '# digest'), /- S-1 \[improve, 1 \+1\] evidence: gate —/);
});

test('the Answers line gives the keys, once each', () => {
  assert.deepEqual(loop.answersOf('Answers: S-1, S-2 S-1\n\nSummary'), ['S-1', 'S-2']);
  assert.deepEqual(loop.answersOf('No line here'), []);
});

test('approved: only an Approve after the latest needs_approval counts', () => {
  const st = (to) => ({ type: 'status', actor: 'a1', data: JSON.stringify({ from: 'x', to }) });
  const act = (id) => ({ type: 'action', actor: 'human', data: JSON.stringify({ id, from: 'needs_approval' }) });
  assert.equal(loop.approved([st('needs_approval')]), false);
  assert.equal(loop.approved([st('needs_approval'), act('approve')]), true);
  assert.equal(loop.approved([st('needs_approval'), act('changes')]), false);
  assert.equal(loop.approved([st('needs_approval'), act('approve'), st('needs_approval')]), false);
  assert.equal(loop.approved([st('needs_approval'), act('changes'), st('needs_approval'), act('approve')]), true);
});

test('approved: Kim\'s latest action since the request counts, from any status; creation in needs_approval asks; a kind change needs a new approval', () => {
  const st = (to) => ({ type: 'status', actor: 'a1', data: JSON.stringify({ from: 'x', to }) });
  const act = (id, from) => ({ type: 'action', actor: 'human', data: JSON.stringify({ id, from }) });
  // Approved, then sent to review and sent back: the latest action is Request changes.
  assert.equal(loop.approved([st('needs_approval'), act('approve', 'needs_approval'), st('needs_review'), act('changes', 'needs_review')]), false);
  // Created straight into needs_approval, then approved.
  assert.equal(loop.approved([{ type: 'created', actor: 'a1', data: JSON.stringify({ key: 'S-1', status: 'needs_approval' }) }, act('approve', 'needs_approval')]), true);
  // An approval from before a kind change doesn't carry over.
  assert.equal(loop.approved([st('needs_approval'), act('approve', 'needs_approval'), { type: 'kind', actor: 'a1', data: JSON.stringify({ from: 'issue', to: 'proposal' }) }]), false);
});

test('an agent can\'t create a proposal in a status that applies it; the human can', async () => {
  for (const status of ['done', 'ready_to_merge', 'merging', 'deploying']) {
    await assert.rejects(itsa.create({ title: `p ${status}`, kind: 'proposal', status, by: 'a1' }), /hasn't approved/, status);
  }
  await itsa.create({ title: 'by the human', kind: 'proposal', status: 'canceled', by: 'human' });
});

test('kind edits: an agent can\'t drop the proposal kind, nor make an applied ITSA a proposal', async () => {
  const p = await itsa.create({ title: 'p', kind: 'proposal', status: 'in_progress', by: 'a1' });
  await assert.rejects(itsa.set(p.key, { kind: 'issue' }, 'steward'), /only your user can change its kind/);
  await assert.rejects(itsa.set(p.key, { kind: 'issue', status: 'done' }, 'steward'), /only your user can change its kind/);
  const done = await itsa.create({ title: 'done issue', kind: 'issue', status: 'in_progress', by: 'a1' });
  await itsa.set(done.key, { status: 'done' }, 'steward');
  await assert.rejects(itsa.set(done.key, { kind: 'proposal' }, 'steward'), /hasn't approved/);
  await itsa.set(p.key, { kind: 'issue' }, 'human');
  await itsa.set(p.key, { kind: 'proposal', status: 'canceled' }, 'human');
});

test('an issue answering retro items is allowed unless it is an instruction or template edit', async () => {
  const retros = await itsa.create({ title: 'Retros for kinds', kind: 'retros', by: 'human' });
  const answers = 'Answers: S-1\n\nSummary';
  const diff = (path) => `\n\ndiff --git a/${path} b/${path}`;
  // A code fix: under Retros with an Answers line and an src/ diff, so it may be an issue.
  const code = await itsa.create({ title: 'code fix', kind: 'issue', parent: retros.id, body: `${answers}${diff('src/retro-loop.ts')}`, by: 'a1' });
  assert.equal(code.kind, 'issue');
  // No kind given: an ordinary ITSA, still not forced to be a proposal.
  const untyped = await itsa.create({ title: 'no kind', parent: retros.id, body: answers, by: 'a1' });
  assert.equal(untyped.kind, null);
  // An instruction or template edit must be a proposal.
  for (const path of ['blocks/type-developer/10-start.md', 'templates/retro.md', 'CLAUDE.md', 'AGENTS.md', 'registry/defaults.json'])
    await assert.rejects(itsa.create({ title: `edit ${path}`, kind: 'issue', parent: retros.id, body: `${answers}${diff(path)}`, by: 'a1' }), /instruction or template edit, so its kind must be proposal/, path);
  // A `+++ b/` header line counts too, even without the diff --git line.
  await assert.rejects(itsa.create({ title: 'template +++', kind: 'issue', parent: retros.id, body: `${answers}\n\n+++ b/templates/type-developer.md`, by: 'a1' }), /must be proposal/);
  // An ITSA later given an instruction diff while under Retros is refused too.
  const plain = await itsa.create({ title: 'plain under retros', kind: 'issue', parent: retros.id, body: 'No answers here', by: 'a1' });
  await assert.rejects(itsa.set(plain.key, { body: `${answers}${diff('blocks/x.md')}` }, 'a1'), /must be proposal/);
  assert.equal(itsa.must(plain.id).body, 'No answers here');
  // A retro item quoting an Answers line is retro bookkeeping, not a proposal: it isn't gated.
  const quoted = await itsa.create({ title: 'a retro quoting an answer', kind: 'retro', parent: retros.id, body: `Kind: improve\nTarget: x\n\n${answers}${diff('blocks/x.md')}`, by: 'a1' });
  // Elsewhere (no Retros parent, no steward) is not gated at all.
  const elsewhere = await itsa.create({ title: 'elsewhere', kind: 'issue', body: `${answers}${diff('blocks/x.md')}`, by: 'a1' });
  const byHuman = await itsa.create({ title: 'by the human', kind: 'issue', parent: retros.id, body: `${answers}${diff('blocks/x.md')}`, by: 'human' });
  await itsa.set(plain.key, { body: `${answers}${diff('blocks/x.md')}` }, 'human');
  const p = await itsa.create({ title: 'a proposal', kind: 'proposal', parent: retros.id, body: `${answers}${diff('blocks/x.md')}`, by: 'a1' });
  for (const x of [code, untyped, plain, quoted, elsewhere, byHuman, p]) await itsa.set(x.key, { status: 'canceled' }, 'human');
});

test('the instruction-diff check normalises the header path, so a spelling cannot evade it', async () => {
  const retros = await itsa.create({ title: 'Retros for path variants', kind: 'retros', by: 'human' });
  const answers = 'Answers: S-1\n\nSummary';
  const evasions = [
    'diff --git a/blocks/x.md b/blocks/x.md',
    'diff --git a/./blocks/x.md b/./blocks/x.md',
    'diff --git a/x/../blocks/x.md b/x/../blocks/x.md',
    'diff --git a//blocks/x.md b//blocks/x.md',
    'diff --git "a/blocks/x.md" "b/blocks/x.md"',
    '   diff --git a/blocks/x.md b/blocks/x.md',
    '--- a/blocks/x.md',
    '+++ b/blocks/x.md',
    'diff --git a/TEMPLATES/x.md b/TEMPLATES/x.md',
    'diff --git a/CLAUDE.md b/CLAUDE.md',
    'diff --git a/AGENTS.md b/AGENTS.md',
    'diff --git a/registry/defaults.json b/registry/defaults.json',
  ];
  for (const line of evasions)
    await assert.rejects(itsa.create({ title: 'evasion', kind: 'issue', parent: retros.id, body: `${answers}\n\n${line}`, by: 'a1' }), /must be proposal/, line);
  // `Answers:` without the space still gates.
  await assert.rejects(itsa.create({ title: 'no space', kind: 'issue', parent: retros.id, body: 'Answers:S-1\n\ndiff --git a/blocks/x.md b/blocks/x.md', by: 'a1' }), /must be proposal/);
  // A body with no diff passes as an issue: the gate decides whether the human must approve a retro
  // answer and reads the path the body claims, never the branch's real diff (S-1050 review).
  const ok = await itsa.create({ title: 'no diff', kind: 'issue', parent: retros.id, body: answers, by: 'a1' });
  assert.equal(ok.kind, 'issue');
  await itsa.set(ok.key, { status: 'canceled' }, 'human');
});

test('an issue a retro steward created is refused; the steward files a proposal', async () => {
  agent('a4', 'typed-steward');
  db.updateAgent('a4', { type: 'retro-steward' });
  const answers = 'Answers: S-1\n\nSummary\ndiff --git a/src/x.ts b/src/x.ts';
  await assert.rejects(itsa.create({ title: 'by the steward', kind: 'issue', body: answers, by: 'a4' }), /must be proposal/);
  const p = await itsa.create({ title: 'steward proposal', kind: 'proposal', owner: 'steward', body: answers, by: 'a4' });
  assert.equal(p.kind, 'proposal');
  await itsa.set(p.key, { status: 'canceled' }, 'human');
  // A live steward would hold the next one back.
  db.updateAgent('a4', { lifecycle: 'archived' });
});

test('a proposal created in needs_approval and approved can be applied', async () => {
  const p = await itsa.create({ title: 'asked at once', kind: 'proposal', owner: 'steward', status: 'needs_approval', by: 'a1' });
  await human.act(p.key, 'approve', '');
  await itsa.set(p.key, { status: 'ready_to_merge' }, 'steward');
  await itsa.set(p.key, { status: 'canceled' }, 'human');
});

test('only a human request may act as the human', () => {
  assert.throws(() => itsa.requestActor('human', false), /only your user/);
  assert.throws(() => itsa.requestActor('The Human', false), /only your user/);
  assert.equal(itsa.requestActor('human', true), 'human');
  assert.equal(itsa.requestActor('a1', false), 'a1');
  assert.equal(itsa.requestActor(undefined, true), 'human');
  assert.equal(itsa.requestActor(undefined, false), null);
});

async function proposal(answers) {
  const retros = await itsa.create({ title: 'Retros', kind: 'retros', by: 'human' });
  const items = [];
  for (const n of [1, 2, 3]) items.push(await itsa.create({ title: `retro ${n}`, kind: 'retro', status: 'idea', parent: retros.id, body: `Kind: improve\nTarget: type-developer\n\nDetails ${n}.`, by: 'a1' }));
  const p = await itsa.create({ title: 'Instruction edits', kind: 'proposal', parent: retros.id, owner: 'steward', status: 'in_progress', body: `Answers: ${answers(items).join(', ')}\n\n- One edit.`, by: 'a1' });
  return { items, p };
}

test('the gate refuses applying until the human approves; Request changes does not approve', async () => {
  const { items, p } = await proposal((xs) => xs.slice(0, 2).map((x) => x.key));
  await assert.rejects(itsa.set(p.key, { status: 'ready_to_merge' }, 'steward'), /hasn't approved/);
  await itsa.post(p.key, { by: 'steward', body: 'Please approve.' });
  await itsa.set(p.key, { status: 'needs_approval' }, 'steward');
  await human.act(p.key, 'changes', 'Shorter, please.');
  await assert.rejects(itsa.set(p.key, { status: 'ready_to_merge' }, 'steward'), /hasn't approved/);
  await itsa.post(p.key, { by: 'steward', body: 'Shorter now.' });
  await itsa.set(p.key, { status: 'needs_approval' }, 'steward');
  await human.act(p.key, 'approve', '');
  // The steward hears both answers, even the Approve without text.
  const notices = db.listEvents('a1', 200).filter((e) => e.type === 'notice:queued').map((e) => JSON.parse(e.data).text);
  assert.ok(notices.some((t) => t.startsWith(`Your user requested changes on ${p.key}`)), notices);
  assert.ok(notices.some((t) => t.startsWith(`Your user approved ${p.key}`)), notices);
  await itsa.set(p.key, { status: 'ready_to_merge' }, 'steward');
  // Release closes it; the two items it answers close, the third stays open.
  await itsa.set(p.key, { status: 'done' }, 'release');
  await tick();
  assert.deepEqual(items.map((x) => itsa.must(x.id).status), ['done', 'done', 'idea']);
  assert.ok(db.threadMail(itsa.must(items[0].id).thread_id).some((m) => m.body.includes(`Answered by ${p.key}`)));
});

test('an issue that answers retro items closes them when it is done, with a comment naming it', async () => {
  const retros = await itsa.create({ title: 'Retros for a code fix', kind: 'retros', by: 'human' });
  const items = [];
  for (const n of [1, 2, 3]) items.push(await itsa.create({ title: `retro c${n}`, kind: 'retro', status: 'idea', parent: retros.id, body: `Kind: improve\nTarget: x\n\nD${n}.`, by: 'a1' }));
  const fix = await itsa.create({ title: 'Code fix', kind: 'issue', parent: retros.id, owner: 'release', status: 'in_progress', body: `Answers: ${items[0].key}, ${items[1].key}\n\ndiff --git a/src/x.ts b/src/x.ts`, by: 'a1' });
  // The deploy watcher closes it as a system sender; the two items it answers close, the third stays open.
  await itsa.set(fix.key, { status: 'done' }, 'system:deploy-watch');
  await tick();
  assert.deepEqual(items.map((x) => itsa.must(x.id).status), ['done', 'done', 'idea']);
  const note = db.threadMail(itsa.must(items[0].id).thread_id).find((m) => m.body.includes(fix.key));
  assert.match(note?.body ?? '', new RegExp(`Closed: ${fix.key} is done`));
  assert.doesNotMatch(note?.body ?? '', /approved/);
});

test('a proposal that reaches done outside Retros still closes the item it answers', async () => {
  const retros = await itsa.create({ title: 'Retros for an outside proposal', kind: 'retros', by: 'human' });
  const item = await itsa.create({ title: 'retro o1', kind: 'retro', status: 'idea', parent: retros.id, body: 'Kind: improve\nTarget: x\n\nD.', by: 'a1' });
  // Parented under the retro item, not Retros: answersRetroItems is false, but a proposal still closes it.
  const p = await itsa.create({ title: 'proposal under item', kind: 'proposal', parent: item.id, owner: 'release', status: 'in_progress', body: `Answers: ${item.key}\n\n- One edit.`, by: 'a1' });
  await itsa.post(p.key, { by: 'release', body: 'Please approve.' });
  await itsa.set(p.key, { status: 'needs_approval' }, 'release');
  await human.act(p.key, 'approve', '');
  await itsa.set(p.key, { status: 'done' }, 'release');
  await tick();
  assert.equal(itsa.must(item.id).status, 'done');
  assert.ok(db.threadMail(itsa.must(item.id).thread_id).some((m) => m.body.includes(`Answered by ${p.key}`)));
});

test('a proposal canceled closes nothing, and other kinds are not gated', async () => {
  const { items, p } = await proposal((xs) => xs.map((x) => x.key));
  await itsa.set(p.key, { status: 'canceled' }, 'steward');
  await tick();
  assert.deepEqual(items.map((x) => itsa.must(x.id).status), ['idea', 'idea', 'idea']);
  const work = await itsa.create({ title: 'work', by: 'a1', status: 'in_progress' });
  await itsa.set(work.key, { status: 'done' }, 'steward');
});

test('a steward spawns once per digest: not while a proposal is open, nor while one lives', async () => {
  const spawned = [];
  const spawn = async (body) => {
    spawned.push(body);
    agent(`s${spawned.length}`, body.name);
    db.updateAgent(`s${spawned.length}`, { type: body.type });
    return { name: body.name };
  };
  // All proposals so far are closed; items are open.
  const r = await loop.afterDigest('2026-10-12', '# digest', spawn);
  assert.equal(r.spawned, 'retro-steward');
  assert.equal(spawned[0].type, 'retro-steward');
  assert.equal(spawned[0].parent, 'a2');
  assert.match(spawned[0].prompt, /### Target: type-developer/);
  // The steward still lives: no second one.
  assert.match((await loop.afterDigest('2026-10-13', '# digest', spawn)).reason, /still alive/);
  db.updateAgent('s1', { lifecycle: 'archived' });
  // An open proposal holds the next one back.
  const open = await itsa.create({ title: 'open', kind: 'proposal', by: 'human' });
  assert.match((await loop.afterDigest('2026-10-13', '# digest', spawn)).reason, /still open/);
  await itsa.set(open.key, { status: 'canceled' }, 'human');
  // A process change waiting for Kim (S-1084) doesn't hold the steward back.
  const procChange = await itsa.create({ title: 'demo process change', kind: 'proposal', body: 'Process proposal: demo\nPR: #7\n\nx', status: 'needs_approval', by: 'human' });
  const r2 = await loop.afterDigest('2026-10-13', '# digest', spawn);
  assert.equal(r2.spawned, 'retro-steward-2');
  await itsa.set(procChange.key, { status: 'canceled' }, 'human');
  // Off in settings: nothing.
  db.updateAgent('s2', { lifecycle: 'archived' });
  settings.setSetting('retro', { ...settings.settings().retro, steward: { enabled: false } });
  assert.match((await loop.afterDigest('2026-10-14', '# digest', spawn)).reason, /off/);
});

test('two digests at once spawn one steward', async () => {
  settings.setSetting('retro', { ...settings.settings().retro, steward: { enabled: true } });
  for (const a of db.listAgents()) if (a.type === 'retro-steward') db.updateAgent(a.id, { lifecycle: 'archived' });
  const names = [];
  const spawn = async (body) => {
    await tick();
    names.push(body.name);
    const id = `c${names.length}`;
    agent(id, body.name);
    db.updateAgent(id, { type: body.type });
    return { name: body.name };
  };
  const rs = await Promise.all([loop.afterDigest('a', '# a', spawn), loop.afterDigest('b', '# b', spawn)]);
  assert.equal(names.length, 1, JSON.stringify(rs));
  assert.match(rs[1].reason, /still alive/);
});
