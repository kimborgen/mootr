#!/usr/bin/env node
// The peer's MCP lease (S-3177), free: no daemon. A fake home answers the lease route with a script of
// (url, bearer) pairs, so the url check, the url-keyed cache and the peer's logout are each pinned.
//   node --test test/mcp-lease-peer.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-lease-peer-');
process.env.STAM_HOME = home;
// The loopback urls are allowed only for a test; no provider is contacted.
process.env.STAM_MCP_AUTH_INSECURE = '1';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const HOME_NAME = 'some-other-machine';
const LEASE_TOKEN = 'LEASE-PEER';
const B = 'http://127.0.0.1:9/b';
const C = 'http://127.0.0.1:9/gamma';

let mcpAuth, server, homeUrl;
// The home's answers, in order: the last one repeats. A request with another lease token is refused. An answer is
// { url, token } for a lease, or { status, raw } for any other reply (S-3472).
let answers = [];
let hits = 0;
// Each lease request's path, in order, and a gate (S-3472): while `gate` is set, the home holds each answer until
// it resolves, and `arrived` resolves when the first held request reaches the home.
let seen = [];
let gate = null;
let arrived = null;
const hold = () => {
  let release;
  gate = new Promise((r) => (release = r));
  let reached;
  arrived = new Promise((r) => (reached = r));
  gate.reached = reached;
  return () => {
    gate = null;
    release();
  };
};

const writeSettings = (url, servers = {}) =>
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      home: HOME_NAME,
      peers: [{ name: HOME_NAME, url: homeUrl, token: 'shared-token', leaseToken: LEASE_TOKEN }],
      mcpServers: { peer: { url, auth: { type: 'oauth' } }, ...Object.fromEntries(Object.entries(servers).map(([n, u]) => [n, { url: u, auth: { type: 'oauth' } }])) },
    }),
  );

