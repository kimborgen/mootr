#!/usr/bin/env node
// Permission mode settings (S-1967) in src/permission-modes.ts and src/settings.ts: the settings'
// defaults and parsing, the mode a new agent gets (type, then harness, then auto), where an older
// agent's mode came from, which running agents are on another mode, the logged settings change,
// and each harness's mapping of 'default'. Its own STAM_HOME; no daemon, no harness.
// `node --test test/permission-modes.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-permmodes-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const { settings } = await import('../src/settings.ts');
const db = await import('../src/db.ts');
const pm = await import('../src/permission-modes.ts');
const { permissionConfig } = await import('../src/adapters/codex.ts');
const { sessionPermissions } = await import('../src/adapters/opencode.ts');

after(() => rmSync(home, { recursive: true, force: true }));

const write = (permissionModes) => writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissionModes }));
let n = 0;
function agent(fields) {
  const id = `pm${++n}`;
  db.createAgent({ id, name: id, role: 't', machine: 'test-machine', harness: fields.harness ?? 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: id });
  db.updateAgent(id, { lifecycle: 'active', ...fields });
  return db.getAgent(id);
}

test('nothing changes until a mode is set: auto for every harness, no type overrides', () => {
  assert.deepEqual(settings().permissionModes, { harness: { claude: 'auto', codex: 'auto', opencode: 'auto' }, types: {} });
  for (const h of ['claude', 'codex', 'opencode']) assert.equal(pm.effectiveMode(h, 'developer'), 'auto');
});

test("a type's override wins over its harness, and 'inherit' or an unknown mode follows the harness", () => {
  write({ harness: { claude: 'bypass', codex: 'nonsense' }, types: { reviewer: 'default', developer: 'inherit', manager: 'yolo' } });
  const p = settings().permissionModes;
  assert.equal(p.harness.codex, 'auto', 'an unknown harness mode keeps the default');
  assert.deepEqual(p.types, { reviewer: 'default' }, "'inherit' and unknown modes are dropped");
  assert.equal(pm.effectiveMode('claude', 'reviewer'), 'default');
  assert.equal(pm.effectiveMode('claude', 'developer'), 'bypass');
  assert.equal(pm.effectiveMode('claude', null), 'bypass');
  assert.equal(pm.effectiveMode('codex', 'manager'), 'auto');
  assert.equal(pm.effectiveMode('somethingelse', null), 'auto', 'a harness with no setting runs auto');
});

test("an agent from before S-1967 follows the settings in auto, and keeps a bypass as the human's pick", () => {
  assert.equal(pm.permissionSource({ permission_mode: 'auto', permission_source: null }), 'settings');
  assert.equal(pm.permissionSource({ permission_mode: 'bypass', permission_source: null }), 'manual');
  assert.equal(pm.permissionSource({ permission_mode: 'bypass', permission_source: 'settings' }), 'settings');
  assert.equal(pm.permissionSource({ permission_mode: 'auto', permission_source: 'manual' }), 'manual');
});

test('the stale list has only running, settings-sourced agents on another mode, and says which switch in place', () => {
  write({ harness: { claude: 'bypass', codex: 'bypass', opencode: 'bypass' }, types: { reviewer: 'auto' } });
  const old = agent({ permission_mode: 'auto', permission_source: 'settings' });
  const legacy = agent({ permission_mode: 'auto', permission_source: null });
  agent({ permission_mode: 'auto', permission_source: 'manual' });
  agent({ permission_mode: 'bypass', permission_source: 'settings' });
  agent({ permission_mode: 'auto', permission_source: 'settings', type: 'reviewer' });
  agent({ permission_mode: 'auto', permission_source: 'settings', lifecycle: 'stopped' });
  const oc = agent({ permission_mode: 'auto', permission_source: 'settings', harness: 'opencode' });
  const cx = agent({ permission_mode: 'auto', permission_source: 'settings', harness: 'codex' });
  const stale = pm.staleAgents();
  assert.deepEqual(stale.map((s) => s.name).sort(), [old.name, legacy.name, oc.name, cx.name].sort());
  for (const s of stale) assert.equal(s.want, 'bypass');
  assert.equal(stale.find((s) => s.name === oc.name).inPlace, false, 'OpenCode keeps its session rules');
  assert.equal(stale.find((s) => s.name === cx.name).inPlace, true);
  assert.ok(stale.every((s) => s.failed === null));
});

