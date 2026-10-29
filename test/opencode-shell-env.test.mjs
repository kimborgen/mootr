#!/usr/bin/env node
// Provider keys stay out of OpenCode's tool shells (S-2118): the real OpenCode server, with stam's
// plugin and a `provider` block whose key is `{env:STAM_PROVIDER_STUB_KEY}`, runs a turn against a
// stub OpenAI-compatible model. The model asks the shell tool for `printenv`; the key reaches the
// model as its bearer key, and the shell sees none. Free: no network, no real model. Needs the
// opencode binary (test/run.sh skips it without). `node --test test/opencode-shell-env.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callerOpencodeBin, tempDir } from './tmphome.mjs';

// The binary this run was started with, not tmphome.mjs's fake default: this test needs a real OpenCode server.
const BIN = callerOpencodeBin ?? join(homedir(), '.opencode/bin/opencode');
const KEY = `sk-stub-${process.pid}-secret`;
const dir = tempDir('stam-oc-shell-env-');
const procs = [];
after(() => {
  for (const p of procs) p.kill();
});

// One turn: a shell tool call, then, once the tool's answer is in, a closing text.
const seen = { auth: [], toolOutput: null };
function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', ...c })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.auth.push(req.headers.authorization ?? '');
    const j = JSON.parse(body || '{}');
    const tool = (j.messages ?? []).find((m) => m.role === 'tool');
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (tool) {
      seen.toolOutput = typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content);
      return sse(res, [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]);
    }
    if (!(j.tools ?? []).some((t) => t.function?.name === 'shell'))
      return sse(res, [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'title' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]);
    const args = JSON.stringify({ command: 'echo "key=[${STAM_PROVIDER_STUB_KEY:-}]"; printenv | grep -c STAM_PROVIDER_ || true; echo end-marker' });
    sse(res, [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: args } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage },
    ]);
  });
});

async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('a tool shell sees no STAM_PROVIDER_*_KEY, while the model gets the key', { skip: !existsSync(BIN) && 'the opencode binary is not installed', timeout: 120_000 }, async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  procs.push({ kill: () => stub.close() });
  const base = `http://127.0.0.1:${stub.address().port}/v1`;
  const cfg = join(dir, 'cfg');
  const work = join(dir, 'work');
  mkdirSync(join(cfg, 'plugins', 'stam'), { recursive: true });
  mkdirSync(work, { recursive: true });
  copyFileSync(join(import.meta.dirname, '../src/adapters/opencode-plugin/index.ts'), join(cfg, 'plugins/stam/index.ts'));
  const { opencodeProviders } = await import('../src/adapters/opencode-providers.ts');
  process.env.OCSE_KEY = KEY;
  const { blocks, env } = opencodeProviders({ stub: { kind: 'openai-compatible', baseUrl: base, apiKey: { env: 'OCSE_KEY' } } }, { models: { 'stub/m': { harnesses: ['opencode'] } } });
  writeFileSync(join(cfg, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: blocks }));

  const port = 20000 + (process.pid % 20000);
  const xdg = join(dir, 'xdg');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STAM_|OPENROUTER_|OPENAI_|AWS_|AZURE_|OCSE_)/.test(k)));
  const server = spawn(BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: work,
    stdio: 'ignore',
    env: { ...clean, ...env, HOME: xdg, XDG_CONFIG_HOME: join(xdg, 'c'), XDG_DATA_HOME: join(xdg, 'd'), XDG_STATE_HOME: join(xdg, 's'), XDG_CACHE_HOME: join(xdg, 'k'), OPENCODE_CONFIG_DIR: cfg, OPENCODE_SERVER_PASSWORD: 'pw' },
  });
  procs.push(server);
  const oc = async (method, path, b) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: 'Basic ' + Buffer.from('opencode:pw').toString('base64'), 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    const t = await r.text();
    const j = t ? JSON.parse(t) : {};
    return j && typeof j === 'object' && 'data' in j ? j.data : j;
  };
  await until('the OpenCode server', () => oc('GET', '/openapi.json').then(() => true));
  const s = await oc('POST', '/api/session', { title: 't', location: { directory: work }, model: { providerID: 'stub', id: 'm' }, permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
  await oc('POST', `/api/session/${s.id}/prompt`, { text: 'go', delivery: 'queue' });
  const out = await until('the shell tool output', async () => seen.toolOutput);

  assert.ok(seen.auth.includes(`Bearer ${KEY}`), 'the model got the provider key');
  assert.match(out, /end-marker/, 'the shell ran');
  assert.match(out, /key=\[\]/, 'the shell sees no key');
  assert.ok(!out.includes(KEY), 'no key in the tool output');
});
