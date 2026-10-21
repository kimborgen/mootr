#!/usr/bin/env node
// Unit tests for block summaries (S-878, src/block-summaries.ts) against a throwaway STAM_HOME and
// the stub endpoint (test/decide-stub.mjs), no daemon, no network: with no model set nothing is
// asked and every block is 'off'; with one, a miss is queued as 'pending' and a later call reads
// the cached 'auto' summary while the hit makes no call; the same text is queued once; a batch
// asks each distinct block once; the answer is cleaned and capped; a failed call is 'failed' with
// nothing cached, so a restart tries again; turning the model off drops a block queued before its
// call starts; the cost lands under openrouter/block-summary; the setting round-trips; a change of
// prompt or model asks a cached block again (S-1684), and a stored summary still shows with the model off.
// Run with `node --test test/block-summaries.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-block-summaries-');
const stubDir = join(home, 'stub');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `block-summaries-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
// No search index: the embedder would install a model.
writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { mailCheck: false }, search: { embedder: 'off' } }));

let stub, db, settings, summaries;
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
// The stub's chat counter, shared by every POST /chat/completions.
const calls = () => (existsSync(join(stubDir, 'titles')) ? Number(readFileSync(join(stubDir, 'titles'), 'utf8')) : 0);
const events = (type) => db.open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ?').all('stam', type).map((r) => JSON.parse(r.data));
const setModel = (model) => settings.patchSettings({ instructions: { summaries: { model } } });
// Waits for the block's call to settle: a cached summary, or an error event naming its hash.
async function settled(h) {
  for (let i = 0; i < 500; i++) {
    if (db.getBlockSummary(h) || events('block-summary:error').some((e) => e.hash === h)) return summaries.summaryFor(h, '');
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no summary or error for ${h}`);
}
const until = async (fn, what) => {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

before(async () => {
  stub = spawn(process.execPath, [join(import.meta.dirname, 'decide-stub.mjs'), stubDir], { stdio: 'ignore' });
  process.on('exit', () => stub.kill());
  for (let i = 0; !existsSync(join(stubDir, 'url')); i++) {
    if (i > 500) throw new Error('the stub did not start');
    await new Promise((r) => setTimeout(r, 10));
  }
  process.env.STAM_OPENROUTER_URL = readFileSync(join(stubDir, 'url'), 'utf8');
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  summaries = await import('../src/block-summaries.ts');
  db.open();
});
after(() => {
  stub?.kill();
  rmSync(home, { recursive: true, force: true });
});

test('the answer is cleaned and capped at 200 characters', () => {
  assert.equal(summaries.cleanSummary('**Summary: Tell the agent to keep commits small.**'), 'Tell the agent to keep commits small.');
  assert.equal(summaries.cleanSummary('Summary: One line\nand a second'), 'One line and a second');
  assert.equal(summaries.cleanSummary('`ask the parent first`'), 'ask the parent first');
  assert.equal(summaries.cleanSummary('x'.repeat(300)).length, 200);
  assert.equal(summaries.cleanSummary('  \n '), null);
  assert.equal(summaries.cleanSummary(undefined), null);
});

test('the setting round-trips and is off by default', () => {
  assert.equal(settings.settings().instructions.summaries.model, '');
  setModel('google/gemma-3-4b-it');
  assert.equal(settings.settings().instructions.summaries.model, 'google/gemma-3-4b-it');
  setModel('');
  assert.equal(settings.settings().instructions.summaries.model, '');
});

test('with no model set nothing is asked and every block is off', () => {
  setModel('');
  const before = calls();
  const text = 'TITLE=Never_asked';
  assert.deepEqual(summaries.summaryFor(hash(text), text), { state: 'off' });
  assert.deepEqual(summaries.summariesFor([{ hash: hash(text), text }]), { [hash(text)]: { state: 'off' } });
  assert.equal(calls(), before);
});

test('a miss is pending, then a cached auto summary; a hit makes no call', async () => {
  setModel('google/gemma-3-4b-it');
  const text = 'Keep commits small and logical.\nTITLE=Small_logical_commits';
  const h = hash(text);
  const before = calls();
  assert.deepEqual(summaries.summaryFor(h, text, 'Commits'), { state: 'pending' });
  const got = await settled(h);
  assert.equal(got.state, 'auto');
  assert.equal(got.summary, 'Small logical commits');
  assert.equal(calls(), before + 1);
  // The hit reads the cache: no second call.
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'auto', summary: 'Small logical commits' });
  assert.equal(calls(), before + 1);
  // The cost is recorded under openrouter/block-summary, like a mail title.
  const row = db.open().prepare("SELECT * FROM usage WHERE agent_id = 'stam' AND model = 'block-summary'").get();
  assert.equal(row.account, 'openrouter-system');
  assert.equal(row.tokens_in, 30);
  assert.equal(row.tokens_out, 4);
  assert.deepEqual(events('decide').at(-1), { purpose: 'block-summary', model: 'google/gemma-3-4b-it-stub', cost: 0.000002, tokens_in: 30, tokens_out: 4 });
  // A stored summary stays readable when the model is turned off, like a stored mail title.
  setModel('');
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'auto', summary: 'Small logical commits' });
  setModel('google/gemma-3-4b-it');
});

