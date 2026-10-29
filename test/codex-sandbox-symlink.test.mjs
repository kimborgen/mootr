#!/usr/bin/env node
// S-3861: Codex's sandbox profile names real paths. After the S-2890 move ~/.local/share/stam is a symlink to
// ~/.local/share/mootr, and bwrap can't bind a secret file (`none`) or a writable root through a symlink, so
// every Codex spawn died before its first prompt. A throwaway HOME with that layout, a scripted fake
// `codex --version`, no daemon, no model: `node --test test/codex-sandbox-symlink.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

// The live layout: the real folder is mootr, and stam is a symlink to it. HOME is set first, so the default
// homes (src/config.ts DEFAULT_HOMES) sit under it too.
const home = tempHome('stam-codex-symlink-');
process.env.HOME = home;
const mootr = join(home, '.local', 'share', 'mootr');
const stam = join(home, '.local', 'share', 'stam');
mkdirSync(mootr, { recursive: true });
symlinkSync(mootr, stam);
process.env.STAM_HOME = stam;
process.env.STAM_TMUX_SOCKET = `codex-sandbox-symlink-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// A fake `codex --version` precedes the real binary, so the launch needs nothing installed. The matching
// trust cache short-circuits hookTrust, so no app-server is probed.
const fakeBin = join(home, 'codex');
writeFileSync(fakeBin, '#!/bin/sh\necho "codex-cli test"\n');
chmodSync(fakeBin, 0o755);
process.env.STAM_CODEX_BIN = fakeBin;

let db, codex, secrets, STAM_BIN, project;

before(async () => {
  await import('../src/adapters/index.ts');
  db = await import('../src/db.ts');
  codex = await import('../src/adapters/codex.ts');
  secrets = await import('../src/secret-files.ts');
  ({ STAM_BIN } = await import('../src/config.ts'));
  writeFileSync(join(mootr, 'codex-hook-trust.json'), JSON.stringify({ version: codex.codex.version(), command: `${STAM_BIN} hook codex`, state: {} }));
  project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(stam, 'workspaces', 'shared'), { recursive: true });
});

after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent(extra = {}) {
  const id = `symlink-${++n}`;
  db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'codex', model: 'gpt-6.1-sol', effort: null, cwd: project, parent_id: null, session_id: null });
  db.updateAgent(id, extra);
  return db.getAgent(id);
}

const filesystem = (a) => codex.agentSandbox(a)['permissions.stam.filesystem'];

test('no sandbox entry names a path through the symlinked home', () => {
  const keys = Object.keys(filesystem(agent()));
  // Both spellings of the home resolve to the same real paths, so each secret file is one entry.
  assert.equal(keys.length, secrets.SECRET_FILES.length, 'the secret files, deduped');
  for (const k of keys) {
    assert.ok(!k.startsWith(`${stam}/`), `${k} goes through the symlink`);
    assert.equal(codex.sandboxPath(k), k, `${k} is already a real path`);
  }
});

test('every secret file is denied under the real home, glob entries included (S-1888)', () => {
  const fs = filesystem(agent());
  for (const f of secrets.SECRET_FILES) assert.equal(fs[join(mootr, f)], 'none', f);
  assert.equal(fs[join(mootr, 'mcp-lease-token.*')], 'none');
  assert.equal(fs[join(mootr, 'settings.json.*')], 'none');
  assert.equal(fs[join(mootr, 'secrets.json.*')], 'none');
});

test('a personal workspace under the symlinked home is writable at its real path', () => {
  const fs = filesystem(agent({ personal_workspace: join(stam, 'workspaces', 'shared') }));
  assert.equal(fs[join(mootr, 'workspaces', 'shared')], 'write');
  assert.ok(!(`${stam}/workspaces/shared` in fs), 'no entry names the symlink');
});

test('a path that does not exist yet takes the real spelling of its existing ancestor', () => {
  assert.equal(codex.sandboxPath(join(stam, 'not', 'yet', 'here')), join(mootr, 'not', 'yet', 'here'));
  assert.equal(codex.sandboxPath(join(stam, 'token')), join(mootr, 'token'), 'a missing secret file');
});

test('a path with no symlink in it is returned as given', () => {
  assert.equal(codex.sandboxPath(join(mootr, 'token')), join(mootr, 'token'));
  assert.equal(codex.sandboxPath('/nonexistent-folder/token'), '/nonexistent-folder/token');
});

test('an error other than not-found keeps the path as given, so its deny stays (fail closed)', () => {
  // A file used as a folder: realpath fails with ENOTDIR, not ENOENT.
  const file = join(mootr, 'plain-file');
  writeFileSync(file, 'x');
  assert.equal(codex.sandboxPath(join(file, 'token')), join(file, 'token'));
});

test('the launch script denies each secret by its real path, and not through the symlink (S-3861)', async () => {
  const a = agent({ type: 'developer' });
  await codex.codex.launch(a);
  const script = readFileSync(join(stam, 'agents', a.id, 'codex-launch.sh'), 'utf8');
  assert.ok(script.includes(`"${join(mootr, 'token')}"="none"`), script);
  assert.ok(script.includes(`"${join(mootr, 'mcp-lease-token.*')}"="none"`), script);
  assert.ok(!script.includes(`"${join(stam, 'token')}"="none"`), 'no entry names the symlink');
  assert.ok(existsSync(join(stam, 'agents', a.id, 'codex-launch.sh')));
});
