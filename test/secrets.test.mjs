#!/usr/bin/env node
// The secret store (S-2114): secrets.json is mode 600 and written atomically, its listing never
// holds a value, opencode.env imports once into a `stam` and an `agent` slot, the environment
// overrides a stored key, and settings references resolve by name. Throwaway STAM_HOME, no daemon.
// `node --test test/secrets.test.mjs`.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-secrets-');
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'secrets-test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];

const file = join(home, 'secrets.json');
const legacy = join(home, 'opencode.env');
const KEY = 'sk-or' + '-v1-abcdefghijklmnop1234';
let secrets, credits;
before(async () => {
  secrets = await import('../src/secrets.ts');
  credits = await import('../src/credits.ts');
});
beforeEach(() => {
  rmSync(file, { force: true });
  rmSync(legacy, { force: true });
  delete process.env.OPENROUTER_API_KEY;
});
const mode = () => statSync(file).mode & 0o777;

test('a set secret is stored mode 600, atomically, and its info never holds the value', () => {
  const info = secrets.set('openai-main', { value: KEY, provider: 'openai' });
  assert.equal(mode(), 0o600);
  assert.deepEqual(readdirSync(home).filter((f) => f.startsWith('secrets.json.')), [], 'no temp file left behind');
  assert.equal(info.last4, '1234');
  assert.equal(info.provider, 'openai');
  assert.equal(info.slot, 'stam');
  assert.ok(!JSON.stringify(info).includes(KEY.slice(0, -4)), 'info holds no more than the last 4');
  assert.ok(!JSON.stringify(secrets.list()).includes(KEY.slice(0, -4)), 'the listing holds no value');
  assert.equal(secrets.getSecret('openai-main'), KEY);
  // A second write replaces the file and keeps the mode.
  secrets.set('other', { value: 'short' });
  assert.equal(mode(), 0o600);
  assert.equal(secrets.list().find((s) => s.name === 'other').last4, '', 'a short value shows no characters');
});

test('a widened file is narrowed back to 600 on read', () => {
  secrets.set('a', { value: KEY });
  chmodSync(file, 0o644);
  // Another process's write: the stat key changes, so the file is read again.
  writeFileSync(file, readFileSync(file, 'utf8') + ' ');
  chmodSync(file, 0o644);
  assert.equal(secrets.getSecret('a'), KEY);
  assert.equal(mode(), 0o600);
});

test('names and values are checked; delete removes', () => {
  assert.throws(() => secrets.set('../x', { value: KEY }), secrets.SecretError);
  assert.throws(() => secrets.set('Upper', { value: KEY }), secrets.SecretError);
  assert.throws(() => secrets.set('ok', { value: '' }), secrets.SecretError);
  assert.throws(() => secrets.set('ok', { value: 'a\nb' }), secrets.SecretError);
  // A value a header can't carry (checkCredential) is refused, and the message never quotes it (S-2115).
  for (const bad of ['sk-has space-leaked', 'sk-tab\tleaked', 'sk-ünïcode-leaked']) {
    assert.throws(() => secrets.set('ok', { value: bad }), (e) => e instanceof secrets.SecretError && !e.message.includes('leaked'));
  }
  assert.throws(() => secrets.set('ok', { value: KEY, slot: 'root' }), secrets.SecretError);
  secrets.set('gone', { value: KEY });
  assert.equal(secrets.remove('gone'), true);
  assert.equal(secrets.remove('gone'), false);
  assert.equal(secrets.getSecret('gone'), undefined);
});

