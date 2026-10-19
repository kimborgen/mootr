// export/doc-shas.mjs keeps the docs entries of export/overrides/manifest.json (S-1868). On a committed tree, refreshDocShas moves
// an entry only when its override was ported after the doc's newest change. On a merge in progress, mergeManifest decides each
// entry from the two sides' tips and the merge base, and gate.mjs's resolveDocShaConflict commits the result. Each case runs in a
// throwaway git repo, so the real tree is only read. Run with `node --test test/doc-shas.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';
import { MANIFEST, mergeManifest, refreshDocShas } from '../export/doc-shas.mjs';
import { sha } from '../export/override-hashes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveDocShaConflict } = await import(join(ROOT, 'scripts', 'gate.mjs'));

const DOC = 'one\ntwo\nthree\n';
const run = (t, args) => spawnSync('git', ['-C', t, '-c', 'user.name=stam', '-c', 'user.email=stam@localhost', ...args], { encoding: 'utf8' });
function git(t, ...args) {
  const r = run(t, args);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const write = (t, rel, text) => {
  mkdirSync(join(t, rel, '..'), { recursive: true });
  writeFileSync(join(t, rel), text);
};
const commit = (t, msg) => {
  git(t, 'add', '-A');
  git(t, 'commit', '-q', '--allow-empty', '-m', msg);
};
const manifest = (over = {}) => JSON.stringify({ templates: {}, types: {}, docs: {}, ...over }, null, 2) + '\n';
const docs = (t) => JSON.parse(readFileSync(join(t, MANIFEST), 'utf8')).docs;
const conflicted = (t) => git(t, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);

// One commit on main: docs/a.md, its public override and a manifest whose docs entry hashes DOC.
function repo() {
  const t = tempDir('stam-doc-shas-');
  git(t, 'init', '-q', '-b', 'main');
  write(t, 'docs/a.md', DOC);
  write(t, 'export/overrides/docs/a.md', DOC);
  write(t, MANIFEST, manifest({ docs: { 'a.md': sha(DOC) } }));
  commit(t, 'base');
  return t;
}

// PR and main diverge from the current commit, each applying its edits in its own commits, then main merges the PR. Returns the
// merge's exit status (non-zero: a conflict is left in the tree).
function diverge(t, pr, main) {
  git(t, 'checkout', '-q', '-b', 'pr');
  pr();
  commit(t, 'pr');
  git(t, 'checkout', '-q', 'main');
  main();
  commit(t, 'main');
  return run(t, ['merge', '--no-ff', '--no-edit', 'pr']).status;
}

const A1 = 'PR one\ntwo\nthree\n';
const M1 = 'one\ntwo\nmain three\n';

// A port followed by a doc-only edit: the port is older than the newest doc change, so it doesn't authorize that edit (S-1868).
test('a port older than a later doc-only edit does not authorize it', () => {
  const t = repo();
  const one = 'ONE\ntwo\nthree\n';
  write(t, 'docs/a.md', one);
  write(t, 'export/overrides/docs/a.md', one);
  commit(t, 'port');
  write(t, 'docs/a.md', 'ONE\ntwo\nTHREE\n');
  commit(t, 'doc-only edit');
  const r = refreshDocShas(t);
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.kept.map((k) => k.name), ['a.md']);
  assert.equal(docs(t)['a.md'], sha(DOC));
});

test('a port recorded in the manifest, then a later doc-only edit, is still stale', () => {
  const t = repo();
  const one = 'ONE\ntwo\nthree\n';
  write(t, 'docs/a.md', one);
  write(t, 'export/overrides/docs/a.md', one);
  write(t, MANIFEST, manifest({ docs: { 'a.md': sha(one) } }));
  commit(t, 'port and refresh');
  write(t, 'docs/a.md', 'ONE\ntwo\nTHREE\n');
  commit(t, 'doc-only edit');
  assert.deepEqual(refreshDocShas(t).kept.map((k) => k.name), ['a.md']);
  assert.equal(docs(t)['a.md'], sha(one));
});

test('a ported doc edit moves its entry, and a second refresh finds nothing to move', () => {
  const t = repo();
  const next = 'ONE\ntwo\nthree\n';
  write(t, 'docs/a.md', next);
  write(t, 'export/overrides/docs/a.md', next);
  commit(t, 'port');
  assert.deepEqual(refreshDocShas(t), { moved: ['a.md'], kept: [] });
  assert.equal(docs(t)['a.md'], sha(next));
  assert.deepEqual(refreshDocShas(t, { check: true }), { moved: [], kept: [] });
});

