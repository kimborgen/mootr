#!/usr/bin/env node
// Unit tests for skill import (S-890, src/skill-import.ts) against a local bare git repository, never
// the network: source parsing (github.com only), a good import with origin.json, the refusals (path
// traversal, a symlink out of the folder, a name that doesn't match its folder, no description, a name
// clash, an oversized folder), a skill at the repository root, sizing before download, the update
// check (head moved but folder same is remembered and not cloned again, folder changed, a pinned
// branch, cached answers) and Update, recovery of an interrupted Update, and the human-only routes. Run with `node --test test/skill-import.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, tempHome } from './tmphome.mjs';

const home = tempHome('stam-import-');
const user = tempDir('stam-import-user-');
process.env.STAM_HOME = home;
process.env.HOME = user;

let imp;
let ins;
const opts = { allowFile: true };
const work = tempDir('stam-import-work-');
const bare = join(work, 'repo.git');
const tree = join(work, 'tree');
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
const write = (p, text) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};
const skillMd = (name, desc = 'Does the thing.') => `---\nname: ${name}\n${desc ? `description: ${desc}\n` : ''}---\nBody.\n`;
const push = (msg) => {
  git(tree, 'add', '-A');
  git(tree, 'commit', '-m', msg);
  git(tree, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
};
const src = (path = '') => `file://${bare}${path ? '#' + path : ''}`;
const refuses = (p, re) => assert.rejects(p, (e) => e.name === 'Error' && re.test(e.message));

before(async () => {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  execFileSync('git', ['init', '-q', '-b', 'main', tree]);
  git(tree, 'remote', 'add', 'origin', bare);
  write(join(tree, 'skills/good/SKILL.md'), skillMd('good'));
  write(join(tree, 'skills/good/refs/guide.md'), 'guide');
  write(join(tree, 'skills/other/SKILL.md'), skillMd('other'));
  write(join(tree, 'skills/wrong-folder/SKILL.md'), skillMd('something-else'));
  write(join(tree, 'skills/nodesc/SKILL.md'), skillMd('nodesc', ''));
  write(join(tree, 'skills/nofile/README.md'), 'x');
  write(join(tree, 'skills/outlink/SKILL.md'), skillMd('outlink'));
  symlinkSync('/etc/passwd', join(tree, 'skills/outlink/abs'));
  write(join(tree, 'skills/uplink/SKILL.md'), skillMd('uplink'));
  symlinkSync('../good/SKILL.md', join(tree, 'skills/uplink/up'));
  write(join(tree, 'skills/inlink/SKILL.md'), skillMd('inlink'));
  symlinkSync('SKILL.md', join(tree, 'skills/inlink/same'));
  write(join(tree, 'skills/big/SKILL.md'), skillMd('big'));
  writeFileSync(join(tree, 'skills/big/blob.bin'), Buffer.alloc(6 * 1024 * 1024, 1));
  write(join(tree, 'skills/Bad_Name/SKILL.md'), skillMd('Bad_Name'));
  write(join(tree, 'skills/agclash/SKILL.md'), skillMd('agclash'));
  write(join(tree, 'skills/pinned/SKILL.md'), skillMd('pinned'));
  write(join(tree, 'skills/linkorigin/SKILL.md'), skillMd('linkorigin'));
  symlinkSync('SKILL.md', join(tree, 'skills/linkorigin/origin.json'));
  push('first');
  imp = await import('../src/skill-import.ts');
  ins = await import('../src/instructions.ts');
});

test('parseSource takes github.com sources only and refuses odd path parts', () => {
  const p = imp.parseSource;
  assert.deepEqual(p('anthropics/skills'), { url: 'https://github.com/anthropics/skills', path: '' });
  assert.deepEqual(p('anthropics/skills/skills/pdf'), { url: 'https://github.com/anthropics/skills', path: 'skills/pdf' });
  assert.deepEqual(p('https://github.com/o/r/tree/main/a/b'), { url: 'https://github.com/o/r', path: 'a/b', ref: 'main' });
  assert.deepEqual(p('github.com/o/r.git'), { url: 'https://github.com/o/r', path: '' });
  assert.deepEqual(p('https://github.com/o/r/blob/v1/a/SKILL.md'), { url: 'https://github.com/o/r', path: 'a', ref: 'v1' });
  for (const bad of ['o/r/../x', 'o/r/a/./b', '-o/r', 'o/-r', 'o/r/--upload-pack=x', 'http://github.com/o/r', 'https://gitlab.com/o/r', 'git@github.com:o/r', 'ssh://github.com/o/r', 'https://evil.example/github.com/o/r', 'o', '', 'o/r/a b', 'o/r?x=1', 'file:///tmp/x.git'])
    assert.throws(() => p(bad), (e) => e.name === 'Error', bad);
  assert.deepEqual(p('file:///tmp/x.git#a/b', opts), { url: 'file:///tmp/x.git', path: 'a/b' });
  assert.throws(() => p('file:///tmp/x.git#../b', opts));
});

test('import writes the folder, origin.json and the commit; the same source is an update', async () => {
  const r = await imp.importSkill(src('skills/good'), opts);
  assert.equal(r.name, 'good');
  assert.equal(r.updated, false);
  const dir = join(home, 'skills', 'good');
  assert.equal(readFileSync(join(dir, 'refs/guide.md'), 'utf8'), 'guide');
  const o = JSON.parse(readFileSync(join(dir, 'origin.json'), 'utf8'));
  assert.equal(o.url, `file://${bare}`);
  assert.equal(o.path, 'skills/good');
  assert.equal(o.commit, git(bare, 'rev-parse', 'main').trim());
  assert.ok(o.tree && o.date);
  assert.ok(!existsSync(join(dir, '.git')));
  assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('.skill-import-')), [], 'no temp folder is left');
  const again = await imp.importSkill(src('skills/good'), opts);
  assert.equal(again.updated, true);
  assert.deepEqual(imp.originOf('good').path, 'skills/good');
});

