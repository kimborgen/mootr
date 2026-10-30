#!/usr/bin/env node
// Restart tests for suggested input's notices (S-4155). The human's approval writes its own notice's row with the move to
// held, and the claim before Enter writes the typed notice's row with the move to approved, so a daemon that stops at any
// step leaves exactly one row for the agent, and the approval, once claimed, is never typed again. Each approval runs in a
// child process (input-notice-child.mjs) that STAM_TEST_INPUT_CRASH stops at one step; a second child is the next start.
// Requests are real: suggestInput makes them and approveInput approves them. The draft redaction and the archive cleanup
// run in this process, through approveInput and lifecycle.archive. Run with `node --test test/input-notice-restart.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';
import { killTmuxServer } from '../src/tmux-socket.ts';

// A marked test home (src/test-env.ts), so the crash step is honoured.
const tmp = tempDir('stam-input-notice-');
const home = join(tmp, 'home');
mkdirSync(home);
writeFileSync(join(home, '.stam-test-home'), '');
writeFileSync(join(tmp, 'owner'), 'agent=input-notice-restart.test\n');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
const socket = `input-notice-test-${process.pid}`;
process.env.STAM_TMUX_SOCKET = socket;
// Deliver by taking, not by a push from a timer.
process.env.STAM_EVENT_FOLD_MS = '60000';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'STAM_TEST_INPUT_CRASH']) delete process.env[k];

const CHILD = fileURLToPath(new URL('./input-notice-child.mjs', import.meta.url));
const HELD = /End your turn so stam can type it/g;
const TYPED = /typed into your input as written/g;
let db, perm, mail, lifecycle, adapters, tmux;

before(async () => {
  db = await import('../src/db.ts');
  perm = await import('../src/permissions.ts');
  mail = await import('../src/mail.ts');
  lifecycle = await import('../src/lifecycle.ts');
  ({ adapters } = await import('../src/adapters/index.ts'));
  tmux = await import('../src/tmux.ts');
  db.open();
});
after(() => killTmuxServer(socket));

const agent = (id, activity = 'idle', harness = 'claude') => {
  db.createAgent({ id, name: id, role: 'dev', machine: 'x', harness, model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: 's-1' });
  db.updateAgent(id, { lifecycle: 'active', activity });
  return db.getAgent(id);
};
const suggested = async (a, text) => (await perm.suggestInput(a, text, 'to see the tree')).id;
const rows = (id) => db.answerNotices().filter((r) => r.agent_id === id);
const count = (text, re) => (text.match(re) ?? []).length;
const status = (id) => db.getPermissionRequest(id).status;

// The human's approval in a daemon process, stopped at `crash` when given.
function approveIn(a, id, log, crash) {
  const env = { ...process.env, ...(crash ? { STAM_TEST_INPUT_CRASH: crash } : {}) };
  const r = spawnSync(process.execPath, [CHILD, 'approve', a.id, id, db.getPermissionRequest(id).sha256, log], { env, encoding: 'utf8' });
  assert.equal(r.status, crash ? 75 : 0, `exit ${r.status}: ${r.stderr}`);
  return crash ? undefined : JSON.parse(r.stdout);
}

// The next daemon start: restore, one sweep, a take.
function restart(a, log) {
  const r = spawnSync(process.execPath, [CHILD, 'restart', a.id, log], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a stop right after the approval commits tells the agent once, and the next start types the line once', async () => {
  const a = agent('in-approved');
  const log = join(tmp, `${a.id}.log`);
  const id = await suggested(a, 'git status');
  approveIn(a, id, log, 'approved');
  assert.equal(status(id), 'held');
  assert.equal(rows(a.id).length, 1);
  assert.match(rows(a.id)[0].text, HELD);
  const next = restart(a, log);
  assert.equal(next.rowsAfterRestore, 1);
  assert.equal(count(next.taken, HELD), 1, next.taken);
  // The sweep typed it after the start: its own outcome, told once.
  assert.equal(count(next.taken, TYPED), 1, next.taken);
  assert.equal(next.submitted, 'git status\n');
  assert.equal(status(id), 'approved');
  const again = restart(a, log);
  assert.equal(again.rowsAfterRestore, 0);
  assert.equal(again.taken, '');
  assert.equal(again.submitted, 'git status\n');
});

