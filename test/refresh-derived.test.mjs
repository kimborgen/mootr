#!/usr/bin/env node
// Tests for scripts/refresh-derived.mjs (S-1371): the files derived from blocks/ and registry/ text
// (summary_of, the template fixtures, the golden briefs, the override manifest). The real tree must
// be current; a copy of it, after a block edit, is stale until the refresh writes it, and then the
// block tests pass again. The copy is in a temp folder, so the real tree is never written.
// Run with `node --test test/refresh-derived.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Not copied: the dependencies (linked instead), the git folder, the web app and the Claude settings.
const LEFT_OUT = new Set(['node_modules', '.git', 'web', '.claude']);
const TESTS = ['test/blocks.test.mjs', 'test/template-blocks.test.mjs', 'test/process-briefs.test.mjs', 'test/export-overrides.test.mjs'];

// The copy is a git repository with one commit, so a port (an edit of the generic text since that commit) is visible to the script.
function copyTree() {
  const t = tempDir('stam-refresh-derived-tree-');
  cpSync(ROOT, t, { recursive: true, filter: (src) => !LEFT_OUT.has(relative(ROOT, src).split('/')[0]) });
  symlinkSync(join(ROOT, 'node_modules'), join(t, 'node_modules'), 'dir');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=stam', '-c', 'user.email=stam@localhost', 'commit', '-q', '-m', 'base']]) {
    const r = spawnSync('git', ['-C', t, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, out(r));
  }
  return t;
}
const refresh = (t, ...a) => spawnSync('node', [join(t, 'scripts', 'refresh-derived.mjs'), ...a], { encoding: 'utf8', cwd: t });
const applyCheck = (t) => spawnSync('node', [join(t, 'export', 'apply-overrides.mjs'), '--check', t], { encoding: 'utf8' });
const out = (r) => `${r.stdout}${r.stderr}`;

test('the shipped text is current: --check passes on this tree', () => {
  const r = refresh(ROOT, '--check');
  assert.equal(r.status, 0, out(r));
});

test('a block edit is stale until the refresh writes its derived files, and then the block tests pass', () => {
  const t = copyTree();
  assert.equal(refresh(t, '--check').status, 0, 'the copy starts current');
  const block = join(t, 'blocks', 'itsa', '10-itsa-what.md');
  const fixture = join(t, 'test', 'fixtures', 'templates', 'itsa.md');
  const fixtureBefore = readFileSync(fixture, 'utf8');
  appendFileSync(block, 'A sentence the summary does not cover.\n');
  const blockEdited = readFileSync(block, 'utf8');

  const stale = refresh(t, '--check');
  assert.equal(stale.status, 1, out(stale));
  assert.match(out(stale), /blocks\/itsa\/10-itsa-what\.md \(summary_of\)/);
  assert.match(out(stale), /test\/fixtures\/templates\/itsa\.md \(fixture\)/);
  assert.match(out(stale), /export\/overrides\/manifest\.json \(manifest: template itsa, not ported\)/);
  assert.match(out(stale), /template itsa changed/);
  // --check changed nothing.
  assert.equal(readFileSync(fixture, 'utf8'), fixtureBefore);
  assert.equal(readFileSync(block, 'utf8'), blockEdited);

  // The generic text is ported first, so the refresh can write the new hash.
  appendFileSync(join(t, 'export', 'overrides', 'templates', 'itsa.md'), 'Ported for the test.\n');
  const fix = refresh(t);
  assert.equal(fix.status, 0, out(fix));
  assert.doesNotMatch(out(fix), /port this into/);
  assert.match(readFileSync(fixture, 'utf8'), /A sentence the summary does not cover\./);

  assert.equal(refresh(t, '--check').status, 0, out(refresh(t, '--check')));
  assert.equal(applyCheck(t).status, 0, out(applyCheck(t)));
  const tests = spawnSync('node', ['--test', ...TESTS], { encoding: 'utf8', cwd: t });
  assert.equal(tests.status, 0, out(tests));
});

test('a block edit without a port keeps its manifest hash: the refresh exits 1 and apply-overrides keeps refusing', () => {
  const t = copyTree();
  const manifest = join(t, 'export', 'overrides', 'manifest.json');
  const manifestBefore = readFileSync(manifest, 'utf8');
  appendFileSync(join(t, 'blocks', 'itsa', '10-itsa-what.md'), 'A sentence the summary does not cover.\n');

  const r = refresh(t);
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /port this into export\/overrides\/templates\/itsa\.md, then rerun/);
  assert.equal(readFileSync(manifest, 'utf8'), manifestBefore);
  assert.equal(applyCheck(t).status, 1, out(applyCheck(t)));

  appendFileSync(join(t, 'export', 'overrides', 'templates', 'itsa.md'), 'Ported for the test.\n');
  const rerun = refresh(t);
  assert.equal(rerun.status, 0, out(rerun));
  assert.notEqual(readFileSync(manifest, 'utf8'), manifestBefore);
  assert.equal(refresh(t, '--check').status, 0, out(refresh(t, '--check')));
  assert.equal(applyCheck(t).status, 0, out(applyCheck(t)));
});

// S-1493: registry-types.json keeps its types at the top level, so a port there must count.
test('a registry brief edit counts as ported once its generic brief in registry-types.json changes', () => {
  const t = copyTree();
  const manifest = join(t, 'export', 'overrides', 'manifest.json');
  const manifestBefore = readFileSync(manifest, 'utf8');
  const edit = (rel, f) => {
    const p = join(t, rel);
    const j = JSON.parse(readFileSync(p, 'utf8'));
    f(j);
    writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  };
  edit('registry/defaults.json', (j) => { j.types.reviewer.brief += ' A sentence for the test.'; });

  const r = refresh(t);
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /port this into export\/overrides\/registry-types\.json, then rerun: the manifest hash for type reviewer/);
  assert.equal(readFileSync(manifest, 'utf8'), manifestBefore);

  edit('export/overrides/registry-types.json', (j) => { j.reviewer.brief += ' Ported for the test.'; });
  const rerun = refresh(t);
  assert.equal(rerun.status, 0, out(rerun));
  assert.doesNotMatch(out(rerun), /port this into/);
  assert.notEqual(readFileSync(manifest, 'utf8'), manifestBefore);
  assert.equal(refresh(t, '--check').status, 0, out(refresh(t, '--check')));
});