test('import refuses what is not a safe skill folder', async () => {
  await refuses(imp.importSkill(src('skills/good'), {}), /only github\.com/);
  await refuses(imp.importSkill(src('skills/nothere'), opts), /no folder/);
  await refuses(imp.importSkill(src('skills/nofile'), opts), /no SKILL\.md/);
  await refuses(imp.importSkill(src('skills/wrong-folder'), opts), /must match its folder/);
  await refuses(imp.importSkill(src('skills/nodesc'), opts), /description/);
  await refuses(imp.importSkill(src('skills/Bad_Name'), opts), /lowercase/);
  await refuses(imp.importSkill(src('skills/outlink'), opts), /points outside/);
  await refuses(imp.importSkill(src('skills/uplink'), opts), /points outside/);
  await refuses(imp.importSkill(src('skills/big'), opts), /larger than/);
  for (const n of ['wrong-folder', 'nodesc', 'outlink', 'uplink', 'big']) assert.ok(!existsSync(join(home, 'skills', n)), `${n} not written`);
  assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('.skill-import-')), []);
});

test('a symlink that stays inside the folder is kept', async () => {
  await imp.importSkill(src('skills/inlink'), opts);
  assert.ok(existsSync(join(home, 'skills', 'inlink', 'same')));
});

test('a name clash with a user skill or another origin is refused', async () => {
  mkdirSync(join(user, '.claude', 'skills', 'other'), { recursive: true });
  writeFileSync(join(user, '.claude', 'skills', 'other', 'SKILL.md'), skillMd('other'));
  await refuses(imp.importSkill(src('skills/other'), opts), /~\/\.claude\/skills/);
  // A stam skill of that name with no origin, or from another one, is never replaced.
  write(join(tree, 'skills/clash/SKILL.md'), skillMd('clash'));
  push('clash');
  write(join(home, 'skills', 'clash', 'SKILL.md'), skillMd('clash'));
  await refuses(imp.importSkill(src('skills/clash'), opts), /already exists/);
  writeFileSync(join(home, 'skills', 'clash', 'origin.json'), JSON.stringify({ url: 'https://github.com/o/r', path: 'x', commit: 'a' }));
  await refuses(imp.importSkill(src('skills/clash'), opts), /already exists/);
});