test("a shut-down agent is listed only while its last switch is the one that failed, with that switch's error", () => {
  const down = agent({ permission_mode: 'auto', permission_source: 'settings', lifecycle: 'shut_down' });
  assert.ok(!pm.staleAgents().some((s) => s.name === down.name), 'a plain shut-down agent is not listed');
  db.addEvent(down.id, 'permission-mode', { mode: 'bypass', source: 'settings', by: 'human' });
  db.addEvent(down.id, 'permission-mode:failed', { mode: 'bypass', by: 'human', kept: 'auto', error: 'launch failed' });
  assert.equal(pm.staleAgents().find((s) => s.name === down.name)?.failed, 'launch failed');
  db.addEvent(down.id, 'permission-mode', { mode: 'auto', source: 'manual', by: 'human' });
  assert.ok(!pm.staleAgents().some((s) => s.name === down.name), 'a later switch clears the failure');
});

test('a settings change is logged with who made it and the agents left on the old mode; an unchanged write is not', () => {
  const before = settings().permissionModes;
  pm.noteSettingsChange(before, 'human');
  const events = () => db.open().prepare("SELECT data FROM events WHERE agent_id = 'human' AND type = 'permission-modes'").all();
  assert.equal(events().length, 0);
  write({ harness: { claude: 'default' }, types: {} });
  pm.noteSettingsChange(before, 'human');
  const [e] = events().map((r) => JSON.parse(r.data));
  assert.equal(e.by, 'human');
  assert.equal(e.before.harness.claude, 'bypass');
  assert.equal(e.after.harness.claude, 'default');
  assert.ok(e.stale.length > 0);
});

test("each harness maps 'default' to its own asking mode", () => {
  assert.deepEqual(permissionConfig('default'), { approval_policy: 'on-request', default_permissions: 'stam', approvals_reviewer: 'user' });
  assert.deepEqual(permissionConfig('auto'), { approval_policy: 'on-request', default_permissions: 'stam', approvals_reviewer: 'auto_review' });
  assert.equal(permissionConfig('bypass').approval_policy, 'never');
  // The mode's rule comes first, then the secret-file denies (S-1888), which win as the last matching rule.
  assert.deepEqual(sessionPermissions('default').slice(0, 1), [{ action: '*', resource: '*', effect: 'ask' }]);
  assert.deepEqual(sessionPermissions('bypass').slice(0, 1), [{ action: '*', resource: '*', effect: 'allow' }]);
  for (const mode of ['default', 'auto', 'bypass']) {
    const denies = sessionPermissions(mode).filter((r) => r.effect === 'deny');
    assert.ok(denies.some((r) => r.action === 'read' && r.resource.endsWith('/secrets.json')), `${mode} denies reading the secret store`);
    assert.ok(denies.some((r) => r.action === 'edit' && r.resource.endsWith('/token')), `${mode} denies editing the token`);
  }
  assert.ok(sessionPermissions('auto').every((r) => r.effect === 'deny'), 'auto adds only denies to OpenCode\'s own rules');
});

test("Settings offers 'default' only where the harness's prompts reach stam's permission requests", () => {
  const offered = (h) => pm.HARNESS_MODES[h].filter((m) => m.offered).map((m) => m.mode);
  assert.deepEqual(offered('claude'), ['default', 'auto', 'bypass']);
  assert.deepEqual(offered('codex'), ['auto', 'bypass']);
  assert.deepEqual(offered('opencode'), ['auto', 'bypass']);
});
