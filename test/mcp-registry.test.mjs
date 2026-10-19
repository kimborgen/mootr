#!/usr/bin/env node
// The MCP registry proxy (S-53): reads a fixture registry over loopback, checks the latest
// version filter, the install options from remotes and packages, the ten-minute cache, and
// the remote-auth probe. Free, no network. `node --test test/mcp-registry.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-registry-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const page = {
  servers: [
    entry('com.example/dual', '1.0.0', { isLatest: false }, { title: 'Dual', websiteUrl: 'https://dual.example', repository: { url: 'https://github.com/example/dual' }, remotes: [
      { type: 'streamable-http', url: 'https://dual.example/mcp' },
      { type: 'sse', url: 'https://dual.example/sse' },
    ] }),
    entry('com.example/dual', '2.0.0', { isLatest: true }, { title: 'Dual', websiteUrl: 'https://dual.example', repository: { url: 'https://github.com/example/dual' }, remotes: [{ type: 'streamable-http', url: 'https://dual.example/mcp' }] }),
    entry('com.example/legacy', '1.2.9', { isLatest: false }, { remotes: [{ type: 'sse', url: 'https://legacy.example/sse' }] }),
    entry('com.example/legacy', '1.2.10', { isLatest: false }, { remotes: [{ type: 'sse', url: 'https://legacy.example/sse' }] }),
    entry('com.example/npm', '1.0.0', { isLatest: true }, { packages: [{ registryType: 'npm', identifier: 'pkg', version: '1.0.0', runtimeHint: 'npx', runtimeArguments: [{ value: '-y', type: 'positional' }], environmentVariables: [
      { name: 'TOKEN', description: 'A token.', isRequired: true, isSecret: true },
      { name: 'MODE', default: 'fast', description: 'A mode.' },
    ] }] }),
    entry('com.example/py', '2.1.0', { isLatest: true }, { packages: [{ registryType: 'pypi', identifier: 'mypkg', version: '2.1.0', packageArguments: [{ type: 'named', name: 'db', value: 'x' }] }] }),
    entry('com.example/oci', '3.0.0', { isLatest: true }, { packages: [{ registryType: 'oci', identifier: 'img', version: '3.0.0' }] }),
    entry('com.example/token', '1.0.0', { isLatest: true }, { remotes: [{ type: 'streamable-http', url: 'https://token.example/mcp', headers: [{ name: 'Authorization', description: 'A token.', isRequired: true, isSecret: true }] }] }),
    entry('com.example/fixed', '1.0.0', { isLatest: true }, { remotes: [{ type: 'streamable-http', url: 'https://fixed.example/mcp', headers: [{ name: 'X-Env', value: 'prod', description: 'Env.' }] }] }),
  ],
  metadata: { count: 9, nextCursor: 'more' },
};

function entry(name, version, official, server) {
  return { server: { name, version, description: `${name} server`, ...server }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: false, ...official } } };
}

let browseRegistry, remoteAuth, requests = 0, port = 0;
const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/v0.1/servers') {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(page));
  }
  if (url.pathname === '/oauth') {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer resource_metadata="http://x"' });
    return res.end('{}');
  }
  if (url.pathname === '/open') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  }
  res.writeHead(404).end();
});
before(() => new Promise((r) => fake.listen(0, '127.0.0.1', () => { port = fake.address().port; process.env.STAM_MCP_REGISTRY_URL = `http://127.0.0.1:${port}/v0.1/servers`; r(); })));
before(async () => ({ browseRegistry, remoteAuth } = await import('../src/mcp-registry.ts')));
after(() => { fake.close(); rmSync(home, { recursive: true, force: true }); });

test('only the latest version of each name is shown', async () => {
  const { servers } = await browseRegistry({ search: '' });
  const dual = servers.find((s) => s.name === 'com.example/dual');
  assert.equal(dual.version, '2.0.0');
  // No isLatest flag: the highest version wins.
  const legacy = servers.find((s) => s.name === 'com.example/legacy');
  assert.equal(legacy.version, '1.2.10');
  assert.equal(servers.filter((s) => s.name === 'com.example/dual').length, 1);
});

test('an entry carries its title, links, description, and options', async () => {
  const { servers, nextCursor } = await browseRegistry({ search: '' });
  const dual = servers.find((s) => s.name === 'com.example/dual');
  assert.equal(dual.title, 'Dual');
  assert.equal(dual.websiteUrl, 'https://dual.example');
  assert.equal(dual.repository, 'https://github.com/example/dual');
  assert.equal(dual.description, 'com.example/dual server');
  assert.equal(nextCursor, 'more');
  // A streamable-http remote wins over the sse one, so no SSE note.
  assert.equal(dual.options.length, 1);
  assert.deepEqual(dual.options[0].server, { url: 'https://dual.example/mcp' });
  assert.equal(dual.options[0].note, undefined);
});

test('an sse-only remote is included, with the note', async () => {
  const { servers } = await browseRegistry({ search: '' });
  const legacy = servers.find((s) => s.name === 'com.example/legacy');
  assert.match(legacy.options[0].note, /streamable HTTP/);
});

test('an npm package becomes npx, with its env fields', async () => {
  const { servers } = await browseRegistry({ search: '' });
  const o = servers.find((s) => s.name === 'com.example/npm').options[0];
  assert.deepEqual(o.server, { command: 'npx', args: ['-y', 'pkg@1.0.0'] });
  assert.deepEqual(o.fields.map((f) => [f.name, f.required, f.secret, f.prefill]), [
    ['TOKEN', true, true, undefined],
    ['MODE', false, false, 'fast'],
  ]);
});

test('pypi and oci packages become uvx and docker run', async () => {
  const { servers } = await browseRegistry({ search: '' });
  assert.deepEqual(servers.find((s) => s.name === 'com.example/py').options[0].server, { command: 'uvx', args: ['mypkg==2.1.0', '--db=x'] });
  assert.deepEqual(servers.find((s) => s.name === 'com.example/oci').options[0].server, { command: 'docker', args: ['run', '-i', '--rm', 'img:3.0.0'] });
});

test('a required remote header is a field; a fixed one is pre-filled', async () => {
  const { servers } = await browseRegistry({ search: '' });
  const token = servers.find((s) => s.name === 'com.example/token').options[0];
  assert.deepEqual(token.fields.map((f) => [f.name, f.required, f.secret, f.in]), [['Authorization', true, true, 'headers']]);
  const fixed = servers.find((s) => s.name === 'com.example/fixed').options[0];
  assert.deepEqual(fixed.fields.map((f) => [f.name, f.required, f.prefill]), [['X-Env', false, 'prod']]);
});

test('a response is cached for ten minutes', async () => {
  requests = 0;
  await browseRegistry({ search: 'cache-check' });
  await browseRegistry({ search: 'cache-check' });
  assert.equal(requests, 1);
});

test('remoteAuth: github is gh, a 401 with WWW-Authenticate is oauth, else none', async () => {
  assert.equal(await remoteAuth('https://api.githubcopilot.com/mcp/'), 'gh');
  assert.equal(await remoteAuth(`http://127.0.0.1:${port}/oauth`), 'oauth');
  assert.equal(await remoteAuth(`http://127.0.0.1:${port}/open`), null);
  assert.equal(await remoteAuth('ftp://nope'), null);
  assert.equal(await remoteAuth('not a url'), null);
});
