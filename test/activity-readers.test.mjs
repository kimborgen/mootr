#!/usr/bin/env node
// Unit tests for the OpenCode and Codex readers of the activity timeline (S-211, src/activity.ts).
// Small inline stores: an OpenCode session_message table under a throwaway XDG_DATA_HOME, and a
// Codex rollout JSONL. Each covers tool calls, code-mode calls split per inner call, text, model
// time, gaps between turns, per-message cost, and incremental reads. Never touches the live
// OpenCode, Codex, or stam data. Runs with no daemon, no network, and no models:
// `node --test test/activity-readers.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-activity-readers-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `activity-readers-test-${process.pid}`;
process.env.XDG_DATA_HOME = join(home, 'xdg');
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'registry.json'), JSON.stringify({ prices: {} }));

let db, activity;
before(async () => {
  db = await import('../src/db.ts');
  activity = await import('../src/activity.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const event = (a, ts, type) => db.open().prepare('INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, NULL)').run(a.id, ts, type);
const rows = (id) => db.open().prepare('SELECT * FROM activity_items WHERE agent_id = ? ORDER BY seq').all(id);
const brief = (id) => rows(id).map((i) => `${i.turn} ${i.kind} ${i.name ?? ''} ${i.start.slice(11, 23)}-${i.end.slice(11, 23)} ${i.wait_kind ?? ''}`.replace(/ +/g, ' ').trim());
const iso = (ms) => new Date(ms).toISOString();
const agentOf = (name, harness, extra) => {
  const a = db.createAgent({ id: db.newAgentId(), name, role: '', machine: 'm', harness, model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(a.id, extra);
  return db.getAgent(a.id);
};

// ---- OpenCode ---------------------------------------------------------------------------

const OC_DB = join(home, 'xdg', 'opencode', 'opencode.db');
const SESSION = 'ses_test_1';
mkdirSync(join(home, 'xdg', 'opencode'), { recursive: true });
const store = new DatabaseSync(OC_DB);
store.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
const insertRow = (id, seq, type, t, data) =>
  store.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, SESSION, type, seq, t, t, JSON.stringify(data));
const tokens = (input, output) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } });

// Turn 1: a user prompt; msg_a runs shell (1210-1250) after its text; msg_b runs code mode with
// two inner calls over 1400-1480; msg_c answers and stops. Turn 2: a prompt, then one answer.
insertRow('u1', 1, 'user', 1000, { text: 'list and read', time: { created: 1000 } });
insertRow('msg_a', 2, 'assistant', 1100, {
  time: { created: 1100, streamed: 1200, completed: 1260 }, model: { id: 'deepseek-test', providerID: 'openrouter' }, finish: 'tool-calls',
  cost: 0.5, tokens: tokens(100, 10),
  content: [
    { type: 'text', text: 'looking' },
    { type: 'tool', name: 'shell', state: { input: { command: 'ls' } }, time: { ran: 1210, completed: 1250 } },
  ],
});
insertRow('msg_b', 3, 'assistant', 1300, {
  time: { created: 1300, streamed: 1400, completed: 1500 }, model: { id: 'deepseek-test', providerID: 'openrouter' }, finish: 'tool-calls',
  cost: 0.3, tokens: tokens(200, 20),
  content: [
    // The real shape: the code is the part's input; toolCalls name each inner call, with no times.
    {
      type: 'tool', name: 'execute', time: { ran: 1400, completed: 1480 },
      state: { input: { code: 'const a = await tools.read({ path: "x" });\nconst b = await tools.grep({ pattern: "y" });' }, metadata: { toolCalls: [{ tool: 'read', status: 'completed' }, { tool: 'grep', status: 'completed' }] } },
    },
  ],
});
insertRow('msg_c', 4, 'assistant', 1500, {
  time: { created: 1500, streamed: 1600, completed: 1700 }, model: { id: 'deepseek-test', providerID: 'openrouter' }, finish: 'stop',
  cost: 0.2, tokens: tokens(50, 5),
  content: [{ type: 'text', text: 'done' }],
});
insertRow('u2', 5, 'user', 5000, { text: 'again', time: { created: 5000 } });
insertRow('msg_d', 6, 'assistant', 5100, {
  time: { created: 5100, streamed: 5200, completed: 5300 }, model: { id: 'deepseek-test', providerID: 'openrouter' }, finish: 'stop',
  cost: 0.1, tokens: tokens(10, 1),
  content: [{ type: 'text', text: 'ok' }],
});

