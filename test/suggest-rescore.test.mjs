#!/usr/bin/env node
// Unit tests for the suggestion rescoring pass (S-1465): off by default (nothing asked), one decide call
// with a score question per candidate, the items at 0.5 or more kept in the model's order, and a failed
// call giving null so the client keeps its first order. A stub decision endpoint (test/decide-stub.mjs)
// answers the scores from its scores.json; no live daemon, no network. Stub embedder only.
// Run with `node --test test/suggest-rescore.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, tempHome } from './tmphome.mjs';

const home = tempHome('stam-suggest-rescore-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `suggest-rescore-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY', 'STAM_OPENROUTER_URL']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
const setSettings = (decisions) => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { model: 'test/decision-model', ...decisions } }));
  settingsChanged();
};

const { stubVector, currentModel } = await import('../src/embed.ts');
const db = await import('../src/db.ts');
const { settingsChanged } = await import('../src/settings.ts');
const R = await import('../src/suggest-rescore.ts');

const QUERY = 'the login redirect loop';
const stubDir = tempDir('stam-rescore-stub-');
let stub;

// Every agent's vector is the query's, so each is a candidate at cosine 1.
const agent = (name) => {
  db.createAgent({ id: name, name, role: QUERY, machine: 'test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  const v = stubVector(QUERY);
  db.putEmbedding({ source: 'agent', ref: name, model: currentModel(), dim: v.length, vec: new Uint8Array(v.buffer), hash: name });
};
const decideCalls = () => (existsSync(join(stubDir, 'count')) ? Number(readFileSync(join(stubDir, 'count'), 'utf8')) : 0);
const opts = { local: true, humanMail: false, recent: [] };

before(async () => {
  stub = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'decide-stub.mjs'), stubDir], { stdio: 'ignore' });
  for (let i = 0; i < 200 && !existsSync(join(stubDir, 'url')); i++) await new Promise((r) => setTimeout(r, 25));
  process.env.STAM_OPENROUTER_URL = readFileSync(join(stubDir, 'url'), 'utf8');
  writeFileSync(join(stubDir, 'scores.json'), JSON.stringify({ 'alpha-dev': 0.9, 'beta-dev': 0.3, 'gamma-dev': 0.7 }));
  for (const name of ['alpha-dev', 'beta-dev', 'gamma-dev']) agent(name);
});
after(() => stub?.kill());

test('off by default: nothing is asked and nothing is returned', async () => {
  setSettings({});
  const before = decideCalls();
  assert.equal(await R.rescoreSuggest(QUERY, opts), null);
  assert.equal(decideCalls(), before, 'no decide call while the setting is off');
});

test('on: one decide call scores every candidate, and the ones at 0.5 or more come back best first', async () => {
  setSettings({ suggestRescore: true });
  const before = decideCalls();
  const out = await R.rescoreSuggest(QUERY, opts);
  assert.equal(decideCalls(), before + 1, 'one call for all the candidates');
  assert.deepEqual(out.map((r) => [r.title, r.score]), [['alpha-dev', 0.9], ['gamma-dev', 0.7]], 'beta-dev scores 0.3, under the show cut');
  assert.ok(out.every((r) => r.kind === 'agent' && r.by === 'meaning'));
  const sent = JSON.parse(readFileSync(join(stubDir, 'state'), 'utf8'));
  assert.equal(sent.text, QUERY);
  assert.deepEqual(sent.candidates.map((c) => c.title).sort(), ['alpha-dev', 'beta-dev', 'gamma-dev']);
});

test('a failed call gives null, so the client keeps its first order', async () => {
  setSettings({ suggestRescore: true });
  agent('STUB:FAIL');
  assert.equal(await R.rescoreSuggest(QUERY, opts), null);
});