before(async () => {
  server = createServer(async (req, res) => {
    hits++;
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${LEASE_TOKEN}`) {
      res.writeHead(403);
      return res.end(JSON.stringify({ error: 'not the lease token' }));
    }
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (gate) {
      gate.reached();
      await gate;
    }
    if (answer.status) {
      res.writeHead(answer.status);
      return res.end(answer.raw);
    }
    res.writeHead(200);
    res.end(JSON.stringify({ url: answer.url, access_token: answer.token, expires_at: Date.now() + 3_600_000 }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  homeUrl = `http://127.0.0.1:${server.address().port}`;
  writeSettings(B);
  mcpAuth = await import('../src/mcp-auth.ts');
});

after(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

test('peer > a lease for another url is asked again, and the bearer for the settings url is used', async () => {
  answers = [
    { url: C, token: 'BEARER-OTHER-URL' },
    { url: B, token: 'BEARER-B' },
  ];
  hits = 0;
  assert.equal(await mcpAuth.token('peer', { refresh: true }), 'BEARER-B');
  assert.equal(hits, 2, 'the home was asked once more after the first lease named another url');
});

test('peer > a lease that still names another url is refused, naming both urls and no bearer', async () => {
  answers = [{ url: C, token: 'BEARER-OTHER-URL' }];
  await assert.rejects(
    () => mcpAuth.token('peer', { refresh: true }),
    (e) => {
      assert.match(e.message, new RegExp(C.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(e.message, new RegExp(B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(e.message, /BEARER/);
      return true;
    },
  );
});

test('peer > the cache is keyed by url, so a changed url gets its own lease', async () => {
  // The bearer for B is cached from the first test. A changed url in the settings must not get it.
  writeSettings(C);
  answers = [{ url: C, token: 'BEARER-C' }];
  assert.equal(await mcpAuth.tokenFor('peer').then((t) => t.token), 'BEARER-C');
});

test('peer > logout deletes a grant the peer still holds, refresh token and all', async () => {
  writeFileSync(
    join(home, 'mcp-auth.json'),
    JSON.stringify({
      peer: { server_url: B, client_id: 'stam', token_endpoint: `${homeUrl}/token`, resource: B, access_token: 'LOCAL-ACCESS', refresh_token: 'LOCAL-REFRESH', expires_at: Date.now() + 3_600_000 },
    }),
  );
  mcpAuth.logout('peer');
  assert.equal(mcpAuth.store().peer, undefined);
  const onDisk = readFileSync(join(home, 'mcp-auth.json'), 'utf8');
  assert.doesNotMatch(onDisk, /LOCAL-REFRESH|LOCAL-ACCESS/);
});

test('peer > logout with no grant of its own is refused, naming the home', () => {
  assert.throws(() => mcpAuth.logout('peer'), /some-other-machine/);
});

// Resolves when the peer logs that a caller waits for the running fetch: the caller is in the single-flight (S-3472).
function waiting(count) {
  const log = console.log;
  let n = 0;
  return new Promise((resolve) => {
    console.log = (...args) => {
      if (String(args[0]).includes('waits for the running fetch') && ++n === count) {
        console.log = log;
        resolve();
      }
      log(...args);
    };
  });
}
const forced = () => seen.filter((u) => u.includes('refresh=1')).length;

test('peer > a forced ask arriving during a non-forced fetch gets a newer lease, not the running one (S-3472)', async () => {
  writeSettings(C, { join: B });
  answers = [
    { url: B, token: 'BEARER-OLD' },
    { url: B, token: 'BEARER-NEW' },
  ];
  seen = [];
  const release = hold();
  const plain = mcpAuth.token('join');
  await arrived;
  const joined = waiting(1);
  const fresh = mcpAuth.token('join', { refresh: true });
  await joined;
  release();
  assert.equal(await plain, 'BEARER-OLD');
  assert.equal(await fresh, 'BEARER-NEW', 'the forced ask got the token of the fetch it arrived during');
  assert.deepEqual(seen, ['/api/peer/mcp/join/lease', '/api/peer/mcp/join/lease?refresh=1']);
  // The newer lease is the one the cache now serves.
  assert.equal(await mcpAuth.token('join'), 'BEARER-NEW');
});

test('peer > concurrent non-forced asks share one fetch, and forced ones arriving during it share the next (S-3472)', async () => {
  writeSettings(C, { many: B });
  answers = [
    { url: B, token: 'BEARER-FIRST' },
    { url: B, token: 'BEARER-SECOND' },
  ];
  seen = [];
  const release = hold();
  const first = mcpAuth.token('many');
  await arrived;
  const joined = waiting(4);
  const plains = [mcpAuth.token('many'), mcpAuth.token('many')];
  const forcedAsks = [mcpAuth.token('many', { refresh: true }), mcpAuth.token('many', { refresh: true })];
  await joined;
  release();
  assert.deepEqual(await Promise.all([first, ...plains]), ['BEARER-FIRST', 'BEARER-FIRST', 'BEARER-FIRST']);
  assert.deepEqual(await Promise.all(forcedAsks), ['BEARER-SECOND', 'BEARER-SECOND']);
  assert.equal(seen.length, 2, 'two fetches: the running one, and one forced one after it');
});

test('peer > a url mismatch is asked again without a forced refresh, while the home settings sync (S-3472)', async () => {
  writeSettings(C, { sync: B });
  // The home still names the old url for the first answer, held until its settings have synced.
  answers = [
    { url: C, token: 'BEARER-OLD-URL' },
    { url: B, token: 'BEARER-SYNCED' },
  ];
  seen = [];
  const release = hold();
  const ask = mcpAuth.token('sync', { refresh: true });
  await arrived;
  release();
  assert.equal(await ask, 'BEARER-SYNCED');
  assert.equal(seen.length, 2);
  assert.equal(forced(), 1, 'the re-ask after a url mismatch made the home refresh again');
});

// Fail closed (S-3472): a home that answers with a refusal or a bad answer gives no bearer, and its cached lease is
// dropped, so the next ask doesn't hand out a token the home no longer leases. Each error is named for what it is.
for (const [label, answer, message] of [
  ['401', { status: 401, raw: JSON.stringify({ error: 'bad lease token' }) }, /refused the lease token \(401/],
  ['403', { status: 403, raw: JSON.stringify({ error: 'not shared' }) }, /refused the lease token \(403/],
  ['404', { status: 404, raw: JSON.stringify({ error: 'no MCP server named it' }) }, /answered 404/],
  ['409', { status: 409, raw: JSON.stringify({ error: 'not logged in' }) }, /has no lease for it/],
  ['500', { status: 500, raw: JSON.stringify({ error: 'boom' }) }, /answered 500/],
  ['a body that is not JSON', { status: 200, raw: '<html>proxy</html>' }, /answered something that is not JSON/],
  ['a 200 without a lease', { status: 200, raw: JSON.stringify({ url: B }) }, /answered 200 without a lease/],
]) {
  test(`peer > fail closed: ${label} from the home gives no bearer and drops the cached lease (S-3472)`, async () => {
    const name = `closed${label.replace(/\W/g, '')}`;
    writeSettings(C, { [name]: B });
    answers = [{ url: B, token: 'BEARER-CACHED' }];
    assert.equal(await mcpAuth.token(name), 'BEARER-CACHED');
    answers = [answer];
    const refused = (e) => {
      assert.match(e.message, message);
      assert.doesNotMatch(e.message, /unreachable/);
      assert.doesNotMatch(e.message, /BEARER|LEASE-PEER/);
      return true;
    };
    await assert.rejects(() => mcpAuth.token(name, { refresh: true }), refused);
    await assert.rejects(() => mcpAuth.token(name), refused, 'the cached lease was served after the home refused');
  });
}

// Last, since it leaves the home marked down: an unreachable home is named so, gives no bearer for a forced ask, and
// keeps the cached lease, which the peer serves until its margin (S-3177).
test('peer > an unreachable home is named so, and the cached lease is kept (S-3472)', async () => {
  writeSettings(C, { down: B });
  answers = [{ url: B, token: 'BEARER-KEPT' }];
  assert.equal(await mcpAuth.token('down'), 'BEARER-KEPT');
  await new Promise((r) => server.close(r));
  server = null;
  await assert.rejects(
    () => mcpAuth.token('down', { refresh: true }),
    (e) => {
      assert.match(e.message, /the home some-other-machine is unreachable/);
      assert.doesNotMatch(e.message, /BEARER/);
      return true;
    },
  );
  assert.equal(await mcpAuth.token('down'), 'BEARER-KEPT');
});
