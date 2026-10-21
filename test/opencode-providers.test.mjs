#!/usr/bin/env node
// OpenCode provider blocks (S-2118, src/adapters/opencode-providers.ts): each settings.providers entry
// as a `provider` block for opencode.json, keys only as `{env:...}` references with the values in the
// server env, the registry's `ID/MODEL` models and per-provider prices as the block's models.
// Free, no daemon, no network. `node --test test/opencode-providers.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

// A throwaway home: the {secret} test writes to its secret store.
process.env.STAM_HOME = tempHome('stam-oc-providers-');
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let mod;
before(async () => {
  process.env.OCP_OA_KEY = 'sk-oa';
  process.env.OCP_AZ_KEY = 'az-key';
  process.env.OCP_BR_KEY = 'br-token';
  delete process.env.OCP_MISSING;
  mod = await import('../src/adapters/opencode-providers.ts');
});

const reg = {
  models: {
    'oa/gpt-6-luna': { harnesses: ['opencode'], name: 'Luna' },
    'oa/codex-only': { harnesses: ['codex'] },
    'br/anthropic.claude-haiku-5-5': { harnesses: ['opencode'] },
    'openrouter/deepseek/deepseek-v4.1-flash': { harnesses: ['opencode'] },
  },
  prices: {
    'oa/gpt-6-luna': { input: 0.2, output: 0.9, cacheRead: 0.02, cacheWrite: null },
    'br/anthropic.claude-haiku-5-5': { input: 0.1, output: null },
  },
};

test('openai-compatible: the compatible package, base URL, key reference, and the registry models with their prices', () => {
  const { blocks, env } = mod.opencodeProviders(
    {
      oa: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/', apiKey: { env: 'OCP_OA_KEY' } },
      local: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' },
    },
    reg,
  );
  assert.deepEqual(blocks.oa, {
    npm: '@ai-sdk/openai',
    name: 'oa',
    options: { baseURL: 'https://api.openai.com/v1', apiKey: '{env:STAM_PROVIDER_OA_KEY}' },
    models: { 'gpt-6-luna': { name: 'Luna', cost: { input: 0.2, output: 0.9, cache_read: 0.02 } } },
  });
  assert.deepEqual(blocks.local, { npm: '@ai-sdk/openai-compatible', name: 'local', options: { baseURL: 'http://127.0.0.1:11434/v1' } });
  assert.deepEqual(env, { STAM_PROVIDER_OA_KEY: 'sk-oa' });
});

test('azure: a resource endpoint names the resource, a dated version uses deployment URLs, the deployment is a model', () => {
  const { blocks, env } = mod.opencodeProviders(
    {
      az: { kind: 'azure', endpoint: 'https://my-res.openai.azure.com/', apiVersion: '2024-10-21', deployment: 'gpt-prod', apiKey: { env: 'OCP_AZ_KEY' } },
      gw: { kind: 'azure', endpoint: 'https://gw.example.com/openai/v1', apiVersion: '2025-01-01', apiKey: { env: 'OCP_AZ_KEY' } },
    },
    reg,
  );
  assert.deepEqual(blocks.az, {
    npm: '@ai-sdk/azure',
    name: 'az',
    options: { resourceName: 'my-res', apiVersion: '2024-10-21', useDeploymentBasedUrls: true, apiKey: '{env:STAM_PROVIDER_AZ_KEY}' },
    models: { 'gpt-prod': { name: 'gpt-prod' } },
  });
  // An endpoint ending in /openai/v1 selects the v1 API whatever the version says.
  assert.deepEqual(blocks.gw, { npm: '@ai-sdk/azure', name: 'gw', options: { baseURL: 'https://gw.example.com/openai', apiKey: '{env:STAM_PROVIDER_GW_KEY}' } });
  assert.deepEqual(env, { STAM_PROVIDER_AZ_KEY: 'az-key', STAM_PROVIDER_GW_KEY: 'az-key' });
});

