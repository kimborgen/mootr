#!/usr/bin/env node
// The settings stam generates for a Claude Code agent carry the read-only allow rules and
// the secret deny rules (S-570), and the allow list holds nothing that writes, deletes,
// pushes, or starts a process. Throwaway STAM_HOME, no daemon, no model.
// `node --test test/claude-permissions.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-claude-perms-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `claude-perms-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, claude, rules, DEFAULT_STAM_HOME;
before(async () => {
  await import('../src/adapters/index.ts');
  db = await import('../src/db.ts');
  claude = (await import('../src/adapters/claude.ts')).claude;
  rules = await import('../src/adapters/claude-permissions.ts');
  // Loaded after STAM_HOME is set, as every other import here is: a static import would pin config.
  DEFAULT_STAM_HOME = (await import('../src/config.ts')).DEFAULT_STAM_HOME;
});
after(() => rmSync(home, { recursive: true, force: true }));

async function generated() {
  db.createAgent({ id: 'perm-1', name: 'perm-1', role: 'test', machine: 'x', harness: 'claude', model: null, effort: null, cwd: tmpdir(), parent_id: null, session_id: 'perm-session' });
  await claude.launch(db.getAgent('perm-1'));
  return JSON.parse(readFileSync(join(home, 'agents', 'perm-1', 'claude-settings.json'), 'utf8')).permissions;
}

test('generated settings > carry stam tools, the read-only allow rules, and the secret deny rules', async () => {
  const p = await generated();
  assert.ok(p.allow.includes('mcp__stam'));
  for (const r of ['Bash(git status:*)', 'Bash(git log:*)', 'Bash(cat:*)', 'Bash(sed -n:*)', 'Bash(grep:*)']) assert.ok(p.allow.includes(r), r);
  assert.ok(p.allow.some((r) => r.startsWith('Read(//') && r.endsWith('/worktrees/**/*.png)')), 'worktree screenshots');
  for (const r of rules.allowRules()) assert.ok(p.allow.includes(r), `allow ${r}`);
  assert.deepEqual(p.deny, rules.denyRules());
  for (const r of ['Bash(*stam/stam.db*)', 'Bash(*stam/token*)', 'Bash(*stam/peer-token*)', 'Bash(*stam/settings.json*)', 'Bash(*stam/settings.shared.json*)', 'Bash(*/.ssh/*)']) assert.ok(p.deny.includes(r), r);
  // The Read tool denies the token and settings files by resolved path (S-743), so a tty read
  // of the peer token is refused, not only `cat`/`grep` on the command line.
  for (const h of [home, DEFAULT_STAM_HOME]) for (const f of ['token', 'peer-token', 'settings.json', 'settings.shared.json', 'settings.json.*']) {
    const r = `Read(/${h}/${f})`;
    assert.ok(p.deny.includes(r), r);
    assert.ok(r.startsWith('Read(//'), `a Read deny is absolute: ${r}`);
  }
  assert.ok(!p.deny.some((r) => r.startsWith('Read(') && r.endsWith('.png)')), 'the deny list does not deny the screenshot reads');
});

test("generated settings > turn Claude Code's own idle compaction off, as stam compacts idle agents (S-2238)", async () => {
  db.createAgent({ id: 'idle-1', name: 'idle-1', role: 'test', machine: 'x', harness: 'claude', model: null, effort: null, cwd: tmpdir(), parent_id: null, session_id: 'idle-session' });
  await claude.launch(db.getAgent('idle-1'));
  assert.equal(JSON.parse(readFileSync(join(home, 'agents', 'idle-1', 'claude-settings.json'), 'utf8')).idleCompaction, false);
});

test('allow rules > nothing that writes, deletes, pushes, or runs a process', () => {
  const banned = /\b(rm|sed -i|find|xargs|push|fetch|ls-remote|gh|kill|tmux|ssh|sudo|docker|python3?|node|sh|bash|tee|mv|cp|chmod)\b|\bgit (branch -[dDmM]|checkout|reset|clean|commit|add|config)\b/;
  for (const r of rules.allowRules()) {
    if (r.startsWith('Read(')) {
      assert.ok(r.endsWith('.png)'), `a Read rule covers images only: ${r}`);
      continue;
    }
    assert.ok(!banned.test(r.replace(/^Bash\(|\)$/g, '')), `risky allow rule: ${r}`);
  }
  assert.ok(!rules.allowRules().some((r) => r.includes('git -C')), 'git -C is unverified and left out');
});

test('deny rules > cover the daemon STAM_HOME, given and resolved, not only the default home', () => {
  const link = `${home}-link`;
  symlinkSync(home, link);
  after(() => rmSync(link, { force: true }));
  const d = rules.denyRules(link);
  const files = ['token', 'peer-token', 'mcp-lease-token', 'mcp-lease-token.*', 'settings.json', 'settings.shared.json', 'settings.json.*', 'opencode.env', 'voice.env', 'mcp-auth.json', 'secrets.json', 'secrets.json.*'];
  for (const h of [link, home, DEFAULT_STAM_HOME]) {
    for (const f of files) assert.ok(d.includes(`Read(/${h}/${f})`), `${h}/${f}`);
  }
  assert.deepEqual(rules.denyRules('/nonexistent-stam-home').filter((r) => r.startsWith('Read(') && r.includes('/nonexistent-stam-home/')).length, files.length);
});

test('deny rules > Edit and Write refuse the secret files too, not only Read (S-1888)', () => {
  const d = rules.denyRules();
  for (const f of ['token', 'peer-token', 'mcp-lease-token', 'settings.json', 'settings.json.*', 'opencode.env', 'voice.env', 'mcp-auth.json', 'secrets.json', 'secrets.json.*']) {
    for (const tool of ['Edit', 'Write']) assert.ok(d.includes(`${tool}(/${DEFAULT_STAM_HOME}/${f})`), `${tool} ${f}`);
  }
});

test('deny rules > Bash refuses commands naming the provider keys and the MCP auth store (S-1888)', () => {
  const d = rules.denyRules();
  for (const f of ['opencode.env', 'voice.env', 'mcp-auth.json', 'secrets.json']) assert.ok(d.includes(`Bash(*stam/${f}*)`), f);
});
