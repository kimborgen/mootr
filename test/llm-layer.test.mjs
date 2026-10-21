#!/usr/bin/env node
// The LLM provider layer (S-2113, src/llm/): model names split into provider and model, with
// openrouter the default; the OpenRouter adapter's chat completion (request body, usage, cost, JSON
// schema, HTTP errors), credit and key reads, and decisions passthrough against a loopback fake.
// Free, no network. `node --test test/llm-layer.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-llm-layer-');
process.env.STAM_HOME = home;
mkdirSync(home, { recursive: true });
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const seen = [];
let mode = 'ok';
// While set, /credits waits for this to resolve (the request is pending at the server).
let hold = null;
let onCredits = () => {};
function answer(res, req, body) {
  if (mode === 'limited') return res.writeHead(429, { 'retry-after': '7' }).end('{}');
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/chat/completions') {
    const schema = JSON.parse(body).response_format;
    return res.end(JSON.stringify({ model: 'm/x', choices: [{ message: { content: schema ? '{"a":1}' : 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.001 } }));
  }
  if (req.url === '/credits') return res.end(JSON.stringify({ data: { total_credits: 10, total_usage: 4 } }));
  if (req.url === '/key') return res.end(JSON.stringify({ data: { limit: 5, limit_remaining: 2 } }));
  if (req.url === '/decisions') return res.end(JSON.stringify({ answers: {} }));
  res.writeHead(404).end('{}');
}
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    if (req.url === '/credits' && hold) {
      onCredits();
      return void hold.then(() => answer(res, req, body));
    }
    answer(res, req, body);
  });
});
let llm, secrets;
before(() => new Promise((r) => fake.listen(0, '127.0.0.1', () => { process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${fake.address().port}`; r(); })));
before(async () => {
  writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=sk-test\n');
  llm = await import('../src/llm/index.ts');
  secrets = await import('../src/secrets.ts');
});
after(() => { fake.close(); rmSync(home, { recursive: true, force: true }); });

test('model names: openrouter is the default provider', () => {
  assert.deepEqual(llm.parseModelRef('google/gemma-3-4b-it'), { provider: 'openrouter', model: 'google/gemma-3-4b-it' });
  assert.deepEqual(llm.parseModelRef('openrouter:google/gemma'), { provider: 'openrouter', model: 'google/gemma' });
  // A colon in an OpenRouter id is not a provider prefix.
  assert.deepEqual(llm.parseModelRef('meta-llama/llama-3:free'), { provider: 'openrouter', model: 'meta-llama/llama-3:free' });
  assert.deepEqual(llm.parseModelRef('unknown:foo'), { provider: 'openrouter', model: 'unknown:foo' });
});

test('registry: a registered provider takes its prefix', async () => {
  llm.registerProvider({ id: 'fake', apiKey: () => 'k', complete: async (r) => ({ text: r.model, model: r.model, usage: { inputTokens: 0, outputTokens: 0 } }) });
  assert.deepEqual(llm.parseModelRef('fake:abc'), { provider: 'fake', model: 'abc' });
  const r = await llm.complete({ model: 'fake:abc', messages: [], maxTokens: 1, temperature: 0 });
  assert.equal(r.text, 'abc');
});

test('complete: the chat-completions request and the parsed answer', async () => {
  seen.length = 0;
  const r = await llm.complete({ model: 'openrouter:m/x', messages: [{ role: 'user', content: 'q' }], maxTokens: 16, temperature: 0 });
  assert.deepEqual(seen[0].body, { model: 'm/x', messages: [{ role: 'user', content: 'q' }], max_tokens: 16, temperature: 0, usage: { include: true } });
  assert.equal(seen[0].auth, 'Bearer sk-test');
  assert.deepEqual(r, { text: 'hi', model: 'm/x', usage: { inputTokens: 3, outputTokens: 2 }, costUsd: 0.001 });
});

test('complete: a JSON schema becomes response_format and the answer is parsed', async () => {
  seen.length = 0;
  const schema = { type: 'object', properties: { a: { type: 'number' } } };
  const r = await llm.complete({ model: 'm/x', messages: [], maxTokens: 1, temperature: 0, jsonSchema: { name: 'n', schema } });
  assert.deepEqual(seen[0].body.response_format, { type: 'json_schema', json_schema: { name: 'n', strict: true, schema } });
  assert.deepEqual(r.json, { a: 1 });
});

test('complete: a non-2xx answer throws an LlmHttpError with the status and Retry-After', async () => {
  mode = 'limited';
  try {
    await assert.rejects(llm.complete({ model: 'm/x', messages: [], maxTokens: 1, temperature: 0 }), (e) => e instanceof llm.LlmHttpError && e.status === 429 && e.retryAfterMs === 7000 && e.message === 'HTTP 429');
  } finally { mode = 'ok'; }
});

test('one poll uses one key: a rotation while /credits is pending does not reach /key', async () => {
  const or = llm.provider('openrouter');
  seen.length = 0;
  const snapshot = or.apiKey();
  let release;
  hold = new Promise((r) => (release = r));
  const reached = new Promise((r) => (onCredits = r));
  try {
    const pending = or.balance(snapshot);
    await reached;
    // The key rotates in the secret store (S-2114) while the server holds /credits; the poll's /key
    // call still uses the snapshot.
    secrets.set('openrouter', { value: 'sk-rotated' });
    assert.equal(or.apiKey(), 'sk-rotated', 'the effective key rotated');
    release();
    await pending;
    await or.keyLimit(snapshot);
  } finally {
    release();
    hold = null;
    secrets.set('openrouter', { value: 'sk-test' });
  }
  assert.deepEqual(seen.map((r) => [r.url, r.auth]), [['/credits', 'Bearer sk-test'], ['/key', 'Bearer sk-test']]);
});

test('balance, keyLimit and decisions', async () => {
  const or = llm.provider('openrouter');
  assert.deepEqual(await or.balance(), { total: 10, used: 4 });
  assert.deepEqual(await or.keyLimit(), { limit: 5, remaining: 2 });
  seen.length = 0;
  assert.deepEqual(await or.decisions({ model: 'm', state: 's', questions: {} }, { timeoutMs: 1000 }), { answers: {} });
  assert.equal(seen[0].url, '/decisions');
  // The caller's key snapshot is the key used, not a second read of the key source.
  seen.length = 0;
  await or.decisions({ model: 'm', state: 's', questions: {} }, { timeoutMs: 1000, key: 'sk-snapshot' });
  assert.equal(seen[0].auth, 'Bearer sk-snapshot');
  mode = 'limited';
  try {
    assert.equal(await or.balance(), null);
    assert.equal(await or.keyLimit(), null);
  } finally { mode = 'ok'; }
});
