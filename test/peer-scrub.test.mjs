#!/usr/bin/env node
// A peer's or a proxy's refusal that echoes a token reaches no caller, log or reply with it (S-3994). A fake peer on
// loopback answers non-2xx with the token in its error. peerCall and peerPoll redact the peer's shared, peer and lease
// tokens and this daemon's own shared, peer and lease tokens, anywhere in the body, whatever their length and after a
// rotation; a success is left as sent, and a body that isn't JSON is a fixed error. A refusal peerStream pipes on is
// redacted too, and a fetch error is redacted only when it names a token, keeping its name (a timeout stays a
// TimeoutError). Two real call sites end to end: mayParticipate's error and loadOwned's log, both through the ITSA home;
// test/e2e-peer-scrub-relay.sh covers the Files and declaration relays through a daemon. Throwaway STAM_HOME, no daemon: `node --test test/peer-scrub.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-peer-scrub-');
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'here';
process.env.STAM_TMUX_SOCKET = `peer-scrub-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const KINDS = {
  "the peer's shared token": 'far-shared-secret',
  "the peer's peer token": 'far-peer-secret',
  "the peer's lease token": 'far-lease-secret',
  'our shared token': 'own-shared-secret',
  'our peer token': 'own-peer-secret',
  'our lease token': 'own-lease-secret',
};
writeFileSync(join(home, 'token'), KINDS['our shared token']);
writeFileSync(join(home, 'peer-token'), KINDS['our peer token']);
writeFileSync(join(home, 'mcp-lease-token'), `${KINDS['our lease token']}\n`);

// What the fake peer answers: a status and a body, set per test; an endless answer writes its body and never ends.
let answer = { status: 403, body: '{}' };
// The health probes the fake peer got: a peer marked down is probed before the next call.
let healthHits = 0;
const server = createServer((req, res) => {
  if (req.url === '/api/health') healthHits++;
  req.resume();
  req.on('end', () => {
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    if (answer.endless) res.write(answer.body);
    else res.end(answer.body);
  });
});
let peers, owners, peer;
// Every string an error holds, own properties hidden or not, its cause's included, read whole: what a caller could log.
function strings(v, seen = new Set()) {
  if (typeof v === 'string') return [v];
  if (!v || typeof v !== 'object' || seen.has(v)) return [];
  seen.add(v);
  return Reflect.ownKeys(v).flatMap((k) => [...(typeof k === 'string' ? [k] : []), ...strings(v[k], seen)]);
}

// Runs fn with env vars set, putting them back after.
async function withEnv(vars, fn) {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const refusal = (tok) => JSON.stringify({ error: `refused: Bearer ${tok} is unknown here`, detail: { seen: [tok], [tok]: 1 } });

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  peer = { name: 'farhome', url, token: KINDS["the peer's shared token"], peerToken: KINDS["the peer's peer token"], leaseToken: KINDS["the peer's lease token"] };
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ itsa: { home: 'farhome' }, peers: [peer] }));
  peers = await import('../src/peers.ts');
  owners = await import('../src/itsa-owners.ts');
  (await import('../src/db.ts')).open();
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// GET through a throwaway server whose handler pipes peerStream: the status and the text the caller got.
async function viaStream(path = '/api/agents/x/view') {
  const relay = createServer((req, res) => void peers.peerStream(peer, path, res));
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${relay.address().port}/`);
    return { status: r.status, text: await r.text() };
  } finally {
    relay.closeAllConnections();
    relay.close();
  }
}

// peerRaw's answer: its status, text, and whether it kept a content-length.
async function viaRaw(path = '/api/decl') {
  const r = await peers.peerRaw(peer, path, {}, true);
  return { status: r.status, text: await r.text(), length: r.headers.get('content-length') };
}

test('a refusal that echoes any token comes back redacted, through peerCall and peerPoll', async () => {
  for (const [kind, tok] of Object.entries(KINDS)) {
    for (const status of [403, 500, 302]) {
      answer = { status, body: refusal(tok) };
      for (const call of [() => peers.peerCall(peer, 'GET', '/api/x'), () => peers.peerPoll(peer, '/api/x', 2000)]) {
        const r = await call();
        assert.equal(r.status, status);
        assert.deepEqual(r.data, { error: 'refused: Bearer [redacted] is unknown here', detail: { seen: ['[redacted]'], '[redacted]': 1 } }, `${kind}, ${status}`);
      }
    }
  }
});

test('a success is the peer protocol, left as it came', async () => {
  answer = { status: 200, body: refusal(KINDS["the peer's peer token"]) };
  assert.equal((await peers.peerCall(peer, 'GET', '/api/x')).data.error, `refused: Bearer ${KINDS["the peer's peer token"]} is unknown here`);
});

test('config accepts a token of any length, so a short one is redacted too', () => {
  assert.equal(peers.redactPeerText({ name: 'x', url: '', token: 'q', peerToken: 'short' }, 'a quick short note'), 'a [redacted]uick [redacted] note');
});