test('a busy agent whose daemon stops right after the approval is still told to end its turn, once', async () => {
  const a = agent('in-busy-stop', 'working');
  const log = join(tmp, `${a.id}.log`);
  const id = await suggested(a, 'make lint');
  approveIn(a, id, log, 'approved');
  const next = restart(a, log);
  assert.equal(next.rowsAfterRestore, 1);
  assert.equal(count(next.taken, HELD), 1, next.taken);
  assert.equal(next.submitted, '');
  assert.equal(status(id), 'held');
  assert.equal(restart(a, log).taken, '');
});

test('a busy hold hands over the approval\'s own row: one row, and a restart before the take delivers it once', async () => {
  const a = agent('in-busy', 'working');
  const log = join(tmp, `${a.id}.log`);
  const id = await suggested(a, 'make test');
  assert.deepEqual(approveIn(a, id, log), { outcome: 'held', why: 'busy' });
  assert.equal(rows(a.id).length, 1);
  const next = restart(a, log);
  assert.equal(next.rowsAfterRestore, 1);
  assert.equal(count(next.taken, HELD), 1, next.taken);
  assert.equal(restart(a, log).rowsAfterRestore, 0);
});

for (const [step, where, typed] of [
  ['claimed', 'after the claim commits, before Enter', ''],
  ['typed', 'after Enter, before the notice is queued', 'git log\n'],
  [undefined, 'after the notice is queued, before the take', 'git log\n'],
]) {
  test(`a stop ${where} delivers the typed notice once and never types the line again`, async () => {
    const a = agent(`in-${step ?? 'queued'}`);
    const log = join(tmp, `${a.id}.log`);
    const id = await suggested(a, 'git log');
    const out = approveIn(a, id, log, step);
    if (!step) assert.equal(out.outcome, 'typed');
    assert.equal(status(id), 'approved');
    // The claim replaced the approval's row with the typed one.
    assert.equal(rows(a.id).length, 1);
    assert.match(rows(a.id)[0].text, TYPED);
    const next = restart(a, log);
    assert.equal(next.rowsAfterRestore, 1);
    assert.equal(count(next.taken, TYPED), 1, next.taken);
    assert.equal(count(next.taken, HELD), 0, next.taken);
    assert.equal(next.submitted, typed);
    const again = restart(a, log);
    assert.equal(again.taken, '');
    assert.equal(again.submitted, typed);
  });
}

test('a draft that holds the approval reaches the agent, and its row keeps the notice without the draft', async () => {
  const a = agent('in-draft');
  const id = await suggested(a, 'make deploy');
  const saved = { type: adapters.claude.typeLiteralInput, box: adapters.claude.inputText };
  adapters.claude.typeLiteralInput = async () => 'draft';
  adapters.claude.inputText = () => 'export TOKEN=ghp_draft_secret';
  try {
    const out = await perm.approveInput(id, db.getPermissionRequest(id).sha256);
    assert.equal(out.why, 'draft');
  } finally {
    adapters.claude.typeLiteralInput = saved.type;
    adapters.claude.inputText = saved.box;
  }
  // One row: the draft notice took the approval's place, with the draft left out.
  assert.equal(rows(a.id).length, 1);
  assert.match(rows(a.id)[0].text, /your input box holds \(a draft, not stored\)/);
  assert.doesNotMatch(rows(a.id)[0].text, /ghp_draft_secret/);
  const take = mail.inTurnTake(a.id);
  assert.match(take.text, /your input box holds `export TOKEN=ghp_draft_secret`/);
  assert.equal(count(take.text, HELD), 0);
});

test('archiving the agent (archiveLocked) drops its answer rows and queued notices with it', async () => {
  adapters.fake = { pushPrompt: async () => true, launch: async () => ({ argv: ['sleep', '600'], env: {} }), afterLaunch: async () => {}, turnRunning: async () => false };
  const a = agent('in-archive', 'idle', 'fake');
  const r = await perm.requestPermission(a, 'Run npm run release', 'needed for the task', '');
  await perm.answerPermission(r.id, false, mail.HUMAN, 'not this week');
  assert.equal(rows(a.id).length, 1);
  assert.equal(mail.queuedNoticeCount(a.id), 1);
  // A shut-down agent takes no wrap-up round: archive runs archiveLocked at once.
  db.updateAgent(a.id, { lifecycle: 'shut_down' });
  assert.equal(await lifecycle.archive(db.getAgent(a.id)), 'done');
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(rows(a.id).length, 0);
  assert.equal(mail.queuedNoticeCount(a.id), 0);
});

