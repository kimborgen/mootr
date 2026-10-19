#!/usr/bin/env node
// Per-type composition of blocks (S-886, src/blocks.ts, src/agent-types.ts): a type's
// `blocks: { off, replace }` drops or swaps global blocks in its agents' prompts and in the
// inventory; no `blocks` field leaves every prompt byte-identical; saveType rejects unknown ids.
// Run with `node --test test/blocks-compose.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-compose-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const { render, template } = await import('../src/templates.ts');
const { saveType } = await import('../src/agent-types.ts');
const { composedText, blocksText, allBlocks } = await import('../src/blocks.ts');
const { typeInventory } = await import('../src/inventory.ts');

// Replacement files live in blocks/_replace/ (not a template); the test's own files are removed at exit.
const repDir = join(import.meta.dirname, '..', 'blocks', '_replace');
const NC = `zz-noncomp-${process.pid}`;
const noncomp = join(import.meta.dirname, '..', 'blocks', `zz-compose-test-${process.pid}`);
mkdirSync(repDir, { recursive: true });
mkdirSync(noncomp, { recursive: true });
const swap = join(repDir, `compose-test-${process.pid}.md`);
const link = join(repDir, `compose-link-${process.pid}.md`);
const outside = join(home, 'outside.md');
const FM = '---\nid: swap\ntitle: Swapped\nsummary: |\n  A swap.\nscope: type\nkind: rule\nsummary_of: x\n---\nSWAPPED RULE\n';
writeFileSync(outside, FM);
symlinkSync(outside, link);
writeFileSync(join(noncomp, '10-a.md'), `---\nid: ${NC}\ntitle: T\nsummary: |\n  S.\nscope: global\nkind: rule\nsummary_of: x\n---\nbody\n`);
process.on('exit', () => {
  for (const f of [swap, link]) rmSync(f, { force: true });
  rmSync(noncomp, { recursive: true, force: true });
  if (existsSync(repDir) && !readdirSync(repDir).length) rmSync(repDir, { recursive: true });
});
writeFileSync(swap, FM);
const WAIT = 'waiting-and-subscribing';
const TRUST = 'stam-mcp-and-trust';
const bodyOf = (id) => allBlocks().get(id).block.body;

test('a type without blocks gets the global text, byte for byte', () => {
  saveType('plain', { description: 'd', harness: 'claude' });
  assert.equal(template('system-prompt', 'plain'), template('system-prompt'));
  assert.equal(template('system-prompt', null), blocksText('system-prompt'));
  assert.equal(composedText('system-prompt', {}), blocksText('system-prompt'));
  assert.equal(composedText('system-prompt', { off: [], replace: {} }), blocksText('system-prompt'));
});

test('off drops the block and nothing else', () => {
  saveType('quiet', { description: 'd', harness: 'claude', blocks: { off: [WAIT] } });
  const t = template('system-prompt', 'quiet');
  assert.equal(t, template('system-prompt').replace(bodyOf(WAIT), ''));
  assert.ok(!t.includes(bodyOf(WAIT)));
  assert.equal(template('system-prompt', 'plain'), template('system-prompt'));
});

test('replace swaps the block body for the file body, in place', () => {
  saveType('swapper', { description: 'd', harness: 'claude', blocks: { replace: { [TRUST]: swap } } });
  const t = template('system-prompt', 'swapper');
  assert.equal(t, template('system-prompt').replace(bodyOf(TRUST), 'SWAPPED RULE\n'));
  assert.match(render('system-prompt', { id: 'a' }, 'swapper'), /SWAPPED RULE/);
});

test('saveType rejects unknown block ids, a missing file, and off plus replace', () => {
  assert.throws(() => saveType('bad1', { description: 'd', harness: 'claude', blocks: { off: ['nope'] } }), /unknown block id nope/);
  assert.throws(() => saveType('bad2', { description: 'd', harness: 'claude', blocks: { replace: { nope: swap } } }), /unknown block id nope/);
  assert.throws(() => saveType('bad3', { description: 'd', harness: 'claude', blocks: { replace: { [TRUST]: join(home, 'gone.md') } } }), /replacement for/);
  assert.throws(() => saveType('bad4', { description: 'd', harness: 'claude', blocks: { off: [TRUST], replace: { [TRUST]: swap } } }), /both off and replaced/);
});

