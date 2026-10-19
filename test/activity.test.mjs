#!/usr/bin/env node
// Unit tests for the activity timeline (S-210, src/activity.ts): a small Claude Code transcript
// (test/fixtures/activity-claude.jsonl) read into activity_items, with tool, text, model, and gap
// items, wait kinds, cost split per message, incremental reads, throttles, and usage scaling;
// then small inline transcripts for the edge cases: a turn's last message cut at the end of the
// file, slices that yield to the event loop, rescaling from raw costs, a changed or truncated
// source, a notice during a running turn, and overlapping cost blockers.
// Runs against a throwaway STAM_HOME with no daemon, no network, and no models:
// `node --test test/activity.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-activity-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `activity-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'registry.json'), JSON.stringify({ prices: { 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } } }));

const FIXTURE = new URL('./fixtures/activity-claude.jsonl', import.meta.url).pathname;
const MORE = new URL('./fixtures/activity-claude-more.jsonl', import.meta.url).pathname;

let db, activity;
before(async () => {
  db = await import('../src/db.ts');
  activity = await import('../src/activity.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

// An agent with its own copy of the fixture as its transcript, and a child named kid.
function agent(name) {
  const path = join(home, `${name}.jsonl`);
  copyFileSync(FIXTURE, path);
  const a = db.createAgent({ id: db.newAgentId(), name, role: '', machine: 'm', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(a.id, { transcript_path: path });
  // stam saw turn 5 end; turn 6 is still running.
  event(a, '2026-10-10T11:10:40.500Z', 'hook:Stop');
  if (!db.getAgent('kid')) db.createAgent({ id: db.newAgentId(), name: 'kid', role: '', machine: 'm', harness: 'claude', model: null, effort: null, cwd: home, parent_id: a.id, session_id: null });
  else db.updateAgent(db.getAgent('kid').id, { parent_id: a.id });
  return { a: db.getAgent(a.id), path };
}

const event = (a, ts, type, data = null) => db.open().prepare('INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)').run(a.id, ts, type, data);
// The Stop hook for the turn that ends the agent's transcript, half a second after its last row.
function ended(a) {
  const path = db.getAgent(a.id).transcript_path;
  const last = readFileSync(path, 'utf8').trim().split('\n').pop();
  event(a, new Date(Date.parse(JSON.parse(last).timestamp) + 500).toISOString(), 'hook:Stop');
}
const rows = (id) => db.open().prepare('SELECT * FROM activity_items WHERE agent_id = ? ORDER BY seq').all(id);

test('reads whole turns into tool, text, model, and gap items with wait kinds', async () => {
  const { a } = agent('alpha');
  const r = await activity.ingest(a);
  assert.equal(r.items, 20);
  const items = rows(a.id);
  const brief = items.map((i) => `${i.turn} ${i.kind} ${i.name ?? ''} ${i.start.slice(11, 19)}-${i.end.slice(11, 19)} ${i.wait_kind ?? ''}`.replace(/ +/g, ' ').trim());
  assert.deepEqual(brief, [
    '1 model 10:00:00-10:00:12 model.generate',
    '1 tool Bash 10:00:12-10:01:12 tool.test',
    '1 model 10:01:12-10:01:20 model.generate',
    '1 text 10:01:20-10:01:20',
    '1 gap child:kid 10:01:20-10:30:00 agent.child',
    '2 model 10:30:00-10:30:05 model.generate',
    '2 tool Bash 10:30:05-10:30:08 tool.short',
    '2 model 10:30:08-10:30:10 model.generate',
    '2 text 10:30:10-10:30:10',
    '2 gap job 10:30:10-10:40:00 job.background',
    '3 model 10:40:00-10:40:05 model.generate',
    '3 text 10:40:05-10:40:05',
    '3 gap mail:kid 10:40:05-11:00:00 agent.child',
    '4 model 11:00:00-11:00:03 model.generate',
    '4 text 11:00:03-11:00:03',
    '4 gap mail:human 11:00:03-11:10:00 human.reply',
    '5 model 11:10:00-11:10:30 model.generate',
    '5 tool Edit 11:10:30-11:10:31 tool.short',
    '5 model 11:10:31-11:10:40 model.generate',
    '5 text 11:10:40-11:10:40',
  ]);
  // Summaries: the tool input or text, at most 300 characters, never the tool's output.
  assert.equal(items[1].summary, 'sh test/run.sh activity');
  assert.equal(items[17].summary, '/repo/src/a.ts');
  assert.equal(items[19].summary.length, 300);
  assert.ok(items.every((i) => !String(i.summary ?? '').includes('SECRET-OUTPUT')));
  // Categories: the rules fill what they settle (S-213); a gap is derived with none; the rest
  // stay NULL for the model.
  assert.ok(items.every((i) => (i.category_source === null) === (i.category === null) || i.kind === 'gap'));
  assert.ok(items.filter((i) => i.kind === 'gap').every((i) => i.category === null && i.category_source === 'derived'));
  assert.ok(items.every((i) => i.category_source !== 'rule' || i.confidence === 1));
});

test('classify fills the same rule categories again, in batches, and only the unclassified rows (S-213)', async () => {
  const a = db.getAgent('alpha').id;
  const before = rows(a).map((i) => [i.category, i.category_source, i.confidence]);
  db.open().prepare('UPDATE activity_items SET category = NULL, category_source = NULL, confidence = NULL WHERE agent_id = ?').run(a);
  // Batches of three rows: a model item's sibling or a text's later text can sit in the next batch.
  assert.equal(await activity.classify(a, 3), before.filter(([, s]) => s === 'rule' || s === 'derived').length);
  assert.deepEqual(rows(a).map((i) => [i.category, i.category_source, i.confidence]), before);
  // Everything is classified now, or left to the model: a second run changes nothing.
  assert.equal(await activity.classify(a), 0);
});

test('classify leaves a row the rules did not settle to the model, and keeps a row the model classified', async () => {
  const a = db.getAgent('alpha').id;
  const d = db.open();
  const seqs = rows(a).filter((i) => i.kind === 'tool').map((i) => i.seq);
  const [keep, ...rest] = seqs;
  // The model's own mark on one tool, and a fresh NULL on another: only the NULL one is read.
  d.prepare("UPDATE activity_items SET category = 'produce.docs', category_source = 'model', confidence = 0.8 WHERE agent_id = ? AND seq = ?").run(a, keep);
  await activity.classify(a);
  const kept = rows(a).find((i) => i.seq === keep);
  assert.deepEqual([kept.category, kept.category_source, kept.confidence], ['produce.docs', 'model', 0.8]);
  for (const seq of rest) assert.ok(rows(a).find((i) => i.seq === seq).category_source !== 'model');
});

test("splits each message's price evenly over its items, counting repeated usage once", () => {
  const items = rows(db.getAgent('alpha').id);
  // msg_A: 1000 in × $4/M + 100 out × $20/M = $0.006, over its model and tool items.
  assert.ok(Math.abs(items[0].est_cost_usd - 0.003) < 1e-12);
  assert.ok(Math.abs(items[1].est_cost_usd - 0.003) < 1e-12);
  assert.equal(items[0].tokens_in, 500);
  assert.equal(items[0].tokens_out, 50);
  // msg_B: 2000 × 4 + 50 × 20 = $0.009, over its model and text items.
  assert.ok(Math.abs(items[2].est_cost_usd - 0.0045) < 1e-12);
  assert.ok(Math.abs(items[3].est_cost_usd - 0.0045) < 1e-12);
  assert.equal(items[4].est_cost_usd, 0);
});

test('stops at the last turn boundary and continues from there without duplicates', async () => {
  const a = db.getAgent('alpha');
  assert.equal((await activity.ingest(a)).items, 0);
  appendFileSync(a.transcript_path, readFileSync(MORE));
  ended(a);
  assert.equal((await activity.ingest(a)).items, 5);
  const items = rows(a.id);
  assert.equal(items.length, 25);
  const tail = items.slice(20).map((i) => `${i.turn} ${i.kind} ${i.name ?? ''} ${i.wait_kind ?? ''}`.replace(/ +/g, ' ').trim());
  assert.deepEqual(tail, ['5 gap prompt human.prompt', '6 model model.generate', '6 tool Read tool.short', '6 model model.generate', '6 text']);
  assert.deepEqual(
    items.map((i) => i.seq),
    items.map((_, n) => n + 1),
  );
});

test('a gap mostly spent paused is throttle.*, cost over scheduler', async () => {
  const { a } = agent('beta');
  const ev = db.open().prepare('INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)');
  ev.run(a.id, '2026-10-10T10:02:00.000Z', 'pause', '{"owner":"cos"}');
  ev.run(a.id, '2026-10-10T10:29:00.000Z', 'unpause', null);
  ev.run(a.id, '2026-10-10T10:41:00.000Z', 'blocker:add', '{"kind":"window"}');
  ev.run(a.id, '2026-10-10T10:59:00.000Z', 'blocker:clear', '{"kind":"window"}');
  await activity.ingest(a);
  const gaps = rows(a.id).filter((i) => i.kind === 'gap');
  assert.deepEqual(
    gaps.map((g) => g.wait_kind),
    ['throttle.scheduler', 'job.background', 'throttle.cost', 'human.reply'],
  );
});

test("scales an agent's daily item costs to its usage row", async () => {
  const { a } = agent('gamma');
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, '2026-10-10', 'claude', 'claude-opus-5-5', '', 1.5)").run(a.id);
  await activity.ingest(a);
  const sum = rows(a.id).reduce((s, i) => s + i.est_cost_usd, 0);
  assert.ok(Math.abs(sum - 1.5) < 1e-9, `sum ${sum}`);
});

test('tool and model wait rules', () => {
  const w = activity.toolWait;
  assert.equal(w('Bash', { command: 'ls' }, 1000), 'tool.short');
  assert.equal(w('Bash', { command: 'npm ci' }, 30_000), 'tool.build');
  assert.equal(w('Bash', { command: 'npx tsc --noEmit' }, 30_000), 'tool.build');
  assert.equal(w('Bash', { command: 'node --test test/x.test.mjs' }, 30_000), 'tool.test');
  assert.equal(w('Bash', { command: 'sh web/check/run.sh phone --only=360-light' }, 30_000), 'tool.test');
  assert.equal(w('Bash', { command: 'sleep 60' }, 60_000), 'tool.sleep');
  assert.equal(w('Bash', { command: 'until [ -f x ]; do sleep 5; done' }, 60_000), 'tool.sleep');
  assert.equal(w('Bash', { command: 'while [ "$(uptime | cut -d, -f4)" > 6 ]; do sleep 10; done' }, 60_000), 'tool.contention');
  assert.equal(w('Bash', { command: 'curl -s https://example.com' }, 9_000), 'tool.network');
  assert.equal(w('Bash', { command: 'git push origin x' }, 9_000), 'tool.network');
  assert.equal(w('mcp__stam__send_mail', {}, 9_000), 'tool.network');
  assert.equal(w('Edit', { file_path: 'a' }, 60_000), 'human.permission');
  assert.equal(w('Agent', {}, 60_000), 'agent.child');
  assert.equal(activity.modelWait(60_000), 'model.generate');
  assert.equal(activity.modelWait(6 * 60_000), 'model.stall');
});

// ---- Inline transcripts for the edge cases ----

const T = (hms) => `2026-10-11T${hms}.000Z`;
// 2500 input tokens at $4/M: $0.01 per message.
const USAGE = { input_tokens: 2500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const j = (rows) => rows.map((r) => JSON.stringify(r) + '\n').join('');
const prompt = (hms, text, meta = false) => ({ type: 'user', timestamp: T(hms), ...(meta ? { isMeta: true } : {}), message: { role: 'user', content: text } });
const said = (hms, id, block, stop = 'end_turn') => ({
  type: 'assistant',
  timestamp: T(hms),
  message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [block], stop_reason: stop, usage: USAGE },
});
const text = (t) => ({ type: 'text', text: t });
// A whole turn: a prompt and one message that answers it ($0.01, a model and a text item).
const turn = (hms, answer, id) => [prompt(hms, 'go'), said(answer, id, text('done'))];

// An agent whose transcript is `rows`; unless `stop` is false, stam saw its last turn end.
function bare(name, rows, { stop = true } = {}) {
  const path = join(home, `${name}.jsonl`);
  writeFileSync(path, j(rows));
  const a = db.createAgent({ id: db.newAgentId(), name, role: '', machine: 'm', harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(a.id, { transcript_path: path });
  if (stop) ended(a);
  return { a: db.getAgent(a.id), path };
}
const brief = (id) => rows(id).map((i) => `${i.turn} ${i.kind} ${i.start.slice(11, 19)}-${i.end.slice(11, 19)} ${i.wait_kind ?? ''}`.trim());

test("a turn's last message cut at the end of the file waits until it is complete, and is charged once", async () => {
  const { a, path } = bare('cut', [prompt('10:00:00', 'go'), said('10:00:05', 'msg_X', { type: 'thinking', thinking: 'hmm' })], { stop: false });
  // While the turn runs (no Stop hook yet), the end of the file is no boundary.
  assert.equal((await activity.ingest(a)).items, 0);
  // The first block of an end_turn message is in; its text block isn't yet.
  appendFileSync(path, j([said('10:00:06', 'msg_X', { type: 'thinking', thinking: 'more' })]));
  assert.equal((await activity.ingest(a)).items, 0);
  appendFileSync(path, j([said('10:00:07', 'msg_X', text('answer'))]));
  ended(a);
  assert.equal((await activity.ingest(a)).items, 2);
  // A stray repeat of the committed message is never read twice.
  appendFileSync(path, j([said('10:00:08', 'msg_X', text('again'))]));
  assert.equal((await activity.ingest(a)).items, 0);
  assert.deepEqual(brief(a.id), ['1 model 10:00:00-10:00:07 model.generate', '1 text 10:00:07-10:00:07']);
  const sum = rows(a.id).reduce((s, i) => s + i.raw_cost_usd, 0);
  assert.ok(Math.abs(sum - 0.01) < 1e-12, `sum ${sum}`);
});

test('a large transcript is read in slices that let the event loop run', async () => {
  const many = [];
  for (let i = 0; i < 3000; i++) {
    const s = String(i % 60).padStart(2, '0');
    const m = String(Math.floor(i / 60) % 60).padStart(2, '0');
    const h = String(10 + Math.floor(i / 3600)).padStart(2, '0');
    many.push(prompt(`${h}:${m}:${s}`, 'go'), said(`${h}:${m}:${s}`, `msg_${i}`, text('ok')));
  }
  const { a } = bare('big', many);
  let ticks = 0;
  const iv = setInterval(() => ticks++, 0);
  const r = await activity.ingest(a);
  clearInterval(iv);
  assert.equal(r.items, 3000 * 3 - 1);
  assert.ok(ticks > 0, 'timers ran during the ingest');
  assert.deepEqual(
    rows(a.id).map((i) => i.seq),
    rows(a.id).map((_, n) => n + 1),
  );
});

test('rescaling works from raw costs and follows usage that changes without new items', async () => {
  const { a, path } = bare('scale', turn('10:00:00', '10:00:05', 'm1'));
  const setUsage = (usd) =>
    db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, '2026-10-11', 'claude', 'claude-opus-5-5', '', ?) ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = excluded.cost_usd").run(a.id, usd);
  setUsage(1);
  await activity.ingest(a);
  appendFileSync(path, j(turn('11:00:00', '11:00:05', 'm2')));
  ended(a);
  setUsage(2);
  await activity.ingest(a);
  const perTurn = () => [1, 2].map((t) => rows(a.id).filter((i) => i.turn === t && i.kind !== 'gap').reduce((s, i) => s + i.est_cost_usd, 0));
  perTurn().forEach((c) => assert.ok(Math.abs(c - 1) < 1e-9, `turn cost ${c}`));
  setUsage(4);
  assert.equal((await activity.ingest(a)).items, 0);
  perTurn().forEach((c) => assert.ok(Math.abs(c - 2) < 1e-9, `turn cost ${c}`));
});

test('a changed or truncated source starts over without duplicates or backwards gaps', async () => {
  const first = [...turn('10:00:00', '10:00:05', 'm1'), ...turn('10:10:00', '10:10:05', 'm2')];
  const { a } = bare('moved', first);
  assert.equal((await activity.ingest(a)).items, 5);
  // A new transcript file that repeats the old conversation, then goes on.
  const moved = join(home, 'moved-2.jsonl');
  writeFileSync(moved, j([...first, ...turn('10:20:00', '10:20:05', 'm3')]));
  db.updateAgent(a.id, { transcript_path: moved });
  ended(a);
  assert.equal((await activity.ingest(a)).items, 3);
  // The same file rewritten shorter than the cursor, holding only a newer turn.
  writeFileSync(moved, j(turn('10:30:00', '10:30:05', 'm4')));
  ended(a);
  assert.equal((await activity.ingest(a)).items, 3);
  assert.deepEqual(brief(a.id), [
    '1 model 10:00:00-10:00:05 model.generate',
    '1 text 10:00:05-10:00:05',
    '1 gap 10:00:05-10:10:00 human.prompt',
    '2 model 10:10:00-10:10:05 model.generate',
    '2 text 10:10:05-10:10:05',
    '2 gap 10:10:05-10:20:00 human.prompt',
    '3 model 10:20:00-10:20:05 model.generate',
    '3 text 10:20:05-10:20:05',
    '3 gap 10:20:05-10:30:00 human.prompt',
    '4 model 10:30:00-10:30:05 model.generate',
    '4 text 10:30:05-10:30:05',
  ]);
});

test('a notice during a running turn is part of the turn, not a gap', async () => {
  const notice = '<channel source="stam" kind="mail">\n[stam] You have 1 unread mail. Read it with the stam `read_mail` tool and act on it. Latest unread:\n- m1 from cos: hi\n</channel>';
  const { a } = bare('midturn', [...turn('10:00:00', '10:00:05', 'm1'), prompt('10:05:00', 'next'), prompt('10:06:00', notice, true), said('10:06:30', 'm2', text('ok'))]);
  await activity.ingest(a);
  assert.deepEqual(brief(a.id), [
    '1 model 10:00:00-10:00:05 model.generate',
    '1 text 10:00:05-10:00:05',
    '1 gap 10:00:05-10:05:00 human.prompt',
    '2 model 10:05:00-10:06:30 model.generate',
    '2 text 10:06:30-10:06:30',
  ]);
});

test('a cost throttle lasts until every blocker has cleared', async () => {
  const { a } = bare('blocked', [...turn('10:00:00', '10:00:05', 'm1'), ...turn('10:30:00', '10:30:05', 'm2')]);
  const ev = db.open().prepare('INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)');
  ev.run(a.id, T('10:02:00'), 'blocker:add', '{"kind":"window","account":"claude"}');
  ev.run(a.id, T('10:03:00'), 'blocker:add', '{"kind":"credit","account":"claude"}');
  ev.run(a.id, T('10:05:00'), 'blocker:clear', '{"kind":"window","account":"claude"}');
  ev.run(a.id, T('10:29:00'), 'blocker:clear', '{"kind":"credit","account":"claude"}');
  await activity.ingest(a);
  assert.deepEqual(
    rows(a.id).filter((i) => i.kind === 'gap').map((g) => g.wait_kind),
    ['throttle.cost'],
  );
});

test('a source read over again skips exactly the rows already read, even in the same millisecond', async () => {
  const u = (row, id) => ({ ...row, uuid: id });
  const first = [u(prompt('10:00:00', 'go'), 'u1'), u(said('10:00:05', 'm1', text('one')), 'u2')];
  const { a } = bare('samems', first);
  assert.equal((await activity.ingest(a)).items, 2);
  const next = join(home, 'samems-2.jsonl');
  writeFileSync(next, j([...first, u(prompt('10:00:05', 'again'), 'u3'), u(said('10:00:05', 'm2', text('two')), 'u4')]));
  db.updateAgent(a.id, { transcript_path: next });
  ended(a);
  assert.equal((await activity.ingest(a)).items, 3);
  assert.deepEqual(brief(a.id), [
    '1 model 10:00:00-10:00:05 model.generate',
    '1 text 10:00:05-10:00:05',
    '1 gap 10:00:05-10:00:05 human.prompt',
    '2 model 10:00:05-10:00:05 model.generate',
    '2 text 10:00:05-10:00:05',
  ]);
});

test("the end of the file commits on stam's Stop hook, whatever the activity, and not on an older one", async () => {
  const { a } = bare('stopped', turn('10:00:00', '10:00:05', 'm1'), { stop: false });
  // A Stop from before this turn's last row doesn't end it.
  event(a, T('09:59:00'), 'hook:Stop');
  assert.equal((await activity.ingest(a)).items, 0);
  // An agent errored (or waiting) after its end_turn still had its turn end.
  db.updateAgent(a.id, { activity: 'errored' });
  event(a, T('10:00:06'), 'hook:Stop');
  assert.equal((await activity.ingest(a)).items, 2);
});

test('a slow turn stays one turn; a prompt after a turn end stam saw starts a gap', async () => {
  const notice = '<channel source="stam" kind="mail">\n[stam] You have 1 unread mail. Read it with the stam `read_mail` tool and act on it. Latest unread:\n- m1 from cos: hi\n</channel>';
  const rows6 = [prompt('10:00:00', 'go'), prompt('10:06:00', notice, true), said('10:06:30', 'm1', text('ok'))];
  const { a } = bare('slow', rows6);
  await activity.ingest(a);
  // Over 5 minutes of model time reads as a stall, but it is one turn, not a gap.
  assert.deepEqual(brief(a.id), ['1 model 10:00:00-10:06:30 model.stall', '1 text 10:06:30-10:06:30']);
  // The same rows, but the turn failed at 10:03 (a StopFailure hook) with nothing in the transcript.
  const { a: b } = bare('failed', rows6, { stop: false });
  event(b, T('10:03:00'), 'hook:StopFailure');
  ended(b);
  await activity.ingest(b);
  assert.deepEqual(brief(b.id), ['1 gap 10:00:00-10:06:00 agent.peer', '2 model 10:06:00-10:06:30 model.generate', '2 text 10:06:30-10:06:30']);
});