test('opencode.env imports once, into a stam and a separate agent slot', () => {
  writeFileSync(legacy, `OPENROUTER_API_KEY=${KEY}\nOPENCODE_DISABLE_AUTOUPDATE=1\n`, { mode: 0o600 });
  assert.deepEqual(secrets.importLegacyOnce().sort(), ['openrouter', 'openrouter-agent']);
  const byName = Object.fromEntries(secrets.list().map((s) => [s.name, s]));
  assert.equal(byName.openrouter.slot, 'stam');
  assert.equal(byName['openrouter-agent'].slot, 'agent');
  assert.equal(byName.openrouter.env, 'OPENROUTER_API_KEY');
  assert.equal(byName.openrouter.provider, 'openrouter');
  assert.equal(mode(), 0o600);
  // A deleted secret isn't brought back, and a changed file doesn't import again.
  secrets.remove('openrouter-agent');
  writeFileSync(legacy, `OPENROUTER_API_KEY=other-key-0000\nOPENAI_API_KEY=x-1111\n`);
  assert.deepEqual(secrets.importLegacyOnce(), []);
  assert.equal(secrets.getSecret('openrouter-agent'), undefined);
  assert.equal(secrets.getSecret('openai'), undefined);
  // The store now wins over the file for stam's own key.
  assert.equal(credits.apiKey(), KEY);
});

test('the slots are separate: OpenCode gets the agent key, stam its own', () => {
  writeFileSync(legacy, `OPENROUTER_API_KEY=${KEY}\nOPENCODE_DISABLE_AUTOUPDATE=1\n`, { mode: 0o600 });
  secrets.importLegacyOnce();
  secrets.set('openrouter-agent', { value: 'agent-key-9999' });
  const env = secrets.agentEnv();
  assert.equal(env.OPENROUTER_API_KEY, 'agent-key-9999');
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1', "opencode.env's other lines still reach OpenCode");
  assert.equal(secrets.keyFor('OPENROUTER_API_KEY', 'stam'), KEY);
});

test('no import before opencode.env exists; the file still works as a fallback', () => {
  assert.deepEqual(secrets.importLegacyOnce(), []);
  assert.equal(existsSync(file), false, 'nothing written, so a file added later still imports');
  assert.equal(credits.apiKey(), undefined);
  writeFileSync(legacy, `OPENROUTER_API_KEY=late-key-5678\n`);
  assert.equal(credits.apiKey(), 'late-key-5678');
});

test('an environment variable overrides the stored key, and the listing says so', () => {
  secrets.set('openrouter', { value: KEY, env: 'OPENROUTER_API_KEY' });
  secrets.set('openrouter-agent', { value: 'agent-key-9999', env: 'OPENROUTER_API_KEY', slot: 'agent' });
  process.env.OPENROUTER_API_KEY = 'from-env-0000';
  assert.equal(credits.apiKey(), 'from-env-0000');
  assert.equal(secrets.getSecret('openrouter'), 'from-env-0000');
  assert.equal(secrets.agentEnv().OPENROUTER_API_KEY, 'from-env-0000');
  assert.equal(secrets.list().find((s) => s.name === 'openrouter').overriddenBy, 'env');
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(credits.apiKey(), KEY);
});

test('settings references resolve by name', () => {
  secrets.set('openai-main', { value: KEY });
  assert.equal(secrets.isRef({ secret: 'openai-main' }), true);
  assert.equal(secrets.isRef('openai-main'), false);
  assert.equal(secrets.isRef({ secret: 'x', extra: 1 }), false);
  assert.equal(secrets.resolveRef({ secret: 'openai-main' }), KEY);
  assert.equal(secrets.resolveRef({ secret: 'missing' }), undefined);
});

test('the store never writes a value into process.env', () => {
  writeFileSync(legacy, `OPENROUTER_API_KEY=${KEY}\n`);
  secrets.init();
  secrets.set('x', { value: 'zz-secret-value-4321', env: 'ZZ_TEST_KEY' });
  secrets.getSecret('x');
  secrets.agentEnv();
  assert.ok(!Object.values(process.env).some((v) => v === KEY || v === 'zz-secret-value-4321'));
});

test('a corrupt secrets.json falls back to the environment and opencode.env, and refuses writes', () => {
  writeFileSync(legacy, `OPENROUTER_API_KEY=${KEY}\n`, { mode: 0o600 });
  writeFileSync(file, '{ not json', { mode: 0o600 });
  assert.equal(credits.apiKey(), KEY, "opencode.env's key still works");
  assert.equal(secrets.getSecret('openrouter'), undefined);
  assert.equal(secrets.agentEnv().OPENROUTER_API_KEY, KEY);
  process.env.OPENROUTER_API_KEY = 'from-env-0000';
  assert.equal(credits.apiKey(), 'from-env-0000');
  assert.doesNotThrow(() => secrets.init());
  assert.throws(() => secrets.set('x', { value: KEY }), secrets.SecretFileError);
  assert.throws(() => secrets.list(), secrets.SecretFileError);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a broken file is left for the human');
});

