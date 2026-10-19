#!/usr/bin/env node
// Unit tests for block files (S-883, src/blocks.ts, blocks/system-prompt/): the prompt built from
// the blocks is byte-identical to the old single template (test/fixtures/system-prompt.main.md)
// for every agent shape; a user override under STAM_HOME/templates still wins; every block has
// frontmatter whose summary_of matches its body, a two-line summary and a size of 50 to 400 tokens (a slots-only context block can be shorter).
// Run with `node --test test/blocks.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-blocks-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const { render, template, listTemplates } = await import('../src/templates.ts');
const { blocksOf, blockHash, parseBlock, memoryBlock, memoryProblem } = await import('../src/blocks.ts');
const { humanMailPrompt } = await import('../src/templates.ts');

const old = readFileSync(join(import.meta.dirname, 'fixtures', 'system-prompt.main.md'), 'utf8');
// What render did before: the template text with placeholders replaced, then trimmed.
const oldRender = (vars) => old.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? '')).trim();

const shapes = {
  developer: { id: 'a1', name: 'alice', machine: 'storage', role: 'developer', org: 'Your parent is x.', instructions: '## Your type: developer\nSmall.', cost: '', retro: render('retro', {}), lessons: '- a lesson', workspace: 'Your workspace: /w', itsa: 'ITSA text', requirements: 'req', human_mail: humanMailPrompt(null) },
  cos: { id: 'cos', name: 'cos', machine: 'host1', role: 'chief of staff', org: '', instructions: 'cos brief', cost: 'cost notes', retro: render('retro', {}), lessons: '', workspace: 'ws', itsa: '', requirements: '', human_mail: humanMailPrompt(undefined) },
  assistant: { id: 'as', name: 'assistant', role: 'not set', org: '', instructions: '', cost: '', retro: '', lessons: '', itsa: '', requirements: '', human_mail: '' },
  restricted: { id: 'r1', name: 'bob', role: 'reviewer', org: 'o', instructions: 'i', cost: '', retro: '', lessons: '', itsa: 'x', requirements: '', human_mail: render('mail-to-human-restricted', {}) },
  // A harness-specific instructions block, as each adapter passes it.
  claude: { id: 'c1', name: 'c', role: 'r', org: '', instructions: 'claude: use skills', cost: '', retro: '', lessons: '', itsa: '', requirements: '', human_mail: 'm' },
  codex: { id: 'x1', name: 'x', role: 'r', org: '', instructions: 'codex: no skills', cost: '', retro: '', lessons: '', itsa: '', requirements: '', human_mail: 'm' },
  opencode: { id: 'o1', name: 'o', role: 'r', org: '', instructions: 'opencode', cost: '', retro: '', lessons: '', itsa: '', requirements: '', human_mail: 'm' },
  missing: { id: 'm1', name: 'm' },
};

test('the template built from blocks is the old template, byte for byte', () => {
  assert.equal(template('system-prompt'), old);
});

for (const [shape, vars] of Object.entries(shapes)) {
  test(`system-prompt renders the same as before for ${shape}`, () => {
    assert.equal(render('system-prompt', vars), oldRender(vars));
  });
}

// The agent's own machine (its registry record's machine) is named in its prompt, so an agent on
// storage doesn't take another machine's line from its harness instructions for its own.
test('the system prompt names the machine the agent runs on', () => {
  for (const machine of ['storage', 'host1']) {
    const text = render('system-prompt', { ...shapes.developer, machine });
    assert.ok(text.includes(`You run on ${machine}, and your tests run there too`), `${machine} not named`);
    const other = machine === 'storage' ? 'host1' : 'storage';
    assert.ok(!text.includes(`You run on ${other}`), `${other} named for a ${machine} agent`);
  }
});

test('a whole-file override under STAM_HOME/templates wins over the blocks', () => {
  mkdirSync(join(home, 'templates'), { recursive: true });
  writeFileSync(join(home, 'templates', 'system-prompt.md'), 'OVERRIDE {{id}}\n');
  assert.equal(render('system-prompt', { id: 'z' }), 'OVERRIDE z');
  const row = listTemplates().find((t) => t.name === 'system-prompt');
  assert.equal(row.overridden, true);
  assert.equal(row.default, old);
  rmFile(join(home, 'templates', 'system-prompt.md'));
  assert.equal(template('system-prompt'), old);
});

import { rmSync } from 'node:fs';
const rmFile = (p) => rmSync(p, { force: true });

test('every block has frontmatter, a current summary_of, a two-line summary and 50-400 tokens', () => {
  const blocks = blocksOf('system-prompt');
  assert.ok(blocks.length >= 6);
  const ids = new Set();
  for (const b of blocks) {
    assert.ok(!ids.has(b.id), `duplicate id ${b.id}`);
    ids.add(b.id);
    assert.equal(b.summary_of, blockHash(b.body), `summary stale: blocks/system-prompt/${b.file} (new summary_of ${blockHash(b.body)}; run node scripts/refresh-derived.mjs)`);
    assert.ok(b.summary.split('\n').length <= 2, `summary of ${b.id} over two lines`);
    assert.equal(b.scope, 'global');
    const tokens = b.body.length / 4;
    assert.ok((b.kind === 'context' || tokens >= 50) && tokens <= 400, `${b.id} is ${Math.round(tokens)} tokens`);
  }
});

test('a placeholder added to a block renders like one in the old template', () => {
  assert.throws(() => parseBlock('x.md', 'no header'), /no frontmatter/);
  const b = parseBlock('x.md', '---\nid: a\ntitle: t\nsummary: |\n  one\n  two\nscope: global\nkind: rule\napplies: [claude, codex]\nsummary_of: h\n---\nHello {{workspace}}\n');
  assert.deepEqual(b.applies, ['claude', 'codex']);
  assert.equal(b.summary, 'one\ntwo');
  assert.equal(b.body, 'Hello {{workspace}}\n');
});

test('a block file with CRLF line endings parses like one with LF', () => {
  const lf = '---\nid: a\ntitle: t\nsummary: |\n  one\nscope: global\nkind: rule\nsummary_of: h\n---\nBody\nmore\n';
  const b = parseBlock('x.md', lf.replace(/\n/g, '\r\n'));
  assert.equal(b.id, 'a');
  assert.equal(b.summary, 'one');
  assert.equal(b.body, 'Body\nmore\n');
});

// type-memtest and type-skilltest are test/type-memory.test.mjs's and test/type-skills.test.mjs's own throwaway types, skipped here.
test('every shipped memory block is valid for its type and has a current summary_of', () => {
  for (const dir of readdirSync(join(import.meta.dirname, '..', 'blocks')).filter((d) => d.startsWith('type-') && !['type-memtest', 'type-skilltest'].includes(d))) {
    const type = dir.slice(5);
    const b = memoryBlock(type);
    if (!b) continue;
    assert.equal(memoryProblem(type, b), null);
    assert.equal(b.summary_of, blockHash(b.body), `summary stale: blocks/${dir}/${b.file}`);
    assert.ok(b.summary.split('\n').length <= 2, `${b.id} summary over two lines`);
  }
});
