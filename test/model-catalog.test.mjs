#!/usr/bin/env node
// The model catalogue behind Settings' model pickers (S-379, src/model-catalog.ts): OpenRouter's
// list read from a fixture over loopback, parsed into USD per million tokens, cached six hours,
// refetched once for concurrent callers, the last one kept when a refresh fails; and the
// registry's harness models with their prices. Free, no network. `node --test test/model-catalog.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-model-catalog-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const models = [
  { id: 'google/gemma-3-4b-it', name: 'Google: Gemma 3 4B', pricing: { prompt: '0.00000002', completion: '0.00000004' } },
  { id: 'openai/gpt-x', name: 'OpenAI: GPT X', pricing: { prompt: '0.0000025', completion: '0.00001' } },
  { id: 'free/model', pricing: { prompt: '0', completion: '0' } },
  { id: 'unpriced/model', name: 'Unpriced', pricing: {} },
  { name: 'no id', pricing: { prompt: '1', completion: '1' } },
];
let requests = 0;
let failing = false;
const fake = createServer((req, res) => {
  if (req.url !== '/api/v1/models') return res.writeHead(404).end();
  requests++;
  if (failing) return res.writeHead(500).end('{}');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: models }));
});
let openRouterModels, harnessModels, port = 0;
before(() => new Promise((r) => fake.listen(0, '127.0.0.1', () => { port = fake.address().port; process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${port}/api/v1`; r(); })));
before(async () => ({ openRouterModels, harnessModels } = await import('../src/model-catalog.ts')));
after(() => { fake.close(); rmSync(home, { recursive: true, force: true }); });

const HOUR = 3600_000;

test('OpenRouter models: id, name, and USD per million tokens; bad rows dropped', async () => {
  const list = await openRouterModels();
  assert.deepEqual(list, [
    { id: 'google/gemma-3-4b-it', name: 'Google: Gemma 3 4B', in: 0.02, out: 0.04 },
    { id: 'openai/gpt-x', name: 'OpenAI: GPT X', in: 2.5, out: 10 },
    { id: 'free/model', name: 'free/model', in: 0, out: 0 },
    { id: 'unpriced/model', name: 'Unpriced', in: null, out: null },
  ]);
});

test('concurrent callers share one fetch, and a failure with nothing cached is thrown', async () => {
  const fresh = await import('../src/model-catalog.ts?fresh=1');
  const before = requests;
  const got = await Promise.all([fresh.openRouterModels(), fresh.openRouterModels(), fresh.openRouterModels()]);
  assert.equal(requests, before + 1);
  assert.ok(got.every((l) => l.length === 4));
  const broken = await import('../src/model-catalog.ts?fresh=2');
  failing = true;
  await assert.rejects(broken.openRouterModels(), /HTTP 500/);
  failing = false;
});

test('the catalogue is cached for six hours', async () => {
  const before = requests;
  const t0 = Date.now();
  await openRouterModels(t0 + 5 * HOUR);
  assert.equal(requests, before, 'a catalogue under six hours old is read from memory');
  await openRouterModels(t0 + 7 * HOUR);
  assert.equal(requests, before + 1, 'a catalogue six hours old is fetched again');
});

test('a failed refresh keeps the last catalogue', async () => {
  failing = true;
  const list = await openRouterModels(Date.now() + 13 * HOUR);
  failing = false;
  assert.equal(list.length, 4);
});

test('harness models: the registry models a harness runs, with its prices where known', () => {
  const claude = harnessModels('claude');
  const opus = claude.find((m) => m.id === 'claude-opus-5-5');
  assert.ok(opus, 'claude-opus-5-5 is a claude model');
  assert.deepEqual([opus.in, opus.out], [4, 20]);
  assert.ok(claude.every((m) => !m.id.startsWith('gpt-')), 'codex-only models are left out');
  assert.ok(harnessModels('').length >= claude.length, 'no harness names every model');
});
