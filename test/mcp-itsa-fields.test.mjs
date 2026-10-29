#!/usr/bin/env node
// itsa_set's reply names a changed ITSA field as key=value pairs, not as "[object Object]" (S-2786).
// A fake daemon on loopback answers each PATCH with the change it is told to make. Free, no model.
// `node --test test/mcp-itsa-fields.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-itsa-fields-change-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// The changes the next PATCH reports; a GET is the name lookup that formats the reply.
let changes = {};
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ key: 'S-2108', itsa: { key: 'S-2108', owner: null }, changes }));
  });
});
let mcp;
before(async () => {
  await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
  process.env.STAM_URL = `http://127.0.0.1:${daemon.address().port}`;
  mcp = await import('../src/mcp.ts');
});
after(() => {
  daemon.close();
  rmSync(home, { recursive: true, force: true });
});

const self = 'agent-itsa-fields-change';
const reply = async (args, report) => {
  changes = report;
  return (await mcp.callTool('itsa_set', { self, ref: 'S-2108', ...args })).content[0].text;
};

test('a fields change reads as key=value pairs, from -> to', async () => {
  const text = await reply({ fields: { stage: 'done' } }, { fields: { from: { stage: 'review' }, to: { stage: 'done' } } });
  assert.equal(text, 'S-2108: fields: stage=review -> stage=done');
  assert.doesNotMatch(text, /object Object/);
});

test('a cleared field shows as (none), and an unset one shows as (none) before', async () => {
  const cleared = await reply({ fields: { stage: null } }, { fields: { from: { stage: 'plan' }, to: { stage: null } } });
  assert.equal(cleared, 'S-2108: fields: stage=plan -> stage=(none)');
  const set = await reply({ fields: { stage: 'code' } }, { fields: { from: { stage: null }, to: { stage: 'code' } } });
  assert.equal(set, 'S-2108: fields: stage=(none) -> stage=code');
});

test('other changes in the same reply render as before', async () => {
  const text = await reply(
    { status: 'done', fields: { stage: 'done' } },
    { status: { from: 'in_review', to: 'done' }, fields: { from: { stage: 'review' }, to: { stage: 'done' } } },
  );
  assert.equal(text, 'S-2108: status: in_review -> done; fields: stage=review -> stage=done');
});
