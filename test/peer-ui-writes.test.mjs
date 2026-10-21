#!/usr/bin/env node
// A peer's UI writes shared settings straight to the home (S-414): which browser origins the home
// answers (src/web-origins.ts), and that the home applies only the shared part of a peer's patch and
// keeps its own machine-local keys. Throwaway STAM_HOME, no daemon, no tailscale:
// `node --test test/peer-ui-writes.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-peer-ui-writes-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `peer-ui-writes-test-${process.pid}`;
const o = await import('../src/web-origins.ts');
const s = await import('../src/settings.ts');
const { MACHINE } = await import('../src/config.ts');

// A tailnet as `tailscale status --json` lists it; names are made up.
const NODES = [
  { DNSName: 'peerbox.example.com.', HostName: 'peerbox', TailscaleIPs: ['192.0.2.2', 'fd7a:115c:a1e0::2'] },
  { DNSName: 'otherbox.example.com.', HostName: 'otherbox', TailscaleIPs: ['192.0.2.3'] },
];

test('a peer UI origin is its daemon URL, that port on its tailnet names, and HTTPS on its full name', () => {
  const got = o.peerUiOrigins(['http://peerbox:7878'], NODES);
  for (const want of ['http://peerbox:7878', 'http://peerbox.example.com:7878', 'http://192.0.2.2:7878', 'http://[fd7a:115c:a1e0::2]:7878', 'https://peerbox.example.com'])
    assert.ok(got.has(want), `missing ${want}: ${[...got]}`);
  for (const not of ['https://otherbox.example.com', 'http://otherbox:7878', 'http://peerbox:9999', 'https://evil.example', 'http://peerbox.evil.example:7878'])
    assert.ok(!got.has(not), `has ${not}`);
});

test('a peer found by its address or full name gets the same origins; one tailscale lacks keeps its own', () => {
  assert.ok(o.peerUiOrigins(['http://192.0.2.2:7878'], NODES).has('https://peerbox.example.com'));
  assert.ok(o.peerUiOrigins(['http://peerbox.example.com:7878/'], NODES).has('http://peerbox:7878'));
  assert.deepEqual([...o.peerUiOrigins(['http://127.0.0.1:4321'], NODES)], ['http://127.0.0.1:4321']);
  assert.deepEqual([...o.peerUiOrigins(['not a url', 'ftp://peerbox/'], NODES)], []);
});

test('only the shared writes are peer UI routes', () => {
  assert.ok(o.peerUiRoute('PATCH', '/api/config/settings'));
  assert.ok(o.peerUiRoute('POST', '/api/config/instructions'));
  assert.ok(o.peerUiRoute('POST', '/api/types/tester'));
  assert.ok(o.peerUiRoute('DELETE', '/api/types/tester'));
  assert.ok(o.peerUiRoute('POST', '/api/templates/type-tester'));
  for (const [m, p] of [['POST', '/api/config/settings'], ['POST', '/api/config/registry'], ['GET', '/api/config/settings'], ['PATCH', '/api/config/settings/x'], ['POST', '/api/agents'], ['POST', '/api/types/a/b'], ['POST', '/api/mail'], ['POST', '/api/templates/mail-to-human'], ['POST', '/api/templates/type-a/b']])
    assert.ok(!o.peerUiRoute(m, p), `${m} ${p}`);
});

test("the home applies a peer's patch to shared keys only and keeps its own local keys", () => {
  const file = join(home, 'settings.json');
  writeFileSync(file, JSON.stringify({ home: MACHINE, peers: [{ name: 'peerbox', url: 'http://peerbox:7878', token: 't' }], itsa: { home: MACHINE, repos: { a: '/a' }, wip: 3 }, humanMail: { when: 'necessary' } }));
  s.settingsChanged();
  const r = s.patchSharedSettings({
    peers: [],
    home: 'peerbox',
    itsa: { home: 'peerbox', repos: {}, wip: 5 },
    humanMail: { when: 'often' },
  });
  assert.ok(!('problem' in r), JSON.stringify(r));
  const now = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(now.home, MACHINE);
  assert.equal(now.peers.length, 1);
  assert.deepEqual(now.itsa, { home: MACHINE, repos: { a: '/a' }, wip: 5 });
  assert.deepEqual(now.humanMail, { when: 'often' });
  // The reply holds only the shared part: no peer tokens.
  const shown = JSON.parse(r.text);
  assert.equal(shown.peers, undefined);
  assert.equal(shown.itsa.home, undefined);
});

test('a mixed key that held only local paths leaves the shared part alone', () => {
  const file = join(home, 'settings.json');
  writeFileSync(file, JSON.stringify({ home: MACHINE, itsa: { home: MACHINE, wip: 2 } }));
  s.settingsChanged();
  s.patchSharedSettings({ itsa: { home: 'peerbox' } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).itsa, { home: MACHINE, wip: 2 });
});