test('bedrock: region, profile and endpoint; a model with no full price gets no cost', () => {
  const { blocks, env } = mod.opencodeProviders(
    {
      br: { kind: 'bedrock', region: 'eu-west-1', profile: 'prod', endpoint: 'https://vpce.example.com', apiKey: { env: 'OCP_BR_KEY' } },
      brprofile: { kind: 'bedrock', region: 'us-east-1' },
    },
    reg,
  );
  assert.deepEqual(blocks.br, {
    npm: '@ai-sdk/amazon-bedrock',
    name: 'br',
    options: { region: 'eu-west-1', profile: 'prod', endpoint: 'https://vpce.example.com', apiKey: '{env:STAM_PROVIDER_BR_KEY}' },
    models: { 'anthropic.claude-haiku-5-5': { name: 'anthropic.claude-haiku-5-5' } },
  });
  assert.deepEqual(blocks.brprofile, { npm: '@ai-sdk/amazon-bedrock', name: 'brprofile', options: { region: 'us-east-1' } });
  assert.deepEqual(env, { STAM_PROVIDER_BR_KEY: 'br-token' });
});

test('no key value ever lands in the blocks; a missing key leaves the apiKey out', () => {
  const { blocks, env } = mod.opencodeProviders(
    {
      oa: { kind: 'openai-compatible', baseUrl: 'https://x.example/v1', apiKey: { env: 'OCP_OA_KEY' } },
      nokey: { kind: 'openai-compatible', baseUrl: 'https://x.example/v1', apiKey: { env: 'OCP_MISSING' } },
    },
    reg,
  );
  const text = JSON.stringify(blocks);
  for (const v of Object.values(env)) assert.ok(!text.includes(v), `${v} leaked into the blocks`);
  assert.equal(blocks.nokey.options.apiKey, undefined);
  assert.equal(env.STAM_PROVIDER_NOKEY_KEY, undefined);
});

test('openrouter, entries that do not parse, and unsafe ids are left out', () => {
  const { blocks, env } = mod.opencodeProviders(
    {
      openrouter: { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
      broken: { kind: 'azure', endpoint: 'https://r.openai.azure.com' },
      nobedrockregion: { kind: 'bedrock' },
      // The Bedrock adapter's parse (S-2117): a region is lower-case letters, digits and dashes, and
      // an endpoint is an https origin.
      badregion: { kind: 'bedrock', region: 'eu west 1' },
      httpendpoint: { kind: 'bedrock', region: 'eu-west-1', endpoint: 'http://vpce.example.com' },
      pathendpoint: { kind: 'bedrock', region: 'eu-west-1', endpoint: 'https://vpce.example.com/x?y' },
      alien: { kind: 'vertex' },
      'bad id': { kind: 'openai-compatible', baseUrl: 'https://x.example/v1' },
    },
    reg,
  );
  assert.deepEqual(blocks, {});
  assert.deepEqual(env, {});
});

test('ids that share a key variable are all left out and named, so no provider gets another\'s key', () => {
  const { blocks, env, collisions } = mod.opencodeProviders(
    {
      'my-az': { kind: 'openai-compatible', baseUrl: 'https://a.example/v1', apiKey: { env: 'OCP_OA_KEY' } },
      my_az: { kind: 'openai-compatible', baseUrl: 'https://b.example/v1', apiKey: { env: 'OCP_AZ_KEY' } },
      ok: { kind: 'openai-compatible', baseUrl: 'https://c.example/v1', apiKey: { env: 'OCP_BR_KEY' } },
    },
    reg,
  );
  assert.deepEqual(Object.keys(blocks), ['ok']);
  assert.deepEqual(env, { STAM_PROVIDER_OK_KEY: 'br-token' });
  assert.deepEqual(collisions.sort(), ['my-az', 'my_az']);
});

test('a key named as a secret comes from the secret store, still only as an env reference (S-2114)', async () => {
  const secrets = await import('../src/secrets.ts');
  secrets.set('oa-agent', { value: 'sk-from-store', provider: 'openai', slot: 'agent' });
  try {
    const { blocks, env } = mod.opencodeProviders({ sec: { kind: 'openai-compatible', baseUrl: 'https://x.example/v1', apiKey: { secret: 'oa-agent' } } }, reg);
    assert.equal(blocks.sec.options.apiKey, '{env:STAM_PROVIDER_SEC_KEY}');
    assert.deepEqual(env, { STAM_PROVIDER_SEC_KEY: 'sk-from-store' });
    assert.ok(!JSON.stringify(blocks).includes('sk-from-store'));
  } finally {
    secrets.remove('oa-agent');
  }
});

test('keyEnvName: upper case, anything else an underscore', () => {
  assert.equal(mod.keyEnvName('my-azure.eu'), 'STAM_PROVIDER_MY_AZURE_EU_KEY');
});
