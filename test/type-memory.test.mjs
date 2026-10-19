#!/usr/bin/env node
// Unit tests for type memory (S-888): `retrosOfType` (the retro items an agent type's agents filed, or
// aimed at `type-NAME` or one of its block ids, open and done, ranked like the Retros page); the memory
// block slot (`99-memory.md` renders in its type's instructions only, a type without one renders
// byte-identical); `memoryProblem` (kind, scope, title and the 400-token cap); and the proposal gate
// (only a retro steward changes a memory block, in a proposal, within the cap).
// Throwaway STAM_HOME, no daemon, no model. Run with `node --test test/type-memory.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-type-memory-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `type-memory-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const root = join(import.meta.dirname, '..');
const slotDir = join(root, 'blocks', 'type-memtest');
let db, itsa, loop, digest, blocks, org, settings;
const agent = (id, name, extra = {}) => {
  db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(id, extra);
};

const fm = (o) => `---\nid: ${o.id ?? 'memory-memtest'}\ntitle: ${o.title ?? 'Before you start'}\nsummary: |\n  Notes.\n  Two lines.\nscope: ${o.scope ?? 'type:memtest'}\nkind: ${o.kind ?? 'memory'}\nsummary_of: x\n---\n`;
const memoryFile = (body, o = {}) => writeFileSync(join(slotDir, '99-memory.md'), fm(o) + body);

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  loop = await import('../src/retro-loop.ts');
  digest = await import('../src/retro-digest.ts');
  blocks = await import('../src/blocks.ts');
  org = await import('../src/org.ts');
  settings = await import('../src/settings.ts');
  settings.setSetting('search', { embedder: 'off' });
  db.open();
  agent('dev1', 'dev-one', { type: 'developer' });
  agent('rev1', 'rev-one', { type: 'reviewer' });
  agent('stew', 'steward', { type: 'retro-steward' });
  agent('memtest1', 'mem-one', { type: 'memtest' });
  loop.watchProposals();
  rmSync(slotDir, { recursive: true, force: true });
  mkdirSync(slotDir, { recursive: true });
  writeFileSync(join(slotDir, '10-brief.md'), fm({ id: 'memtest-brief', title: 'Brief', scope: 'type:memtest', kind: 'rule' }) + '## Your type: memtest\n\nDo the thing.\n');
});
after(() => rmSync(slotDir, { recursive: true, force: true }));

test('retrosOfType: items by the type\'s agents, or aimed at its template or a block id, open and done, ranked', async () => {
  const retros = await itsa.create({ title: 'Retros', kind: 'retros', by: 'human' });
  const file = (by, title, target, extra = {}) => itsa.create({ title, kind: 'retro', status: extra.status ?? 'idea', parent: retros.id, body: `Kind: improve\nTarget: ${target}\nEvidence: ${extra.evidence ?? 'none'}\nReporter: x (m, ${extra.reporter ?? 'other'})\n\nd`, by });
  const own = await file('dev1', 'own', 'none');
  const evidence = await file('dev1', 'own with evidence', 'none', { evidence: 'gate' });
  const aimed = await file('rev1', 'aimed at the template', 'type-developer');
  const block = await file('rev1', 'aimed at a block id', 'developer-change');
  const done = await file('dev1', 'done one', 'none', { status: 'done' });
  const dup = await file('dev1', 'duplicate', 'none', { status: 'duplicate' });
  const wont = await file('dev1', 'wont do', 'none', { status: 'wont_do' });
  const other = await file('rev1', 'someone else', 'type-reviewer');
  const word = await file('rev1', 'near miss', 'type-developer-x');
  const view = await digest.retrosOfType('developer');
  const keys = view.items.map((x) => x.key);
  assert.deepEqual(new Set(keys), new Set([own, evidence, aimed, block, done].map((x) => x.key)));
  assert.equal(keys[0], evidence.key, 'evidence ranks first');
  assert.ok(!keys.includes(dup.key) && !keys.includes(wont.key) && !keys.includes(other.key) && !keys.includes(word.key));
  assert.equal(view.items.find((x) => x.key === done.key).status, 'done');
});

test('a reporter whose agent is gone is read from the Reporter line', async () => {
  const retros = (await itsa.list({ kind: 'retros' }))[0];
  const x = await itsa.create({ title: 'gone', kind: 'retro', status: 'idea', parent: retros.id, body: 'Kind: idea\nTarget: none\nReporter: ghost (claude-opus-5-5, reviewer)\n\nd', by: 'human' });
  assert.ok((await digest.retrosOfType('reviewer')).items.some((i) => i.key === x.key));
  assert.ok(!(await digest.retrosOfType('developer')).items.some((i) => i.key === x.key));
});