test('OpenCode: tools, code-mode inner calls, text, model time, gaps, and cost per message', async () => {
  const a = agentOf('oc-main', 'opencode', { session_id: SESSION });
  const r = await activity.ingest(a);
  assert.equal(r.items, 11);
  const items = brief(a.id);
  // Tool time is each part's ran → completed; the code-mode call splits into its two inner calls.
  assert.ok(items.includes('1 tool shell 00:00:01.210-00:00:01.250 tool.short'));
  assert.ok(items.includes('1 tool read 00:00:01.400-00:00:01.440 tool.short'));
  assert.ok(items.includes('1 tool grep 00:00:01.440-00:00:01.480 tool.short'));
  // The gap between the turns is the human's prompt.
  assert.ok(items.includes('1 gap prompt 00:00:01.700-00:00:05.000 human.prompt'));
  // Costs: each message's price is split over its items; the day sums to the messages' prices.
  const sum = rows(a.id).reduce((s, i) => s + i.raw_cost_usd, 0);
  assert.ok(Math.abs(sum - 1.1) < 1e-9, `cost sum ${sum}`);
});

test('OpenCode: a turn stam saw end, with no finished message, commits on its execution event', async () => {
  const sid = 'ses_test_2';
  store.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('x1', sid, 'user', 1, 1000, 1000, JSON.stringify({ text: 'hi', time: { created: 1000 } }));
  store.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('x2', sid, 'assistant', 2, 1100, 1100, JSON.stringify({ time: { created: 1100, streamed: 1200, completed: 1300 }, finish: 'tool-calls', content: [{ type: 'text', text: 'working' }] }));
  const a = agentOf('oc-running', 'opencode', { session_id: sid });
  // Still running: nothing is committed.
  assert.equal((await activity.ingest(a)).items, 0);
  event(a, iso(1400), 'opencode:session.execution.failed');
  assert.equal((await activity.ingest(a)).items, 2);
  assert.deepEqual(brief(a.id), ['1 model 00:00:01.000-00:00:01.200 model.generate', '1 text 00:00:01.200-00:00:01.200']);
});

test('OpenCode: ingestAll reads an agent with a session and no transcript_path (S-1008)', async () => {
  const a = agentOf('oc-all', 'opencode', { session_id: SESSION });
  assert.equal(a.transcript_path, null);
  const rs = await activity.ingestAll(a.id);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].error, undefined);
  assert.equal(rs[0].items, 11);
});

test('OpenCode: a long session yields more than one slice, each ending on a finished turn (S-1008)', async () => {
  const sid = 'ses_long';
  const ins = store.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const turns = 1100;
  for (let i = 0; i < turns; i++) {
    const t = 100_000 + i * 1000;
    ins.run(`lu${i}`, sid, 'user', 2 * i + 1, t, t, JSON.stringify({ text: `p${i}`, time: { created: t } }));
    ins.run(`la${i}`, sid, 'assistant', 2 * i + 2, t + 100, t + 100, JSON.stringify({
      time: { created: t + 100, streamed: t + 200, completed: t + 300 }, model: { id: 'm', providerID: 'p' }, finish: 'stop',
      tokens: tokens(1, 1), content: [{ type: 'text', text: 'ok' }],
    }));
  }
  const slices = [];
  for await (const r of activity.readOpenCode(OC_DB, sid, null, { turnEnded: () => true })) slices.push(r);
  assert.ok(slices.length > 1, `slices ${slices.length}`);
  assert.equal(slices.at(-1).cursor.offset, turns * 2);
  assert.ok(slices.every((r) => r.cursor.offset % 2 === 0));
});

test('OpenCode: a read picks up only the rows after its cursor', async () => {
  const a = agentOf('oc-more', 'opencode', { session_id: SESSION });
  await activity.ingest(a);
  const before = rows(a.id).length;
  insertRow('u3', 7, 'user', 9000, { text: 'third', time: { created: 9000 } });
  insertRow('msg_e', 8, 'assistant', 9100, {
    time: { created: 9100, streamed: 9200, completed: 9300 }, model: { id: 'deepseek-test', providerID: 'openrouter' }, finish: 'stop', cost: 0.05, tokens: tokens(5, 1),
    content: [{ type: 'text', text: 'three' }],
  });
  const r = await activity.ingest(a);
  // The gap since the last answer, then one model item and one text.
  assert.equal(r.items, 3);
  assert.equal(rows(a.id).length, before + 3);
});

// ---- Codex ------------------------------------------------------------------------------