test('saveType confines a replacement to blocks/: absolute, ../ and symlink out are rejected', () => {
  const bad = (p) => assert.throws(() => saveType('conf', { description: 'd', harness: 'claude', blocks: { replace: { [TRUST]: p } } }), /replacement for/);
  bad(outside);
  bad('blocks/../package.json');
  bad(link);
  bad('../outside.md');
});

test('a registry edited by hand cannot reach outside blocks/ or break a render', () => {
  const reg = (blocks) => writeFileSync(join(home, 'registry.json'), JSON.stringify({ types: { hand: { description: 'd', harness: 'claude', model: null, effort: null, blocks } } }));
  const globalText = template('system-prompt');
  for (const p of [outside, link, 'blocks/../package.json', join(repDir, 'gone.md')]) {
    reg({ replace: { [TRUST]: p } });
    assert.equal(template('system-prompt', 'hand'), globalText, p);
    const flags = typeInventory('hand').flags.filter((f) => f.kind === 'composition-ignored');
    assert.equal(flags.length, 1, p);
    assert.ok(typeInventory('hand').layers[0].blocks.every((b) => !b.state));
  }
});

test('an id from a template that does not compose is rejected, and ignored with a flag when hand-edited', () => {
  assert.throws(() => saveType('nc', { description: 'd', harness: 'claude', blocks: { off: [NC] } }), new RegExp(`unknown block id ${NC}`));
  writeFileSync(join(home, 'registry.json'), JSON.stringify({ types: { hand2: { description: 'd', harness: 'claude', model: null, effort: null, blocks: { off: [NC] } } } }));
  const inv = typeInventory('hand2');
  assert.equal(inv.flags.filter((f) => f.kind === 'composition-ignored').length, 1);
  assert.ok(inv.layers[0].blocks.every((b) => !b.state));
});

test('the inventory marks off, replaced and replaces entries without adding tokens', () => {
  saveType('plain', { description: 'd', harness: 'claude' });
  saveType('both', { description: 'd', harness: 'claude', blocks: { off: [WAIT], replace: { [TRUST]: swap } } });
  const inv = typeInventory('both');
  const sp = inv.layers.find((l) => l.key === 'system-prompt');
  const by = (s) => sp.blocks.filter((b) => b.state === s);
  assert.deepEqual(by('off').map((b) => b.by), ['both']);
  assert.equal(by('replaced').length, 1);
  assert.equal(by('replaces').length, 1);
  assert.match(by('replaces')[0].text, /SWAPPED RULE/);
  assert.equal(sp.tokens, sp.blocks.filter((b) => !b.state).reduce((n, b) => n + b.tokens, 0));
  const plain = typeInventory('plain').layers.find((l) => l.key === 'system-prompt');
  assert.ok(plain.blocks.every((b) => !b.state));
});

test('a malformed blocks field is ignored by the render and flagged by the inventory', () => {
  for (const bad of [{ off: 5 }, { off: 'retro-record' }, { off: [1, null] }, { replace: [] }, { replace: { x: 3 } }, 'x', 7]) {
    assert.equal(composedText('system-prompt', bad), blocksText('system-prompt'), JSON.stringify(bad));
  }
  writeFileSync(join(home, 'registry.json'), JSON.stringify({ types: { odd: { description: 'd', harness: 'claude', model: null, effort: null, blocks: { off: 5 } } } }));
  assert.equal(template('system-prompt', 'odd'), template('system-prompt'));
  const inv = typeInventory('odd');
  assert.equal(inv.flags.filter((f) => f.kind === 'composition-ignored').length, 1);
});

