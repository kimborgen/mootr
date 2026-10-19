#!/usr/bin/env node
// Unit tests for the "Your workspace" block (S-895): the index (order, cap, dotfiles, empty,
// missing folder) and the templates carrying it. No model runs.
// Run with `node --test test/workspace-prompt.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STAM_HOME = mkdtempSync(join(tmpdir(), 'stam-ws-unit-'));
const { workspaceIndex, workspacePrompt, WORKSPACE_INDEX_MAX_CHARS } = await import('../src/workspace-prompt.ts');
const { render } = await import('../src/templates.ts');

const dir = () => mkdtempSync(join(tmpdir(), 'stam-ws-dir-'));

test('index lists sorted files with first lines, skips dotfiles', () => {
  const d = dir();
  writeFileSync(join(d, 'b.md'), '\n# B notes\nmore\n');
  writeFileSync(join(d, 'a.md'), 'A first\nsecond');
  writeFileSync(join(d, '.hidden'), 'secret');
  mkdirSync(join(d, 'sub'));
  writeFileSync(join(d, 'sub', 'c.txt'), 'C line');
  assert.equal(workspaceIndex(d), '- `a.md`: A first\n- `b.md`: # B notes\n- `sub/c.txt`: C line');
});

test('index is capped with a +N more files tail', () => {
  const d = dir();
  for (let i = 0; i < 100; i++) writeFileSync(join(d, `f${String(i).padStart(3, '0')}.md`), 'x'.repeat(100));
  const out = workspaceIndex(d);
  assert.ok(out.length <= WORKSPACE_INDEX_MAX_CHARS);
  assert.match(out, /\n\+\d+ more files$/);
  assert.ok(out.startsWith('- `f000.md`'));
});

test('empty and missing folders give an empty index', () => {
  assert.equal(workspaceIndex(dir()), '(empty)');
  assert.equal(workspaceIndex(join(dir(), 'nope')), '(empty)');
});

test('prompt block and the templates', () => {
  const d = dir();
  writeFileSync(join(d, 'notes.md'), 'My notes');
  const ws = workspacePrompt({ personal_workspace: d });
  assert.ok(ws.includes(d) && ws.includes('- `notes.md`: My notes'));
  assert.equal(workspacePrompt({ personal_workspace: null }), '');
  const vars = { id: 'x1', name: 'n', role: 'r', org: '', instructions: '', cost: '', retro: '', lessons: '', itsa: '', requirements: '', human_mail: '' };
  assert.match(render('system-prompt', { ...vars, workspace: ws }), /# Your workspace/);
  assert.doesNotMatch(render('system-prompt', { ...vars, workspace: workspacePrompt({}) }), /Your workspace/);
  for (const t of ['compacted-self', 'compacted-forced'])
    assert.match(render(t, { history: 'h', prompt: 'p', enforce: '1k', workspace: ws }), /# Your workspace/);
});

test('symlinks are not followed and binary first lines are dropped', async () => {
  const { symlinkSync } = await import('node:fs');
  const outside = dir();
  writeFileSync(join(outside, 'secret.md'), 'OUTSIDE');
  const d = dir();
  writeFileSync(join(d, 'ok.md'), 'fine');
  writeFileSync(join(d, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  symlinkSync(join(outside, 'secret.md'), join(d, 'link.md'));
  symlinkSync(outside, join(d, 'linkdir'));
  const out = workspaceIndex(d);
  assert.equal(out, '- `blob.bin`\n- `ok.md`: fine');
  assert.ok(!out.includes('OUTSIDE') && !out.includes('secret'));
});

test('a UTF-8 line cut mid-character at the read limit is still text', () => {
  const d = dir();
  writeFileSync(join(d, 'long.md'), 'a' + 'é'.repeat(300));
  const out = workspaceIndex(d);
  assert.ok(out.startsWith('- `long.md`: aéé'));
});
