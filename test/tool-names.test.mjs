#!/usr/bin/env node
// Unit tests for tool names (S-1933, src/tool-names.ts, src/tool-name-labels.ts) against a throwaway
// STAM_HOME and the stub endpoint (test/decide-stub.mjs), no daemon, no network: seeded labels need no
// model; a missing label is asked once per (harness, tool), stored and read back by every agent of the
// harness; a tool in flight is busy, so a second request makes no second call; every kind of reply
// (good, JSON without a label, empty, not JSON, too long) ends in a stored label or a failure that is
// not asked again; with the step off, no key or a spent system budget nothing is asked and nothing fails;
// nothing is asked in bulk, and a settings change regenerates nothing; an MCP tool is named by its
// tool part. Run with `node --test test/tool-names.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-tool-names-');
const stubDir = join(home, 'stub');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `tool-names-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { mailCheck: false }, search: { embedder: 'off' } }));

let stub, db, settings, tn, labels;
const calls = () => (existsSync(join(stubDir, 'titles')) ? Number(readFileSync(join(stubDir, 'titles'), 'utf8')) : 0);
const events = (type) => db.open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ?').all('stam', type).map((r) => JSON.parse(r.data));
// The step is off with its toggle; a model can't be empty, it falls back to the default.
const setOn = (enabled) => settings.patchSettings({ tiny: { toolNames: { enabled } } });
const setModel = (model) => settings.patchSettings({ tiny: { toolNames: { model } } });
const MODEL = 'google/gemma-3-4b-it';
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
  tn = await import('../src/tool-names.ts');
  labels = await import('../src/tool-name-labels.ts');
  db.open();
});
after(() => {
  stub?.kill();
  rmSync(home, { recursive: true, force: true });
});

test('an MCP name splits into server and tool; a raw name is prettified; Bash stays Bash', () => {
  assert.deepEqual(labels.splitTool('mcp__stam__send_mail'), { server: 'stam', tool: 'send_mail' });
  assert.deepEqual(labels.splitTool('mcp__claude_ai_Gmail__authenticate'), { server: 'claude_ai_Gmail', tool: 'authenticate' });
  assert.deepEqual(labels.splitTool('Bash'), { tool: 'Bash' });
  assert.equal(labels.toolTitle('mcp__stam__send_mail'), 'stam · Send mail');
  assert.equal(labels.toolTitle('mcp__stam__send_mail', 'Mail an agent'), 'stam · Mail an agent');
  assert.equal(labels.toolTitle('Bash'), 'Bash');
  // Codex names an MCP tool server.tool (src/adapters/codex-view.ts), read so only for codex; its built-ins have no dot.
  assert.deepEqual(labels.splitTool('stam.send_mail', 'codex'), { server: 'stam', tool: 'send_mail' });
  assert.deepEqual(labels.splitTool('github.create_issue', 'codex'), { server: 'github', tool: 'create_issue' });
  assert.deepEqual(labels.splitTool('mcp__stam__send_mail', 'codex'), { server: 'stam', tool: 'send_mail' });
  assert.deepEqual(labels.splitTool('exec_command', 'codex'), { tool: 'exec_command' });
  assert.deepEqual(labels.splitTool('stam.send_mail', 'claude'), { tool: 'stam.send_mail' });
  assert.equal(labels.toolTitle('stam.send_mail', undefined, 'codex'), 'stam · Send mail');
  assert.equal(labels.toolTitle('github.create_issue', 'Create issue', 'codex'), 'github · Create issue');
  assert.equal(labels.toolTitle('WebSearch'), 'Web search');
  assert.equal(labels.toolTitle('exec_command'), 'Exec command');
  assert.equal(labels.toolTitle('x', 'Shown'), 'Shown');
});

test('the answer must be JSON with a label of at most three words', () => {
  assert.equal(tn.parseToolLabel('{"label": "Send mail"}'), 'Send mail');
  assert.equal(tn.parseToolLabel('```json\n{"label":" Edit  file "}\n```'), 'Edit file');
  for (const bad of ['Send mail', '{}', '{"label": ""}', '{"label": 4}', '["Send"]', '', undefined, '{"label": "one two three four"}', JSON.stringify({ label: 'x'.repeat(31) })]) assert.equal(tn.parseToolLabel(bad), null, String(bad));
});

test('the request is checked: names are short text', () => {
  assert.deepEqual(tn.readNames(['Bash', 'mcp__a__b']), ['Bash', 'mcp__a__b']);
  assert.throws(() => tn.readNames('Bash'));
  assert.throws(() => tn.readNames(['']));
  assert.throws(() => tn.readNames([4]));
  assert.throws(() => tn.readNames(['n'.repeat(201)]));
  assert.ok(tn.readNames(['n'.repeat(200)]));
});

test('the step is on by default, and the per-call summary stays off', () => {
  assert.equal(settings.settings().tiny.toolNames.enabled, true);
  assert.equal(settings.settings().tiny.toolSummary.enabled, false);
});

test('a seeded built-in needs no model, with or without one', async () => {
  const before = calls();
  const names = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Task', 'Agent'];
  const got = await tn.toolNames('claude', names, 500);
  assert.deepEqual(Object.keys(got.labels), names);
  assert.equal(got.labels.WebSearch, 'Web search');
  assert.equal(got.labels.Task, 'Agent');
  assert.deepEqual(got.pending, []);
  assert.equal((await tn.toolNames('codex', ['exec_command', 'apply_patch'])).labels.exec_command, 'Bash');
  assert.equal((await tn.toolNames('opencode', ['bash', 'webfetch'])).labels.webfetch, 'Web fetch');
  // Seeded per harness: Claude's `bash` isn't seeded, and the seeded `Bash` isn't OpenCode's name.
  assert.equal(labels.seededLabel('claude', 'bash'), undefined);
  assert.equal(calls(), before);
  setOn(false);
  try {
    assert.deepEqual(await tn.toolNames('claude', ['Bash', 'Task']), { enabled: false, labels: { Bash: 'Bash', Task: 'Agent' }, pending: [] });
  } finally {
    setOn(true);
  }
  assert.equal(calls(), before);
});

test('a missing label is asked once, stored, and read back by every agent of the harness', async () => {
  const before = calls();
  const got = await tn.toolNames('claude', ['mcp__stam__send_mail'], 5000);
  // The label is for the tool part; the stub names it after the tool part.
  assert.deepEqual(got, { enabled: true, labels: { mcp__stam__send_mail: 'Stub send_mail' }, pending: [] });
  assert.equal(calls(), before + 1);
  assert.equal(db.getToolName('claude', 'send_mail'), 'Stub send_mail');
  // Again, and from another server's copy of the tool: a peer copy is read, not regenerated.
  assert.equal((await tn.toolNames('claude', ['mcp__stam__send_mail'])).labels.mcp__stam__send_mail, 'Stub send_mail');
  assert.equal((await tn.toolNames('claude', ['mcp__other__send_mail'])).labels.mcp__other__send_mail, 'Stub send_mail');
  assert.equal(calls(), before + 1);
  // Another harness has its own tool of that name.
  assert.equal((await tn.toolNames('codex', ['send_mail'], 5000)).labels.send_mail, 'Stub send_mail');
  assert.equal(calls(), before + 2);
  // A Codex MCP name (server.tool) is stored and read by its tool part, so it reads the label above without a new call.
  assert.equal((await tn.toolNames('codex', ['stam.send_mail'])).labels['stam.send_mail'], 'Stub send_mail');
  assert.equal(calls(), before + 2);
  // Written once: a later write leaves the first label.
  db.setToolName('claude', 'send_mail', 'Other', 'm');
  assert.equal(db.getToolName('claude', 'send_mail'), 'Stub send_mail');
  const row = db.open().prepare("SELECT * FROM usage WHERE agent_id = 'stam' AND model = 'tool-name'").get();
  assert.equal(row.account, 'openrouter-system');
  assert.equal(events('decide').at(-1).purpose, 'tool-name');
});

test('with no wait a miss is pending, then stored', async () => {
  assert.deepEqual(await tn.toolNames('claude', ['nowait_tool']), { enabled: true, labels: {}, pending: ['nowait_tool'] });
  await until(() => db.getToolName('claude', 'nowait_tool'), 'the label stored');
  assert.deepEqual((await tn.toolNames('claude', ['nowait_tool'])).labels, { nowait_tool: 'Stub nowait_tool' });
});

test('a tool in flight is busy: a second request joins it, no second call', async () => {
  writeFileSync(join(stubDir, 'hang'), '');
  try {
    const before = calls();
    const first = tn.toolNames('claude', ['STUB:HANG_busy'], 5000);
    await until(() => calls() === before + 1, 'the call in flight');
    assert.deepEqual(await tn.toolNames('claude', ['STUB:HANG_busy'], 20), { enabled: true, labels: {}, pending: ['STUB:HANG_busy'] });
    const again = tn.toolNames('claude', ['STUB:HANG_busy'], 5000);
    assert.equal(calls(), before + 1);
    rmSync(join(stubDir, 'hang'));
    writeFileSync(join(stubDir, 'release'), '');
    // The held call gets an error: failed, so neither stored nor pending, and not asked again.
    assert.deepEqual((await first).pending, []);
    assert.deepEqual((await again).pending, []);
    assert.equal(calls(), before + 1);
  } finally {
    rmSync(join(stubDir, 'hang'), { force: true });
  }
});

test('every kind of reply ends in a stored label or a failure that is not asked again', async () => {
  // The stub reads a TOOLNAME=... marker from the prompt; the tool name carries it.
  const cases = {
    good: ['{"label":"Fine label"}', 'Fine label'],
    nolabel: ['{"other":"x"}', null],
    empty: ['', null],
    notjson: ['Send mail', null],
    toolong: [JSON.stringify({ label: 'a b c d e' }), null],
  };
  for (const [k, [answer, want]] of Object.entries(cases)) {
    const name = `reply_${k}=TOOLNAME=${encodeURIComponent(answer || '%20')}`;
    const tool = name;
    const before = calls();
    const got = await tn.toolNames('claude', [tool], 5000);
    assert.equal(calls(), before + 1, k);
    assert.deepEqual(got.pending, [], k);
    if (want) assert.equal(got.labels[tool], want, k);
    else assert.deepEqual(got.labels, {}, k);
    // Asked again: no second call, no pending (a failure stays failed, a label is read).
    const again = await tn.toolNames('claude', [tool], 500);
    assert.deepEqual(again, got, k);
    assert.equal(calls(), before + 1, k);
    assert.equal(db.getToolName('claude', tool), want ?? undefined, k);
  }
  assert.ok(events('tool-name:refused').length >= 4);
  // A server error is a failure too.
  const before = calls();
  assert.deepEqual((await tn.toolNames('claude', ['STUB:FAIL_tool'], 5000)).pending, []);
  assert.deepEqual((await tn.toolNames('claude', ['STUB:FAIL_tool'], 500)).pending, []);
  assert.equal(calls(), before + 1);
  assert.equal(events('tool-name:error').filter((e) => e.tool === 'STUB:FAIL_tool').length, 1);
});

test('with the step off, no key or a spent system budget nothing is asked or failed', async () => {
  const before = calls();
  setOn(false);
  try {
    assert.deepEqual(await tn.toolNames('claude', ['off_model'], 500), { enabled: false, labels: {}, pending: [] });
  } finally {
    setOn(true);
  }
  const env = join(home, 'opencode.env');
  const key = readFileSync(env, 'utf8');
  rmSync(env);
  try {
    assert.deepEqual(await tn.toolNames('claude', ['off_key'], 500), { enabled: false, labels: {}, pending: [] });
  } finally {
    writeFileSync(env, key);
  }
  const day = new Date().toISOString().slice(0, 10);
  settings.patchSettings({ cost: { accounts: { 'openrouter-system': { match: { harness: 'stam' }, budget: { usd: 0.5, per: 'day' } } } } });
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('held-seed', ?, 'openrouter', 'x', 'openrouter-system', 1)").run(day);
  try {
    assert.deepEqual(await tn.toolNames('claude', ['off_held'], 500), { enabled: false, labels: {}, pending: [] });
  } finally {
    db.open().prepare("DELETE FROM usage WHERE agent_id = 'held-seed'").run();
    settings.patchSettings({ cost: { accounts: { 'openrouter-system': null } } });
  }
  assert.equal(calls(), before);
  // None of them failed: with a model, a key and budget back, each is named.
  assert.equal((await tn.toolNames('claude', ['off_model', 'off_key', 'off_held'], 5000)).labels.off_key, 'Stub off_key');
});

test('names are not made in bulk: a batch is capped, and a settings change asks nothing', async () => {
  const many = Array.from({ length: 70 }, (_, i) => `bulk_${i}`);
  const before = calls();
  const got = await tn.toolNames('claude', many);
  assert.equal(got.pending.length, tn.NAMES_MAX);
  assert.ok(!got.pending.includes('bulk_40'));
  await until(() => !tn.queuedTools().length && calls() === before + tn.NAMES_MAX, 'the batch to be named');
  assert.equal(db.getToolName('claude', 'bulk_40'), undefined);
  const after = calls();
  setModel('openai/gpt-4.1-nano');
  setModel(MODEL);
  setOn(false);
  setOn(true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls(), after);
});
