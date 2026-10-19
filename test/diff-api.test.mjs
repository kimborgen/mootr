#!/usr/bin/env node
// The PR diff API's local half (S-1530): the file list from a PR ref and the merge base, file classes, whole
// files from git objects, the deny list, the per-head cache, and the human-only check. Temp git repos
// (a bare "origin" with a refs/pull/7/head ref made locally), no network, no daemon: `node --test test/diff-api.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome, tempDir } from './tmphome.mjs';

const stamHome = tempHome('stam-diff-');
const root = tempDir('stam-diff-repos-');
process.env.STAM_HOME = stamHome;
process.env.HOME = tempDir('stam-diff-home-');
const origin = join(root, 'origin.git');
const work = join(root, 'work');
const checkout = join(root, 'checkout');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const put = (rel, content) => {
  mkdirSync(join(work, rel, '..'), { recursive: true });
  writeFileSync(join(work, rel), content);
};
const commit = (msg) => (git(work, 'add', '-A'), git(work, 'commit', '-q', '-m', msg), git(work, 'rev-parse', 'HEAD').trim());
const setSettings = (extra = {}) => {
  writeFileSync(join(stamHome, 'settings.json'), JSON.stringify({ itsa: { repos: { app: checkout } }, diff: { refreshSeconds: 600 }, ...extra }));
  s.settingsChanged();
};
const reply = () => {
  const r = { status: 0, headers: {}, body: Buffer.alloc(0) };
  r.writeHead = (status, headers) => ((r.status = status), (r.headers = headers));
  r.end = (b) => (r.body = Buffer.from(b ?? ''));
  return r;
};
const call = async (kind, human, qs, res = reply()) => {
  const out = await d.request(kind, human, new URLSearchParams(qs), res);
  return { out, res };
};
const err = async (kind, human, qs) => {
  try {
    await call(kind, human, qs);
  } catch (e) {
    assert.ok(e instanceof d.DiffError, String(e));
    return e;
  }
  assert.fail('expected a DiffError');
};
let s, d, head1, base0, mainTip;