test('update check: unrelated commit is no update, a change to the folder is, and Update replaces it', async () => {
  imp.forgetChecks();
  const same = await imp.checkUpdate('good', opts);
  assert.deepEqual(same, { moved: false, commit: git(bare, 'rev-parse', 'main').trim() });
  write(join(tree, 'elsewhere.txt'), 'x');
  push('unrelated');
  imp.forgetChecks();
  const before = imp.counters.clones;
  const unrelated = await imp.checkUpdate('good', opts);
  assert.equal(unrelated.moved, false, 'head moved but the folder did not');
  assert.equal(imp.counters.clones, before + 1);
  assert.equal(imp.originOf('good').seen, git(bare, 'rev-parse', 'main').trim(), 'the head seen is recorded');
  imp.forgetChecks();
  assert.equal((await imp.checkUpdate('good', opts)).moved, false);
  assert.equal(imp.counters.clones, before + 1, 'the same head is not cloned again');
  assert.equal(imp.checkUpdate('good', opts), imp.checkUpdate('good', opts), 'an answer is kept for a while');
  write(join(tree, 'skills/good/SKILL.md'), skillMd('good', 'Now does more.'));
  push('change good');
  imp.forgetChecks();
  const moved = await imp.checkUpdate('good', opts);
  assert.equal(moved.moved, true);
  assert.equal(moved.commit, git(bare, 'rev-parse', 'main').trim());
  const r = await imp.updateSkill('good', opts);
  assert.equal(r.updated, true);
  assert.match(readFileSync(join(home, 'skills', 'good', 'SKILL.md'), 'utf8'), /Now does more/);
  assert.equal(imp.originOf('good').commit, moved.commit);
  assert.equal((await imp.checkUpdate('good', opts)).moved, false);
  assert.equal(imp.originOf('good').seen, undefined, 'a fresh import starts without a seen head');
  await refuses(imp.updateSkill('own-made', opts), /not imported|origin/);
  await refuses(imp.updateSkill('../x', opts), /not a skill name/);
});

test('a skill at the repository root imports, without the clone\'s own .git', async () => {
  const rb = join(work, 'rootskill.git');
  const rt = join(work, 'roottree');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', rb]);
  git(rb, 'config', 'uploadpack.allowFilter', 'true');
  execFileSync('git', ['init', '-q', '-b', 'main', rt]);
  git(rt, 'remote', 'add', 'origin', rb);
  write(join(rt, 'SKILL.md'), skillMd('rootskill'));
  write(join(rt, 'notes/a.md'), 'a');
  git(rt, 'add', '-A');
  git(rt, 'commit', '-m', 'root');
  git(rt, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const r = await imp.importSkill(`file://${rb}`, opts);
  assert.equal(r.name, 'rootskill');
  const dir = join(home, 'skills', 'rootskill');
  assert.ok(existsSync(join(dir, 'notes/a.md')) && !existsSync(join(dir, '.git')));
  assert.equal(imp.originOf('rootskill').path, '');
});

test('the folder is sized before its files are downloaded', async () => {
  const gh = { url: 'https://github.com/o/r', path: 'skills/x' };
  const reply = (status, json) => async (url) => {
    assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/o\/r\/git\/trees\/abc123\?recursive=1$/);
    return { ok: status === 200, status, json: async () => json };
  };
  const blob = (size) => ({ type: 'blob', size });
  assert.deepEqual(await imp.treeSizes(gh, '', 'abc123', false, reply(200, { tree: [blob(10), { type: 'tree' }, blob(5)] })), { files: 2, bytes: 15 });
  await refuses(imp.treeSizes(gh, '', 'abc123', false, reply(200, { tree: [blob(40 * 1024 * 1024)] })), /larger than/);
  await refuses(imp.treeSizes(gh, '', 'abc123', false, reply(200, { tree: Array.from({ length: 301 }, () => blob(1)) })), /more than 300/);
  await refuses(imp.treeSizes(gh, '', 'abc123', false, reply(200, { tree: [], truncated: true })), /too large/);
  await refuses(imp.treeSizes(gh, '', 'abc123', false, reply(200, { tree: [{ type: 'commit' }] })), /submodule/);
  await refuses(imp.treeSizes(gh, '', 'abc123', false, reply(403, {})), /rate limit/);
  await refuses(imp.treeSizes(gh, '', 'abc123', false, async () => { throw new Error('offline'); }), /could not size/);
  await refuses(imp.treeSizes({ url: 'file:///x.git', path: '' }, '', 'abc123', false), /only github\.com/);
});

