#!/usr/bin/env node
// The repo config (S-2202, scripts/repo-config.mjs): the schema's defaults and refusals, the settings fallback under the
// file, the file read from a commit and never from the working tree or another branch, the Gates: line checked against
// the config's gate names, and the gates a PR runs by name and by path glob. Uses throwaway git repos.
// Run with `node --test test/repo-config.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const { DEFAULTS, MAX_CONFIG_BYTES, RepoConfigError, globError, parseRepoGates, readRepoConfig, selectGates, validateRepoConfig } = await import(join(ROOT, 'scripts/repo-config.mjs'));

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

// A git repo whose main commit holds `config` as .stam/repo.json (none when null), cleaned up after the test.
function repoWith(t, config) {
  const dir = tempDir('stam-repo-config-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(dir, 'README'), 'x\n');
  if (config !== null) {
    mkdirSync(join(dir, '.stam'));
    writeFileSync(join(dir, '.stam/repo.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'base');
  return dir;
}

const CONFIG = {
  github: 'acme/widgets',
  gates: [
    { name: 'unit', command: 'npm test' },
    { name: 'web', command: 'npm run build', when: 'web/**' },
    { name: 'docs', command: 'npm run lint:docs', when: ['docs/**', '*.md'] },
    { name: 'e2e', command: 'npm run e2e', when: [] },
  ],
};

test('an empty config gets every default', () => {
  assert.deepEqual(validateRepoConfig({}), { ...DEFAULTS, gates: [], requiredStatuses: ['stam/review'], merge: { method: 'merge', command: null } });
});

test('a full config keeps its values and normalises when to a list or null', () => {
  const c = validateRepoConfig({ ...CONFIG, mainBranch: 'trunk', branchPrefix: '', requiredStatuses: ['ci', 'stam/review'], merge: { method: 'squash', command: './merge.sh' }, deploy: './deploy.sh', home: 'box' });
  assert.equal(c.mainBranch, 'trunk');
  assert.equal(c.branchPrefix, '');
  assert.deepEqual(c.gates.map((g) => g.when), [null, ['web/**'], ['docs/**', '*.md'], []]);
  assert.deepEqual(c.merge, { method: 'squash', command: './merge.sh' });
  assert.equal(c.deploy, './deploy.sh');
  assert.equal(c.home, 'box');
});

test('a bad config is refused, naming every problem', () => {
  const bad = {
    github: 'not a repo',
    extra: 1,
    mainBranch: '-x',
    gates: [{ name: 'auto', command: 'x' }, { name: 'a', command: '' }, { name: 'a', command: 'y', when: [1], other: 2 }],
    requiredStatuses: 'stam/review',
    merge: { method: 'octopus', how: 1 },
    deploy: '',
  };
  assert.throws(() => validateRepoConfig(bad), (e) => {
    assert.ok(e instanceof RepoConfigError);
    for (const part of ['unknown key extra', 'github must be OWNER/NAME', 'mainBranch must be', 'name auto is reserved', 'gates[1]: command', 'name a is used twice', 'gates[2]: unknown key other', 'gates[2]: when must be', 'requiredStatuses must be', 'merge: unknown key how', 'merge.method must be', 'deploy must be']) {
      assert.ok(e.message.includes(part), `missing "${part}" in: ${e.message}`);
    }
    return true;
  });
  assert.throws(() => validateRepoConfig([]), /must be a JSON object/);
});

test('the file is read from the commit asked for, not the working tree or another branch', (t) => {
  const dir = repoWith(t, CONFIG);
  // A PR branch that rewrites the gates and drops the required review, and an uncommitted edit on top.
  git(dir, 'checkout', '--quiet', '-b', 'stam/pr');
  writeFileSync(join(dir, '.stam/repo.json'), JSON.stringify({ gates: [], requiredStatuses: [] }));
  git(dir, 'commit', '--quiet', '-am', 'weaken');
  writeFileSync(join(dir, '.stam/repo.json'), JSON.stringify({ deploy: 'rm -rf /' }));
  const c = readRepoConfig(dir, 'main');
  assert.deepEqual(c.gates.map((g) => g.name), ['unit', 'web', 'docs', 'e2e']);
  assert.deepEqual(c.requiredStatuses, ['stam/review']);
  assert.equal(c.deploy, null);
  assert.deepEqual(readRepoConfig(dir, 'stam/pr').requiredStatuses, []);
});

test('no file and no fallback is null; the fallback stands alone or fills what the file leaves out', (t) => {
  const bare = repoWith(t, null);
  assert.equal(readRepoConfig(bare, 'main'), null);
  const fallback = { github: 'acme/other', mainBranch: 'trunk', merge: { command: './merge.sh' }, deploy: './deploy.sh' };
  const alone = readRepoConfig(bare, 'main', fallback);
  assert.equal(alone.github, 'acme/other');
  assert.equal(alone.mainBranch, 'trunk');
  assert.deepEqual(alone.merge, { method: 'merge', command: './merge.sh' });

  const dir = repoWith(t, { github: 'acme/widgets', merge: { method: 'squash' } });
  const c = readRepoConfig(dir, 'main', fallback);
  assert.equal(c.github, 'acme/widgets'); // the file wins
  assert.equal(c.mainBranch, 'trunk'); // the fallback fills
  assert.equal(c.deploy, './deploy.sh');
  assert.deepEqual(c.merge, { method: 'squash', command: './merge.sh' }); // per field
});

test('a file that is not JSON, a bad fallback, and an unknown ref are refused', (t) => {
  assert.throws(() => readRepoConfig(repoWith(t, '{ nope'), 'main'), /not JSON/);
  assert.throws(() => readRepoConfig(repoWith(t, null), 'main', { gates: 'x' }), /settings itsa.repoConfig: gates must be a list/);
  assert.throws(() => readRepoConfig(repoWith(t, CONFIG), 'no-such-branch'), /no commit no-such-branch/);
});

test('a config read that fails throws; only a path absent from the tree is no config', (t) => {
  // Over the size limit: refused, never read as missing (it would drop the gates and statuses).
  const big = repoWith(t, JSON.stringify({ ...CONFIG, pad: 'x'.repeat(MAX_CONFIG_BYTES) }));
  assert.throws(() => readRepoConfig(big, 'main'), (e) => e instanceof RepoConfigError && /bytes, over the \d+-byte limit/.test(e.message));
  // A blob git can't read: the tree still lists it, its object is gone.
  const broken = repoWith(t, CONFIG);
  const oid = git(broken, 'rev-parse', 'main:.stam/repo.json');
  unlinkSync(join(broken, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  assert.throws(() => readRepoConfig(broken, 'main'), (e) => e instanceof RepoConfigError && new RegExp(`can't read blob ${oid}`).test(e.message));
  // A fallback never stands in for a failed read.
  assert.throws(() => readRepoConfig(broken, 'main', { github: 'acme/x' }), /can't read blob/);
  // An entry that isn't a plain file.
  const linked = repoWith(t, null);
  mkdirSync(join(linked, '.stam'));
  symlinkSync('/etc/passwd', join(linked, '.stam/repo.json'));
  git(linked, 'add', '-A');
  git(linked, 'commit', '--quiet', '-m', 'link');
  assert.throws(() => readRepoConfig(linked, 'main'), /not a plain file \(blob 120000\)/);
});

test('when globs: the supported syntax passes, malformed globs and lists are refused', () => {
  for (const ok of ['src/**', '*.md', '**/*.test.ts', 'docs/{a,b}/*', 'src/[abc].ts', 'src/[a-z]*', 'src/[!x]*', 'f?le']) assert.equal(globError(ok), null, ok);
  const bad = { '': 'is empty', '/src/**': 'starts with /', 'src\\x': 'backslash', '../x': '. or ..', 'src/./x': '. or ..', 'src/[': 'unclosed [', 'src/[]x': 'empty []', 'src/[!]': 'empty []', 'src/[a/b]': 'holding [ or /', 'src/[a[b]': 'holding [ or /', 'src/a]': '] with no [', 'src/{a,b': 'unclosed {', 'src/{a,{b}}': 'nests', 'src/a}': '} with no {' };
  for (const [glob, why] of Object.entries(bad)) assert.ok(globError(glob)?.includes(why), `${JSON.stringify(glob)}: ${globError(glob)}`);
  assert.throws(() => validateRepoConfig({ gates: [{ name: 'a', command: 'x', when: 'src/[' }] }), /gates\[0\]: when glob "src\/\[" has an unclosed \[ class/);
  assert.throws(() => validateRepoConfig({ gates: [{ name: 'a', command: 'x', when: ['src/**', 'src/{a,b'] }] }), /gates\[0\]: when glob "src\/\{a,b" has an unclosed \{ brace/);
  assert.throws(() => validateRepoConfig({ gates: [{ name: 'a', command: 'x', when: ['src/**', 7] }] }), /gates\[0\]: when must be a path glob/);
  assert.throws(() => validateRepoConfig({ gates: [{ name: 'a', command: 'x', when: '' }] }), /when glob "" is empty/);
});

test('the Gates: line names config gates, auto or none', () => {
  const c = validateRepoConfig(CONFIG);
  assert.deepEqual(parseRepoGates('ITSA: S-1\nGates: e2e; web; e2e\nDeploy: normal', c), ['e2e', 'web']);
  assert.deepEqual(parseRepoGates('Gates: auto', c), []);
  assert.deepEqual(parseRepoGates('Gates: none', c), []);
  assert.throws(() => parseRepoGates('Gates: none; unit', c), /stands alone/);
  assert.throws(() => parseRepoGates('Gates: unit; tsc; phone', c), /unknown gates: tsc, phone; .stam\/repo.json has unit, web, docs, e2e/);
  assert.throws(() => parseRepoGates('Gates: unit', validateRepoConfig({})), /has no gates/);
  assert.throws(() => parseRepoGates('ITSA: S-1', c), /no Gates: line/);
  assert.throws(() => parseRepoGates('Gates: ;', c), /names no gates/);
});

test('a PR runs the gates with no when, the ones it names, and the ones its paths match, in config order', () => {
  const c = validateRepoConfig(CONFIG);
  const names = (named, paths) => selectGates(c, named, paths).map((g) => g.name);
  assert.deepEqual(names([], ['src/a.ts']), ['unit']);
  assert.deepEqual(names([], ['web/src/App.tsx', 'README.md']), ['unit', 'web', 'docs']);
  assert.deepEqual(names(['e2e'], ['docs/x/y.md']), ['unit', 'docs', 'e2e']);
  assert.deepEqual(names([], []), ['unit']);
});
