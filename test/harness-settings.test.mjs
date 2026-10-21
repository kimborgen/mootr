#!/usr/bin/env node
// settings.harness (S-2240): the harnesses' own cache and compaction keys, passed on at launch. Claude's go into the
// per-agent claude-settings.json, Codex's are `-c` overrides on its app-server. With none set (no key, an empty
// section, or every key cleared to null) both launches are byte-identical to today's. A value the harness wouldn't
// take is refused at write time, and one written by hand never reaches a launch. Throwaway STAM_HOME and HOME, a
// scripted fake `codex --version` (no real harness, no model), no daemon: `node --test test/harness-settings.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-harness-settings-');
process.env.STAM_HOME = home;
process.env.HOME = home;
process.env.STAM_MACHINE = 'test-storage';
process.env.STAM_TMUX_SOCKET = `harness-settings-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// A fake `codex --version`; the matching trust cache below short-circuits hookTrust, so no app-server is probed.
const fakeBin = join(home, 'codex');
writeFileSync(fakeBin, '#!/bin/sh\necho "codex-cli test"\n');
chmodSync(fakeBin, 0o755);
process.env.STAM_CODEX_BIN = fakeBin;

let db, claude, codex, s, perms;
before(async () => {
  await import('../src/adapters/index.ts');
  db = await import('../src/db.ts');
  claude = (await import('../src/adapters/claude.ts')).claude;
  codex = await import('../src/adapters/codex.ts');
  s = await import('../src/settings.ts');
  perms = await import('../src/permissions.ts');
  const { STAM_BIN } = await import('../src/config.ts');
  writeFileSync(join(home, 'codex-hook-trust.json'), JSON.stringify({ version: codex.codex.version(), command: `${STAM_BIN} hook codex`, state: {} }));
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent(harness) {
  const id = `hs-${++n}`;
  db.createAgent({ id, name: id, role: 'test', machine: 'test-storage', harness, model: harness === 'codex' ? 'gpt-6.1-sol' : null, effort: null, cwd: tmpdir(), parent_id: null, session_id: 'hs-session' });
  return db.getAgent(id);
}
// The launch files with settings.harness set to `h` (undefined: the key left out of settings.json).
async function launched(h) {
  const user = JSON.parse(s.readSettingsText() || '{}');
  if (h === undefined) delete user.harness;
  else user.harness = h;
  s.writeSettingsText(JSON.stringify(user, null, 2));
  const c = agent('claude');
  await claude.launch(c);
  const x = agent('codex');
  await codex.codex.launch(x);
  return {
    claude: readFileSync(join(home, 'agents', c.id, 'claude-settings.json'), 'utf8'),
    codex: readFileSync(join(home, 'agents', x.id, 'codex-launch.sh'), 'utf8').replaceAll(x.id, 'AGENT'),
  };
}

test('none set: both launches are byte-identical, whether the key is missing, empty or cleared', async () => {
  const before = await launched(undefined);
  assert.deepEqual(Object.keys(JSON.parse(before.claude)).sort(), ['hooks', 'idleCompaction', 'permissions', 'statusLine']);
  assert.equal(JSON.parse(before.claude).idleCompaction, false, "stam's own idle compaction off stays");
  assert.doesNotMatch(before.codex, /model_auto_compact_token_limit/);
  for (const h of [{ claude: {}, codex: {} }, {}, { claude: { promptCacheTtl: null, subagentPromptCacheTtl: null, idleCompaction: null, autoCompactWindow: null }, codex: { model_auto_compact_token_limit: null } }]) {
    const now = await launched(h);
    assert.equal(now.claude, before.claude, JSON.stringify(h));
    assert.equal(now.codex, before.codex, JSON.stringify(h));
  }
});

test('set keys go into claude-settings.json and the Codex overrides', async () => {
  const r = await launched({ claude: { promptCacheTtl: '5m', subagentPromptCacheTtl: '1h', idleCompaction: true, autoCompactWindow: 400_000 }, codex: { model_auto_compact_token_limit: 200_000 } });
  const c = JSON.parse(r.claude);
  assert.deepEqual([c.promptCacheTtl, c.subagentPromptCacheTtl, c.idleCompaction, c.autoCompactWindow], ['5m', '1h', true, 400_000]);
  assert.ok(c.permissions.allow.includes('mcp__stam'), "stam's own keys stay");
  assert.match(r.codex, /'-c' 'model_auto_compact_token_limit=200000'|-c model_auto_compact_token_limit=200000/);
  // One key set leaves the others out.
  const one = JSON.parse((await launched({ claude: { promptCacheTtl: '1h' } })).claude);
  assert.equal(one.promptCacheTtl, '1h');
  assert.ok(!('subagentPromptCacheTtl' in one) && !('autoCompactWindow' in one));
  assert.equal(one.idleCompaction, false);
});

// Names Object.prototype has: an inherited lookup would find them (S-2240 review).
const PROTO = [
  [{ claude: { constructor: 1 } }, /harness\.claude\.constructor is not a setting stam passes on/],
  [{ claude: { toString: '1h' } }, /harness\.claude\.toString is not a setting stam passes on/],
  [JSON.parse('{"claude":{"__proto__":{"ok":1}}}'), /harness\.claude\.__proto__ is not a setting stam passes on/],
  [{ constructor: {} }, /harness\.constructor is not a harness stam sets/],
  [{ toString: {} }, /harness\.toString is not a harness stam sets/],
  [JSON.parse('{"__proto__":{}}'), /harness\.__proto__ is not a harness stam sets/],
];
const BAD = [
  [{ claude: { promptCacheTtl: '10m' } }, /harness\.claude\.promptCacheTtl must be "5m" or "1h"/],
  [{ claude: { subagentPromptCacheTtl: 3600 } }, /subagentPromptCacheTtl must be "5m" or "1h"/],
  [{ claude: { idleCompaction: 'no' } }, /idleCompaction must be true or false/],
  [{ claude: { autoCompactWindow: 50_000 } }, /autoCompactWindow must be a whole number of tokens from 100000 to 1000000/],
  [{ claude: { autoCompactWindow: 200_000.5 } }, /autoCompactWindow/],
  [{ codex: { model_auto_compact_token_limit: 0 } }, /model_auto_compact_token_limit must be a whole number of tokens above 0/],
  [{ claude: { promptCacheTTL: '1h' } }, /harness\.claude\.promptCacheTTL is not a setting stam passes on/],
  [{ opencode: {} }, /harness\.opencode is not a harness stam sets/],
  [{ claude: '1h' }, /harness\.claude must be an object/],
  ['1h', /harness must be an object/],
  ...PROTO,
];

test('a value the harness would not take is refused on every write path, and nothing is written', async () => {
  const kept = s.readSettingsText();
  const asker = agent('claude');
  for (const [h, re] of BAD) {
    const what = JSON.stringify(h);
    // The settings page's patch (PATCH /api/config/settings).
    const r = s.patchSettings({ harness: h });
    assert.equal(r.field, 'harness', what);
    assert.match(r.problem, re, what);
    // The whole-file save (PUT /api/config/settings checks fileProblem).
    const whole = { ...JSON.parse(kept), harness: h };
    const f = s.fileProblem(whole);
    assert.equal(f?.field, 'harness', what);
    assert.match(f.problem, re, what);
    // settings_ask, as a patch and as a whole file: refused before the human is asked.
    for (const change of [{ kind: 'patch', patch: { harness: h }, fill: false }, { kind: 'post', text: JSON.stringify(whole) }]) {
      const ask = await perms.requestSettingsChange(asker, change);
      assert.ok('error' in ask, `${change.kind} ${what}`);
      assert.match(ask.error, /^harness config rejected: /);
      assert.match(ask.error, re, `${change.kind} ${what}`);
    }
    assert.equal(s.readSettingsText(), kept, `nothing written for ${what}`);
  }
  assert.equal(db.listPermissionRequests().length, 0, 'no ask was made');
  assert.ok('text' in s.patchSettings({ harness: { claude: { promptCacheTtl: '1h', autoCompactWindow: null }, codex: { model_auto_compact_token_limit: 150_000 } } }));
  assert.deepEqual(s.settings().harness, { claude: { promptCacheTtl: '1h' }, codex: { model_auto_compact_token_limit: 150_000 } });
  assert.equal(s.fileProblem(JSON.parse(s.readSettingsText())), null, 'a valid file passes the whole-file check');
});

test('a bad value written by hand never reaches a launch', async () => {
  // Hand-edited names Object.prototype has are dropped too, not thrown on.
  const hand = JSON.parse('{"claude":{"promptCacheTtl":"10m","subagentPromptCacheTtl":"5m","bogus":1,"constructor":1,"toString":"1h","__proto__":{"ok":1}},"codex":{"model_auto_compact_token_limit":-5},"constructor":{"x":1},"toString":{}}');
  const r = await launched(hand);
  assert.deepEqual(s.settings().harness, { claude: { subagentPromptCacheTtl: '5m' }, codex: {} });
  const c = JSON.parse(r.claude);
  for (const k of ['promptCacheTtl', 'bogus', 'toString', 'ok']) assert.ok(!Object.hasOwn(c, k), k);
  assert.equal(c.constructor, Object, 'no own constructor key');
  assert.equal(c.subagentPromptCacheTtl, '5m');
  assert.doesNotMatch(r.codex, /model_auto_compact_token_limit/);
});
