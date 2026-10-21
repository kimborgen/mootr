#!/usr/bin/env node
// Settings asks name where a key goes (S-2115): a provider's `apiKey: {secret: NAME}` shows its name
// (a name, not a value) to agents and in the ask's diff, and an ask that would send a stored key or an
// environment variable's key to a new host says so in the ask itself. Throwaway STAM_HOME, no daemon.
// `node --test test/key-destinations.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-key-dest-');
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'key-dest-test';
process.env.STAM_TMUX_SOCKET = `key-dest-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let s, p, db;
const save = (obj) => { writeFileSync(join(home, 'settings.json'), JSON.stringify(obj)); s.settingsChanged(); };
before(async () => {
  s = await import('../src/settings.ts');
  p = await import('../src/permissions.ts');
  db = await import('../src/db.ts');
  db.open();
  db.createAgent({ id: 'cos1', name: 'cos', role: 'x', machine: 'key-dest-test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
});

const oa = (baseUrl, apiKey) => ({ kind: 'openai-compatible', baseUrl, apiKey });

test('a secret name under a provider shows to agents; a value that is no name, and other secrets, stay hidden', () => {
  const shown = JSON.parse(s.redactSettingsText(JSON.stringify({
    providers: { a: oa('https://api.openai.com/v1', { secret: 'openai-main' }), b: oa('https://x/v1', { secret: 'sk-Raw Key With Spaces' }) },
    peers: [{ name: 'p', token: 'peer-secret' }],
  })));
  assert.equal(shown.providers.a.apiKey.secret, 'openai-main');
  assert.equal(shown.providers.b.apiKey.secret, s.REDACTED);
  assert.equal(shown.peers[0].token, s.REDACTED);
});

const shown = (settings) => p.keyDestinations(settings).map(({ sig, ...d }) => d);

test('keyDestinations names each provider, key source and origin, read by kind', () => {
  assert.deepEqual(shown({
    providers: {
      a: oa('https://api.openai.com/v1', { secret: 'openai-main' }),
      az: { kind: 'azure', endpoint: 'https://res.openai.azure.com', apiVersion: 'v1', apiKey: { env: 'AZ_KEY' } },
      br: { kind: 'bedrock', region: 'eu-west-1', apiKey: { secret: 'aws' } },
      local: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
    },
  }), [
    { provider: '`a`', key: 'the stored secret `openai-main`', to: '`https://api.openai.com`' },
    { provider: '`az`', key: 'the environment variable `AZ_KEY`', to: '`https://res.openai.azure.com`' },
    { provider: '`br`', key: 'the stored secret `aws`', to: '`https://bedrock-runtime.eu-west-1.amazonaws.com`' },
  ]);
});

test('an azure provider with a stray baseUrl is read at its endpoint, and a kind flip moves the key', () => {
  const both = { endpoint: 'https://res.openai.azure.com', apiVersion: 'v1', baseUrl: 'https://elsewhere.example/v1', apiKey: { secret: 'k' } };
  assert.equal(shown({ providers: { x: { kind: 'azure', ...both } } })[0].to, '`https://res.openai.azure.com`');
  const notes = p.keyDestinationNotes(JSON.stringify({ providers: { x: { kind: 'azure', ...both } } }), JSON.stringify({ providers: { x: { kind: 'openai-compatible', ...both } } }));
  assert.match(notes, /provider `x` would send the stored secret `k` to `https:\/\/elsewhere\.example`/);
});

test('a providers.openrouter entry sends no key, so it has no line', () => {
  // sync() never replaces the built-in adapter, which reads OPENROUTER_API_KEY's key, not the entry's.
  assert.equal(p.keyDestinationNotes('{}', JSON.stringify({ providers: { openrouter: oa('https://evil.example/v1', { secret: 'k' }) } })), '');
});

