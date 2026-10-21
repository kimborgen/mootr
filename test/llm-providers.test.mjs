#!/usr/bin/env node
// The OpenAI-compatible and Azure OpenAI adapters (S-2116, src/llm/openai.ts) and the decisions
// fallback through complete() (src/decide.ts), against the stub (test/decide-stub.mjs): the URL,
// headers, body and parsed answer of each adapter, a key read from the environment variable the
// config names, settings changes that rebuild the providers, and decide() on a provider without
// /decisions. Free, no network, no daemon. `node --test test/llm-providers.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-llm-providers-');
const stubDir = join(home, 'stub');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `llm-providers-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=or-key\n');
process.env.STUB_OA_KEY = 'sk-oa';
process.env.STUB_AZ_KEY = 'az-key';
delete process.env.STUB_MISSING_KEY;

let stub, llm, settings, decide, base;
const last = () => JSON.parse(readFileSync(join(stubDir, 'last-request'), 'utf8'));
const setKey = (k) => (k ? writeFileSync(join(stubDir, 'key'), k) : rmSync(join(stubDir, 'key'), { force: true }));
const providers = () => ({
  oa: { kind: 'openai-compatible', baseUrl: `${base}/v1/`, apiKey: { env: 'STUB_OA_KEY' } },
  oatemp: { kind: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: { env: 'STUB_OA_KEY' }, temperature: 0.3 },
  oamc: { kind: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: { env: 'STUB_OA_KEY' }, maxTokensParam: 'max_completion_tokens' },
  local: { kind: 'openai-compatible', baseUrl: `${base}/ollama/v1` },
  nokey: { kind: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: { env: 'STUB_MISSING_KEY' } },
  az: { kind: 'azure', endpoint: `${base}/`, deployment: 'dep1', apiVersion: '2024-10-21', apiKey: { env: 'STUB_AZ_KEY' } },
  azmodel: { kind: 'azure', endpoint: base, apiVersion: '2024-10-21', apiKey: { env: 'STUB_AZ_KEY' } },
  azv1: { kind: 'azure', endpoint: base, apiVersion: 'v1', apiKey: { env: 'STUB_AZ_KEY' } },
  azv1url: { kind: 'azure', endpoint: `${base}/openai/v1`, apiVersion: '2025-01-01', apiKey: { env: 'STUB_AZ_KEY' } },
  broken: { kind: 'azure', endpoint: base },
  alien: { kind: 'bedrock' },
});
const ask = (model, text = 'q', extra = {}) => llm.complete({ model, messages: [{ role: 'user', content: text }], maxTokens: 20, ...extra });

before(async () => {
  stub = spawn(process.execPath, [join(import.meta.dirname, 'decide-stub.mjs'), stubDir], { stdio: 'ignore' });
  process.on('exit', () => stub.kill());
  for (let i = 0; !existsSync(join(stubDir, 'url')); i++) {
    if (i > 500) throw new Error('the stub did not start');
    await new Promise((r) => setTimeout(r, 10));
  }
  base = readFileSync(join(stubDir, 'url'), 'utf8');
  process.env.STAM_OPENROUTER_URL = base;
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ providers: providers(), decisions: { mailCheck: false } }));
  settings = await import('../src/settings.ts');
  llm = await import('../src/llm/index.ts');
  decide = await import('../src/decide.ts');
});
after(() => { stub.kill(); rmSync(home, { recursive: true, force: true }); });

test('openai-compatible: bearer key, chat-completions URL under the base, max_tokens, parsed answer', async () => {
  setKey('sk-oa');
  const r = await ask('oa:gpt-x', 'hello');
  const req = last();
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.authorization, 'Bearer sk-oa');
  // No temperature unless the request or the provider sets one.
  assert.deepEqual(req.body, { model: 'gpt-x', messages: [{ role: 'user', content: 'hello' }], max_tokens: 20 });
  assert.equal(r.model, 'google/gemma-3-4b-it-stub');
  assert.deepEqual(r.usage, { inputTokens: 30, outputTokens: 4 });
  assert.equal(r.costUsd, undefined);
  assert.equal(typeof r.text, 'string');
});

test('openai-compatible: maxTokensParam, JSON schema, and a 401 as LlmHttpError', async () => {
  setKey('sk-oa');
  const schema = { type: 'object', properties: {} };
  await llm.complete({ model: 'oamc:m', messages: [], maxTokens: 5, jsonSchema: { name: 'n', schema } });
  const body = last().body;
  assert.equal(body.max_completion_tokens, 5);
  assert.equal(body.max_tokens, undefined);
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'n', strict: true, schema } });
  setKey('other');
  await assert.rejects(ask('oa:m'), (e) => e instanceof llm.LlmHttpError && e.status === 401);
  setKey('');
});

test('temperature: sent when the request sets it, else the provider\'s, else not at all', async () => {
  setKey('');
  await ask('oa:m', 'q', { temperature: 0 });
  assert.equal(last().body.temperature, 0);
  await ask('oatemp:m');
  assert.equal(last().body.temperature, 0.3);
  await ask('oatemp:m', 'q', { temperature: 0.9 });
  assert.equal(last().body.temperature, 0.9);
  await ask('oa:m');
  assert.equal('temperature' in last().body, false);
});

test('a redirect is an error: the key never reaches the other origin', async () => {
  const got = [];
  const target = createServer((req, res) => { got.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[]}'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const other = `http://127.0.0.1:${target.address().port}`;
  const hop = createServer((req, res) => res.writeHead(Number(req.url.split('/')[1]), { location: `${other}/stolen` }).end());
  await new Promise((r) => hop.listen(0, '127.0.0.1', r));
  const from = `http://127.0.0.1:${hop.address().port}`;
  try {
    settings.patchSettings({
      providers: {
        ...providers(),
        r307: { kind: 'openai-compatible', baseUrl: `${from}/307`, apiKey: { env: 'STUB_OA_KEY' } },
        raz: { kind: 'azure', endpoint: `${from}/308`, apiVersion: 'v1', apiKey: { env: 'STUB_AZ_KEY' } },
      },
    });
    await assert.rejects(ask('r307:m'));
    await assert.rejects(llm.provider('r307').listModels());
    await assert.rejects(ask('raz:m'));
    // A key check (S-2115) refuses the redirect too, and says so without the key.
    const check = await llm.provider('r307').checkKey('sk-redirected');
    assert.equal(check.ok, false);
    assert.ok(!check.detail.includes('sk-redirected'));
    assert.equal((await llm.provider('raz').checkKey('az-redirected')).ok, false);
    assert.deepEqual(got, [], 'the second server saw no request, so no key');
  } finally {
    target.close();
    hop.close();
    settings.patchSettings({ providers: providers() });
  }
});