test('a type without a memory block renders byte-identical to its template, and gets no memory', () => {
  const dev = db.getAgent('dev1');
  const fixture = readFileSync(join(root, 'test', 'fixtures', 'templates', 'type-developer.md'), 'utf8');
  assert.equal(org.typePrompt(dev), fixture.trim());
  assert.equal(blocks.memoryBlock('developer'), undefined);
  assert.equal(blocks.blocksOf('type-developer').some((b) => b.kind === 'memory'), false);
});

test('a memory block renders last in its type\'s instructions, for agents of that type only', () => {
  const before = org.typePrompt(db.getAgent('memtest1'));
  assert.equal(before, '## Your type: memtest\n\nDo the thing.');
  memoryFile('- Run the check before you push.\n');
  assert.equal(org.typePrompt(db.getAgent('memtest1')), `${before}\n\n- Run the check before you push.`);
  assert.ok(!org.typePrompt(db.getAgent('dev1')).includes('Run the check before you push'));
  assert.equal(blocks.memoryBlock('memtest').id, 'memory-memtest');
  assert.deepEqual(blocks.blockIdsOf('memtest'), ['memtest-brief', 'memory-memtest']);
  assert.equal(blocks.memoryProblem('memtest', blocks.memoryBlock('memtest')), null);
});

test('memoryProblem names a wrong kind, scope, title and an oversize block', () => {
  const read = (body, o) => { memoryFile(body, o); return blocks.memoryBlock('memtest'); };
  assert.match(blocks.memoryProblem('memtest', read('x\n', { kind: 'rule' })), /kind memory/);
  assert.match(blocks.memoryProblem('memtest', read('x\n', { scope: 'global' })), /scope type:memtest/);
  assert.match(blocks.memoryProblem('memtest', read('x\n', { title: 'Notes' })), /titled "Before you start"/);
  assert.match(blocks.memoryProblem('memtest', read('x'.repeat(blocks.MEMORY_MAX_CHARS + 1), {})), /over 400/);
  assert.equal(blocks.memoryProblem('memtest', read('x'.repeat(blocks.MEMORY_MAX_CHARS), {})), null);
});

const diff = (type, lines) => `Answers: S-1\n\n\`\`\`diff\ndiff --git a/blocks/type-${type}/99-memory.md b/blocks/type-${type}/99-memory.md\n--- /dev/null\n+++ b/blocks/type-${type}/99-memory.md\n${lines.map((l) => `+${l}`).join('\n')}\n\`\`\``;

test('memoryTypesIn reads the types whose memory file a diff changes', () => {
  assert.deepEqual(loop.memoryTypesIn(diff('developer', ['a'])), ['developer']);
  assert.deepEqual(loop.memoryTypesIn('a plain mention of blocks/type-developer/99-memory.md'), []);
});

test('only a retro steward can write a memory block, in a proposal, within the cap', async () => {
  const body = diff('developer', ['- one line']);
  await assert.rejects(itsa.create({ title: 'p', kind: 'proposal', status: 'idea', body, by: 'dev1' }), /only the retro-steward writes type memory/);
  await assert.rejects(itsa.create({ title: 'i', kind: 'issue', status: 'idea', body, by: 'stew' }), /kind must be proposal/);
  await assert.rejects(itsa.create({ title: 'big', kind: 'proposal', status: 'idea', body: diff('developer', ['x'.repeat(blocks.MEMORY_MAX_CHARS + 10)]), by: 'stew' }), /more than 400 tokens/);
  const ok = await itsa.create({ title: 'ok', kind: 'proposal', status: 'idea', body, by: 'stew' });
  assert.equal(ok.kind, 'proposal');
  // The same edit moved into the body of an existing issue by an agent is refused too.
  const plain = await itsa.create({ title: 'plain', kind: 'issue', status: 'idea', by: 'dev1' });
  await assert.rejects(itsa.set(plain.id, { body }, 'dev1'), /memory block/);
  // The human is not gated, and a proposal stays behind the approval gate.
  await itsa.create({ title: 'by the human', kind: 'proposal', status: 'canceled', body, by: 'human' });
  await assert.rejects(itsa.set(ok.id, { status: 'ready_to_merge' }, 'stew'), /hasn't approved/);
});

test('the steward\'s type block sends improve items to the memory block and names block ids', () => {
  const text = blocks.blocksText('type-retro-steward');
  assert.match(text, /blocks\/type-NAME\/99-memory\.md/);
  assert.match(text, /kind `memory`, title "Before you start", 400 tokens at most/);
  assert.match(text, /`Target:` can be a block id/);
  assert.doesNotMatch(text, /Before you start" list/);
});
