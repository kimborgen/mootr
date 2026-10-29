#!/usr/bin/env node
// Unit tests for tiny-model spend on providers other than OpenRouter (S-3245) against a throwaway STAM_HOME and the
// stub endpoint (test/decide-stub.mjs), no daemon, no network: an OpenAI-compatible and a Bedrock call are priced
// from their tokens and the registry's prices (an unpriced model at a dearer fallback, logged, never $0); a held
// <provider>-system budget skips the call; tool summaries, mail titles and block summaries book to
// <provider>-system, not openrouter-system; a Bedrock 403 reads as an invalid key and quotes nothing.
// Run with `node --test test/tiny-spend.test.mjs`.
import './scrub-env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-tiny-spend-');
const stubDir = join(home, 'stub');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `tiny-spend-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { mailCheck: false }, search: { embedder: 'off' } }));

let stub, db, settings, llm, ts, titles, summaries, mail, base;
const calls = () => (existsSync(join(stubDir, 'titles')) ? Number(readFileSync(join(stubDir, 'titles'), 'utf8')) : 0);
const events = (type) => db.open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ?').all('stam', type).map((r) => JSON.parse(r.data));
const usage = (account) => db.open().prepare('SELECT harness, model, cost_usd, tokens_in FROM usage WHERE agent_id = ? AND account = ?').get('stam', account);
const until = async (fn, what) => {
  for (let i = 0; i < 500; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const ask = (model) => llm.complete({ model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 20, timeoutMs: 5000 });

before(async () => {
  stub = spawn(process.execPath, [join(import.meta.dirname, 'decide-stub.mjs'), stubDir], { stdio: 'ignore' });
  process.on('exit', () => stub.kill());
  for (let i = 0; !existsSync(join(stubDir, 'url')); i++) {
    if (i > 500) throw new Error('the stub did not start');
    await new Promise((r) => setTimeout(r, 10));
  }
  base = readFileSync(join(stubDir, 'url'), 'utf8').trim().replace(/\/+$/, '');
  process.env.STAM_OPENROUTER_URL = base + '/';
  process.env.TINY_SPEND_KEY = 'sk-secret-tiny-key';
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  llm = await import('../src/llm/index.ts');
  ts = await import('../src/tool-summaries.ts');
  titles = await import('../src/mail-title.ts');
  summaries = await import('../src/block-summaries.ts');
  mail = await import('../src/mail.ts');
  db.open();
  settings.patchSettings({
    providers: {
      myoai: { kind: 'openai-compatible', baseUrl: base, apiKey: { env: 'TINY_SPEND_KEY' } },
      local: { kind: 'openai-compatible', baseUrl: base },
      mybr: { kind: 'bedrock', region: 'us-east-1', endpoint: base, apiKey: { env: 'TINY_SPEND_KEY' } },
    },
  });
});
after(() => {
  stub?.kill();
  rmSync(home, { recursive: true, force: true });
});

test('an OpenAI-compatible call is priced from its tokens and the registry (30 in, 4 out at $0.1 and $0.5 per million)', async () => {
  const r = await ask('myoai:gpt-6-luna');
  assert.equal(r.priced, 'catalog');
  assert.ok(Math.abs(r.costUsd - (30 * 0.1 + 4 * 0.5) / 1e6) < 1e-12);
});

test('a Bedrock call is priced the same way (31 in, 5 out)', async () => {
  const r = await ask('mybr:claude-haiku-5-5');
  assert.equal(r.priced, 'catalog');
  assert.ok(Math.abs(r.costUsd - (31 * 0.1 + 5 * 0.5) / 1e6) < 1e-12);
});

test('an unpriced model books at the dearer fallback and logs it, never $0; OpenRouter keeps its own cost', async () => {
  const r = await ask('myoai:no-such-model');
  assert.equal(r.priced, 'fallback');
  assert.ok(Math.abs(r.costUsd - (30 * 15 + 4 * 75) / 1e6) < 1e-12);
  assert.ok(r.costUsd > 0);
  assert.ok(events('llm:unpriced').some((e) => e.provider === 'myoai' && e.model === 'no-such-model' && e.cost_usd === r.costUsd));
  const or = await ask('google/gemma-3-4b-it');
  assert.equal(or.costUsd, 0.000002);
  assert.equal(or.priced, undefined);
});

test('a Bedrock 403 reads as an invalid key and quotes neither the key nor the response', async () => {
  writeFileSync(join(stubDir, 'revoked'), '');
  try {
    await assert.rejects(ask('mybr:claude-haiku-5-5'), (e) => {
      assert.ok(e instanceof llm.LlmHttpError);
      assert.equal(e.status, 403);
      assert.match(e.message, /key invalid or access denied/);
      assert.ok(!e.message.includes('sk-secret-tiny-key') && !e.message.includes('sk-leak'));
      return true;
    });
  } finally {
    rmSync(join(stubDir, 'revoked'));
  }
});

test('tool summaries, mail titles and block summaries through another provider book to <provider>-system', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const orBefore = usage('openrouter-system')?.tokens_in ?? 0;
  const myBefore = usage('myoai-system')?.tokens_in ?? 0;
  const seen = [];
  const booked = () => events('decide').filter((e) => e.provider === 'myoai').length;

  settings.patchSettings({ tiny: { toolSummary: { enabled: true, model: 'myoai:gpt-6-luna' } } });
  const call = { id: 'c1', name: 'Bash', input: { command: 'echo TOOLSUM=' + encodeURIComponent('{"tool":"run","doing":"echoing"}') } };
  await ts.toolSummaries('ag-tiny', [call], 5000);
  await until(() => booked() >= 1, 'the tool summary spend');
  seen.push('tool-summary');

  settings.patchSettings({ mail: { titles: { model: 'myoai:gpt-6-luna' } } });
  for (const [id, name] of [['t1', 'alice'], ['t2', 'bob']]) db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  const m = await mail.sendMail({ from: 't1', to: ['bob'], subject: 'Tiny spend', body: 'TITLE=Spend_title', new_thread: true });
  await until(() => db.getMail(m.id)?.title, 'the mail title');
  seen.push('mail-title');

  settings.patchSettings({ instructions: { summaries: { model: 'myoai:gpt-6-luna' } } });
  const text = 'Block text for the tiny spend test';
  const h = summaries.textHash(text);
  summaries.summaryFor(h, text);
  await until(() => db.getBlockSummary(h), 'the block summary');
  seen.push('block-summary');

  assert.deepEqual(seen, ['tool-summary', 'mail-title', 'block-summary']);
  for (const purpose of ['tool-summary', 'mail-title', 'block-summary']) {
    const ev = events('decide').filter((e) => e.purpose === purpose && e.provider === 'myoai');
    assert.equal(ev.length, 1, purpose);
    assert.equal(ev[0].account, 'myoai-system');
    assert.ok(ev[0].cost > 0, `${purpose} is priced`);
    assert.match(ev[0].model, /^myoai:/);
  }
  assert.equal(usage('openrouter-system')?.tokens_in ?? 0, orBefore);
  assert.ok(usage('myoai-system').tokens_in > myBefore);
  assert.equal(usage('myoai-system').harness, 'myoai');
  assert.ok(day);
});

test('a spent <provider>-system budget skips the call for every step', async () => {
  const day = new Date().toISOString().slice(0, 10);
  settings.patchSettings({ cost: { accounts: { 'myoai-system': { provider: 'myoai', match: { harness: 'myoai' }, budget: { usd: 0.0001, per: 'day' } } } } });
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('held-seed', ?, 'myoai', 'x', 'myoai-system', 1)").run(day);
  try {
    const before = calls();
    const call = { id: 'held1', name: 'Bash', input: { command: 'echo TOOLSUM=' + encodeURIComponent('{"tool":"run","doing":"held"}') } };
    assert.deepEqual(await ts.toolSummaries('ag-held', [call], 300), { enabled: true, summaries: {}, pending: [] });
    const m = await mail.sendMail({ from: 't1', to: ['bob'], subject: 'Held tiny spend', body: 'TITLE=Never_asked', new_thread: true });
    await until(() => events('mail-title:skipped').some((e) => e.id === m.id && /myoai-system/.test(e.reason)), 'the mail title skip');
    const text = 'Held block text for the tiny spend test';
    summaries.summaryFor(summaries.textHash(text), text);
    await until(() => summaries.summaryFor(summaries.textHash(text), text).state === 'failed', 'the block to fail');
    assert.equal(calls(), before, 'no call reached the stub');
  } finally {
    db.open().prepare("DELETE FROM usage WHERE agent_id = 'held-seed'").run();
    settings.patchSettings({ cost: { accounts: { 'myoai-system': null } } });
  }
});

test('decide through another provider books to <provider>-system, and leaves openrouter-system and its pending bill alone', async () => {
  settings.patchSettings({ decisions: { model: 'myoai:no-such-model' } });
  const pending = () => db.open().prepare('SELECT exact_pending FROM ledger_recon WHERE id = 1').get()?.exact_pending ?? 0;
  const orBefore = usage('openrouter-system')?.cost_usd ?? 0;
  const pendingBefore = pending();
  const myBefore = usage('myoai-system')?.cost_usd ?? 0;
  const decide = await import('../src/decide.ts');
  const r = await decide.decide('state P=0.7', { yes: { type: 'noul', instructions: 'Is it yes?' } }, { purpose: 'decide:tiny-spend' });
  assert.equal(r.answers.yes.noul, 0.7);
  assert.ok(usage('myoai-system').cost_usd > myBefore, 'booked to myoai-system');
  assert.equal(usage('openrouter-system')?.cost_usd ?? 0, orBefore);
  assert.equal(pending(), pendingBefore);
  // The provider's own budget holds the decide call, not the OpenRouter system one.
  const day = new Date().toISOString().slice(0, 10);
  settings.patchSettings({ cost: { accounts: { 'myoai-system': { provider: 'myoai', match: { harness: 'myoai' }, budget: { usd: 0.0001, per: 'day' } } } } });
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('held-seed2', ?, 'myoai', 'x', 'myoai-system', 1)").run(day);
  try {
    const before = calls();
    const held = await decide.decideWithFailure('state P=0.7', { yes: { type: 'noul', instructions: 'Is it yes?' } }, { purpose: 'decide:tiny-spend' });
    assert.equal(held.result, null);
    assert.match(held.failure.error, /myoai-system/);
    assert.equal(calls(), before);
  } finally {
    db.open().prepare("DELETE FROM usage WHERE agent_id = 'held-seed2'").run();
    settings.patchSettings({ cost: { accounts: { 'myoai-system': null } } });
  }
});

test('a keyless local server books $0 for an uncatalogued model, with no unpriced event; a keyed one logs once per model', async () => {
  const before = events('llm:unpriced').length;
  const a = await ask('local:llama-local');
  assert.equal(a.costUsd, 0);
  assert.equal(a.priced, 'free');
  assert.equal(events('llm:unpriced').length, before);
  // A catalogued model on a keyless server still prices from the catalogue.
  assert.ok((await ask('local:gpt-6-luna')).costUsd > 0);
  // Keyed: the fallback, logged once for the model however many calls.
  await ask('myoai:logged-once');
  await ask('myoai:logged-once');
  assert.equal(events('llm:unpriced').filter((e) => e.model === 'logged-once').length, 1);
});