test('openai-compatible: no key means no call; a keyless server needs none and sends no header', async () => {
  assert.equal(llm.hasKey('nokey:m'), false);
  await assert.rejects(ask('nokey:m'), /no API key/);
  assert.equal(llm.hasKey('local:m'), true);
  assert.equal(llm.hasKey('oa:m'), true);
  await ask('local:llama3');
  assert.equal(last().url, '/ollama/v1/chat/completions');
  assert.equal(last().authorization, undefined);
});

test('a key named as a secret comes from the secret store; a set variable wins over it (S-2114)', async () => {
  const secrets = await import('../src/secrets.ts');
  const { resolveKey } = await import('../src/llm/openai.ts');
  secrets.set('oa-stored', { value: 'sk-from-store', provider: 'openai' });
  settings.patchSettings({ providers: { ...providers(), oasec: { kind: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: { secret: 'oa-stored' } } } });
  try {
    setKey('sk-from-store');
    assert.equal(llm.hasKey('oasec:m'), true);
    await ask('oasec:gpt-x');
    assert.equal(last().authorization, 'Bearer sk-from-store');
    assert.equal(resolveKey({ secret: 'missing' }), undefined);
    assert.equal(resolveKey({ env: 'STUB_MISSING_KEY', secret: 'oa-stored' }), 'sk-from-store', 'an unset variable falls through to the secret');
    assert.equal(resolveKey({ env: 'STUB_OA_KEY', secret: 'oa-stored' }), 'sk-oa', 'a set variable wins');
    secrets.remove('oa-stored');
    assert.equal(llm.hasKey('oasec:m'), false, 'a deleted secret is no key');
  } finally {
    secrets.remove('oa-stored');
    settings.patchSettings({ providers: providers() });
  }
});

