#!/usr/bin/env node
// S-896: workspace_share. Grant, revoke, idempotence, a non-holder refused, the grantee's
// "Shared with you" block, the Claude settings and Codex roots, the cost-switch carry-over and
// the archive rules. Throwaway STAM_HOME, no daemon, no model.
// `node --test test/workspace-share.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ws-share-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `ws-share-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, share, prompt, claude, codex, lifecycle, secretPaths;
before(async () => {
  await import('../src/adapters/index.ts');
  db = await import('../src/db.ts');
  share = await import('../src/workspace-share.ts');
  prompt = await import('../src/workspace-prompt.ts');
  claude = (await import('../src/adapters/claude.ts')).claude;
  codex = await import('../src/adapters/codex.ts');
  lifecycle = await import('../src/lifecycle.ts');
  secretPaths = (await import('../src/secret-files.ts')).secretPaths;
});
after(() => rmSync(home, { recursive: true, force: true }));

// The Codex profile of a default or auto agent: its writable roots, and every secret file denied (S-1888), each
// at its real path (S-3861).
const profile = (roots) => ({
  'permissions.stam.extends': ':workspace',
  'permissions.stam.filesystem': { ...Object.fromEntries(roots.map((p) => [p, 'write'])), ...Object.fromEntries(secretPaths().map((p) => [codex.sandboxPath(p), 'none'])) },
});