test('a timeout is thrown as it came: its message names no token, and a DOMException message is read-only', async () => {
  const hang = createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  try {
    const slow = { ...peer, name: 'slowhome', url: `http://127.0.0.1:${hang.address().port}` };
    await assert.rejects(peers.peerCall(slow, 'GET', '/api/x', undefined, 50), (e) => {
      assert.equal(e.name, 'TimeoutError');
      assert.equal(e.message, 'The operation was aborted due to timeout');
      assert.ok(!strings(e).some((x) => Object.values(KINDS).some((t) => x.includes(t))));
      return true;
    });
  } finally {
    hang.closeAllConnections();
    hang.close();
  }
});

test('a transport error that holds a token is rebuilt: its name, its message redacted, and no cause or property with it', async () => {
  // A URL the fetch refuses to build quotes it, and a peer's URL may carry a token (user:token@host). The long one puts
  // the token past the 10,000 characters a display of the cause would show.
  const tok = KINDS["the peer's lease token"];
  for (const [i, url] of [`http://user:${tok}@[::1`, `http://user:${'a'.repeat(12000)}${tok}@[::1`].entries()) {
    // A name of its own each: a failed call marks its peer down.
    await assert.rejects(peers.peerCall({ ...peer, name: `badhome${i}`, url }, 'GET', '/api/x'), (e) => {
      assert.ok(!String(e.cause?.input ?? '').includes(tok));
      assert.ok(!strings(e).some((x) => x.includes(tok)), 'a property of the error holds the token');
      assert.match(e.message, /\[redacted\]/);
      assert.equal(e.name, 'TypeError');
      return true;
    });
  }
});

const CODE_TOKEN = 'FAR_PEER_SECRET';