// A tmux session for the agent running the fake Claude Code input box (vim insert mode, so the box takes text whatever
// this machine's Claude Code settings say), and the file its submitted lines go to.
const FAKE_BOX = fileURLToPath(new URL('../go/internal/lifecycle/testdata/fake-box.mjs', import.meta.url));
async function boxSession(id) {
  const log = join(tmp, `${id}.submitted`);
  tmux.newSession(id, tmp, { LOG: log, VIM: 'insert' }, [process.execPath, FAKE_BOX]);
  await until('the box to draw', () => tmux.capturePane(id).includes('──────'));
  return log;
}
async function until(what, ok) {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

test('an Enter that can\'t be sent after the claim fails the approval, and its row replaces the typed one', async () => {
  const a = agent('in-unsent');
  const log = await boxSession(a.id);
  const id = await suggested(a, 'make deploy');
  // The real adapter types into the box, the claim goes through, and the typing stops at the barrier before Enter; the
  // session then goes away, so Enter throws.
  const barrier = join(tmp, 'barrier-unsent');
  mkdirSync(barrier);
  writeFileSync(join(barrier, 'hold-enter'), '');
  process.env.STAM_TEST_INPUT_BARRIER = barrier;
  try {
    const approving = perm.approveInput(id, db.getPermissionRequest(id).sha256);
    await until('the typing to reach the barrier', () => existsSync(join(barrier, 'at-enter')));
    tmux.killSession(a.id);
    rmSync(join(barrier, 'hold-enter'));
    assert.equal((await approving).outcome, 'failed');
  } finally {
    delete process.env.STAM_TEST_INPUT_BARRIER;
  }
  assert.equal(read(log), '');
  assert.equal(status(id), 'failed');
  assert.equal(db.getPermissionRequest(id).note, "typed, but Enter not sent: the agent's pane changed or tmux failed");
  assert.equal(rows(a.id).length, 1);
  assert.match(rows(a.id)[0].text, /stam couldn't press Enter/);
  const take = mail.inTurnTake(a.id);
  assert.equal(count(take.text, TYPED), 0, take.text);
  assert.equal(count(take.text, HELD), 0, take.text);
});

test('a first try that throws drops the approval\'s row, so no restart tells the agent to end its turn', async () => {
  const a = agent('in-throws');
  const id = await suggested(a, 'git diff');
  // The claim's write fails, through the real claim, with the fake box saying yes.
  db.open().exec("CREATE TRIGGER in_throws BEFORE UPDATE OF status ON permission_requests WHEN NEW.status = 'approved' AND OLD.agent_id = 'in-throws' BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END");
  const saved = adapters.claude.typeLiteralInput;
  adapters.claude.typeLiteralInput = async (_agent, _text, proceed) => ((await proceed(() => true)) ? 'typed' : 'cancelled');
  try {
    await assert.rejects(perm.approveInput(id, db.getPermissionRequest(id).sha256), /injected claim failure/);
  } finally {
    adapters.claude.typeLiteralInput = saved;
    db.open().exec('DROP TRIGGER in_throws');
  }
  assert.equal(status(id), 'held');
  assert.equal(rows(a.id).length, 0);
  assert.equal(mail.queuedNoticeCount(a.id), 0);
});

test('a claim whose notice row fails rolls back with the approval unsettled, and the approval\'s row still goes', async () => {
  const a = agent('in-rollback');
  const id = await suggested(a, 'git show');
  // The typed row's insert fails after the claim's transaction deleted the approval's row: the rollback puts that row back,
  // and only a settle after the commit (none here) would keep approveInput from dropping it.
  db.open().exec("CREATE TRIGGER in_rollback BEFORE INSERT ON answer_notices WHEN NEW.agent_id = 'in-rollback' AND instr(NEW.text, 'typed into your input') > 0 BEGIN SELECT RAISE(ABORT, 'injected row failure'); END");
  const saved = adapters.claude.typeLiteralInput;
  adapters.claude.typeLiteralInput = async (_agent, _text, proceed) => ((await proceed(() => true)) ? 'typed' : 'cancelled');
  try {
    await assert.rejects(perm.approveInput(id, db.getPermissionRequest(id).sha256), /injected row failure/);
  } finally {
    adapters.claude.typeLiteralInput = saved;
    db.open().exec('DROP TRIGGER in_rollback');
  }
  assert.equal(status(id), 'held');
  assert.equal(rows(a.id).length, 0);
});