let n = 0;
function agent(extra = {}, harness = 'claude') {
  const id = `ws${++n}`;
  db.createAgent({ id, name: `agent-${id}`, role: '', machine: 'x', harness, model: null, effort: null, cwd: tmpdir(), parent_id: null, session_id: `s-${id}` });
  db.updateAgent(id, { lifecycle: 'active', ...extra });
  return db.getAgent(id);
}
function holder(files = {}) {
  const path = join(home, 'workspaces', `ws-${++n}`);
  mkdirSync(path, { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(join(path, f), t);
  return agent({ personal_workspace: path });
}

test('grant, change, revoke, and idempotence', () => {
  const owner = holder(), g = agent();
  share.share(owner.id, g.name, 'read');
  assert.deepEqual(share.grantsFor(g.id), [{ owner: owner.name, path: owner.personal_workspace, access: 'read' }]);
  share.share(owner.id, g.id, 'read');
  assert.equal(share.grantsFor(g.id).length, 1, 'same grant twice is one row');
  share.share(owner.id, g.id, 'write');
  assert.deepEqual(share.grantedPaths(g.id, 'write'), [owner.personal_workspace]);
  assert.deepEqual(share.grantedPaths(g.id, 'read'), []);
  share.share(owner.id, g.id, 'none');
  assert.deepEqual(share.grantsFor(g.id), []);
  assert.match(share.share(owner.id, g.id, 'none').message, /wasn't shared/);
});

test('refuses a caller without a workspace, a bad access, self, an unknown or archived grantee', () => {
  const plain = agent(), owner = holder(), g = agent();
  assert.throws(() => share.share(plain.id, g.id, 'read'), /no personal workspace/);
  assert.throws(() => share.share(owner.id, g.id, 'admin'), /access must be/);
  assert.throws(() => share.share(owner.id, owner.id, 'read'), /own workspace/);
  assert.throws(() => share.share(owner.id, 'nobody', 'read'), /no agent nobody/);
  db.updateAgent(g.id, { lifecycle: 'archived' });
  assert.throws(() => share.share(owner.id, g.id, 'read'), /archived/);
  const far = agent({ machine: 'elsewhere' });
  assert.throws(() => share.share(owner.id, far.id, 'read'), /runs on elsewhere/);
});

test('the grantee gets a Shared with you block, with or without its own workspace', () => {
  const owner = holder({ 'private.md': 'the owner index' }), g = agent();
  assert.equal(prompt.workspacePrompt(g), '');
  share.share(owner.id, g.id, 'read');
  const only = prompt.workspacePrompt(g);
  assert.match(only, /# Your workspace/);
  assert.ok(only.includes(`${owner.name}: \`${owner.personal_workspace}\` (read)`));
  assert.match(only, /advisory/);
  assert.ok(!only.includes('the owner index'), 'paths only, not the owner index');
  const own = holder({ 'mine.md': 'my notes' });
  share.share(owner.id, own.id, 'write');
  const both = prompt.workspacePrompt(db.getAgent(own.id));
  assert.ok(both.includes('mine.md') && both.includes('(write)'));
  assert.equal(prompt.workspacePrompt(db.getAgent(owner.id)).includes('Shared with you'), false);
});

test('Claude settings list the granted paths; Codex gets write grants as writable roots', async () => {
  const owner = holder(), readR = holder(), g = agent();
  share.share(owner.id, g.id, 'write');
  share.share(readR.id, g.id, 'read');
  await claude.launch(g);
  const dirs = JSON.parse(readFileSync(join(home, 'agents', g.id, 'claude-settings.json'), 'utf8')).permissions.additionalDirectories;
  assert.ok(dirs.includes(owner.personal_workspace) && dirs.includes(readR.personal_workspace));
  const cx = agent({}, 'codex');
  assert.deepEqual(codex.agentSandbox(cx), profile([]));
  share.share(owner.id, cx.id, 'write');
  share.share(readR.id, cx.id, 'read');
  assert.deepEqual(codex.agentSandbox(cx), profile([owner.personal_workspace]));
});

test('the owner\'s own folder is allowed for Claude and writable for Codex, and its block lists who it shares with', async () => {
  const owner = holder(), g = agent();
  await claude.launch(owner);
  const dirs = JSON.parse(readFileSync(join(home, 'agents', owner.id, 'claude-settings.json'), 'utf8')).permissions.additionalDirectories;
  assert.ok(dirs.includes(owner.personal_workspace));
  const cx = agent({ personal_workspace: owner.personal_workspace }, 'codex');
  assert.deepEqual(codex.agentSandbox(cx), profile([owner.personal_workspace]));
  share.share(owner.id, g.id, 'write');
  assert.match(prompt.workspacePrompt(db.getAgent(owner.id)), new RegExp(`You share this folder with: ${g.name} \\(write\\)`));
});

test('the notice says when the path becomes usable, per harness', () => {
  assert.match(share.shareNotice('o', 'claude', '/p', 'read'), /don't read it before then/);
  assert.match(share.shareNotice('o', 'codex', '/p', 'write'), /writable at your next launch/);
  assert.match(share.shareNotice('o', 'opencode', '/p', 'read'), /Use it now/);
});

test('a revoke says when the access ends, per harness and access, to the grantee and the owner', () => {
  const owner = holder(), w = agent(), r = agent({}, 'codex'), cr = agent({}, 'codex');
  const p = owner.personal_workspace;
  // Claude reads its allowed directories at launch, whatever the access: it ends at the next launch.
  share.share(owner.id, w.id, 'write');
  assert.match(share.share(owner.id, w.id, 'none').message, /Access ends at .+ next launch, not now/);
  assert.match(share.revokeNotice(owner.name, p, 'claude', 'read'), /stays reachable until your next launch/);
  // Codex write roots apply at launch, so that ends at the next launch too.
  share.share(owner.id, cr.id, 'write');
  assert.match(share.share(owner.id, cr.id, 'none').message, /Access ends at .+ next launch, not now/);
  // Codex read grants and OpenCode never had a launch gate: the sandbox never enforced them.
  share.share(owner.id, r.id, 'read');
  const codexRead = share.share(owner.id, r.id, 'none').message;
  assert.match(codexRead, /Nothing enforced this access/);
  assert.doesNotMatch(codexRead, /next launch/);
  assert.match(share.revokeNotice(owner.name, p, 'codex', 'read'), /please just stop using the folder/);
  assert.doesNotMatch(share.revokeNotice(owner.name, p, 'opencode', 'write'), /next launch/);
  assert.match(share.revokeMessage('g', p, 'opencode', 'write'), /must stop using the folder itself/);
});

test('a revoke reads the live grantee\'s own grant, not a stopped predecessor\'s', () => {
  const owner = holder(), g = agent({}, 'codex'), succ = agent({}, 'codex');
  share.share(owner.id, g.id, 'write');
  share.copyGrants(g.id, succ.id);
  db.updateAgent(g.id, { forwarded_to: succ.id });
  share.share(owner.id, succ.id, 'read'); // downgraded; the predecessor's row still says write
  assert.match(share.share(owner.id, succ.id, 'none').message, /Nothing enforced this access/);
});

test('a grant follows the grantee through a cost switch, and none revokes the whole chain', () => {
  const owner = holder(), g = agent(), succ = agent();
  share.share(owner.id, g.id, 'write');
  share.copyGrants(g.id, succ.id);
  db.updateAgent(g.id, { forwarded_to: succ.id });
  assert.equal(share.grantsFor(succ.id).length, 1, 'the successor holds the grant');
  // A grant to the old name lands on the live successor.
  share.share(owner.id, g.name, 'read');
  assert.equal(share.grantsFor(succ.id)[0].access, 'read');
  assert.equal(share.grantsFor(g.id)[0].access, 'write', 'the stopped predecessor is untouched');
  share.share(owner.id, g.name, 'none');
  assert.equal(share.grantsFor(g.id).length + share.grantsFor(succ.id).length, 0, 'none clears both');
});

test('archiving the grantee drops its grants; the owner keeps them, and a respawn adopting the folder is named', async () => {
  const owner = holder(), g = agent();
  share.share(owner.id, g.id, 'read');
  // Archive asks an active agent for a final round first (S-1043); the sweep runs it past its deadline.
  const sweep = () => lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  await lifecycle.archive(db.getAgent(owner.id), true);
  await sweep();
  assert.equal(db.getAgent(owner.id).lifecycle, 'archived');
  assert.equal(share.grantsFor(g.id).length, 1, 'archiving the owner keeps the grants');
  const adopter = agent({ personal_workspace: owner.personal_workspace });
  assert.equal(share.grantsFor(g.id)[0].owner, adopter.name, 'the grantee sees the folder\'s current holder');
  assert.ok(prompt.workspacePrompt(db.getAgent(adopter.id)).includes(g.name), 'the holder sees who has access');
  await lifecycle.archive(db.getAgent(g.id), true);
  await sweep();
  assert.equal(db.getAgent(g.id).lifecycle, 'archived');
  assert.equal(share.grantsFor(g.id).length, 0, 'archiving the grantee drops its grants');
});
