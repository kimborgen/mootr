#!/usr/bin/env node
// The inventory block splitter (S-877): markdown split at its headings (# to ###) with the
// heading path kept, a heading inside a code fence left as text, a block under ~50 tokens merged
// into the next block of the same part, and stable ids and sha256 hashes. Free: no daemon and no
// model. `node --test test/inventory-block.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

// src/inventory.ts imports the daemon's modules (config, settings), which read STAM_HOME at import.
const home = tempHome('stam-inventory-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let estimateTokens, splitIntoBlocks, partBlocks;
before(async () => ({ estimateTokens, splitIntoBlocks, partBlocks } = await import('../src/inventory.ts')));
after(() => rmSync(home, { recursive: true, force: true }));

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
// A body long enough that its block is over the ~50-token merge threshold.
const BIG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');

test('a part with no heading is one block, titled by the fallback', () => {
  const blocks = partBlocks('sys', 'Just one paragraph.', 'text', 'Role');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].headingPath, []);
  assert.equal(blocks[0].title, 'Role');
  assert.equal(blocks[0].id, 'sys:role');
  assert.equal(blocks[0].format, 'text');
  assert.equal(blocks[0].tokens, estimateTokens('Just one paragraph.'));
});

test('headings # to ### split a part and keep the heading path', () => {
  const text = ['# One', BIG, '## Two', BIG, '### Three', BIG].join('\n');
  const blocks = partBlocks('sys', text, 'markdown', 'System');
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.headingPath), [['One'], ['One', 'Two'], ['One', 'Two', 'Three']]);
  assert.deepEqual(blocks.map((b) => b.title), ['One', 'Two', 'Three']);
  assert.deepEqual(blocks.map((b) => b.id), ['sys:one', 'sys:one-two', 'sys:one-two-three']);
});

test('text before the first heading is its own block and merges forward when tiny', () => {
  const blocks = partBlocks('sys', `intro\n# Big\n${BIG}`, 'markdown', 'System');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].headingPath, ['Big']);
  assert.match(blocks[0].text, /^intro\n# Big\n/);
});

test('a heading inside a code fence is text, not a heading', () => {
  const text = ['# A', BIG, '```ts', '# not a heading', '```', '', '# B', BIG].join('\n');
  const blocks = partBlocks('sys', text, 'markdown', 'System');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.headingPath), [['A'], ['B']]);
  assert.match(blocks[0].text, /# not a heading/);
});

test('a block under ~50 tokens merges into the next block in the same part', () => {
  const text = ['# Small', 'x', '# Big', BIG].join('\n');
  const blocks = partBlocks('sys', text, 'markdown', 'System');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].headingPath, ['Big']);
  assert.match(blocks[0].text, /^# Small\nx\n# Big\n/);
});

test('a tiny final block has nothing after it and stays as it is', () => {
  const text = ['# Big', BIG, '# Small', 'y'].join('\n');
  const blocks = partBlocks('sys', text, 'markdown', 'System');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.headingPath), [['Big'], ['Small']]);
});

test('a repeated heading path gets a -2 id, and ids and hashes are stable', () => {
  const text = ['# Dup', BIG, '# Dup', BIG].join('\n');
  const first = partBlocks('sys', text, 'markdown', 'System');
  assert.deepEqual(first.map((b) => b.id), ['sys:dup', 'sys:dup-2']);
  assert.equal(first[0].hash, sha(first[0].text));
  assert.equal(first[0].tokens, Math.ceil(first[0].text.length / 4));
  // The same text gives the same ids and hashes, so a summary can be cached on them.
  const again = partBlocks('sys', text, 'markdown', 'System');
  assert.deepEqual(again.map((b) => [b.id, b.hash]), first.map((b) => [b.id, b.hash]));
});

test('a root heading path (a file shown whole) prefixes every block', () => {
  const blocks = partBlocks('files', `# Repo\n${BIG}`, 'markdown', 'CLAUDE.md', ['CLAUDE.md']);
  assert.deepEqual(blocks[0].headingPath, ['CLAUDE.md', 'Repo']);
  assert.equal(blocks[0].title, 'Repo');
  assert.equal(blocks[0].id, 'files:claude-md-repo');
});

test('an empty or whitespace-only part has no blocks', () => {
  assert.deepEqual(partBlocks('sys', '   \n\n', 'markdown', 'System'), []);
});

test('estimateTokens rounds characters/4 up', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});