// Errors a fetch could reject with that hold the peer's token where reading them throws or shows it.
function hostileErrors(tok) {
  const throwing = () => {
    throw new Error(`denied ${tok}`);
  };
  const getter = (key) => Object.defineProperty(new TypeError('fetch failed'), key, { get: throwing });
  const traps = Object.fromEntries(['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map((t) => [t, throwing]));
  return {
    'a Proxy cause whose traps throw': Object.assign(new TypeError('fetch failed'), { cause: new Proxy({}, traps) }),
    'a throwing message': getter('message'),
    'a throwing name': getter('name'),
    'a throwing cause': getter('cause'),
    'a throwing code': Object.assign(new TypeError('fetch failed'), { cause: Object.defineProperty({}, 'code', { get: throwing }) }),
    'a token in its own name': Object.assign(new TypeError('fetch failed'), { name: `Bad ${tok}` }),
    // A token that reads as an error code: CODE_TOKEN below is the peer's token for this one.
    'a token in its code': Object.assign(new TypeError('fetch failed'), { cause: { code: CODE_TOKEN, input: CODE_TOKEN } }),
  };
}

// Calls fn with fetch rejecting with err, putting fetch back after.
async function rejecting(err, fn) {
  const was = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(err);
  try {
    return await fn();
  } finally {
    globalThis.fetch = was;
  }
}

test('a fetch error is always rebuilt: nothing that reads or shows a token gets past, and nothing throws past it', async () => {
  const tok = KINDS["the peer's peer token"];
  let i = 0;
  for (const [kind, err] of Object.entries(hostileErrors(tok))) {
    // A name of its own each: a failed call marks its peer down.
    const p = { ...peer, name: `hostile${i++}`, peerToken: kind === 'a token in its code' ? CODE_TOKEN : tok };
    for (const call of [() => peers.peerCall(p, 'GET', '/api/x'), () => peers.peerPoll(p, '/api/x', 2000)]) {
      const e = await rejecting(err, () => call().then(() => assert.fail(`${kind}: no error`), (x) => x));
      assert.ok(e instanceof Error, kind);
      const held = strings(e).find((x) => x.includes(p.peerToken) || x.includes(tok));
      assert.equal(held, undefined, `${kind}: the error holds the token`);
    }
  }
});

test('a timeout rebuilt keeps its name and message', async () => {
  const e = await rejecting(new DOMException('The operation was aborted due to timeout', 'TimeoutError'), () => peers.peerPoll(peer, '/api/x', 2000).then(() => assert.fail('no error'), (x) => x));
  assert.equal(e.name, 'TimeoutError');
  assert.equal(e.message, 'The operation was aborted due to timeout');
});

test('a lease token rotated after the first call is redacted at once', async () => {
  answer = { status: 403, body: refusal(KINDS['our lease token']) };
  await peers.peerCall(peer, 'GET', '/api/x');
  const rotated = 'rotated-lease-secret';
  writeFileSync(join(home, 'mcp-lease-token'), `${rotated}\n`);
  try {
    answer = { status: 403, body: refusal(rotated) };
    assert.equal((await peers.peerCall(peer, 'GET', '/api/x')).data.error, 'refused: Bearer [redacted] is unknown here');
  } finally {
    writeFileSync(join(home, 'mcp-lease-token'), `${KINDS['our lease token']}\n`);
  }
});

test("a refusal piped on by peerStream (an agent's view) or read by peerRaw is redacted; a success is the peer's bytes", async () => {
  for (const tok of Object.values(KINDS)) {
    answer = { status: 403, body: refusal(tok) };
    for (const r of [await viaStream(), await viaRaw()]) {
      assert.equal(r.status, 403);
      assert.ok(!r.text.includes(tok), r.text);
      assert.equal(JSON.parse(r.text).error, 'refused: Bearer [redacted] is unknown here');
    }
  }
  answer = { status: 200, body: refusal(KINDS["the peer's peer token"]) };
  assert.ok((await viaStream()).text.includes(KINDS["the peer's peer token"]));
  assert.ok((await viaRaw()).text.includes(KINDS["the peer's peer token"]));
});

test('a JSON refusal with its token escaped is decoded, redacted and written again, through peerStream and peerRaw', async () => {
  const tok = KINDS["the peer's peer token"];
  const escaped = `\\u${tok.charCodeAt(0).toString(16).padStart(4, '0')}${tok.slice(1)}`;
  answer = { status: 403, body: `{"error":"denied: ${escaped}","${escaped}":[1]}` };
  for (const r of [await viaStream(), await viaRaw()]) {
    assert.equal(r.text, '{"error":"denied: [redacted]","[redacted]":[1]}');
  }
});

const FIXED = '{"error":"farhome refused with 403; its answer was too long or too slow to show safely"}';

test('a refusal over the cap, or one that never ends, is a fixed refusal with its status, and the peer stays up', async () => {
  const tok = KINDS["the peer's peer token"];
  await withEnv({ STAM_PEER_REFUSAL_MAX_BYTES: '100', STAM_PEER_REFUSAL_MS: '50' }, async () => {
    const probes = healthHits;
    for (const a of [{ status: 403, body: `{"error":"${'x'.repeat(200)}${tok}"}` }, { status: 403, body: `{"error":"${tok.slice(0, 6)}`, endless: true }]) {
      answer = a;
      for (const r of [await viaStream(), await viaRaw()]) {
        assert.equal(r.status, 403);
        assert.equal(r.text, FIXED, a.endless ? 'endless' : 'oversized');
      }
    }
    // A slow refusal is still an answer: the peer isn't marked down, so the next relay goes straight to it, unprobed.
    answer = { status: 200, body: '{"ok":true}' };
    assert.equal((await viaRaw()).text, '{"ok":true}');
    assert.equal(healthHits, probes, 'the peer was marked down and probed');
  });
});

test('a JSON refusal too deeply nested to redact, with a token escaped in it, is the fixed refusal', async () => {
  const tok = KINDS["the peer's peer token"];
  const escaped = `\\u${tok.charCodeAt(0).toString(16).padStart(4, '0')}${tok.slice(1)}`;
  answer = { status: 403, body: `{"error":"denied: ${escaped}","n":${'['.repeat(20000)}${']'.repeat(20000)}}` };
  for (const r of [await viaStream(), await viaRaw()]) {
    assert.equal(r.status, 403);
    assert.equal(r.text, FIXED);
  }
});

test('a refusal cap or wait that is not a positive number is the default, not a bound that refuses every answer', async () => {
  for (const v of ['-5', '0']) {
    await withEnv({ STAM_PEER_REFUSAL_MAX_BYTES: v, STAM_PEER_REFUSAL_MS: v }, async () => {
      answer = { status: 403, body: refusal(KINDS["the peer's peer token"]) };
      for (const r of [await viaStream(), await viaRaw()]) assert.equal(JSON.parse(r.text).error, 'refused: Bearer [redacted] is unknown here', v);
    });
  }
});

test('a body that is not JSON is a fixed error, without the token', async () => {
  answer = { status: 502, body: `<html>Bearer ${KINDS["the peer's peer token"]}</html>` };
  await assert.rejects(peers.peerCall(peer, 'GET', '/api/x'), (e) => e.message === 'farhome answered something that is not JSON');
  await assert.rejects(peers.peerPoll(peer, '/api/x', 2000), (e) => e.message === 'farhome answered something that is not JSON');
});

test('a real call site: the home refusing a spawn check reaches the caller redacted', async () => {
  for (const [kind, tok] of Object.entries(KINDS)) {
    answer = { status: 403, body: refusal(tok) };
    await assert.rejects(owners.mayParticipate(['S-1']), (e) => {
      assert.equal(e.message, 'the ITSA home farhome refused: refused: Bearer [redacted] is unknown here', kind);
      return true;
    });
  }
});

test('a real call site: a home refusal that is logged is logged redacted', async () => {
  const lines = [];
  const was = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    for (const tok of Object.values(KINDS)) {
      answer = { status: 500, body: refusal(tok) };
      await owners.loadOwned('a1');
    }
  } finally {
    console.error = was;
  }
  const logged = lines.join('\n');
  assert.match(logged, /refused: Bearer \[redacted\] is unknown here/);
  for (const [kind, tok] of Object.entries(KINDS)) assert.ok(!logged.includes(tok), `the log holds ${kind}`);
});