test('composition is not shown for a template a whole file overrides, or for the mail rules the model does not get', async () => {
  const { patchSettings } = await import('../src/settings.ts');
  const { mkdirSync: mk } = await import('node:fs');
  saveType('ovr', { description: 'd', harness: 'claude', model: 'm-restricted', blocks: { off: ['retro-record', 'mail-human-when'] } });
  const flagsOf = () => typeInventory('ovr').flags.filter((f) => f.kind === 'composition-ignored');
  const states = () => typeInventory('ovr').layers[0].blocks.filter((b) => b.state).map((b) => b.id);
  // The model gets the full mail rules, and retro is built from blocks: both switches show.
  assert.equal(flagsOf().length, 0);
  assert.equal(states().length, 2);
  // Retro overridden by a whole file: its switch is ignored and flagged.
  mk(join(home, 'templates'), { recursive: true });
  writeFileSync(join(home, 'templates', 'retro.md'), 'my retro');
  assert.equal(flagsOf().length, 1);
  assert.equal(states().length, 1);
  rmSync(join(home, 'templates', 'retro.md'));
  // A model that may not mail the human gets the restricted rules, so a mail-to-human block switch is ignored.
  patchSettings({ humanMail: { models: { 'm-restricted': false } } });
  assert.equal(flagsOf().length, 1);
  assert.equal(states().length, 1);
});

test('order reorders a template\'s blocks, ignores unlisted ids, and saveType rejects unknown ones (S-892)', () => {
  const ids = [...allBlocks()].filter(([, v]) => v.template === 'system-prompt').map(([id]) => id);
  assert.ok(ids.length >= 3);
  const flipped = [...ids].reverse();
  saveType('ordered', { description: 'd', harness: 'claude', blocks: { order: flipped } });
  assert.equal(composedText('system-prompt', { order: flipped }), flipped.map(bodyOf).join(''));
  // A partial order puts the listed block first and keeps the rest in filename order.
  const last = ids[ids.length - 1];
  assert.equal(composedText('system-prompt', { order: [last] }), bodyOf(last) + ids.slice(0, -1).map(bodyOf).join(''));
  assert.equal(composedText('system-prompt', { order: [] }), blocksText('system-prompt'));
  assert.throws(() => saveType('ordered2', { description: 'd', harness: 'claude', blocks: { order: ['nope'] } }), /unknown block id nope/);
  assert.throws(() => saveType('ordered2', { description: 'd', harness: 'claude', blocks: { order: 'x' } }), /must be a list/);
  assert.throws(() => saveType('ordered2', { description: 'd', harness: 'claude', blocks: { order: [ids[0], ids[0]] } }), /twice/);
});

test('the composer catalog lists the composing blocks with tokens and the replacement files', async () => {
  const { composerCatalog } = await import('../src/inventory.ts');
  const c = composerCatalog();
  assert.ok(c.blocks.every((b) => b.tokens > 0 && b.rendered));
  assert.deepEqual(new Set(c.blocks.map((b) => b.id)), new Set(allBlocks().keys()));
  assert.ok(c.replacements.some((r) => r.path === `blocks/_replace/compose-test-${process.pid}.md` && r.id === 'swap'));
  assert.ok(!c.replacements.some((r) => r.path.includes('compose-link')), 'a symlink out of blocks/ is not offered');
});

test('the composer catalog marks the mail rules the type\'s agent does not get as not applying', async () => {
  const { composerCatalog } = await import('../src/inventory.ts');
  const { patchSettings } = await import('../src/settings.ts');
  saveType('mailer', { description: 'd', harness: 'claude', model: 'm-mailer' });
  const applies = (c) => Object.fromEntries(['mail-to-human', 'mail-to-human-restricted'].map((t) => [t, c.blocks.filter((b) => b.template === t).every((b) => b.applies)]));
  assert.deepEqual(applies(composerCatalog('mailer')), { 'mail-to-human': true, 'mail-to-human-restricted': false });
  patchSettings({ humanMail: { models: { 'm-mailer': false } } });
  assert.deepEqual(applies(composerCatalog('mailer')), { 'mail-to-human': false, 'mail-to-human-restricted': true });
  // On another harness the type's model is dropped, so the full rules apply again.
  assert.deepEqual(applies(composerCatalog('mailer', 'codex')), { 'mail-to-human': true, 'mail-to-human-restricted': false });
  assert.deepEqual(applies(composerCatalog()), { "mail-to-human": true, "mail-to-human-restricted": false }, "with no type the full rules apply");
});