before(async () => {
  s = await import('../src/settings.ts');
  d = await import('../src/diff.ts');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', work);
  put('a.txt', 'one\ntwo\nthree\n');
  put('gone.txt', 'bye\n');
  put('old-name.txt', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
  put('package-lock.json', '{}\n');
  put('docs/readme.md', '# hi\n');
  put('.env', 'SECRET=1\n');
  writeFileSync(join(work, 'img.bin'), Buffer.from([1, 2, 0, 3]));
  base0 = commit('base');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  // The PR branch.
  git(work, 'checkout', '-q', '-b', 'pr');
  put('a.txt', 'one\nTWO\nthree\nfour\n');
  rmSync(join(work, 'gone.txt'));
  renameSync(join(work, 'old-name.txt'), join(work, 'new-name.txt'));
  put('new-name.txt', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\nextra\n');
  put('package-lock.json', '{"a":1}\n');
  put('test/a.test.mjs', 'x\n');
  put('src/big.txt', 'x'.repeat(5 * 1024 * 1024 + 10));
  put('.env', 'SECRET=2\n');
  put('src/deep/.env.local', 'S=3\n');
  writeFileSync(join(work, 'img.bin'), Buffer.from([9, 2, 0, 3, 4]));
  put('src/new.ts', 'export const n = 1;\n');
  head1 = commit('pr');
  git(work, 'push', '-q', 'origin', 'pr:refs/pull/7/head');
  // Main moves on after the branch point, so the merge base is not main's tip.
  git(work, 'checkout', '-q', 'main');
  put('other.txt', 'later\n');
  mainTip = commit('main moves');
  git(work, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, checkout);
  setSettings();
});

const byPath = (r) => Object.fromEntries(r.files.map((f) => [f.path, f]));

test('the file list: statuses, counts, renames, a binary, and the merge base', async () => {
  const { out } = await call('list', true, { repo: 'app', pr: '7' });
  assert.equal(out.repo, 'app');
  assert.equal(out.pr, 7);
  assert.equal(out.head, head1);
  assert.equal(out.base, mainTip);
  assert.equal(out.mergeBase, base0);
  const f = byPath(out);
  assert.equal(f['other.txt'], undefined, 'a change made on main after the branch point is not in the PR diff');
  const blob = (rev, path) => git(work, 'rev-parse', `${rev}:${path}`).trim();
  assert.deepEqual({ ...f['a.txt'] }, { path: 'a.txt', status: 'modified', additions: 2, deletions: 1, binary: false, class: null, headBlob: blob(head1, 'a.txt'), baseBlob: blob(base0, 'a.txt') });
  assert.equal(f['gone.txt'].baseBlob, blob(base0, 'gone.txt'));
  assert.equal(f['gone.txt'].headBlob, undefined, 'a deleted file has no head blob');
  assert.equal(f['src/new.ts'].headBlob, blob(head1, 'src/new.ts'));
  assert.equal(f['src/new.ts'].baseBlob, undefined, 'an added file has no base blob');
  assert.equal(f['new-name.txt'].baseBlob, blob(base0, 'old-name.txt'), 'a rename pairs the blobs of the old and new paths');
  assert.equal(f['new-name.txt'].headBlob, blob(head1, 'new-name.txt'));
  assert.equal(f['gone.txt'].status, 'deleted');
  assert.equal(f['gone.txt'].deletions, 1);
  assert.equal(f['src/new.ts'].status, 'added');
  assert.equal(f['src/new.ts'].additions, 1);
  assert.equal(f['new-name.txt'].status, 'renamed');
  assert.equal(f['new-name.txt'].oldPath, 'old-name.txt');
  assert.equal(f['new-name.txt'].additions, 1);
  assert.equal(f['old-name.txt'], undefined);
  assert.equal(f['img.bin'].binary, true);
  assert.equal(f['img.bin'].additions, 0);
  assert.equal(f['package-lock.json'].class, 'lockfiles');
  assert.equal(f['test/a.test.mjs'].class, 'tests');
  // Denied paths are listed, flagged, without counts.
  for (const p of ['.env', 'src/deep/.env.local']) assert.deepEqual({ ...f[p] }, { path: p, status: p === '.env' ? 'modified' : 'added', additions: 0, deletions: 0, binary: false, class: null, denied: true });
  assert.equal(f['a.txt'].denied, undefined);
});

test('class patterns: folders, names, whole paths, and the first class wins', () => {
  const c = s.settings().diff.classes;
  const k = (p) => d.classify(p, c);
  assert.equal(k('test/x.js'), 'tests');
  assert.equal(k('web/src/__tests__/x.ts'), 'tests');
  assert.equal(k('src/foo.spec.ts'), 'tests');
  assert.equal(k('src/foo.test.mjs'), 'tests');
  assert.equal(k('yarn.lock'), 'lockfiles');
  assert.equal(k('sub/go.sum'), 'lockfiles');
  assert.equal(k('dist/a.js'), 'generated');
  assert.equal(k('web/dist/a.js'), 'generated');
  assert.equal(k('app.min.js'), 'generated');
  assert.equal(k('a.js.map'), 'generated');
  assert.equal(k('docs/x.png'), 'docs');
  assert.equal(k('README.md'), 'docs');
  assert.equal(k('src/contest/a.ts'), null, 'a folder name must match whole, not as a suffix');
  assert.equal(k('latest.ts'), null);
  assert.equal(k('docs/a.test.ts'), 'tests', 'tests come before docs');
  assert.equal(k('src/a.ts'), null);
  assert.ok(d.matchPattern('src/**/gen.ts', 'src/a/b/gen.ts'));
  assert.ok(!d.matchPattern('src/*.ts', 'src/a/b.ts'));
  assert.ok(d.matchPattern('src/*.ts', 'src/b.ts'));
  assert.ok(!d.matchPattern('', 'a'));
  // A user's patterns replace one class's defaults only.
  assert.equal(d.classify('x.gen.ts', { generated: ['*.gen.*'] }), 'generated');
  assert.equal(d.classify('test/a.js', { generated: ['*.gen.*'] }), null);
});

test('diff.classes in settings replaces one class and keeps the others', () => {
  setSettings({ diff: { refreshSeconds: 600, classes: { docs: ['notes/'] } } });
  const c = s.settings().diff.classes;
  assert.deepEqual(c.docs, ['notes/']);
  assert.ok(c.tests.includes('*.test.*'));
  assert.equal(d.classify('docs/a.png', c), null);
  setSettings();
});

test('a file at the head and at the base, with the files API headers', async () => {
  const head = await call('file', true, { repo: 'app', pr: '7', path: 'a.txt', side: 'head' });
  assert.equal(head.res.status, 200);
  assert.equal(head.res.body.toString(), 'one\nTWO\nthree\nfour\n');
  assert.equal(head.res.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(head.res.headers['x-content-type-options'], 'nosniff');
  assert.equal(head.res.headers['cache-control'], 'private');
  assert.match(head.res.headers['content-type'], /^text\/plain/);
  const base = await call('file', true, { repo: 'app', pr: '7', path: 'a.txt', side: 'base' });
  assert.equal(base.res.body.toString(), 'one\ntwo\nthree\n');
  const gone = await call('file', true, { repo: 'app', pr: '7', path: 'gone.txt', side: 'base' });
  assert.equal(gone.res.body.toString(), 'bye\n');
  const bin = await call('file', true, { repo: 'app', pr: '7', path: 'img.bin' });
  assert.deepEqual([...bin.res.body], [9, 2, 0, 3, 4]);
  assert.match(bin.res.headers['content-disposition'], /^attachment/);
  assert.equal((await err('file', true, { repo: 'app', pr: '7', path: 'gone.txt', side: 'head' })).status, 404);
  assert.equal((await err('file', true, { repo: 'app', pr: '7', path: 'src', side: 'head' })).status, 400, 'a folder is not a file');
  assert.equal((await err('file', true, { repo: 'app', pr: '7', path: 'a.txt', side: 'middle' })).status, 400);
});

test('text over 5 MB is cut unless all=1', async () => {
  const cut = await call('file', true, { repo: 'app', pr: '7', path: 'src/big.txt' });
  assert.equal(cut.res.body.length, 5 * 1024 * 1024);
  assert.equal(cut.res.headers['x-stam-truncated'], '1');
  assert.equal(cut.res.headers['x-stam-size'], 5 * 1024 * 1024 + 10);
  const all = await call('file', true, { repo: 'app', pr: '7', path: 'src/big.txt', all: '1' });
  assert.equal(all.res.body.length, 5 * 1024 * 1024 + 10);
  assert.equal(all.res.headers['x-stam-truncated'], undefined);
});

test('the files deny list holds on /api/diff/file, at both sides, even for files in the diff', async () => {
  for (const path of ['.env', 'src/deep/.env.local']) {
    for (const side of ['head', 'base']) assert.equal((await err('file', true, { repo: 'app', pr: '7', path, side })).status, 403, `${path} at ${side}`);
  }
  for (const path of ['../x', '/etc/passwd', 'a//b', './a.txt', '']) assert.equal((await err('file', true, { repo: 'app', pr: '7', path })).status, 400, path);
});

test('a second request for the same head is served from the cache, with no fetch', async () => {
  // Origin is gone: only the cache can answer.
  renameSync(origin, origin + '.away');
  try {
    const { out } = await call('list', true, { repo: 'app', pr: '7' });
    assert.equal(out.head, head1);
    assert.equal((await call('file', true, { repo: 'app', pr: '7', path: 'a.txt' })).res.status, 200);
    // Once the refresh time has passed, the fetch runs, and fails clearly.
    setSettings({ diff: { refreshSeconds: 0 } });
    const e = await err('list', true, { repo: 'app', pr: '7' });
    assert.equal(e.status, 502);
    assert.match(e.message, /fetching PR 7 of app failed/);
  } finally {
    renameSync(origin + '.away', origin);
    setSettings();
  }
});

test('a new head is picked up once the refresh time has passed, and the list is cached per head', async () => {
  git(work, 'checkout', '-q', 'pr');
  put('src/new.ts', 'export const n = 2;\nexport const m = 3;\n');
  const head2 = commit('pr again');
  git(work, 'push', '-q', '-f', 'origin', 'pr:refs/pull/7/head');
  // Still inside the refresh time: the old head.
  assert.equal((await call('list', true, { repo: 'app', pr: '7' })).out.head, head1);
  setSettings({ diff: { refreshSeconds: 0 } });
  const second = (await call('list', true, { repo: 'app', pr: '7' })).out;
  assert.equal(second.head, head2);
  assert.equal(byPath(second)['src/new.ts'].additions, 2);
  const head = await call('file', true, { repo: 'app', pr: '7', path: 'src/new.ts' });
  assert.equal(head.res.body.toString(), 'export const n = 2;\nexport const m = 3;\n');
  setSettings();
});

let listBefore, head2, head3, base2;

test('the file call serves the head and base the list returned, even after a push', async () => {
  const first = (await call('list', true, { repo: 'app', pr: '7' })).out;
  listBefore = first;
  head2 = first.head;
  base2 = first.base;
  git(work, 'checkout', '-q', 'pr');
  put('a.txt', 'one\nTWO\nthree\nfour\nfive\n');
  head3 = commit('pr third');
  git(work, 'push', '-q', '-f', 'origin', 'pr:refs/pull/7/head');
  setSettings({ diff: { refreshSeconds: 0 } });
  const cur = await call('file', true, { repo: 'app', pr: '7', path: 'a.txt' });
  assert.equal(cur.res.body.toString(), 'one\nTWO\nthree\nfour\nfive\n');
  assert.equal(cur.res.headers['x-stam-head'], head3);
  assert.equal(cur.res.headers['x-stam-base'], mainTip);
  const old = await call('file', true, { repo: 'app', pr: '7', path: 'a.txt', head: head2, base: base2 });
  assert.equal(old.res.body.toString(), 'one\nTWO\nthree\nfour\n');
  assert.equal(old.res.headers['x-stam-head'], head2);
  assert.equal((await err('file', true, { repo: 'app', pr: '7', path: 'a.txt', head: 'zz' })).status, 400);
  assert.equal((await err('file', true, { repo: 'app', pr: '7', path: 'a.txt', head: 'a'.repeat(40), base: base2 })).status, 404);
  setSettings();
});

test('the cache owns its objects after the first fetch: no alternates, and it is complete', () => {
  const cache = join(stamHome, 'cache', 'diff', 'app.git');
  assert.equal(existsSync(join(cache, 'objects', 'info', 'alternates')), false);
  git(cache, 'fsck', '--connectivity-only', '--no-dangling');
});

test('a merged PR still lists its files, diffed from the merge commit\'s first parent', async () => {
  setSettings({ diff: { refreshSeconds: 0 } });
  const before = (await call('list', true, { repo: 'app', pr: '7' })).out;
  git(work, 'checkout', '-q', 'main');
  git(work, 'merge', '-q', '--no-ff', '-m', 'merge pr 7', 'pr');
  const merged = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'push', '-q', 'origin', 'main');
  // Main moves again after the merge.
  put('later.txt', 'after\n');
  commit('after the merge');
  git(work, 'push', '-q', 'origin', 'main');
  const after = (await call('list', true, { repo: 'app', pr: '7' })).out;
  assert.equal(after.head, before.head);
  assert.notEqual(after.base, before.base);
  assert.equal(after.mergeBase, base0, 'the diff still starts where the PR branched');
  assert.deepEqual(after.files, before.files);
  assert.ok(git(work, 'merge-base', '--is-ancestor', head3, merged) === '');
  const base = await call('file', true, { repo: 'app', pr: '7', path: 'a.txt', side: 'base' });
  assert.equal(base.res.body.toString(), 'one\ntwo\nthree\n');
  setSettings();
});

test('pruning keeps the most recently used PRs, never the one asked for, and refetches a dropped one', async () => {
  const cache = join(stamHome, 'cache', 'diff', 'app.git');
  const refs = () => git(cache, 'for-each-ref', '--format=%(refname:short)', 'refs/stam-diff/pr/').trim().split('\n').filter(Boolean).sort();
  git(work, 'checkout', '-q', 'pr');
  git(work, 'push', '-q', 'origin', 'pr:refs/pull/8/head', 'pr:refs/pull/9/head');
  setSettings({ diff: { refreshSeconds: 0, maxPrRefs: 2 } });
  await call('list', true, { repo: 'app', pr: '8' });
  await call('list', true, { repo: 'app', pr: '9' });
  assert.deepEqual(refs(), ['stam-diff/pr/8', 'stam-diff/pr/9'], 'PR 7, the longest unused, was dropped');
  assert.equal((await call('list', true, { repo: 'app', pr: '7' })).out.head, head3, 'a dropped PR is fetched again');
  assert.deepEqual(refs(), ['stam-diff/pr/7', 'stam-diff/pr/9'], 'PR 8 went; the PR asked for stays');
  setSettings();
});

test('only the human reads a diff', async () => {
  assert.equal((await err('list', false, { repo: 'app', pr: '7' })).status, 403);
  assert.equal((await err('file', false, { repo: 'app', pr: '7', path: 'a.txt' })).status, 403);
});

test('clear errors: unknown repo, bad pr, no such PR, a repo name that is not own', async () => {
  assert.equal((await err('list', true, { repo: 'nope', pr: '7' })).status, 404);
  assert.match((await err('list', true, { repo: 'nope', pr: '7' })).message, /unknown repo nope/);
  assert.equal((await err('list', true, { repo: 'toString', pr: '7' })).status, 404);
  assert.equal((await err('list', true, { repo: '', pr: '7' })).status, 400);
  assert.equal((await err('list', true, { repo: 'app', pr: 'x' })).status, 400);
  assert.equal((await err('list', true, { repo: 'app', pr: '0' })).status, 400);
  const e = await err('list', true, { repo: 'app', pr: '99' });
  assert.equal(e.status, 404);
  assert.match(e.message, /no PR 99/);
});

test('the served repos name their GitHub repo, or null when the origin is not on GitHub (S-1533)', async () => {
  assert.equal(d.githubSlug('https://github.com/example/repo.git'), 'example/repo');
  assert.equal(d.githubSlug('git@github.com:example/repo.git'), 'example/repo');
  assert.equal(d.githubSlug('ssh://git@github.com/o/r'), 'o/r');
  assert.equal(d.githubSlug('https://gitlab.com/o/r.git'), null);
  assert.equal(d.githubSlug('/tmp/origin.git'), null);
  const app = async () => (await call('repos', true, {})).out.repos.find((r) => r.name === 'app');
  assert.deepEqual(await app(), { name: 'app', github: null });
  assert.equal((await err('repos', false, {})).status, 403);
  git(checkout, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git');
  try {
    assert.deepEqual(await app(), { name: 'app', github: 'acme/app' });
  } finally {
    git(checkout, 'remote', 'set-url', 'origin', origin);
  }
});

test('the checkout is never written to', async () => {
  assert.equal(git(checkout, 'status', '--porcelain'), '');
  assert.equal(git(checkout, 'for-each-ref').split('\n').filter((l) => /stam-diff|pull/.test(l)).length, 0);
  assert.ok(existsSync(join(stamHome, 'cache', 'diff', 'app.git', 'HEAD')));
});

const st = (state, description, at = '2026-10-19T10:00:00Z', context = 'stam/review') => ({ context, state, description, updated_at: at, created_at: at });

test('the review verdict (S-1917): reviewOf maps the newest stam/review status, and stale compares against the head the list shows', () => {
  const snap = (statuses, checksHead = 'aaa') => ({ checksHead, headStatuses: statuses });
  const ok = d.reviewOf(snap([st('success', 'Review (rev-1): approve. Looks <b>good</b> to me')]), 'aaa');
  assert.deepEqual(ok, { verdict: 'approve', by: 'rev-1', summary: 'Looks <b>good</b> to me', at: '2026-10-19T10:00:00Z', head: 'aaa', stale: false });
  const old = d.reviewOf(snap([st('failure', 'Review (rev-1): request_changes. Missing a test')]), 'bbb');
  assert.equal(old.verdict, 'changes');
  assert.equal(old.stale, true, 'compared against the head the list shows, not the poller head');
  assert.equal(old.head, 'aaa');
  // The newest of several wins; other contexts and pending ones count for nothing.
  const newest = d.reviewOf(snap([st('failure', 'Review (a): request_changes. no', '2026-10-19T09:00:00Z'), st('success', 'Review (b): approve. ok', '2026-10-19T11:00:00Z'), st('failure', 'x', '2026-10-19T12:00:00Z', 'stam/gates')]), 'aaa');
  assert.equal(newest.by, 'b');
  assert.equal(d.reviewOf(snap([st('pending', 'Review (a): approve. wait')]), 'aaa'), null);
  assert.equal(d.reviewOf(snap([st('success', 'ok', undefined, 'stam/gates')]), 'aaa'), null);
  assert.equal(d.reviewOf(snap([]), 'aaa'), null);
  assert.equal(d.reviewOf(null, 'aaa'), null);
  assert.equal(d.reviewOf({ headStatuses: [st('success', 'x')] }, 'aaa'), null, 'no checks head, no verdict');
  // A description that is not the reviewer's own format still shows, without an author.
  const plain = d.reviewOf(snap([st('success', 'approved by hand')]), 'aaa');
  assert.equal(plain.by, null);
  assert.equal(plain.summary, 'approved by hand');
});

test('reviewFor reads the watch snapshot of the repo\'s GitHub PR; an unwatched PR or a non-GitHub origin has none', async () => {
  const gh = join(root, 'gh-checkout');
  git(root, 'init', '-q', '-b', 'main', gh);
  git(gh, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  setSettings({ itsa: { repos: { app: checkout, gh } } });
  const db = await import('../src/db.ts');
  assert.equal(await d.reviewFor('gh', 5, 'aaa'), null, 'unwatched');
  db.setWatchState('github:acme/widgets#5', { checksHead: 'aaa', headStatuses: [st('success', 'Review (rev-1): approve. fine')] }, {});
  const r = await d.reviewFor('gh', 5, 'aaa');
  assert.equal(r.verdict, 'approve');
  assert.equal(r.stale, false);
  assert.equal(await d.reviewFor('gh', 6, 'aaa'), null, 'another PR');
  assert.equal(await d.reviewFor('app', 5, 'aaa'), null, 'origin is not on GitHub');
  assert.equal(await d.reviewFor('nope', 5, 'aaa'), null, 'unknown repo');
  setSettings();
});

test('a status description GitHub cut at 140 characters ("...") still yields the reviewer and a summary (S-1917)', async () => {
  const text = `Review (rev-1): request_changes. ${'x'.repeat(200)}`;
  const desc = `${text.slice(0, 137)}...`;
  assert.equal(desc.length, 140);
  const r = d.reviewOf({ checksHead: 'aaa', headStatuses: [st('failure', desc)] }, 'aaa');
  assert.equal(r.by, 'rev-1');
  assert.equal(r.verdict, 'changes');
  assert.ok(r.summary.endsWith('...') && r.summary.startsWith('xxx'), r.summary);
});