test("a secret's Test checks the stored key against its provider and records fixed text (S-2115)", async () => {
  const secrets = await import('../src/secrets.ts');
  secrets.set('oa-test', { value: 'sk-right', provider: 'openai' });
  secrets.set('az-test', { value: 'az-right', provider: 'azure' });
  secrets.set('or-test', { value: 'or-right', env: 'OPENROUTER_API_KEY' });
  secrets.set('orphan', { value: 'nobody-uses-me' });
  settings.patchSettings({
    providers: {
      ...providers(),
      oatest: { kind: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: { secret: 'oa-test' } },
      aztest: { kind: 'azure', endpoint: base, apiVersion: '2024-10-21', apiKey: { secret: 'az-test' } },
      azv1test: { kind: 'azure', endpoint: base, apiVersion: 'v1', apiKey: { secret: 'az-test' } },
    },
  });
  try {
    setKey('sk-right');
    assert.deepEqual(await llm.testSecret('oa-test'), { provider: 'oatest', ok: true, detail: 'HTTP 200' });
    setKey('sk-other');
    const bad = await llm.testSecret('oa-test');
    assert.deepEqual(bad, { provider: 'oatest', ok: false, status: 401, detail: 'the provider refused the key (HTTP 401)' });
    const rec = secrets.list().find((x) => x.name === 'oa-test').test;
    assert.equal(rec.ok, false);
    assert.equal(rec.detail, 'oatest: the provider refused the key (HTTP 401)');
    // Azure, on the dated and the v1 API, sends the key as api-key.
    setKey('az-right');
    assert.equal((await llm.testSecret('az-test', 'aztest')).ok, true);
    assert.equal((await llm.testSecret('az-test', 'azv1test')).ok, true);
    setKey('az-wrong');
    assert.equal((await llm.testSecret('az-test', 'azv1test')).status, 401);
    // The secret that stands for OpenRouter's key is tested on OpenRouter's /key.
    setKey('or-right');
    assert.deepEqual(await llm.testSecret('or-test'), { provider: 'openrouter', ok: true, detail: 'HTTP 200' });
    // The stored value is tested, not an environment override.
    process.env.OPENROUTER_API_KEY = 'or-from-env';
    assert.equal((await llm.testSecret('or-test')).ok, true);
    delete process.env.OPENROUTER_API_KEY;
    // No provider to test against, an unknown one, a missing secret: refused, nothing recorded.
    await assert.rejects(llm.testSecret('orphan'), (e) => e instanceof llm.KeyTestError && e.status === 400);
    await assert.rejects(llm.testSecret('oa-test', 'nope'), (e) => e.status === 400);
    // A provider that doesn't use the secret is refused, so a Test sends a key only where settings do.
    await assert.rejects(llm.testSecret('oa-test', 'aztest'), (e) => e.status === 400 && /doesn't use oa-test/.test(e.message));
    await assert.rejects(llm.testSecret('oa-test', 'openrouter'), (e) => e.status === 400);
    assert.equal((await llm.testSecret('or-test', 'openrouter')).provider, 'openrouter');
    // A providers.openrouter entry's key is never used (the built-in adapter stays), so it is no Test target.
    settings.patchSettings({ providers: { ...settings.settings().providers, openrouter: { kind: 'openai-compatible', baseUrl: 'https://evil.example/v1', apiKey: { secret: 'oa-test' } } } });
    await assert.rejects(llm.testSecret('oa-test', 'openrouter'), (e) => e.status === 400);
    assert.equal((await llm.testSecret('oa-test')).provider, 'oatest');
    await assert.rejects(llm.testSecret('missing'), (e) => e.status === 404);
    assert.equal(secrets.list().find((x) => x.name === 'orphan').test, null);
    // Nothing the check returns or records holds a key.
    assert.ok(!JSON.stringify(secrets.list()).match(/sk-right|az-right|or-right/));
  } finally {
    setKey('');
    delete process.env.OPENROUTER_API_KEY;
    for (const n of ['oa-test', 'az-test', 'or-test', 'orphan']) secrets.remove(n);
    settings.patchSettings({ providers: providers() });
  }
});

test('a key check reports an unreachable provider by code only', async () => {
  const { probeKey } = await import('../src/llm/key-check.ts');
  const r = await probeKey('http://127.0.0.1:1/models', { authorization: 'Bearer sk-secret-in-header' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /^could not reach the provider \([\w ]+\)$/);
  assert.ok(!r.detail.includes('sk-secret'));
});

test('a malformed key is named invalid and never sent, nor quoted', async () => {
  for (const id of ['oa', 'openrouter']) {
    const r = await llm.provider(id).checkKey('k\nleaked');
    assert.equal(r.ok, false);
    assert.match(r.detail, /^invalid API key/);
    assert.ok(!r.detail.includes('leaked'));
  }
});

test("an unnamed Test skips a provider that can't test a key (S-2115)", async () => {
  const secrets = await import('../src/secrets.ts');
  secrets.set('shared-key', { value: 'sk-right' });
  // `aaa` sorts first and has no checkKey; `zzz` can test the key.
  llm.registerProvider({ id: 'aaa', complete: async () => ({ text: '', model: '', usage: { inputTokens: 0, outputTokens: 0 } }) });
  settings.patchSettings({ providers: { ...providers(), aaa: { kind: 'unknown', apiKey: { secret: 'shared-key' } }, zzz: { kind: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: { secret: 'shared-key' } } } });
  try {
    setKey('sk-right');
    assert.deepEqual(await llm.testSecret('shared-key'), { provider: 'zzz', ok: true, detail: 'HTTP 200' });
    await assert.rejects(llm.testSecret('shared-key', 'aaa'), (e) => e.status === 400 && /can't test a key/.test(e.message));
  } finally {
    setKey('');
    secrets.remove('shared-key');
    settings.patchSettings({ providers: providers() });
  }
});

test('openai-compatible: listModels reads GET /models', async () => {
  setKey('');
  assert.deepEqual(await llm.provider('oa').listModels(), [{ id: 'stub-model-a', name: 'stub-model-a', in: null, out: null }, { id: 'stub-model-b', name: 'stub-model-b', in: null, out: null }]);
});

test('azure: deployment path, api-version, api-key header, max_completion_tokens, no model in the body', async () => {
  setKey('az-key');
  await ask('az:ignored-model');
  const req = last();
  assert.equal(req.url, '/openai/deployments/dep1/chat/completions?api-version=2024-10-21');
  assert.equal(req.apiKey, 'az-key');
  assert.equal(req.authorization, undefined);
  assert.deepEqual(req.body, { messages: [{ role: 'user', content: 'q' }], max_completion_tokens: 20 });
  // Without a configured deployment the model names it.
  await ask('azmodel:gpt-4o');
  assert.equal(last().url, '/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21');
  setKey('wrong');
  await assert.rejects(ask('az:x'), (e) => e instanceof llm.LlmHttpError && e.status === 401);
  setKey('');
});

test('azure: the /openai/v1 endpoint takes the model in the body and no api-version', async () => {
  setKey('az-key');
  await ask('azv1:gpt-5');
  assert.equal(last().url, '/openai/v1/chat/completions');
  assert.equal(last().body.model, 'gpt-5');
  assert.equal(last().apiKey, 'az-key');
  await ask('azv1url:gpt-5');
  assert.equal(last().url, '/openai/v1/chat/completions');
  setKey('');
});

test('providers come from settings and follow changes; broken and unknown entries are ignored', async () => {
  assert.equal(llm.provider('broken'), undefined);
  assert.equal(llm.provider('alien'), undefined);
  assert.deepEqual(llm.parseModelRef('az:foo'), { provider: 'az', model: 'foo' });
  // A configured id can't replace a built-in adapter.
  settings.patchSettings({ providers: { ...providers(), openrouter: { kind: 'openai-compatible', baseUrl: base } } });
  assert.equal(llm.provider('openrouter').id, 'openrouter');
  assert.equal(llm.provider('openrouter').keyless, undefined);
  settings.patchSettings({ providers: { only: { kind: 'openai-compatible', baseUrl: base } } });
  assert.equal(llm.provider('az'), undefined);
  assert.deepEqual(llm.parseModelRef('az:foo'), { provider: 'openrouter', model: 'az:foo' });
  assert.ok(llm.provider('only'));
  settings.patchSettings({ providers: providers() });
  assert.ok(llm.provider('az'));
});

const questions = {
  yes: { type: 'noul', instructions: 'Is it fine?' },
  pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'first', b: 'second' } },
  rate: { type: 'score', instructions: 'How good?', criteria: ['bad', 'good'] },
};

test('decide: a provider without /decisions is asked through complete() and parsed like the endpoint', async () => {
  setKey('sk-oa');
  settings.patchSettings({ decisions: { model: 'oa:gpt-x' } });
  const r = await decide.decide('state P=0.7 CHOICE=b', questions, { purpose: 'decide:test' });
  assert.equal(r.answers.yes.noul, 0.7);
  assert.equal(decide.noul(r, 'yes'), 0.7);
  assert.equal(r.answers.pick.choice, 'b');
  assert.equal(r.answers.pick.probabilities.b, 0.9);
  assert.ok(Math.abs(r.answers.pick.probabilities.a - 0.1) < 1e-9);
  assert.equal(r.answers.rate.score, 0.7);
  assert.deepEqual(r.answers.rate.legend, { 0: 'bad', 1: 'good' });
  // One request, with a strict schema that has one object per question, none to the decisions endpoint.
  const req = last();
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.body.model, 'gpt-x');
  assert.equal(req.body.response_format.json_schema.schema.required.join(), 'yes,pick,rate');
  assert.deepEqual(req.body.response_format.json_schema.schema.properties.pick.properties.choice.enum, ['a', 'b']);
  assert.match(req.body.messages[1].content, /state P=0\.7/);
  assert.equal(existsSync(join(stubDir, 'count')), false);
  assert.equal(r.usage.input_tokens, 30);
});

