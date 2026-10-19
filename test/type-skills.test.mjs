#!/usr/bin/env node
// Unit tests for per-type skills (S-891, src/org.ts typeSegments, src/instructions.ts typeSkillsBlock,
// src/agent-types.ts saveType): a type's `skills` become a "Skills available" block in its slot, after
// the type's blocks and before its memory block, with the absolute SKILL.md path; a type without skills
// renders byte-identical; an unknown skill is rejected on save; a skill that disappears is skipped and
// flagged in the inventory, never thrown on; the block shows in the inventory's system-prompt layer.
// Throwaway HOME and STAM_HOME, no daemon, no model. Run with `node --test test/type-skills.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, tempHome } from './tmphome.mjs';

const home = tempHome('stam-type-skills-');
const user = tempDir('stam-type-skills-user-');
process.env.STAM_HOME = home;
process.env.HOME = user;
process.env.STAM_TMUX_SOCKET = `type-skills-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'STAM_AGENTS_SKILLS']) delete process.env[k];

const root = join(import.meta.dirname, '..');
const slotDir = join(root, 'blocks', 'type-skilltest');
const fm = (id, title, scope, kind) => `---\nid: ${id}\ntitle: ${title}\nsummary: |\n  Notes.\n  Two lines.\nscope: ${scope}\nkind: ${kind}\nsummary_of: x\n---\n`;
let db, org, types, ins, inv, blocks;
const skill = (dir, name, description) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
};
const agentOf = (type) => ({ id: 'a1', name: 'a-one', role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: null, type });

before(async () => {
  skill(join(user, '.claude', 'skills'), 'user-style', 'How to write to the user.');
  skill(join(home, 'skills'), 'tidy', 'Tidy up scratch files.');
  db = await import('../src/db.ts');
  org = await import('../src/org.ts');
  types = await import('../src/agent-types.ts');
  ins = await import('../src/instructions.ts');
  inv = await import('../src/inventory.ts');
  blocks = await import('../src/blocks.ts');
  db.open();
  rmSync(slotDir, { recursive: true, force: true });
  mkdirSync(slotDir, { recursive: true });
  writeFileSync(join(slotDir, '10-brief.md'), fm('skilltest-brief', 'Brief', 'type:skilltest', 'rule') + '## Your type: skilltest\n\nDo the thing.\n');
  writeFileSync(join(slotDir, '99-memory.md'), fm('memory-skilltest', 'Before you start', 'type:skilltest', 'memory') + 'REMEMBER THIS.\n');
});
after(() => rmSync(slotDir, { recursive: true, force: true }));

const save = (skills) => types.saveType('skilltest', { description: 'Tests.', harness: 'claude', ...(skills === undefined ? {} : { skills }) });
const asAgent = () => ({ ...agentOf('skilltest') });

test('a type without skills renders byte-identical to the template', () => {
  save();
  const plain = org.typePrompt(asAgent());
  assert.ok(plain.includes('Do the thing.') && plain.endsWith('REMEMBER THIS.'));
  assert.ok(!plain.includes('Skills available'));
  assert.deepEqual(org.typeSegments(asAgent()).map((s) => s.key), ['type']);
  save([]);
  assert.equal(org.typePrompt(asAgent()), plain);
  assert.equal(types.agentTypes().skilltest.skills, undefined);
});

test('saveType rejects an unknown skill and a non-list; known names are kept once', () => {
  assert.throws(() => save(['nope']), /unknown skill nope/);
  assert.throws(() => save('tidy'), /skills must be a list/);
  assert.throws(() => save([1]), /skills must be a list/);
  save(['tidy', 'user-style', 'tidy']);
  assert.deepEqual(types.agentTypes().skilltest.skills, ['tidy', 'user-style']);
});

test('the Skills available block sits after the type blocks and before the memory, with absolute SKILL.md paths', () => {
  save(['tidy', 'user-style']);
  const text = org.typePrompt(asAgent());
  const at = (s) => text.indexOf(s);
  assert.ok(at('Do the thing.') >= 0 && at('Do the thing.') < at('## Skills available') && at('## Skills available') < at('REMEMBER THIS.'));
  assert.ok(text.includes(`- tidy: Tidy up scratch files. (${join(home, 'skills', 'tidy', 'SKILL.md')})`));
  assert.ok(text.includes(`- user-style: How to write to the user. (${join(user, '.claude', 'skills', 'user-style', 'SKILL.md')})`));
  assert.match(text, /read its SKILL\.md/);
  assert.deepEqual(org.typeSegments(asAgent()).map((s) => s.key), ['type', 'skills', 'memory']);
});

test('a stored skill that is no longer installed does not block saving the type; a new unknown one still does', () => {
  save(['tidy']);
  rmSync(join(home, 'skills', 'tidy'), { recursive: true });
  assert.doesNotThrow(() => types.saveType('skilltest', { description: 'Edited.', harness: 'claude', skills: ['tidy'] }));
  assert.equal(types.agentTypes().skilltest.description, 'Edited.');
  assert.throws(() => save(['tidy', 'ghost']), /unknown skill ghost/);
  skill(join(home, 'skills'), 'tidy', 'Tidy up scratch files.');
});

test('another type is untouched by a type\'s skills', () => {
  save(['tidy']);
  assert.ok(!org.typePrompt(agentOf('developer')).includes('Skills available'));
  assert.equal(org.typePrompt({ ...agentOf(null) }), '');
});

test('a skill that disappears is skipped and flagged, never a throw', () => {
  save(['tidy', 'user-style']);
  rmSync(join(home, 'skills', 'tidy'), { recursive: true });
  const text = org.typePrompt(asAgent());
  assert.ok(text.includes('user-style') && !text.includes('tidy'));
  const i = inv.typeInventory('skilltest');
  assert.ok(i.flags.some((f) => f.kind === 'type-skill-missing' && f.message.includes('tidy')));
  assert.deepEqual(types.agentTypes().skilltest.skills, ['tidy', 'user-style']);
  rmSync(join(user, '.claude', 'skills', 'user-style'), { recursive: true });
  assert.ok(!org.typePrompt(asAgent()).includes('Skills available'));
  assert.ok(org.typePrompt(asAgent()).endsWith('REMEMBER THIS.'));
  skill(join(home, 'skills'), 'tidy', 'Tidy up scratch files.');
  skill(join(user, '.claude', 'skills'), 'user-style', 'How to write to the user.');
});

test('the inventory lists the block in the system-prompt layer with its tokens', () => {
  save(['tidy']);
  const i = inv.typeInventory('skilltest');
  const layer = i.layers.find((l) => l.key === 'system-prompt');
  const b = layer.blocks.find((x) => x.text.includes('## Skills available') || x.title.includes('Skills available'));
  assert.ok(b && b.tokens > 0 && b.text.includes('tidy'));
  assert.ok(!i.flags.some((f) => f.kind === 'type-skill-missing'));
  save();
  assert.ok(!inv.typeInventory('skilltest').layers.find((l) => l.key === 'system-prompt').blocks.some((x) => x.text.includes('Skills available')));
});

test('a very long description is cut', () => {
  skill(join(home, 'skills'), 'wordy', 'w'.repeat(1000));
  const { text } = ins.typeSkillsBlock(['wordy']);
  assert.ok(text.length < 600 && text.includes('…'));
});
