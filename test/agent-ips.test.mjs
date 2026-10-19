#!/usr/bin/env node
// The agent machines' Tailscale addresses (S-488): a request reads the last result and never waits on
// `tailscale status`. A scripted runner, no tailscale, no daemon: `node --test test/agent-ips.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { agentIpCache } = await import('../src/agent-ips.ts');

const STATUS = JSON.stringify({
  Self: { TailscaleIPs: ['192.0.2.1'] },
  Peer: {
    a: { HostName: 'peerbox', DNSName: 'peerbox.example.com.', TailscaleIPs: ['192.0.2.2'] },
    b: { HostName: 'laptop', DNSName: 'laptop.example.com.', TailscaleIPs: ['192.0.2.3'] },
  },
});

test('get never waits on the runner: it is empty until a refresh finishes, then returns the peers and self', async () => {
  let release;
  let calls = 0;
  const c = agentIpCache(() => { calls++; return new Promise((r) => (release = () => r(STATUS))); }, () => ['peerbox']);
  assert.equal(c.get().size, 0);
  assert.equal(c.get().size, 0);
  assert.equal(calls, 1, 'a refresh still running is joined');
  release();
  await c.refresh();
  assert.deepEqual([...c.get()].sort(), ['192.0.2.1', '192.0.2.2']);
});

test('an old result is returned as it is while a background refresh runs; a failure keeps the last result', async () => {
  let next = Promise.resolve(STATUS);
  let calls = 0;
  const c = agentIpCache(() => { calls++; return next; }, () => ['peerbox'], 0);
  await c.refresh();
  next = Promise.reject(new Error('tailscale down'));
  assert.deepEqual([...c.get()].sort(), ['192.0.2.1', '192.0.2.2']);
  await c.refresh();
  assert.equal(calls, 2, "the explicit refresh joins the one get started");
  assert.deepEqual([...c.get()].sort(), ['192.0.2.1', '192.0.2.2']);
});