test('a pinned branch is compared by its own head and an unrelated commit is not cloned twice', async () => {
  await imp.importSkill(`${src('skills/pinned')}@main`, opts);
  assert.equal(imp.originOf('pinned').ref, 'main');
  write(join(tree, 'elsewhere2.txt'), 'y');
  push('unrelated 2');
  imp.forgetChecks();
  const before = imp.counters.clones;
  assert.equal((await imp.checkUpdate('pinned', opts)).moved, false);
  imp.forgetChecks();
  assert.equal((await imp.checkUpdate('pinned', opts)).moved, false);
  assert.equal(imp.counters.clones, before + 1);
  write(join(tree, 'skills/pinned/SKILL.md'), skillMd('pinned', 'Changed.'));
  push('change pinned');
  imp.forgetChecks();
  assert.equal((await imp.checkUpdate('pinned', opts)).moved, true);
});

test('a name taken in ~/.agents/skills is refused, but stam\'s own link there is an update', async () => {
  mkdirSync(join(user, '.agents', 'skills', 'agclash'), { recursive: true });
  await refuses(imp.importSkill(src('skills/agclash'), opts), /~\/\.agents\/skills/);
  assert.ok(!existsSync(join(home, 'skills', 'agclash')));
  ins.linkSkills(ins.agentsSkillsDir());
  assert.ok(existsSync(join(user, '.agents', 'skills', 'good', 'SKILL.md')), 'stam linked good for Codex');
  assert.equal((await imp.updateSkill('good', opts)).updated, true);
});

test('recoverImports puts back a folder an interrupted Update moved aside', () => {
  const work1 = join(home, '.skill-import-crashed');
  mkdirSync(join(work1, 'old-lost'), { recursive: true });
  writeFileSync(join(work1, 'old-lost', 'SKILL.md'), skillMd('lost'));
  mkdirSync(join(home, 'skills', 'kept'), { recursive: true });
  writeFileSync(join(home, 'skills', 'kept', 'SKILL.md'), 'new');
  const work2 = join(home, '.skill-import-crashed2');
  mkdirSync(join(work2, 'old-kept'), { recursive: true });
  mkdirSync(join(home, '.skill-check-left'), { recursive: true });
  imp.recoverImports();
  assert.ok(existsSync(join(home, 'skills', 'lost', 'SKILL.md')), 'a missing skill comes back');
  assert.equal(readFileSync(join(home, 'skills', 'kept', 'SKILL.md'), 'utf8'), 'new', 'one that exists is not overwritten');
  assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('.skill-')), [], 'work folders are removed');
});

test('every skills route that reaches the network or writes is human only', () => {
  const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
  for (const route of ['/api/skills/updates', '/api/skills/(import|update)']) {
    const i = daemon.indexOf(route.replace(/\//g, '\\/').replace('(import|update)', '(import|update)'));
    assert.ok(i > 0, route);
    assert.match(daemon.slice(i, i + 400), /humanOnly\(req,/, route);
  }
});

test('a repository that ships origin.json as a link to SKILL.md cannot redirect the write', async () => {
  await imp.importSkill(src('skills/linkorigin'), opts);
  const dir = join(home, 'skills', 'linkorigin');
  assert.ok(lstatSync(join(dir, 'origin.json')).isFile(), 'origin.json is a plain file, not the shipped link');
  assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /^---\nname: linkorigin/, 'SKILL.md is untouched');
  assert.equal(imp.originOf('linkorigin').path, 'skills/linkorigin');
});

test('a clone past the size cap is stopped, not only by the timeout', async () => {
  const was = imp.limits.cloneBytes;
  imp.limits.cloneBytes = 1;
  try {
    await refuses(imp.importSkill(src('skills/other'), opts), /too large to fetch/);
  } finally {
    imp.limits.cloneBytes = was;
  }
  assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('.skill-import-')), [], 'no temp folder is left');
});

test('an update check that finishes after the folder changed does not write its stale origin', async () => {
  write(join(tree, 'elsewhere3.txt'), 'y');
  push('unrelated again');
  imp.forgetChecks();
  const file = join(home, 'skills', 'linkorigin', 'origin.json');
  const o = JSON.parse(readFileSync(file, 'utf8'));
  const p = imp.checkUpdate('linkorigin', opts);
  // An Update lands while the check is still running.
  const newer = { ...o, commit: 'f'.repeat(40) };
  writeFileSync(file, JSON.stringify(newer));
  assert.equal((await p).moved, false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), newer, 'the newer origin stands');
});