test('a spent system budget fails the block without a call', async () => {
  setModel('google/gemma-3-4b-it');
  const day = new Date().toISOString().slice(0, 10);
  settings.patchSettings({ cost: { accounts: { 'openrouter-system': { match: { harness: 'stam' }, budget: { usd: 0.5, per: 'day' } } } } });
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('held-seed', ?, 'openrouter', 'x', 'openrouter-system', 1)").run(day);
  try {
    const text = 'Held by the system budget.\nTITLE=Held_block';
    const h = hash(text);
    const before = calls();
    summaries.summaryFor(h, text);
    await until(() => summaries.summaryFor(h, text).state === 'failed', 'the block to fail');
    assert.equal(calls(), before);
  } finally {
    db.open().prepare("DELETE FROM usage WHERE agent_id = 'held-seed'").run();
    settings.patchSettings({ cost: { accounts: { 'openrouter-system': null } } });
  }
});

test('the same text queued twice makes one call', async () => {
  setModel('google/gemma-3-4b-it');
  const text = 'Prefer the smallest change that works.\nTITLE=Smallest_change';
  const h = hash(text);
  const before = calls();
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'pending' });
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'pending' });
  assert.equal((await settled(h)).summary, 'Smallest change');
  assert.equal(calls(), before + 1);
});

test('a batch asks each distinct block once', async () => {
  setModel('google/gemma-3-4b-it');
  const a = 'Read the docs first.\nTITLE=Read_the_docs';
  const b = 'Mail your parent when done.\nTITLE=Mail_your_parent';
  const before = calls();
  const got = summaries.summariesFor([
    { hash: hash(a), text: a, title: 'Docs' },
    { hash: hash(b), text: b },
    { hash: hash(a), text: a, title: 'Docs' },
  ]);
  assert.deepEqual(got, { [hash(a)]: { state: 'pending' }, [hash(b)]: { state: 'pending' } });
  await until(() => db.getBlockSummary(hash(a)) && db.getBlockSummary(hash(b)), 'both blocks cached');
  assert.equal(calls(), before + 2);
  assert.equal(summaries.summariesFor([{ hash: hash(a), text: a }, { hash: hash(b), text: b }])[hash(a)].summary, 'Read the docs');
});

test('a failed call is failed with nothing cached, so a restart tries again', async () => {
  setModel('google/gemma-3-4b-it');
  const text = 'This one breaks.\nSTUB:FAIL';
  const h = hash(text);
  const before = calls();
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'pending' });
  assert.deepEqual(await settled(h), { state: 'failed' });
  assert.equal(calls(), before + 1);
  assert.equal(db.getBlockSummary(h), undefined);
  assert.equal(events('block-summary:error').at(-1).hash, h);
});

