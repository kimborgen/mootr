#!/usr/bin/env node
// An ask's ITSA home on another machine (S-3827, src/ask-home.ts with itsa-owners.ts askItsa). A fake ITSA home on loopback
// answers as the test sets. A home from before S-3827 has no `POST /api/itsas/ask-home` (`no route`, a 404): an ask then has
// no ITSA home and is still sent, its named `itsa` not refused, while the refusal is staged. A missing ITSA (`no ITSA`, also a
// 404) is still refused, as is a 403; a home that drops the call or fails (a 500) is no home, so an agent blocked on a
// safety check can still ask. A dialog or escalation (fallback) waits about 2 s for a slow home, then has no ITSA home.
// Needs a listening socket, so it isn't a LIGHT test. Run with `node --test test/ask-home-peer.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ask-home-peer-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const HOME = 'home-peer';
// What the fake home answers next, after how long.
let next = { status: 200, body: null, delay: 0 };
let peer, db, askHome, HomeRefused, dev;

before(async () => {
  peer = createServer((req, res) => {
    req.resume();
    req.on('end', () => setTimeout(() => {
      if (next.drop) return req.socket.destroy();
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    }, next.delay));
  });
  await new Promise((done) => peer.listen(0, '127.0.0.1', done));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ itsa: { home: HOME }, peers: [{ name: HOME, url: `http://127.0.0.1:${peer.address().port}`, token: 'peer-token' }] }));
  db = await import('../src/db.ts');
  ({ askHome, HomeRefused } = await import('../src/ask-home.ts'));
  db.open();
  db.createAgent({ id: 'dev1', name: 'dev-one', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  dev = db.getAgent('dev1');
});
after(() => {
  if (peer.listening) peer.close();
  rmSync(home, { recursive: true, force: true });
});

test("an old ITSA home's unknown route is no home: the ask is sent to a new thread, a named itsa not refused", async () => {
  next = { status: 404, body: { error: 'no route POST /api/itsas/ask-home' }, delay: 0 };
  const h = await askHome(dev, { itsa: 'S-12' }, 'human');
  assert.equal(h.thread, null);
  assert.equal(h.itsa, null);
  assert.equal(h.noHome, true, 'it goes to a new thread with the no-home line');
});

test('a missing ITSA on a new home is still refused', async () => {
  next = { status: 404, body: { error: 'no ITSA S-12' }, delay: 0 };
  await assert.rejects(askHome(dev, { itsa: 'S-12' }, 'human'), HomeRefused);
});

test('the ITSA home answering places the ask in its thread', async () => {
  next = { status: 200, body: { id: 'i1', key: 'S-12', title: 'Work', thread_id: 'm42' }, delay: 0 };
  const h = await askHome(dev, { itsa: 'S-12' }, 'human');
  assert.equal(h.thread, 'm42');
});

test('a dialog waits about 2 s for a slow home, then has no ITSA home', async () => {
  next = { status: 200, body: { id: 'i1', key: 'S-12', title: 'Work', thread_id: 'm42' }, delay: 6000 };
  const t0 = Date.now();
  const h = await askHome(dev, {}, 'fallback');
  const took = Date.now() - t0;
  assert.equal(h.thread, null);
  assert.ok(took < 4000, `it gave up in ${took} ms`);
});

test('a named itsa is not refused while the ITSA home is down or failing: the ask goes to a new thread', async () => {
  for (const n of [{ drop: true, status: 200, body: null, delay: 0 }, { status: 500, body: { error: 'database is locked' }, delay: 0 }]) {
    next = n;
    const h = await askHome(dev, { itsa: 'S-12' }, 'human');
    assert.equal(h.thread, null);
    assert.equal(h.noHome, true);
  }
});

test("the home's 403 for a named itsa is still refused", async () => {
  next = { status: 403, body: { error: "dev-one can't ask in the thread of S-12" }, delay: 0 };
  await assert.rejects(askHome(dev, { itsa: 'S-12' }, 'human'), HomeRefused);
});
