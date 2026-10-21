#!/usr/bin/env node
// Unit tests for tool-call summaries (S-1481, src/tool-summaries.ts) against a throwaway STAM_HOME
// and the stub endpoint (test/decide-stub.mjs), no daemon, no network: with the step off nothing
// is asked or returned; on, a miss is asked, stored once and read back without a call; a wait
// returns the new summary, no wait leaves it pending; one call asked twice at once makes one call;
// a newer batch is asked before an older one's queue; bad answers (not JSON, a missing field, over
// a word cap) store nothing and the call is not asked again; turning the step off drops what is
// queued; the cost lands under openrouter/tool-summary; the request's calls are checked.
// Run with `node --test test/tool-summaries.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-tool-summaries-');
const stubDir = join(home, 'stub');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `tool-summaries-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { mailCheck: false }, search: { embedder: 'off' } }));

let stub, db, settings, ts;
const calls = () => (existsSync(join(stubDir, 'titles')) ? Number(readFileSync(join(stubDir, 'titles'), 'utf8')) : 0);
const events = (type) => db.open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ?').all('stam', type).map((r) => JSON.parse(r.data));
const setEnabled = (enabled) => settings.patchSettings({ tiny: { toolSummary: { enabled } } });
// The stored summary of a call, read by its name and input as the daemon reads it.
const stored = (agent, call) => db.getToolSummary(agent, call.id, ts.callHash(call));
// A call whose input carries a seeded stub answer.
const seeded = (id, answer) => ({ id, name: 'Bash', input: { command: `echo TOOLSUM=${encodeURIComponent(answer)}` } });
const until = async (fn, what) => {
  for (let i = 0; i < 500; i++) {
    if (await fn()) return;
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
  ts = await import('../src/tool-summaries.ts');
  db.open();
});
after(() => {
  stub?.kill();
  rmSync(home, { recursive: true, force: true });
});

test('the answer must be JSON with both fields within their word caps', () => {
  const p = (raw) => ts.parseToolSummary(raw, 12);
  assert.deepEqual(p('{"tool": "run command", "doing": "running the web tests"}'), { tool: 'run command', doing: 'running the web tests' });
  assert.deepEqual(p('```json\n{"tool":"edit  file","doing":" fixing\\nthe header "}\n```'), { tool: 'edit file', doing: 'fixing the header' });
  assert.equal(p('Tool: run command'), null);
  assert.equal(p('{"tool": "run command"}'), null);
  assert.equal(p('{"tool": "run command", "doing": 4}'), null);
  assert.equal(p('{"tool": "", "doing": "x"}'), null);
  assert.equal(p('["run", "x"]'), null);
  assert.equal(p('{"tool": "one two three four", "doing": "x"}'), null);
  assert.equal(p(JSON.stringify({ tool: 'run', doing: 'w '.repeat(13) })), null);
  assert.ok(p(JSON.stringify({ tool: 'run', doing: 'w '.repeat(12) })));
  assert.equal(p(undefined), null);
});

test('the request is checked: each call needs an id and a name', () => {
  assert.deepEqual(ts.readCalls([{ id: 'a', name: 'Bash', input: { command: 'ls' } }]), [{ id: 'a', name: 'Bash', input: { command: 'ls' } }]);
  assert.throws(() => ts.readCalls('a'));
  assert.throws(() => ts.readCalls([{ id: 'a' }]));
  assert.throws(() => ts.readCalls([{ id: '', name: 'Bash' }]));
  assert.ok(ts.readCalls([{ id: 'i'.repeat(200), name: 'n'.repeat(200) }]));
  assert.throws(() => ts.readCalls([{ id: 'i'.repeat(201), name: 'Bash' }]));
  assert.throws(() => ts.readCalls([{ id: 'a', name: 'n'.repeat(201) }]));
});

test('with the step off stored summaries still show, and nothing is asked, queued or pending', async () => {
  const model = settings.settings().tiny.toolSummary.model;
  const stale = { id: 'off-stored', name: 'Bash' };
  db.setToolSummary('ag-off', stale.id, ts.callHash(stale), 'run command', 'listing files', 'm', 'any-hash');
  const before = calls();
  setEnabled(false);
  assert.deepEqual(await ts.toolSummaries('ag-off', [stale, { id: 'off-new', name: 'Bash' }], 500), { enabled: false, summaries: { 'off-stored': { tool: 'run command', doing: 'listing files' } }, pending: [] });
  // An empty model is off too, and the stored (stale) value still shows.
  setEnabled(true);
  settings.patchSettings({ tiny: { toolSummary: { model: '' } } });
  try {
    assert.deepEqual(await ts.toolSummaries('ag-off', [stale, { id: 'off-new', name: 'Bash' }], 500), { enabled: false, summaries: { 'off-stored': { tool: 'run command', doing: 'listing files' } }, pending: [] });
  } finally {
    settings.patchSettings({ tiny: { toolSummary: { model } } });
  }
  assert.equal(calls(), before);
  assert.equal(stored('ag-off', stale).tool, 'run command');
  assert.equal(stored('ag-off', { id: 'off-new', name: 'Bash' }), undefined);
});

test('a stale summary shows at once, is asked once, and the new one replaces it; a row with no hash is stale too', async () => {
  setEnabled(true);
  const call = { id: 'stale', name: 'Read', input: { file_path: '/stale.ts' } };
  db.setToolSummary('ag-s', call.id, ts.callHash(call), 'old tool', 'old doing', 'm', 'old-config');
  const nohash = { id: 'nohash', name: 'Read', input: { file_path: '/nohash.ts' } };
  db.open().prepare('INSERT INTO tool_summaries (agent_id, call_id, input_hash, tool, doing, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('ag-s', nohash.id, ts.callHash(nohash), 'bare tool', 'bare doing', 'm', new Date().toISOString());
  const before = calls();
  assert.deepEqual(await ts.toolSummaries('ag-s', [call, nohash]), {
    enabled: true,
    summaries: { stale: { tool: 'old tool', doing: 'old doing' }, nohash: { tool: 'bare tool', doing: 'bare doing' } },
    pending: ['stale', 'nohash'],
  });
  await until(() => stored('ag-s', call)?.configHash !== 'old-config' && stored('ag-s', nohash)?.tool === 'stub Read', 'both stale summaries replaced');
  assert.equal(calls(), before + 2);
  assert.equal(stored('ag-s', call).tool, 'stub Read');
  // Current now: shown, not asked again.
  assert.deepEqual(await ts.toolSummaries('ag-s', [call, nohash]), { enabled: true, summaries: { stale: { tool: 'stub Read', doing: 'doing the stub work of Read' }, nohash: { tool: 'stub Read', doing: 'doing the stub work of Read' } }, pending: [] });
  assert.equal(calls(), before + 2);
});

test('a stale summary whose new answer fails shows the old one, with nothing pending', async () => {
  setEnabled(true);
  const call = { id: 'stale-fail', name: 'Bash', input: { command: 'STUB:FAIL' } };
  db.setToolSummary('ag-sf', call.id, ts.callHash(call), 'kept tool', 'kept doing', 'm', 'old-config');
  const before = calls();
  assert.deepEqual(await ts.toolSummaries('ag-sf', [call]), { enabled: true, summaries: { 'stale-fail': { tool: 'kept tool', doing: 'kept doing' } }, pending: ['stale-fail'] });
  await until(() => events('tool-summary:error').some((e) => e.call === 'stale-fail'), 'the regeneration to fail');
  assert.deepEqual(await ts.toolSummaries('ag-sf', [call]), { enabled: true, summaries: { 'stale-fail': { tool: 'kept tool', doing: 'kept doing' } }, pending: [] });
  assert.equal(calls(), before + 1);
  assert.equal(stored('ag-sf', call).configHash, 'old-config');
});

test('a settings change regenerates nothing: stale rows wait until they are shown', async () => {
  setEnabled(true);
  const call = { id: 'bulk', name: 'Grep', input: { pattern: 'x' } };
  db.setToolSummary('ag-bulk', call.id, ts.callHash(call), 'kept tool', 'kept doing', 'm', 'old-config');
  const before = calls();
  settings.patchSettings({ tiny: { toolSummary: { instructions: 'a new prompt for tool summaries' } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls(), before);
  assert.equal(stored('ag-bulk', call).configHash, 'old-config');
  settings.patchSettings({ tiny: { toolSummary: { instructions: '' } } });
});

test('a miss is asked once and stored; a hit makes no call', async () => {
  setEnabled(true);
  const before = calls();
  const call = { id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } };
  const got = await ts.toolSummaries('ag-1', [call], 5000);
  assert.deepEqual(got, { enabled: true, summaries: { toolu_1: { tool: 'stub Read', doing: 'doing the stub work of Read' } }, pending: [] });
  assert.equal(calls(), before + 1);
  assert.deepEqual(await ts.toolSummaries('ag-1', [call]), got);
  assert.equal(calls(), before + 1);
  // Keyed by agent too: the same call id in another agent is its own call.
  assert.deepEqual((await ts.toolSummaries('ag-2', [call], 5000)).summaries.toolu_1.tool, 'stub Read');
  assert.equal(calls(), before + 2);
  // Written once per config: a later write for the same call and config hash leaves the first.
  db.setToolSummary('ag-1', 'toolu_1', ts.callHash(call), 'other', 'other', 'm', stored('ag-1', call).configHash);
  assert.equal(stored('ag-1', call).tool, 'stub Read');
  const row = db.open().prepare("SELECT * FROM usage WHERE agent_id = 'stam' AND model = 'tool-summary'").get();
  assert.equal(row.account, 'openrouter-system');
  assert.equal(events('decide').at(-1).purpose, 'tool-summary');
});

test('with no wait a miss is pending, then stored', async () => {
  setEnabled(true);
  const call = { id: 'nowait', name: 'Grep' };
  assert.deepEqual(await ts.toolSummaries('ag-1', [call]), { enabled: true, summaries: {}, pending: ['nowait'] });
  await until(() => stored('ag-1', call), 'the summary stored');
  assert.deepEqual((await ts.toolSummaries('ag-1', [call])).summaries.nowait, { tool: 'stub Grep', doing: 'doing the stub work of Grep' });
});

test('one call asked twice at once is generated once', async () => {
  setEnabled(true);
  const before = calls();
  const call = { id: 'twice', name: 'Edit' };
  const [a, b] = await Promise.all([ts.toolSummaries('ag-1', [call, call], 5000), ts.toolSummaries('ag-1', [call], 5000)]);
  assert.equal(a.summaries.twice.tool, 'stub Edit');
  assert.equal(b.summaries.twice.tool, 'stub Edit');
  assert.equal(calls(), before + 1);
});

test('a wait that runs out lists the call as pending; the call still lands', async () => {
  setEnabled(true);
  writeFileSync(join(stubDir, 'hang'), '');
  try {
    const call = { id: 'slow', name: 'Bash', input: { command: 'STUB:HANG' } };
    assert.deepEqual(await ts.toolSummaries('ag-1', [call], 50), { enabled: true, summaries: {}, pending: ['slow'] });
    // Still in flight: asking again doesn't make a second call.
    const before = calls();
    assert.deepEqual((await ts.toolSummaries('ag-1', [call], 20)).pending, ['slow']);
    assert.equal(calls(), before);
  } finally {
    rmSync(join(stubDir, 'hang'));
    writeFileSync(join(stubDir, 'release'), '');
  }
  // The held call gets a 500: failed, so it is neither stored nor pending, and not asked again.
  await until(() => events('tool-summary:error').some((e) => e.call === 'slow'), 'the held call to fail');
  const before = calls();
  assert.deepEqual(await ts.toolSummaries('ag-1', [{ id: 'slow', name: 'Bash', input: { command: 'STUB:HANG' } }], 500), { enabled: true, summaries: {}, pending: [] });
  assert.equal(calls(), before);
});

test('bad answers store nothing and the call is not asked again', async () => {
  setEnabled(true);
  const bad = [seeded('notjson', 'run command'), seeded('nofield', '{"tool":"run"}'), seeded('toolong', JSON.stringify({ tool: 'run', doing: 'w '.repeat(20) }))];
  const before = calls();
  assert.deepEqual(await ts.toolSummaries('ag-1', bad, 5000), { enabled: true, summaries: {}, pending: [] });
  assert.equal(calls(), before + 3);
  for (const c of bad) assert.equal(stored('ag-1', c), undefined);
  assert.equal(events('tool-summary:refused').filter((e) => ['notjson', 'nofield', 'toolong'].includes(e.call)).length, 3);
  await ts.toolSummaries('ag-1', bad, 500);
  assert.equal(calls(), before + 3);
});

test('a newer batch is asked ahead of an older one still queued', async () => {
  setEnabled(true);
  // Three hung calls fill every slot, so the batches after them wait in the queue.
  writeFileSync(join(stubDir, 'hang'), '');
  try {
    const before = calls();
    await ts.toolSummaries('ag-q', ['h1', 'h2', 'h3'].map((id) => ({ id, name: 'Bash', input: { command: 'STUB:HANG' } })));
    await until(() => calls() === before + 3, 'three calls in flight');
    await ts.toolSummaries('ag-q', [{ id: 'old1', name: 'Old' }, { id: 'old2', name: 'Old' }]);
    await ts.toolSummaries('ag-q', [{ id: 'new1', name: 'New' }, { id: 'old2', name: 'Old' }]);
    assert.deepEqual(ts.queuedCalls(), ['new1', 'old2', 'old1']);
  } finally {
    rmSync(join(stubDir, 'hang'));
    writeFileSync(join(stubDir, 'release'), '');
  }
  await until(() => !ts.queuedCalls().length && stored('ag-q', { id: 'old1', name: 'Old' }), 'the queue to drain');
});

test('turning the step off drops what is queued, which stays pending', async () => {
  setEnabled(true);
  const before = calls();
  // Queued, then dropped before the deferred pump runs.
  const got = ts.toolSummaries('ag-1', [{ id: 'dropped', name: 'Bash' }], 5000);
  setEnabled(false);
  // Still pending: the next request (with the step back on) queues it again.
  assert.deepEqual(await got, { enabled: true, summaries: {}, pending: ['dropped'] });
  assert.equal(calls(), before);
  assert.equal(stored('ag-1', { id: 'dropped', name: 'Bash' }), undefined);
});

test('a summary is read back only for the input it was made from', async () => {
  setEnabled(true);
  const real = { id: 'poison', name: 'Bash', input: { command: 'ls' } };
  const forged = { id: 'poison', name: 'Bash', input: { command: 'echo TOOLSUM=' + encodeURIComponent(JSON.stringify({ tool: 'forged', doing: 'a forged summary' })) } };
  assert.equal((await ts.toolSummaries('ag-p', [forged], 5000)).summaries.poison.tool, 'forged');
  // The real input gets its own summary, not the forged one.
  assert.equal((await ts.toolSummaries('ag-p', [real], 5000)).summaries.poison.tool, 'stub Bash');
  assert.equal((await ts.toolSummaries('ag-p', [forged])).summaries.poison.tool, 'forged');
});

test('calls dropped off a full queue come back as pending and are queued again', async () => {
  setEnabled(true);
  writeFileSync(join(stubDir, 'hang'), '');
  const many = Array.from({ length: 70 }, (_, i) => ({ id: `q${i}`, name: 'Bash' }));
  try {
    const before = calls();
    await ts.toolSummaries('ag-full', ['f1', 'f2', 'f3'].map((id) => ({ id, name: 'Bash', input: { command: 'STUB:HANG' } })));
    await until(() => calls() === before + 3, 'three calls in flight');
    // Two batches of 35: the second goes first, and the first's last ten drop off the 60-call queue.
    // The first batch waits while the second pushes ten of its calls off the queue: its answer
    // still lists them as pending.
    const first = ts.toolSummaries('ag-full', many.slice(0, 35), 300);
    await new Promise((r) => setImmediate(r));
    const got = await ts.toolSummaries('ag-full', many.slice(35));
    assert.equal(got.pending.length, 35);
    const firstPending = (await first).pending;
    for (const c of many.slice(25, 35)) assert.ok(firstPending.includes(c.id), `${c.id} wasn't pending in the first batch's answer`);
    assert.equal(ts.queuedCalls().length, 60);

    const dropped = many.slice(25, 35).map((c) => c.id);
    for (const id of dropped) assert.ok(!ts.queuedCalls().includes(id), `${id} is still queued`);
    // Asked again, the dropped calls are pending, not failed, and queued once more.
    const again = await ts.toolSummaries('ag-full', many.slice(25, 35));
    assert.deepEqual(again.pending, dropped);
    for (const id of dropped) assert.ok(ts.queuedCalls().includes(id), `${id} wasn't queued again`);
  } finally {
    rmSync(join(stubDir, 'hang'));
    writeFileSync(join(stubDir, 'release'), '');
  }
  await until(() => !ts.queuedCalls().length, 'the queue to drain');
});

