#!/usr/bin/env node
// What pr_open may push (S-581, src/pr-open.ts) against throwaway git repos and a fake gh: an agent's
// own worktree branch, a child's, and a branch linked to an ITSA it takes part in are pushed; another
// agent's branch is refused before any git or gh call; a call with no agent (the human, the shared
// token) is allowed. Nothing touches GitHub. Run with `node --test test/pr-open-scope.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const base = tempDir('stam-pr-open-scope-test-');
const bin = join(base, 'bin');
const ghDir = join(base, 'gh');
const callsFile = join(ghDir, 'calls.jsonl');
process.env.STAM_HOME = join(base, 'home');
process.env.STAM_TMUX_SOCKET = `pr-open-scope-test-${process.pid}`;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];


const BODY = 'ITSA: S-1\nGates: tsc\nDeploy: normal\n\nx\n';
let openPrHere, prStatusHere, prStatusRouted, itsa, db, cfg, work, seed;

const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const clearCalls = () => rmSync(callsFile, { force: true });
const originSha = (branch) => git(work, ['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0];

// A fake gh: `pr list` serves list.json when the test wrote one, `pr create` prints the new PR's url,
// and every call is recorded (with the body it sends) in calls.jsonl under FAKE_GH_DIR.
function fakeGh() {
  mkdirSync(bin, { recursive: true });
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = ${JSON.stringify(ghDir)};
const args = process.argv.slice(2);
const call = { args };
const bodyFile = args[args.indexOf('--body-file') + 1];
if (args.includes('--body-file')) call.body = readFileSync(bodyFile, 'utf8');
const field = args.find((a) => a.startsWith('body=@'));
if (field) call.body = readFileSync(field.slice('body=@'.length), 'utf8');
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(call) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(existsSync(join(dir, 'list.json')) ? readFileSync(join(dir, 'list.json'), 'utf8') : '[]');
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ body: 'ITSA: S-1\\n', headRefOid: 'abc123' }));
} else if (args[0] === 'pr' && args[1] === 'create') {
  process.stdout.write('https://github.com/example/stam/pull/7\\n');
}
`);
  chmodSync(join(bin, 'gh'), 0o755);
}

before(async () => {
  const d = join(base, 'repos');
  mkdirSync(d);
  git(d, ['init', '-q', '--bare', '-b', 'main', 'origin.git']);
  git(d, ['init', '-q', '--bare', '-b', 'main', 'storage.git']);
  // The seed makes main on origin and the feature branch on storage.
  seed = join(d, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'main']);
  git(seed, ['push', '-q', join(d, 'origin.git'), 'main']);
  git(seed, ['checkout', '-q', '-b', 'feature/x']);
  writeFileSync(join(seed, 'a.txt'), 'two\n');
  git(seed, ['commit', '-qam', 'feature']);
  for (const b of ['own', 'child', 'linked', 'other', 'free', 'gone', 'dual', 'old']) git(seed, ['push', '-q', join(d, 'storage.git'), `feature/x:refs/heads/stam/${b}`]);
  // The stam2 checkout: origin is the GitHub stand-in, storage the remote the branch comes from.
  work = join(d, 'work');
  git(d, ['clone', '-q', join(d, 'origin.git'), 'work']);
  git(work, ['remote', 'add', 'storage', join(d, 'storage.git')]);
  fakeGh();

  // The module reads the ITSA store under STAM_HOME; the repo name is one the settings already know.
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  ({ openPrHere, prStatusHere, prStatusRouted } = await import('../src/pr-open.ts'));
  db.open();
  cfg = { repoName: 'stam2', repo: work, storage: 'storage', origin: 'origin', gh: join(bin, 'gh'), github: 'example/stam', base: 'main' };
});

after(() => rmSync(base, { recursive: true, force: true }));

const agent = (id, name, parent, branch) => {
  db.createAgent({ id, name, role: 'developer', machine: 'm', harness: 'claude', model: 'm', effort: 'low', cwd: '/tmp', parent_id: parent, session_id: null });
  if (branch) db.open().prepare('UPDATE agents SET workspace = ? WHERE id = ?').run(JSON.stringify({ worktree: { branch, path: '/tmp/x' } }), id);
};
const push = (branch, via) => openPrHere({ branch, title: 't', body: BODY, by: via?.agent ?? 'human' }, via, cfg);
const as = (agent) => ({ agent, boss: false });

test('own branch, a child\'s branch, and a linked participating ITSA\'s branch are allowed', async () => {
  agent('aaaa2', 'parent-a', null, 'stam/own');
  agent('aaaa3', 'child-a', 'aaaa2', 'stam/child');
  agent('aaaa4', 'other-a', null, 'stam/other');
  const x = await itsa.create({ title: 'Work', owner: 'aaaa2', by: 'human' });
  await itsa.addLink(x.key, { system: 'branch', external_id: 'stam/linked', repo: 'stam2', url: '' }, 'human');
  assert.equal((await push('stam/own', as('aaaa2'))).branch, 'stam/own');
  assert.equal((await push('stam/child', as('aaaa2'))).branch, 'stam/child');
  assert.equal((await push('stam/linked', as('aaaa2'))).branch, 'stam/linked');
  // A participant counts too.
  const y = await itsa.create({ title: 'Shared', owner: 'aaaa4', participants: ['aaaa3'], by: 'human' });
  await itsa.addLink(y.key, { system: 'branch', external_id: 'stam/free', repo: 'stam2', url: '' }, 'human');
  assert.equal((await push('stam/free', as('aaaa3'))).branch, 'stam/free');
});

test('another agent\'s branch is refused before git or gh run, naming the rule', async () => {
  agent('aaaa5', 'stranger', null, 'stam/stranger');
  clearCalls();
  const before = git(work, ['ls-remote', 'origin', 'refs/heads/stam/own']);
  await assert.rejects(push('stam/own', as('aaaa5')), /stranger can't push stam\/own.*rule 1/);
  // A child may not push its parent's branch.
  await assert.rejects(push('stam/own', as('aaaa3')), /can't push stam\/own/);
  assert.equal(existsSync(callsFile), false, 'gh never ran');
  assert.equal(git(work, ['ls-remote', 'origin', 'refs/heads/stam/own']), before);
});

test('a stolen link opens nothing: another agent\'s branch stays refused whatever it is linked to', async () => {
  const x = await itsa.create({ title: 'Stolen', owner: 'aaaa5', by: 'human' });
  await itsa.addLink(x.key, { system: 'branch', external_id: 'stam/own', repo: 'stam2', url: '' }, 'human');
  clearCalls();
  await assert.rejects(push('stam/own', as('aaaa5')), /rule 1/);
  assert.equal(existsSync(callsFile), false);
  // The caller's daemon already answered for a forwarded call: 'tree' passes, 'foreign' refuses, whatever this daemon knows.
  assert.equal((await push('stam/free', { agent: 'aaaa9', boss: false, scope: 'tree' })).branch, 'stam/free');
  await assert.rejects(push('stam/free', { agent: 'aaaa5', boss: false, scope: 'foreign' }), /rule 1/);
});

test('a stopped agent still owns its branch, another owner beats the caller\'s own tree, and only archiving frees a branch', async () => {
  agent('aaaa6', 'stopped', null, 'stam/gone');
  db.open().prepare("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'aaaa6'").run();
  const x = await itsa.create({ title: 'Grab', owner: 'aaaa5', by: 'human' });
  await itsa.addLink(x.key, { system: 'branch', external_id: 'stam/gone', repo: 'stam2', url: '' }, 'human');
  await assert.rejects(push('stam/gone', as('aaaa5')), /rule 1/);
  // aaaa5 and aaaa4 both have a worktree on stam/dual: the other agent's wins over the caller's own.
  agent('aaaa7', 'dual-a', null, 'stam/dual');
  agent('aaaa8', 'dual-b', 'aaaa7', 'stam/dual');
  agent('aaaa9', 'dual-c', null, 'stam/dual');
  await assert.rejects(push('stam/dual', as('aaaa7')), /rule 1/);
  // An archived owner no longer holds the branch: a linked ITSA the caller owns then opens it.
  agent('aaab1', 'retired', null, 'stam/old');
  db.open().prepare("UPDATE agents SET lifecycle = 'archived' WHERE id = 'aaab1'").run();
  await itsa.addLink(x.key, { system: 'branch', external_id: 'stam/old', repo: 'stam2', url: '' }, 'human');
  assert.equal((await push('stam/old', as('aaaa5'))).branch, 'stam/old');
});

test('a forwarded \'tree\' can\'t hide an owner on the home, and a caller\'s own tree passes while a peer is down', async () => {
  // The caller's daemon says 'tree', yet a home agent outside it owns the branch: refused (the earlier bug).
  clearCalls();
  await assert.rejects(push('stam/own', { agent: 'aaaa9', boss: false, scope: 'tree' }), /rule 1/);
  assert.equal(existsSync(callsFile), false);
  // A peer that never answers: a local caller's own branch still passes, a free branch is judged by rule 2 alone (S-1477: a peer that doesn't answer isn't an owner).
  const file = join(base, 'home', 'settings.json');
  mkdirSync(join(base, 'home'), { recursive: true });
  writeFileSync(file, JSON.stringify({ peers: [{ name: 'down', url: 'http://127.0.0.1:9', token: 'x' }] }));
  try {
    assert.equal((await push('stam/own', as('aaaa2'))).branch, 'stam/own');
    await assert.rejects(push('stam/free', as('aaaa2')), (e) => /rule 2/.test(e.message) && !/didn't answer/.test(e.message));
  } finally {
    writeFileSync(file, '{}');
  }
});

test('the shared token and the human (no agent via) push any branch', async () => {
  assert.equal((await push('stam/other', undefined)).branch, 'stam/other');
  assert.equal((await push('stam/own', { agent: 'aaaa5', boss: true })).branch, 'stam/own');
});

// pr_open's status lookup (S-1332) gives the same answer to a caller as the push does: a branch the caller may not push
// is not looked up on GitHub either, whether or not an ITSA is named.
test('the status lookup refuses another agent\'s branch before gh runs, with or without an ITSA named (S-1332)', async () => {
  writeFileSync(join(ghDir, 'list.json'), JSON.stringify([{ number: 7, url: 'https://github.com/example/stam/pull/7' }]));
  try {
    clearCalls();
    await assert.rejects(prStatusHere({ branch: 'stam/own' }, as('aaaa5'), cfg), /stranger can't push stam\/own.*rule 1/);
    const x = await itsa.create({ title: 'Probe', owner: 'aaaa5', by: 'human' });
    await assert.rejects(prStatusHere({ branch: 'stam/own', itsa: x.key }, as('aaaa5'), cfg), /stranger can't push stam\/own/);
    assert.equal(existsSync(callsFile), false, 'gh never ran');
  } finally {
    rmSync(join(ghDir, 'list.json'), { force: true });
  }
});

test('the status lookup answers for the caller\'s own branch, and a routed call takes the caller\'s scope (S-1332)', async () => {
  writeFileSync(join(ghDir, 'list.json'), JSON.stringify([{ number: 7, url: 'https://github.com/example/stam/pull/7' }]));
  try {
    const own = await prStatusHere({ branch: 'stam/own' }, as('aaaa2'), cfg);
    assert.equal(own.found, true);
    assert.equal(own.number, 7);
    assert.equal(own.head, 'abc123');
    // The home answers for a caller whose daemon said the branch is foreign to it: refused, even though nothing here owns it.
    await assert.rejects(prStatusRouted({ branch: 'stam/free' }, { agent: 'aaaa2', boss: false, scope: 'foreign' }), /can't push stam\/free/);
    // The chief of staff (boss) keeps full rights, as on every ITSA route.
    assert.equal((await prStatusHere({ branch: 'stam/other' }, { agent: 'boss', boss: true }, cfg)).found, true);
  } finally {
    rmSync(join(ghDir, 'list.json'), { force: true });
  }
});
