#!/usr/bin/env node
// Unit test for Claude Code's part of stam's own agent view (src/adapters/claude-view.ts):
// a realistic transcript (test/fixtures/claude-view.jsonl: a prompt, a Bash tool with its
// result, a thinking block that is empty then one with text, a failing tool, a sidechain,
// an attachment, a second turn) mapped to view messages and paged, and appended rows
// followed into the store. Throwaway STAM_HOME, no daemon, no model:
// `node --test test/claude-view.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-claude-view-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `claude-view-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const rows = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/claude-view.jsonl'), 'utf8').split('\n').filter(Boolean);
const file = join(home, 'transcript.jsonl');
const A = 'cl-agent';
let db, claudeView, view, agent;

// A LiveSink like agent-view's: the store plus counters for what the stream would flush.
function sink() {
  const s = { store: new view.ViewStore(), changes: 0, resyncs: 0 };
  s.changed = () => s.changes++;
  s.resync = () => s.resyncs++;
  return s;
}
// Waits for a condition the follow poll brings about; the test never sleeps for a fixed time.
async function until(cond, what) {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const ids = (msgs) => msgs.map((m) => m.id);
const msg = (s, id) => s.store.messages.find((m) => m.id === id);

before(async () => {
  db = await import('../src/db.ts');
  await import('../src/adapters/index.ts'); // the registry first, as the daemon loads it
  view = await import('../src/agent-view.ts');
  claudeView = (await import('../src/adapters/claude-view.ts')).claudeView;
  db.createAgent({ id: A, name: 'cl', role: 'dev', machine: 'x', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: '/tmp/cl', parent_id: null, session_id: 'sess-1' });
  writeFileSync(file, rows.join('\n') + '\n');
  db.updateAgent(A, { transcript_path: file, activity: 'idle' });
  agent = db.getAgent(A);
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

test('the transcript maps to turns: tool results fill their tool part, sidechains and attachments are left out', async () => {
  const { messages, older } = await claudeView.page(agent, { limit: 50 });
  assert.equal(older, null);
  assert.deepEqual(ids(messages), ['u1', 'a1', 'u4', 'a5']);
  const [prompt, turn, , reply] = messages;
  assert.deepEqual(prompt.parts, [{ type: 'text', text: 'Run the tests and tell me the result.' }]);
  assert.equal(prompt.role, 'user');
  // One turn: text, the Bash call with its output, the reasoning, the failing call, the closing text.
  assert.deepEqual(turn.parts, [
    { type: 'text', text: 'Running them now.' },
    { type: 'tool', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'Run the test suite' }, output: 'ok 12 passed', status: 'done' },
    { type: 'reasoning', text: 'The tests passed; the lint is next.' },
    { type: 'tool', id: 'toolu_2', name: 'Bash', input: { command: 'npm run lint' }, output: 'lint: 2 errors', status: 'error' },
    { type: 'text', text: "Lint failed with 2 errors; I'll fix them." },
  ]);
  assert.equal(turn.role, 'assistant');
  assert.deepEqual(reply.parts, [{ type: 'text', text: "You're welcome." }]);
});

test('an empty thinking block is no reasoning part', async () => {
  const { messages } = await claudeView.page(agent, { limit: 50 });
  assert.ok(!messages[1].parts.some((p) => p.type === 'reasoning' && p.text === ''));
});

test('paging: the newest page, then the older ones by `before`', async () => {
  const first = await claudeView.page(agent, { limit: 2 });
  assert.deepEqual(ids(first.messages), ['u4', 'a5']);
  assert.equal(first.older, 'u4');
  const second = await claudeView.page(agent, { limit: 2, before: first.older });
  assert.deepEqual(ids(second.messages), ['u1', 'a1']);
  assert.equal(second.older, null);
});

test('status: working or blocked is running; a blocked dialog with no recorded request is shown read-only', async () => {
  db.updateAgent(A, { activity: 'working' });
  assert.equal((await claudeView.status(db.getAgent(A))).running, true);
  db.updateAgent(A, { activity: 'blocked', activity_detail: 'permission Bash' });
  const st = await claudeView.status(db.getAgent(A));
  assert.equal(st.running, true);
  assert.deepEqual(st.permissions, [{ id: `blocked:${A}`, action: 'permission', resources: ['permission Bash'] }]);
  db.updateAgent(A, { activity: 'idle', activity_detail: null });
  assert.deepEqual(await claudeView.status(db.getAgent(A)), { running: false, permissions: [] });
});

test('follow: appended rows update the message they belong to, and a new turn joins the window', async () => {
  // The transcript so far is the first six rows: a turn that is still going.
  const partial = join(home, 'partial.jsonl');
  writeFileSync(partial, rows.slice(0, 6).join('\n') + '\n');
  db.updateAgent(A, { transcript_path: partial, activity: 'working' });
  const live = sink();
  const stop = claudeView.follow(db.getAgent(A), live);
  try {
    // The page is the store's first content; follow adds nothing that's already there.
    live.store.merge((await claudeView.page(db.getAgent(A), { limit: 50 })).messages);
    await until(() => live.store.running, 'running from the activity');
    assert.deepEqual(ids(live.store.messages), ['u1', 'a1']);

    // The turn's tail and the lint's result arrive, appended one row at a time.
    appendFileSync(partial, rows[6] + '\n');
    await until(() => msg(live, 'a1').parts.some((p) => p.type === 'text' && p.text.startsWith('Lint failed')), 'the closing text');
    assert.deepEqual(msg(live, 'a1').parts[1], { type: 'tool', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'Run the test suite' }, output: 'ok 12 passed', status: 'done' });
    assert.equal(msg(live, 'a1').parts[3].status, 'error');
    assert.equal(live.resyncs, 0);

    // The turn ends; the next prompt is a new message.
    appendFileSync(partial, rows.slice(8).join('\n') + '\n');
    db.updateAgent(A, { activity: 'idle' });
    await until(() => ids(live.store.messages).join() === 'u1,a1,u4,a5', 'the second turn');
    await until(() => !live.store.running, 'not running once idle');
    assert.equal(live.resyncs, 0);
    assert.ok(live.changes > 0);
  } finally {
    stop();
  }
});

test('follow: a transcript replaced by a shorter file is re-read, not patched', async () => {
  const replaced = join(home, 'replaced.jsonl');
  writeFileSync(replaced, rows.join('\n') + '\n');
  db.updateAgent(A, { transcript_path: replaced, activity: 'idle' });
  const live = sink();
  const stop = claudeView.follow(db.getAgent(A), live);
  try {
    writeFileSync(replaced, rows.slice(0, 1).join('\n') + '\n');
    await until(() => live.resyncs > 0, 'a resync after the file shrank');
  } finally {
    stop();
  }
});

test('follow: a new transcript path (the session changed) is re-read', async () => {
  const first = join(home, 'first.jsonl');
  const second = join(home, 'second.jsonl');
  writeFileSync(first, rows.slice(0, 1).join('\n') + '\n');
  writeFileSync(second, rows.slice(0, 3).join('\n') + '\n');
  db.updateAgent(A, { transcript_path: first, activity: 'idle' });
  const live = sink();
  const stop = claudeView.follow(db.getAgent(A), live);
  try {
    db.updateAgent(A, { transcript_path: second });
    await until(() => live.resyncs > 0, 'a resync after the path changed');
  } finally {
    stop();
  }
});

test('a partial last line waits for its newline', async () => {
  const t = new (await import('../src/adapters/claude-view.ts')).Transcript(join(home, 'partial-line.jsonl'));
  writeFileSync(join(home, 'partial-line.jsonl'), rows[0].slice(0, 40));
  assert.equal(t.read().touched.size, 0);
  appendFileSync(join(home, 'partial-line.jsonl'), rows[0].slice(40) + '\n');
  assert.deepEqual([...t.read().touched], ['u1']);
  assert.deepEqual(ids(t.messages), ['u1']);
});

// A sink whose resync re-reads the page the way agent-view does: from the agent snapshot it
// was given (stale on purpose, as openLive's `l.agent` is).
function pagedSink(snapshot) {
  const live = sink();
  live.resync = () => {
    live.resyncs++;
    claudeView.page(snapshot, { limit: 50 }).then((p) => live.store.merge(p.messages));
  };
  return live;
}

test('a session change shows the new transcript, even with a stale agent snapshot', async () => {
  const old = join(home, 'session-old.jsonl');
  const fresh = join(home, 'session-new.jsonl');
  writeFileSync(old, rows[10] + '\n');
  writeFileSync(fresh, rows.slice(0, 3).join('\n') + '\n');
  db.updateAgent(A, { transcript_path: old, activity: 'idle' });
  const snapshot = db.getAgent(A);
  const live = pagedSink(snapshot);
  const stop = claudeView.follow(snapshot, live);
  try {
    live.store.merge((await claudeView.page(snapshot, { limit: 50 })).messages);
    assert.deepEqual(ids(live.store.messages), ['a5']);
    db.updateAgent(A, { transcript_path: fresh });
    await until(() => ids(live.store.messages).join() === 'u1,a1', 'the new session\'s rows');
    assert.ok(live.resyncs > 0);
  } finally {
    stop();
    db.updateAgent(A, { transcript_path: old });
  }
});

test('a page read first doesn\'t hide an appended row from the follow', async () => {
  const partial = join(home, 'shared.jsonl');
  writeFileSync(partial, rows.slice(0, 6).join('\n') + '\n');
  db.updateAgent(A, { transcript_path: partial, activity: 'working' });
  const cur = db.getAgent(A);
  const live = pagedSink(cur);
  const stop = claudeView.follow(cur, live);
  try {
    live.store.merge((await claudeView.page(cur, { limit: 50 })).messages);
    appendFileSync(partial, rows[6] + '\n');
    // The page reads the row first, and the follow must still see that a1 changed.
    await claudeView.page(cur, { limit: 50 });
    await until(() => msg(live, 'a1').parts.some((p) => p.type === 'text' && p.text.startsWith('Lint failed')), 'the row the page read');
  } finally {
    stop();
  }
});

test('a page is a copy: changing it leaves the next page as the transcript wrote it', async () => {
  db.updateAgent(A, { transcript_path: file, activity: 'idle' });
  const cur = db.getAgent(A);
  const first = await claudeView.page(cur, { limit: 50 });
  first.messages[0].parts[0].text = 'changed by a caller';
  const second = await claudeView.page(cur, { limit: 50 });
  assert.equal(second.messages[0].parts[0].text, 'Run the tests and tell me the result.');
});

test('prompts to one agent queue: the second is refused once the first has taken the box', async () => {
  const { claude } = await import('../src/adapters/claude.ts');
  const real = claude.typeHumanInput;
  db.updateAgent(A, { transcript_path: file, activity: 'idle' });
  // Like the real one: refuses unless idle, then takes a moment and turns the agent busy.
  claude.typeHumanInput = async (a) => {
    if (db.getAgent(a.id).activity !== 'idle') return false;
    await new Promise((r) => setTimeout(r, 30));
    db.updateAgent(a.id, { activity: 'working' });
    return true;
  };
  try {
    const cur = db.getAgent(A);
    const [one, two] = await Promise.allSettled([claudeView.prompt(cur, 'first'), claudeView.prompt(cur, 'second')]);
    assert.equal(one.status, 'fulfilled');
    assert.equal(two.status, 'rejected');
    assert.equal(two.reason.status, 409);
  } finally {
    claude.typeHumanInput = real;
    db.updateAgent(A, { activity: 'idle' });
  }
});

// S-278: the shape of a real Claude Code transcript (a developer's, 2026-10-12) where mail came
// in and went out mid-turn: attachment rows between the blocks, the stam notice as hook
// context, then read_mail and send_mail calls, one row per block. The daemon's mail and the
// web view's layout put each mail right after the call before it, not after the turn. The
// turn ends at Claude Code's turn_duration row, and the stam channel message that wakes the
// agent (a meta row) is a notice that starts the next turn, not more of the last one.
test('mail in and out during a real-shaped turn sits where it happened, and a stam notice starts the next turn', async () => {
  const { layout } = await import('../web/src/views/ownview-model.ts');
  const t0 = Date.parse('2026-10-12T23:43:29.746Z');
  const iso = (ms) => new Date(ms).toISOString();
  const at = (s) => iso(t0 + s * 1000);
  const use = (uuid, s, id, name, input = {}) => ({ type: 'assistant', uuid, isSidechain: false, timestamp: at(s), message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const result = (uuid, s, id, text) => ({ type: 'user', uuid, isSidechain: false, timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
  const attach = (s, attachment) => ({ type: 'attachment', isSidechain: false, timestamp: at(s), attachment });
  const said = (uuid, s, text) => ({ type: 'assistant', uuid, isSidechain: false, timestamp: at(s), message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] } });
  const real = [
    { type: 'user', uuid: 'p1', isSidechain: false, timestamp: at(0), message: { role: 'user', content: 'You now own ITSA S-271.' } },
    attach(0, { type: 'skill_listing', content: '- adhd' }),
    use('b1', 2, 'toolu_a', 'mcp__stam__itsa_get', { key: 'S-271' }),
    result('r1', 2.2, 'toolu_a', 'S-271: in_progress'),
    use('b2', 34, 'toolu_b', 'Bash', { command: 'npm test' }),
    attach(34, { type: 'hook_additional_context', content: ['[stam] You have 1 unread mail'] }),
    result('r2', 34.1, 'toolu_b', 'ok'),
    use('b3', 74.3, 'toolu_c', 'mcp__stam__read_mail'),
    result('r3', 74.4, 'toolu_c', '## m70ccf09: Re: S-271'),
    said('b4', 78, 'S-238 is already merged.'),
    use('b5', 85.3, 'toolu_d', 'mcp__stam__send_mail', { to: ['haiku-exp'], subject: 'Re: S-271' }),
    result('r5', 85.5, 'toolu_d', 'Sent m3c5851c in thread m3c5851c.'),
    use('b6', 90, 'toolu_e', 'mcp__stam__wait_for', { from: 'haiku-exp' }),
    result('r6', 90.1, 'toolu_e', 'waiting'),
    said('b7', 95, 'Waiting for the review.'),
    // The turn ends; a mail wakes the agent through a stam channel message, a new turn.
    { type: 'system', subtype: 'turn_duration', isSidechain: false, timestamp: at(95.1), durationMs: 95000 },
    { type: 'queue-operation', operation: 'enqueue', timestamp: at(150), content: '<channel source="stam" kind="mail">' },
    { type: 'user', uuid: 'n1', isMeta: true, isSidechain: false, origin: { kind: 'channel', server: 'stam' }, timestamp: at(150.1), message: { role: 'user', content: '<channel source="stam" kind="mail">\n[stam] You have 1 unread mail.\n</channel>' } },
    use('b8', 152, 'toolu_f', 'mcp__stam__read_mail'),
    result('r8', 152.1, 'toolu_f', '## m9e70048: Re: S-271'),
  ];
  const f = join(home, 'real-shape.jsonl');
  writeFileSync(f, real.map((r) => JSON.stringify(r)).join('\n') + '\n');
  db.createAgent({ id: 'cl-real', name: 'b-dev-1', role: 'dev', machine: 'x', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: '/tmp/b', parent_id: null, session_id: 'sess-real' });
  db.updateAgent('cl-real', { transcript_path: f, activity: 'idle' });
  const mail = (id, from, to, s) => {
    db.createMail({ id, from_id: from, from_name: from, subject: 'Re: S-271', body: 'b', thread_id: 'mfa33f25', reply_to: null }, [to]);
    db.open().prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(at(s), id);
  };
  mail('m70ccf09', 'haiku-exp', 'cl-real', 53.2); // arrived during the Bash call's turn, read at 74
  mail('m3c5851c', 'cl-real', 'haiku-exp', 85.4); // sent by the send_mail call
  mail('m9e70048', 'haiku-exp', 'cl-real', 149); // arrived while the agent was idle, and woke it
  const a = db.getAgent('cl-real');
  const page = await claudeView.page(a, { limit: 50 });
  const shown = layout(view.withMail(a, page.messages, false));
  const what = (m) => (m.kind === 'mail' ? m.id : m.kind === 'notice' ? `notice: ${m.parts[0].text}` : m.parts.map((p) => (p.type === 'tool' ? p.name.replace('mcp__stam__', '') : p.type)).join(','));
  assert.deepEqual(shown.map(what), ['text', 'itsa_get,Bash', 'mail:m70ccf09', 'read_mail,text,send_mail', 'mail:m3c5851c', 'wait_for,text', 'mail:m9e70048', 'notice: [stam] You have 1 unread mail.', 'read_mail']);
});