test('a model with no OpenRouter key fails the block instead of leaving it pending', async () => {
  setModel('google/gemma-3-4b-it');
  const env = join(home, 'opencode.env');
  const key = readFileSync(env, 'utf8');
  rmSync(env);
  // The key was imported into the secret store (S-2114): no key means neither file.
  rmSync(join(home, 'secrets.json'), { force: true });
  try {
    const text = 'Nobody can ask about this.';
    const h = hash(text);
    const before = calls();
    assert.deepEqual(summaries.summaryFor(h, text), { state: 'pending' });
    await until(() => summaries.summaryFor(h, text).state === 'failed', 'a failed block');
    assert.equal(calls(), before);
    assert.equal(db.getBlockSummary(h), undefined);
  } finally {
    writeFileSync(env, key);
  }
});

test('turning the model off drops a block queued before its call starts', async () => {
  setModel('');
  const text = 'TITLE=Dropped_block';
  const h = hash(text);
  setModel('google/gemma-3-4b-it');
  const before = calls();
  // Queued, then dropped all before the deferred pump runs.
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'pending' });
  setModel('');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls(), before);
  assert.equal(db.getBlockSummary(h), undefined);
});

test('a prompt or model change asks a cached block again, and the same pair is a hit (S-1684)', async () => {
  const lastSystem = () => readFileSync(join(stubDir, 'last-system'), 'utf8');
  settings.patchSettings({ tiny: { blockSummaries: { instructions: '' } } });
  setModel('google/gemma-3-4b-it');
  const text = 'Ask again when the prompt changes.\nTITLE=Asked_again';
  const h = hash(text);
  const before = calls();
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'pending' });
  await until(() => summaries.summaryFor(h, text).state === 'auto', 'the first summary');
  assert.equal(calls(), before + 1);
  // A new prompt: the stored summary is a miss, so the block is queued and asked once more.
  settings.patchSettings({ tiny: { blockSummaries: { instructions: 'Summarise in Swedish.' } } });
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'pending' });
  await until(() => summaries.summaryFor(h, text).state === 'auto', 'the summary under the new prompt');
  assert.equal(calls(), before + 2);
  assert.equal(lastSystem(), 'Summarise in Swedish.');
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'auto', summary: 'Asked again' });
  assert.equal(calls(), before + 2);
  // A new model: asked again under that model too.
  setModel('other/model');
  assert.deepEqual(summaries.summaryFor(h, text), { state: 'pending' });
  await until(() => summaries.summaryFor(h, text).state === 'auto', 'the summary under the new model');
  assert.equal(calls(), before + 3);
  settings.patchSettings({ tiny: { blockSummaries: { instructions: '' } } });
  setModel('google/gemma-3-4b-it');
});

test('an instructions override reaches the model prompt, and empty falls back to the shipped one (S-1579)', async () => {
  const lastSystem = () => readFileSync(join(stubDir, 'last-system'), 'utf8');
  setModel('google/gemma-3-4b-it');
  try {
    assert.equal(summaries.summaryPrompt(), summaries.SUMMARY_PROMPT);
    settings.patchSettings({ tiny: { blockSummaries: { instructions: 'Summarise in Swedish.' } } });
    const a = 'Override me.\nTITLE=Overridden';
    await settled((summaries.summaryFor(hash(a), a), hash(a)));
    assert.equal(lastSystem(), 'Summarise in Swedish.');
    settings.patchSettings({ tiny: { blockSummaries: { instructions: '   ' } } });
    const b = 'Default me.\nTITLE=Defaulted';
    await settled((summaries.summaryFor(hash(b), b), hash(b)));
    assert.equal(lastSystem(), summaries.SUMMARY_PROMPT);
  } finally {
    settings.patchSettings({ tiny: { blockSummaries: { instructions: '' } } });
    setModel('');
  }
});