test('a symlinked secrets.json is not followed, and nothing throws', () => {
  const target = join(home, 'elsewhere.json');
  writeFileSync(target, JSON.stringify({ secrets: { openrouter: { value: 'sk-planted-0000000000', env: 'OPENROUTER_API_KEY' } }, imported: [] }));
  symlinkSync(target, file);
  try {
    assert.equal(credits.apiKey(), undefined);
    assert.equal(secrets.getSecret('openrouter'), undefined);
    assert.deepEqual(secrets.agentEnv(), {});
    assert.throws(() => secrets.list(), secrets.SecretFileError);
  } finally {
    rmSync(target, { force: true });
  }
});

test('after the import, a key deleted in the store is not taken from opencode.env; its config lines still are', () => {
  writeFileSync(legacy, `OPENROUTER_API_KEY=${KEY}\nXDG_DATA_HOME=/tmp/oc\n`, { mode: 0o600 });
  secrets.importLegacyOnce();
  secrets.remove('openrouter');
  secrets.remove('openrouter-agent');
  assert.equal(credits.apiKey(), undefined);
  assert.deepEqual(secrets.agentEnv(), { XDG_DATA_HOME: '/tmp/oc' });
});

test('a file with no key lines is not marked imported, so a key added later imports', () => {
  writeFileSync(legacy, 'XDG_DATA_HOME=/tmp/oc\n', { mode: 0o600 });
  assert.deepEqual(secrets.importLegacyOnce(), []);
  writeFileSync(legacy, `XDG_DATA_HOME=/tmp/oc\nOPENROUTER_API_KEY=${KEY}\n`);
  assert.deepEqual(secrets.importLegacyOnce().sort(), ['openrouter', 'openrouter-agent']);
});

test('a failed write leaves memory as it was on disk', () => {
  secrets.set('keep', { value: KEY });
  chmodSync(home, 0o500);
  try {
    assert.throws(() => secrets.set('keep', { value: 'new-value-0000000' }));
    assert.throws(() => secrets.remove('keep'));
    assert.throws(() => secrets.recordTest('keep', { ok: true }));
  } finally {
    chmodSync(home, 0o700);
  }
  assert.equal(secrets.getSecret('keep'), KEY);
  assert.equal(secrets.list().find((s) => s.name === 'keep').test, null);
});

test('two secrets for one variable and slot: the first by name wins, the same way everywhere', () => {
  secrets.set('b-key', { value: 'second-key-2222', env: 'OPENROUTER_API_KEY', slot: 'agent' });
  secrets.set('a-key', { value: 'first-key-11111', env: 'OPENROUTER_API_KEY', slot: 'agent' });
  assert.equal(secrets.keyFor('OPENROUTER_API_KEY', 'agent'), 'first-key-11111');
  assert.equal(secrets.agentEnv().OPENROUTER_API_KEY, 'first-key-11111');
});

test("a test result's detail never holds the key, masked or not", () => {
  secrets.set('t', { value: KEY });
  secrets.recordTest('t', { ok: false, detail: `401: bad key ${KEY}; did you mean sk-or${"-"}v1-abcd****************1234? ${'x'.repeat(400)}` });
  const t = secrets.list().find((s) => s.name === 't').test;
  assert.equal(t.ok, false);
  assert.ok(!t.detail.includes(KEY) && !t.detail.includes('abcd') && t.detail.length <= 200, t.detail);
  assert.ok(t.detail.startsWith('401: bad key [key]'));
});

test('a loose umask still gives a mode-600 file', () => {
  const old = process.umask(0);
  try {
    secrets.set('loose', { value: KEY });
  } finally {
    process.umask(old);
  }
  assert.equal(mode(), 0o600);
});