test('an unported doc edit keeps its entry, so apply-overrides keeps refusing it', () => {
  const t = repo();
  write(t, 'docs/a.md', 'ONE\ntwo\nthree\n');
  commit(t, 'edit without port');
  const r = refreshDocShas(t);
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.kept.map((k) => k.name), ['a.md']);
  assert.equal(docs(t)['a.md'], sha(DOC));
  assert.notEqual(sha(readFileSync(join(t, 'docs/a.md'), 'utf8')), docs(t)['a.md']);
});

// A port made on main without a doc change is older than the newest doc change, so it doesn't count for a later doc edit.
test('an override change without a doc change does not port a later doc edit', () => {
  const t = repo();
  write(t, 'export/overrides/docs/a.md', 'one\ntwo\nport on main\n');
  commit(t, 'main ports without a doc change');
  write(t, 'docs/a.md', 'ONE\ntwo\nthree\n');
  commit(t, 'doc edit without port');
  const r = refreshDocShas(t);
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.kept.map((k) => k.name), ['a.md']);
});

test('a deleted override does not port a doc edit, committed or not', () => {
  const t = repo();
  write(t, 'docs/a.md', 'ONE\ntwo\nthree\n');
  rmSync(join(t, 'export/overrides/docs/a.md'));
  commit(t, 'edit and delete the override');
  assert.deepEqual(refreshDocShas(t).kept.map((k) => k.name), ['a.md']);
  const u = repo();
  write(u, 'docs/a.md', 'ONE\ntwo\nthree\n');
  rmSync(join(u, 'export/overrides/docs/a.md'));
  assert.deepEqual(refreshDocShas(u).kept.map((k) => k.name), ['a.md']);
});

// A rename brings a doc and its override in at the newest commit, where the parent has neither: that is not a port.
test('a doc and override added back in the newest commit are not a port', () => {
  const t = repo();
  rmSync(join(t, 'docs/a.md'));
  rmSync(join(t, 'export/overrides/docs/a.md'));
  commit(t, 'remove the doc');
  write(t, 'docs/a.md', 'ONE\ntwo\nthree\n');
  write(t, 'export/overrides/docs/a.md', 'ONE\ntwo\nthree\n');
  commit(t, 'add it back under the same name');
  assert.deepEqual(refreshDocShas(t).kept.map((k) => k.name), ['a.md']);
});

// The merge cases (S-1868): a port on each side, a port followed by an unported edit, an unported edit by main, and keys that
// were added, removed or renamed. Each side's edit is judged on its own tip and the merge base.
test('both sides ported: the merged doc becomes the entry', () => {
  const t = repo();
  const status = diverge(
    t,
    () => {
      write(t, 'docs/a.md', A1);
      write(t, 'export/overrides/docs/a.md', A1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(A1) } }));
    },
    () => {
      write(t, 'docs/a.md', M1);
      write(t, 'export/overrides/docs/a.md', M1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(M1) } }));
    },
  );
  assert.notEqual(status, 0);
  assert.deepEqual(conflicted(t), [MANIFEST]);
  const merged = 'PR one\ntwo\nmain three\n';
  assert.equal(resolveDocShaConflict(t), true);
  assert.deepEqual(conflicted(t), []);
  assert.equal(readFileSync(join(t, 'docs/a.md'), 'utf8'), merged);
  assert.equal(docs(t)['a.md'], sha(merged));
  assert.deepEqual(refreshDocShas(t, { check: true }), { moved: [], kept: [] });
});

test('a PR that edits the doc without its override is left conflicted', () => {
  const t = repo();
  const status = diverge(
    t,
    () => {
      write(t, 'docs/a.md', A1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(A1) } }));
    },
    () => {
      write(t, 'docs/a.md', M1);
      write(t, 'export/overrides/docs/a.md', M1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(M1) } }));
    },
  );
  assert.notEqual(status, 0);
  assert.equal(resolveDocShaConflict(t), false);
  assert.deepEqual(conflicted(t), [MANIFEST]);
});

// The PR ports, then edits the doc again without porting, and its entry still hashes the ported text: the tip check refuses it.
test('a PR that ports and then edits again without porting is left conflicted', () => {
  const t = repo();
  const status = diverge(
    t,
    () => {
      write(t, 'docs/a.md', A1);
      write(t, 'export/overrides/docs/a.md', A1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(A1) } }));
      commit(t, 'pr port');
      write(t, 'docs/a.md', 'PR two\ntwo\nthree\n');
    },
    () => {
      write(t, 'docs/a.md', M1);
      write(t, 'export/overrides/docs/a.md', M1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(M1) } }));
    },
  );
  assert.notEqual(status, 0);
  assert.equal(resolveDocShaConflict(t), false);
  assert.deepEqual(conflicted(t), [MANIFEST]);
});