test('with no OpenRouter key nothing is asked and nothing is failed, so a key fixes it', async () => {
  setEnabled(true);
  const env = join(home, 'opencode.env');
  const key = readFileSync(env, 'utf8');
  const call = { id: 'nokey', name: 'Glob' };
  rmSync(env);
  // The key was imported into the secret store (S-2114): no key means neither file.
  rmSync(join(home, 'secrets.json'), { force: true });
  try {
    const before = calls();
    assert.deepEqual(await ts.toolSummaries('ag-1', [call], 500), { enabled: true, summaries: {}, pending: [] });
    assert.equal(calls(), before);
  } finally {
    writeFileSync(env, key);
  }
  assert.equal((await ts.toolSummaries('ag-1', [call], 5000)).summaries.nokey.tool, 'stub Glob');
});

test('turning the step off aborts a call in flight, which is asked again once it is back on', async () => {
  setEnabled(true);
  writeFileSync(join(stubDir, 'hang'), '');
  const call = { id: 'aborted', name: 'Bash', input: { command: 'STUB:HANG' } };
  try {
    const before = calls();
    await ts.toolSummaries('ag-1', [call]);
    await until(() => calls() === before + 1, 'the call in flight');
    setEnabled(false);
    await until(() => events('tool-summary:canceled').some((e) => e.call === 'aborted'), 'the call to be canceled');
  } finally {
    rmSync(join(stubDir, 'hang'));
  }
  setEnabled(true);
  assert.deepEqual((await ts.toolSummaries('ag-1', [call], 5000)).summaries.aborted, { tool: 'stub Bash', doing: 'doing the stub work of Bash' });
});