const ts = (s) => (s.includes(':') ? `2026-10-10T${s}Z` : `2026-10-10T16:43:${s}Z`);
// Rows carry an ordinal, as Codex writes them, so rows at the same time are told apart.
let ordinal = 0;
const line = (t, type, payload) => JSON.stringify({ timestamp: ts(t), ordinal: ++ordinal, type, payload });
const user = (t, text) => line(t, 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
const agentMsg = (t, text) => line(t, 'event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }] } });
const call = (t, id, name, args) => line(t, 'response_item', { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const out = (t, id) => line(t, 'response_item', { type: 'function_call_output', call_id: id, output: 'ok' });
const exec = (t, id, code) => line(t, 'response_item', { type: 'custom_tool_call', call_id: id, name: 'exec', input: code });
// A usage row is top-level in a real rollout, with the response's own usage.
const usage = (t, resp, input, cached, output) => line(t, 'token_usage_record', { response_id: resp, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } });
const done = (t) => line(t, 'event_msg', { type: 'task_complete', completed_at: 1 });

const RUN = join(home, 'codex-run.jsonl');
const codexRows = [
  line('52.000', 'session_meta', { id: 's1' }),
  line('52.100', 'turn_context', { model: 'gpt-test' }),
  line('52.200', 'event_msg', { type: 'task_started' }),
  user('52.300', 'run the checks'),
  agentMsg('53.000', 'checking'),
  call('53.100', 'c1', 'exec_command', { cmd: 'echo hi' }),
  out('53.600', 'c1'),
  exec('54.000', 'c2', 'const a = await tools.exec_command({cmd:"ls -la"});\nconst b = await tools.write_stdin({session_id: 1});\ntext(a.output);'),
  out('55.000', 'c2'),
  usage('55.100', 'resp_1', 1000, 800, 30),
  agentMsg('55.200', 'all done'),
  usage('55.300', 'resp_2', 500, 0, 20),
  done('55.400'),
  user('16:44:10.000', 'once more'),
  agentMsg('16:44:10.500', 'yes'),
  usage('16:44:10.600', 'resp_3', 100, 0, 5),
  done('16:44:10.700'),
];
writeFileSync(RUN, codexRows.join('\n') + '\n');

test('Codex: calls, code-mode inner calls, text, usage per response, and gaps between turns', async () => {
  const a = agentOf('cx-main', 'codex', { transcript_path: RUN });
  const r = await activity.ingest(a);
  assert.equal(r.items, 11);
  const items = rows(a.id);
  const brief2 = items.map((i) => `${i.turn} ${i.kind} ${i.name ?? ''}`.trim());
  assert.deepEqual(brief2, [
    '1 model',
    '1 text',
    '1 tool exec_command',
    '1 model',
    '1 tool exec_command',
    '1 tool write_stdin',
    '1 model',
    '1 text',
    '1 gap prompt',
    '2 model',
    '2 text',
  ]);
  // The code-mode exec splits into its inner calls in order, sharing its span.
  const writes = items.filter((i) => i.kind === 'tool');
  assert.deepEqual(writes.map((i) => i.name), ['exec_command', 'exec_command', 'write_stdin']);
  assert.equal(writes[1].summary, 'ls -la');
  // Model time before the first tool call, and the gap is the human's prompt.
  assert.equal(items[0].start, ts('52.300'));
  const gap = items.find((i) => i.kind === 'gap');
  assert.equal(gap.wait_kind, 'human.prompt');
  // Each response's items are named by its usage row; the text of resp_1 and its tools share it.
  // The msg names come from the reader's slices, as activity_items doesn't keep them.
  const got = [];
  for await (const r of activity.readCodex(RUN, null, { turnEnded: () => false })) got.push(...r.items);
  // resp_1 made the first model span, its text, two tool calls, and the code-mode exec's two inner calls.
  assert.equal(got.filter((i) => i.msg === 'resp_1').length, 6);
  assert.deepEqual([...new Set(got.map((i) => i.msg).filter(Boolean))].sort(), ['resp_1', 'resp_2', 'resp_3']);
  assert.equal(got.find((i) => i.kind === 'model' && i.start === Date.parse(ts('55.000'))).msg, 'resp_2');
  // No prices in this registry, so the items cost nothing.
  assert.equal(items.reduce((s, i) => s + i.raw_cost_usd, 0), 0);
});

test('Codex: a read picks up only the new turns, without duplicates', async () => {
  const path = join(home, 'codex-more.jsonl');
  writeFileSync(path, codexRows.slice(0, 13).join('\n') + '\n');
  const a = agentOf('cx-more', 'codex', { transcript_path: path });
  // Turn 1 only: its eight items, committed at task_complete.
  assert.equal((await activity.ingest(a)).items, 8);
  appendFileSync(path, codexRows.slice(13).join('\n') + '\n');
  // The gap, then turn 2's text and model.
  assert.equal((await activity.ingest(a)).items, 3);
  assert.equal(rows(a.id).length, 11);
  const seqs = rows(a.id).map((i) => i.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
});

test('Codex: a turn stam saw end, with no task_complete, commits on its Stop hook', async () => {
  const path = join(home, 'codex-stopped.jsonl');
  writeFileSync(path, [user('10.000', 'go'), agentMsg('10.500', 'working'), usage('10.600', 'resp_s', 10, 0, 1)].join('\n') + '\n');
  const a = agentOf('cx-stopped', 'codex', { transcript_path: path });
  assert.equal((await activity.ingest(a)).items, 0);
  event(a, iso(Date.parse(ts('11.000'))), 'hook:Stop');
  // The model until the last row, then the text.
  assert.equal((await activity.ingest(a)).items, 2);
  assert.deepEqual(brief(a.id).length, 2);
});

test('Codex: a usage row sets the response tokens: uncached input, cache reads, and output', async () => {
  const got = { usage: new Map() };
  for await (const r of activity.readCodex(RUN, null, { turnEnded: () => false })) for (const [k, v] of r.usage) got.usage.set(k, v);
  // resp_1: 1000 input of which 800 cached, 30 output; the gpt-test model from turn_context.
  assert.deepEqual(got.usage.get('resp_1'), { model: 'gpt-test', tokens_in: 200, tokens_out: 30, tokens_cache_read: 800, tokens_cache_write: 0 });
});

test('Codex: a rebuilt rollout whose next prompt shares the previous task_complete time keeps that turn', async () => {
  const first = [user('16:45:00.000', 'one'), agentMsg('16:45:01.000', 'first'), usage('16:45:01.500', 'r1', 10, 0, 1), done('16:45:02.000')];
  const path = join(home, 'codex-rebuilt-a.jsonl');
  writeFileSync(path, first.join('\n') + '\n');
  const a = agentOf('cx-rebuilt', 'codex', { transcript_path: path });
  await activity.ingest(a);
  // The same rows, then a prompt at the very millisecond the first turn completed, in a new file.
  const second = [user('16:45:02.000', 'two'), agentMsg('16:45:03.000', 'second'), usage('16:45:03.500', 'r2', 10, 0, 1), done('16:45:04.000')];
  const path2 = join(home, 'codex-rebuilt-b.jsonl');
  writeFileSync(path2, [...first, ...second].join('\n') + '\n');
  db.updateAgent(a.id, { transcript_path: path2 });
  await activity.ingest(a);
  assert.ok(rows(a.id).some((i) => i.summary === 'second'), 'turn two is kept');
  assert.equal(rows(a.id).filter((i) => i.summary === 'first').length, 1, 'turn one is not counted twice');
});

test('Codex: model time waits while any parallel tool still runs', async () => {
  const p = [
    user('16:46:00.000', 'go'),
    call('16:46:01.000', 'A', 'exec_command', { cmd: 'a' }),
    call('16:46:01.200', 'B', 'exec_command', { cmd: 'b' }),
    out('16:46:02.000', 'A'),
    call('16:46:03.000', 'C', 'exec_command', { cmd: 'c' }),
    out('16:46:04.000', 'C'),
    out('16:46:05.000', 'B'),
    done('16:46:06.000'),
  ];
  const path = join(home, 'codex-parallel.jsonl');
  writeFileSync(path, p.join('\n') + '\n');
  const a = agentOf('cx-parallel', 'codex', { transcript_path: path });
  await activity.ingest(a);
  const model = rows(a.id).filter((i) => i.kind === 'model').map((i) => [i.start.slice(11, 23), i.end.slice(11, 23)]);
  // Model time before the first call, then after the last tool finishes; none while B runs.
  assert.deepEqual(model, [['16:46:00.000', '16:46:01.000'], ['16:46:05.000', '16:46:06.000']]);
});

test('OpenCode: a message ends at its completion, not its last stream', async () => {
  // Turn 1's final message streams to 1600 and completes at 1700: the gap starts at 1700.
  const a = agentOf('oc-completed', 'opencode', { session_id: SESSION });
  await activity.ingest(a);
  const gap = rows(a.id).find((i) => i.kind === 'gap');
  assert.equal(gap.start, iso(1700));
});