test('decide: azure works the same, and a missing key or a 401 is a recorded failure', async () => {
  setKey('az-key');
  settings.patchSettings({ decisions: { model: 'az:ignored' } });
  const r = await decide.decide('P=0.4', { q: questions.yes }, { purpose: 'decide:test' });
  assert.equal(r.answers.q.noul, 0.4);
  assert.match(last().url, /^\/openai\/deployments\/dep1\//);
  setKey('rotated');
  const bad = await decide.decideWithFailure('P=0.4', { q: questions.yes }, { purpose: 'decide:test' });
  assert.equal(bad.result, null);
  assert.equal(bad.failure.status, 401);
  assert.equal(bad.failure.kind, 'other');
  settings.patchSettings({ decisions: { model: 'nokey:m' } });
  assert.equal((await decide.decideWithFailure('x', { q: questions.yes }, { purpose: 'decide:test' })).failure.error, 'no API key');
  setKey('');
});

test('decide: a failing provider call is a recorded server failure', async () => {
  setKey('');
  settings.patchSettings({ decisions: { model: 'oa:m' } });
  const r = await decide.decideWithFailure('P=0.5', { ok: questions.yes }, { purpose: 'decide:test' });
  assert.equal(r.result.answers.ok.noul, 0.5);
  const none = await decide.decideWithFailure('STUB:FAIL', { ok: questions.yes }, { purpose: 'decide:test' });
  assert.equal(none.result, null);
  assert.equal(none.failure.kind, 'server');
});

test('decide: a malformed choice distribution is rejected, never filled in', async () => {
  setKey('');
  settings.patchSettings({ decisions: { model: 'oa:m' } });
  const both = { yes: questions.yes, pick: questions.pick };
  for (const marker of ['STUB:NOPROBS', 'STUB:BADPROB', 'STUB:SKEW']) {
    const r = await decide.decide(`P=0.6 ${marker}`, both, { purpose: 'decide:test' });
    assert.equal(r.answers.pick, undefined, marker);
    assert.equal(r.answers.yes.noul, 0.6, `${marker} keeps the valid answers`);
    assert.equal((await decide.decide(`${marker}`, { pick: questions.pick }, { purpose: 'decide:test' })), null);
  }
});

test('decide: bad JSON, a refusal and a truncated answer each yield no answer', async () => {
  setKey('');
  settings.patchSettings({ decisions: { model: 'oa:m' } });
  for (const marker of ['STUB:BADJSON', 'STUB:REFUSAL', 'STUB:TRUNC']) {
    const r = await decide.decideWithFailure(`P=0.6 ${marker}`, { q: questions.yes }, { purpose: 'decide:test' });
    assert.equal(r.result, null, marker);
    assert.equal(r.failure.error, 'no answers in the response');
  }
});

test('decide: the default (OpenRouter) still uses the decisions endpoint', async () => {
  settings.patchSettings({ decisions: { model: 'microsoft/microsoft-decision-1' } });
  const r = await decide.decide('P=0.3', { q: questions.yes }, { purpose: 'decide:test' });
  assert.equal(r.answers.q.noul, 0.3);
  assert.equal(readFileSync(join(stubDir, 'count'), 'utf8'), '1');
});

test('a malformed OpenAI or Azure key never reaches the failure or decide:error', async () => {
  const secret = 'leaked-secret-value';
  const events = async (type) => (await import('../src/db.ts')).open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ?').all('stam', type).map((r) => JSON.parse(r.data));
  for (const [model, env] of [['oa:m', 'STUB_OA_KEY'], ['az:m', 'STUB_AZ_KEY']]) {
    const was = process.env[env];
    process.env[env] = `k\n${secret}`;
    try {
      settings.patchSettings({ decisions: { model } });
      const r = await decide.decideWithFailure('P=0.5', { q: questions.yes }, { purpose: 'decide:test' });
      assert.equal(r.result, null, model);
      assert.equal(r.failure.error, 'invalid API key', model);
      assert.ok(!JSON.stringify((await events('decide:error')).at(-1)).includes(secret), model);
      if (model === 'oa:m') await assert.rejects(llm.provider('oa').listModels(), (e) => !String(e).includes(secret));
    } finally {
      process.env[env] = was;
    }
  }
});

test('a malformed OpenRouter key never reaches complete()\'s error, the path mail titles, tool summaries and block summaries take (S-2117)', async () => {
  const secret = 'leaked-openrouter-secret';
  const was = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = `k\n${secret}`;
  try {
    const err = await llm.complete({ model: 'vendor/model', messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 }).then(() => null, (e) => e);
    assert.equal(err?.message, 'invalid API key');
    assert.ok(!String(err?.stack).includes(secret));
  } finally {
    if (was === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = was;
  }
});