test('a Bedrock provider is named where its adapter sends, and SigV4 names the AWS credentials (S-2117)', async () => {
  // The line's origin is the one the adapter calls: a stubbed fetch records the URLs it is given.
  const got = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { got.push(String(u)); return new Response(null, { status: 403 }); };
  const endpoint = 'https://vpce-0.bedrock-runtime.eu-west-1.vpce.amazonaws.com';
  try {
    const { bedrock, parseBedrockConfig } = await import('../src/llm/bedrock.ts');
    process.env.STUB_BR_KEY = 'br-key';
    for (const cfg of [{ kind: 'bedrock', region: 'eu-west-1', apiKey: { env: 'STUB_BR_KEY' } }, { kind: 'bedrock', region: 'eu-west-1', endpoint, apiKey: { env: 'STUB_BR_KEY' } }]) {
      got.length = 0;
      const a = bedrock('br', parseBedrockConfig(cfg));
      await a.complete({ model: 'm', messages: [{ role: 'user', content: 'q' }], maxTokens: 1 }).catch(() => {});
      // checkKey goes to the same runtime.
      assert.deepEqual(await a.checkKey('br-key'), { ok: false, status: 403, detail: 'the provider refused the key (HTTP 403)' });
      assert.equal(got.length, 2);
      for (const u of got) assert.equal(shown({ providers: { br: cfg } })[0].to, `\`${new URL(u).origin}\``);
    }
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.STUB_BR_KEY;
  }
  // No apiKey: the AWS credentials from the chain go to the runtime, and there is no stored key to test.
  const { bedrock, parseBedrockConfig } = await import('../src/llm/bedrock.ts');
  assert.equal(bedrock('sig', parseBedrockConfig({ kind: 'bedrock', region: 'us-east-1' })).checkKey, undefined);
  assert.deepEqual(shown({ providers: {
    sig: { kind: 'bedrock', region: 'us-east-1' },
    prof: { kind: 'bedrock', region: 'us-east-1', profile: 'work', endpoint: 'https://vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com' },
  } }), [
    { provider: '`sig`', key: 'the AWS credentials', to: '`https://bedrock-runtime.us-east-1.amazonaws.com`' },
    { provider: '`prof`', key: 'the AWS credentials of profile `work`', to: '`https://vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com`' },
  ]);
  // A new SigV4 provider, or a moved endpoint, is a new line.
  const at = (endpoint) => JSON.stringify({ providers: { sig: { kind: 'bedrock', region: 'us-east-1', ...(endpoint ? { endpoint } : {}) } } });
  assert.match(p.keyDestinationNotes('{}', at()), /provider `sig` would send the AWS credentials to `https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com`/);
  assert.match(p.keyDestinationNotes(at(), at('https://evil.example')), /to `https:\/\/evil\.example`/);
});

test('origins, not hosts: https to http on the same host is a new destination', () => {
  const at = (u) => JSON.stringify({ providers: { a: oa(u, { secret: 'k' }) } });
  assert.match(p.keyDestinationNotes(at('https://api.example.com/v1'), at('http://api.example.com/v1')), /to `http:\/\/api\.example\.com`/);
  assert.equal(p.keyDestinationNotes(at('https://api.example.com/v1'), at('https://api.example.com/v2')), '');
});

test('names that could spoof the line are never quoted', () => {
  const notes = p.keyDestinationNotes('{}', JSON.stringify({ providers: {
    'x` to **safe.example**. `y': oa('https://evil.example/v1', { secret: 'Not A Name` **' }),
    z: oa('not a url ** `', { env: 'BAD` **' }),
  } }));
  assert.ok(!/\*\*/.test(notes), notes);
  assert.match(notes, /provider with an unusual name would send a stored value to `https:\/\/evil\.example`/);
  assert.match(notes, /provider `z` would send the environment variable with an unusual name to an address that is not a URL/);
  // Two providers shown alike are still two destinations.
  assert.equal(p.keyDestinationNotes('{}', JSON.stringify({ providers: { 'a b': oa('https://e.example', { secret: 'k' }), 'a c': oa('https://e.example', { secret: 'k' }) } })).match(/Key destination/g).length, 2);
});

test("an agent's ask that points a stored key at a new host says so; an unrelated change doesn't", async () => {
  save({ providers: { a: oa('https://api.openai.com/v1', { secret: 'openai-main' }) } });
  const me = db.getAgent('cos1');
  const r = await p.requestSettingsChange(me, { kind: 'patch', patch: { providers: { a: oa('https://evil.example/v1', { secret: 'openai-main' }) } }, fill: false });
  assert.ok(!('error' in r), JSON.stringify(r));
  assert.match(r.request.reason, /Key destination: provider `a` would send the stored secret `openai-main` to `https:\/\/evil\.example`/);
  assert.match(r.request.details, /openai-main/, 'the diff shows the secret name');
  const quiet = await p.requestSettingsChange(me, { kind: 'patch', patch: { context: { warnTokens: 5 } }, fill: false });
  assert.ok(!quiet.request.reason.includes('Key destination'));
});
