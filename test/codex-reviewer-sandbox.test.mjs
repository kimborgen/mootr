#!/usr/bin/env node
// S-731: Codex's workspace-write sandbox has no network and only the workspace writable, so a
// reviewer agent can't `gh`/`git fetch` a PR. A reviewer-type Codex launch gets network access and
// ~/.cache/stam-review writable, where the brief makes its own clone (S-817); the shared repo's
// git dir is never writable (a reviewer in the live checkout must not reach its hooks/config).
// The root is created before launch, since the sandbox can't make it. A non-reviewer keeps the
// plain policy. Throwaway STAM_HOME and HOME, a scripted fake `codex --version` (no real Codex, no
// model), no daemon: `node --test test/codex-reviewer-sandbox.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-codex-reviewer-');
process.env.STAM_HOME = home;
// Keep the reviewer scratch root under the throwaway home, so its creation is checked in isolation.
process.env.HOME = home;
process.env.STAM_TMUX_SOCKET = `codex-reviewer-sandbox-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// A fake `codex --version` precedes the real binary, so the launch needs nothing installed. The
// matching trust cache below short-circuits hookTrust, so no app-server is ever probed.
const fakeBin = join(home, 'codex');
writeFileSync(fakeBin, '#!/bin/sh\necho "codex-cli test"\n');
chmodSync(fakeBin, 0o755);
process.env.STAM_CODEX_BIN = fakeBin;

let db, codex, STAM_BIN, repo;
const reviewRoot = join(home, '.cache', 'stam-review');

before(async () => {
  await import('../src/adapters/index.ts');
  db = await import('../src/db.ts');
  codex = await import('../src/adapters/codex.ts');
  ({ STAM_BIN } = await import('../src/config.ts'));
  writeFileSync(join(home, 'codex-hook-trust.json'), JSON.stringify({ version: codex.codex.version(), command: `${STAM_BIN} hook codex`, state: {} }));
  // A throwaway git repo as the agent's cwd, so the test can prove its .git is not a writable root.
  repo = mkdtempSync(join(tmpdir(), 'stam-codex-repo-'));
  execFileSync('git', ['init', '-q', repo]);
});

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

let n = 0;
function agent(type) {
  const id = `sandbox-${++n}`;
  db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'codex', model: 'gpt-6.1-sol', effort: null, cwd: repo, parent_id: null, session_id: null });
  if (type) db.updateAgent(id, { type });
  return db.getAgent(id);
}

test('a reviewer launch makes the writable scratch root (the sandbox cannot)', async () => {
  rmSync(reviewRoot, { recursive: true, force: true });
  assert.ok(!existsSync(reviewRoot), 'the root starts absent');
  await codex.codex.launch(agent('reviewer'));
  assert.ok(existsSync(reviewRoot), 'the launch created ~/.cache/stam-review');
});

test('a reviewer type gets network access and only the scratch root writable', () => {
  const r = codex.reviewerSandbox(agent('reviewer'));
  assert.equal(r['sandbox_workspace_write.network_access'], true);
  assert.deepEqual(r['sandbox_workspace_write.writable_roots'], [reviewRoot]);
  assert.ok(!r['sandbox_workspace_write.writable_roots'].includes(join(repo, '.git')), 'the shared repo git dir must never be writable');
});

test('a non-reviewer type gets no sandbox overrides', () => {
  assert.deepEqual(codex.reviewerSandbox(agent('developer')), {});
  assert.deepEqual(codex.reviewerSandbox(agent(null)), {}, 'an untyped agent keeps the plain policy');
});

test('the reviewer launch script carries the sandbox overrides, and another type does not', async () => {
  const r = agent('reviewer');
  await codex.codex.launch(r);
  const script = readFileSync(join(home, 'agents', r.id, 'codex-launch.sh'), 'utf8');
  assert.ok(script.includes('sandbox_workspace_write.network_access=true'), script);
  assert.ok(script.includes(`sandbox_workspace_write.writable_roots=["${reviewRoot}"]`), script);
  assert.ok(!script.includes('.git'), `the shared git dir is on a writable root: ${script}`);

  const d = agent('developer');
  await codex.codex.launch(d);
  const dev = readFileSync(join(home, 'agents', d.id, 'codex-launch.sh'), 'utf8');
  assert.ok(!dev.includes('sandbox_workspace_write.'), dev);
});