// Main's own entry stamps its doc with no override port: the side's override is unchanged since the base, so it is refused.
test('an unported edit on main is left conflicted', () => {
  const t = repo();
  const status = diverge(
    t,
    () => {
      write(t, 'docs/a.md', A1);
      write(t, 'export/overrides/docs/a.md', A1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(A1) } }));
    },
    () => {
      write(t, 'docs/a.md', M1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(M1) } }));
    },
  );
  assert.notEqual(status, 0);
  assert.equal(resolveDocShaConflict(t), false);
  assert.deepEqual(conflicted(t), [MANIFEST]);
});

// The PR adds a docs key with its doc and override beside a conflict on another: the key sets differ, so the merge is refused.
test('a merge that adds a docs key is left conflicted', () => {
  const t = repo();
  const status = diverge(
    t,
    () => {
      write(t, 'docs/a.md', A1);
      write(t, 'export/overrides/docs/a.md', A1);
      write(t, 'docs/b.md', 'bee\n');
      write(t, 'export/overrides/docs/b.md', 'bee\n');
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(A1), 'b.md': sha('bee\n') } }));
    },
    () => {
      write(t, 'docs/a.md', M1);
      write(t, 'export/overrides/docs/a.md', M1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(M1) } }));
    },
  );
  assert.notEqual(status, 0);
  assert.equal(mergeManifest(t), null);
  assert.equal(resolveDocShaConflict(t), false);
  assert.deepEqual(conflicted(t), [MANIFEST]);
});

// The PR removes a docs key (with its doc and override) and ports another doc: the key sets differ, so the merge is refused.
test('a merge that removes a docs key is left conflicted', () => {
  const t = repo();
  write(t, 'docs/b.md', 'bee\n');
  write(t, 'export/overrides/docs/b.md', 'bee\n');
  write(t, MANIFEST, manifest({ docs: { 'a.md': sha(DOC), 'b.md': sha('bee\n') } }));
  commit(t, 'add b');
  const status = diverge(
    t,
    () => {
      write(t, 'docs/a.md', A1);
      write(t, 'export/overrides/docs/a.md', A1);
      rmSync(join(t, 'docs/b.md'));
      rmSync(join(t, 'export/overrides/docs/b.md'));
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(A1) } }));
    },
    () => {
      write(t, 'docs/a.md', M1);
      write(t, 'export/overrides/docs/a.md', M1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(M1), 'b.md': sha('bee\n') } }));
    },
  );
  assert.notEqual(status, 0);
  assert.equal(mergeManifest(t), null);
  assert.equal(resolveDocShaConflict(t), false);
});

// A rename removes one docs key and adds another, with its override: the key sets differ, so it is not a port on the merge path.
test('a renamed doc and override are not a port on the merge path', () => {
  const t = repo();
  const status = diverge(
    t,
    () => {
      rmSync(join(t, 'docs/a.md'));
      rmSync(join(t, 'export/overrides/docs/a.md'));
      write(t, 'docs/c.md', A1);
      write(t, 'export/overrides/docs/c.md', A1);
      write(t, MANIFEST, manifest({ docs: { 'c.md': sha(A1) } }));
    },
    () => {
      write(t, 'docs/a.md', M1);
      write(t, 'export/overrides/docs/a.md', M1);
      write(t, MANIFEST, manifest({ docs: { 'a.md': sha(M1) } }));
    },
  );
  assert.notEqual(status, 0);
  assert.equal(mergeManifest(t), null);
});

test('a PR that changes a template or type hash is left conflicted', () => {
  const t = repo();
  write(t, MANIFEST, manifest({ templates: { itsa: 'h0' }, docs: { 'a.md': sha(DOC) } }));
  commit(t, 'template hash');
  const status = diverge(
    t,
    () => write(t, MANIFEST, manifest({ templates: { itsa: 'h1' }, docs: { 'a.md': sha('PR text') } })),
    () => {
      write(t, 'docs/a.md', M1);
      write(t, 'export/overrides/docs/a.md', M1);
      write(t, MANIFEST, manifest({ templates: { itsa: 'h0' }, docs: { 'a.md': sha(M1) } }));
    },
  );
  assert.notEqual(status, 0);
  assert.equal(resolveDocShaConflict(t), false);
  assert.deepEqual(conflicted(t), [MANIFEST]);
});

test('the shipped manifest has every docs entry current', () => {
  assert.deepEqual(refreshDocShas(ROOT, { check: true }), { moved: [], kept: [] });
});
