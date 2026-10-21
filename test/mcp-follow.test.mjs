#!/usr/bin/env node
// Unit test for `stam mcp` following deploys (S-178, mcp.ts followDeploys): a server started
// from release A serves release B's tools once `current` moves to B, and says so with
// tools/list_changed. A release whose tools fail to load is tried again until they load.
// Releases are copies of this checkout under a throwaway STAM_HOME; no daemon, no network,
// no models: `node --test test/mcp-follow.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './tmphome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = tempHome('stam-mcp-follow-');
const R = join(home, 'releases');
after(() => rmSync(home, { recursive: true, force: true }));

function release(name) {
  const dir = join(R, name);
  mkdirSync(dir, { recursive: true });
  for (const d of ['bin', 'src', 'scripts', 'templates', 'package.json']) cpSync(join(root, d), join(dir, d), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}
const point = (name) => spawnSync('ln', ['-sfn', name, join(R, 'current')]);

test('a running server takes up the current release, retrying one that failed to load', async () => {
  release('A');
  const B = release('B');
  // B adds a tool, and its module throws while the `broken` file exists (a release that
  // doesn't load yet).
  const src = readFileSync(join(B, 'src/mcp.ts'), 'utf8')
    .replace(
      'export const tools: Tool[] = [\n',
      "export const tools: Tool[] = [\n  { name: 'release_b_probe', group: 'agents', description: 'Added in release B.', inputSchema: { type: 'object', properties: {} }, run: async () => text('probe ok') },\n",
    )
    .replace("let agentId = process.env.STAM_AGENT_ID;", "let agentId = process.env.STAM_AGENT_ID;\nif ((await import('node:fs')).existsSync(process.env.STAM_HOME + '/broken')) throw new Error('half deployed');");
  assert.match(src, /release_b_probe/);
  assert.match(src, /half deployed/);
  writeFileSync(join(B, 'src/mcp.ts'), src);
  point('A');

  const env = { ...process.env, STAM_HOME: home, STAM_PORT: '1', STAM_URL: 'http://127.0.0.1:1' };
  delete env.STAM_AGENT_ID;
  delete env.STAM_RELEASE_ID;
  const child = spawn(join(R, 'current/bin/stam'), ['mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  after(() => child.kill());
  const pending = new Map();
  let changed = 0;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method === 'notifications/tools/list_changed') changed++;
      else pending.get(m.id)?.(m);
    }
  });
  let next = 1;
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const names = async () => (await request('tools/list')).result.tools.map((t) => t.name);

  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.capabilities.tools.listChanged, true);
  assert.ok((await names()).includes('whoami'));
  assert.ok(!(await names()).includes('release_b_probe'));

  writeFileSync(join(home, 'broken'), '');
  point('B');
  assert.ok(!(await names()).includes('release_b_probe'), "B's tools don't load while it's broken");
  assert.equal(changed, 0);

  rmSync(join(home, 'broken'));
  // Retries back off from 1 s; poll until B's tools are served.
  const deadline = Date.now() + 20_000;
  let got = [];
  while (Date.now() < deadline && !got.includes('release_b_probe')) {
    got = await names();
    if (!got.includes('release_b_probe')) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(got.includes('release_b_probe'), 'B is retried once it loads');
  assert.equal(changed, 1, 'one tools/list_changed');
  const call = await request('tools/call', { name: 'release_b_probe', arguments: {} });
  assert.equal(call.result.content[0].text, 'probe ok');
});
