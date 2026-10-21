#!/usr/bin/env node
// S-908: the daemon archives a shut-down developer minutes after its work is safe: its worktree head
// is merged, or it owns only ITSAs queued for merge, with a clean worktree and a pushed branch. Never a
// paused, waiting or mailed agent, never unpushed or dirty work, and it fails closed. Throwaway STAM_HOME,
// no daemon, no GitHub: `node --test test/auto-archive-queued.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-auto-archive-');
const socket = `auto-archive-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const writeSettings = (archive = {}) => writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], archive }));
writeSettings();

const MIN = 60_000;
let db, lifecycle, itsa, createWorkspace, permissions, waits;
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  itsa = await import('../src/itsa.ts');
  permissions = await import('../src/permissions.ts');
  waits = await import('../src/waits.ts');
  // The daemon registers the ITSA human-status hooks at start; an ask's wait clears through them.
  (await import('../src/itsa-human.ts')).watchHumanStatuses();
  ({ createWorkspace } = await import('../src/workspace.ts'));
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
// A repo with a remote configured and origin/main at its first commit.
function repo() {
  const dir = join(home, `repo-${++n}`);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-qm', 'init');
  gitIn(dir, 'remote', 'add', 'origin', join(home, 'nowhere.git'));
  gitIn(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}
// A shut-down developer in a worktree with one commit of its own; `pushed` puts its head on a remote ref.
function developer({ pushed = true, parent = null } = {}) {
  const ws = createWorkspace({ kind: 'worktree', repo: repo() }, `dev-${n}`);
  gitIn(ws.cwd, 'commit', '--allow-empty', '-qm', 'work');
  if (pushed) gitIn(ws.worktree.repo, 'update-ref', `refs/remotes/origin/${ws.worktree.branch}`, gitIn(ws.cwd, 'rev-parse', 'HEAD'));
  const id = db.newAgentId();
  db.createAgent({ id, name: `d${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: ws.cwd, parent_id: parent, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify(ws), lifecycle: 'shut_down', activity: 'unknown' });
  return { ws, a: db.getAgent(id) };
}
const queuedItsa = (owner, status = 'ready_to_merge') => itsa.create({ title: `Work ${++n}`, by: 'human', owner, kind: 'issue', status });
const sweep = (a) => lifecycle.archiveIdleShutdowns(Date.parse(db.getAgent(a.id).updated_at) + 15 * MIN);
const state = (a) => db.getAgent(a.id).lifecycle;

test('a pushed, clean developer whose ITSA is queued for merge is archived after the short grace, and its parent hears once', async () => {
  const parent = developer().a;
  const { a } = developer({ parent: parent.id });
  await queuedItsa(a.id);
  const stopped = Date.parse(a.updated_at);
  assert.deepEqual(await lifecycle.archiveIdleShutdowns(stopped + 5 * MIN), [], 'not before the grace');
  assert.deepEqual(await sweep(a), [a.name]);
  assert.equal(state(a), 'archived');
  const notices = db.listEvents(parent.id, 100).filter((e) => e.type === 'notice:queued' && /archived automatically/.test(JSON.stringify(e.data ?? e)));
  assert.equal(notices.length, 1);
});

test('a developer whose branch head is merged is archived while its ITSA deploys', async () => {
  const { ws, a } = developer();
  gitIn(ws.worktree.repo, 'update-ref', 'refs/remotes/origin/main', gitIn(ws.cwd, 'rev-parse', 'HEAD'));
  await queuedItsa(a.id, 'deploying');
  assert.deepEqual(await sweep(a), [a.name]);
});

test('an ITSA still in progress, a dirty worktree and an unpushed head keep the developer', async () => {
  const busy = developer().a;
  await queuedItsa(busy.id, 'in_progress');
  const dirty = developer();
  await queuedItsa(dirty.a.id);
  writeFileSync(join(dirty.ws.cwd, 'a.txt'), 'changed\n');
  const unpushed = developer({ pushed: false });
  await queuedItsa(unpushed.a.id);
  for (const x of [busy, dirty.a, unpushed.a]) assert.deepEqual(await sweep(x), []);
  assert.deepEqual([busy, dirty.a, unpushed.a].map(state), ['shut_down', 'shut_down', 'shut_down']);
  assert.ok(db.getAgent(unpushed.a.id).workspace, 'the unpushed worktree is untouched');
});

test('a paused (resting) developer, one with an open wait, and one with unread mail are kept', async () => {
  const paused = developer().a;
  await queuedItsa(paused.id);
  db.updateAgent(paused.id, { lifecycle: 'paused', paused_by: JSON.stringify(['standing-idle']) });
  const waiting = developer().a;
  await queuedItsa(waiting.id);
  db.addWait({ agent_id: waiting.id, kind: 'timer', source: 'agent', until: new Date(Date.now() + 3_600_000).toISOString() });
  const mailed = developer().a;
  await queuedItsa(mailed.id);
  db.createMail({ id: `m${++n}`, from_id: 'human', from_name: 'human', subject: 's', body: 'b', thread_id: `t${n}`, reply_to: null }, [mailed.id]);
  for (const x of [paused, waiting, mailed]) assert.deepEqual(await sweep(x), []);
  assert.deepEqual([paused, waiting, mailed].map(state), ['paused', 'shut_down', 'shut_down']);
});

test('a developer with an open permission ask is kept', async () => {
  const { a } = developer();
  await queuedItsa(a.id);
  db.createPermissionRequest(a.id, 'push', 'needs approval', '');
  assert.deepEqual(await sweep(a), []);
  assert.equal(state(a), 'shut_down');
});

test('an agent resumed between the check and the archive is left running', async () => {
  const { a } = developer();
  await queuedItsa(a.id);
  const at = Date.parse(a.updated_at) + 15 * MIN;
  const pass = lifecycle.archiveIdleShutdowns(at);
  // The pass is awaiting the ITSA home; the resume lands before its re-read.
  db.updateAgent(a.id, { lifecycle: 'active' });
  assert.deepEqual(await pass, []);
  assert.equal(state(a), 'active');
});

test('mail landing between the check and the archive also keeps the agent', async () => {
  const { a } = developer();
  await queuedItsa(a.id);
  const pass = lifecycle.archiveIdleShutdowns(Date.parse(a.updated_at) + 15 * MIN);
  db.createMail({ id: `m${++n}`, from_id: 'human', from_name: 'human', subject: 's', body: 'b', thread_id: `t${n}`, reply_to: null }, [a.id]);
  assert.deepEqual(await pass, []);
  assert.equal(state(a), 'shut_down');
});

test('a second pass archives nothing twice', async () => {
  const { a } = developer();
  await queuedItsa(a.id);
  assert.deepEqual(await sweep(a), [a.name]);
  assert.deepEqual(await lifecycle.archiveIdleShutdowns(Date.now() + 2 * 3_600_000), []);
});

test('archiveWhenQueued: false turns the short grace off', async () => {
  writeSettings({ archiveWhenQueued: false });
  try {
    const { a } = developer();
    await queuedItsa(a.id);
    assert.deepEqual(await sweep(a), []);
    assert.equal(state(a), 'shut_down');
  } finally {
    writeSettings();
  }
});

test('an agent that owns no ITSA stays, though its clean worktree has no commits', async () => {
  const ws = createWorkspace({ kind: 'worktree', repo: repo() }, `bare-${++n}`);
  const id = db.newAgentId();
  db.createAgent({ id, name: `b${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: ws.cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify(ws), lifecycle: 'shut_down', activity: 'unknown' });
  assert.ok(!(await sweep({ id })).includes(db.getAgent(id).name));
  assert.equal(state({ id }), 'shut_down');
});

// Runs a sweep with STAM_DEBUG on and returns the "not archived" lines the daemon logged.
async function loggedSweep(a) {
  const lines = [];
  const orig = console.error;
  const dbg = process.env.STAM_DEBUG;
  console.error = (m) => lines.push(String(m));
  process.env.STAM_DEBUG = '1';
  try {
    const archived = await sweep(a);
    return { archived, lines };
  } finally {
    console.error = orig;
    if (dbg === undefined) delete process.env.STAM_DEBUG;
    else process.env.STAM_DEBUG = dbg;
  }
}

// A clean worktree detached at its pushed head, while the branch ref holds a commit no remote has: the
// sweep's own check passes (HEAD is pushed), so only archive()'s unpushed guard refuses.
function branchAheadOfPushedHead() {
  const d = developer();
  gitIn(d.ws.cwd, 'checkout', '-q', '--detach');
  const head = gitIn(d.ws.cwd, 'rev-parse', 'HEAD');
  const ahead = gitIn(d.ws.cwd, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'only on the branch');
  gitIn(d.ws.cwd, 'update-ref', `refs/heads/${d.ws.worktree.branch}`, ahead);
  return d;
}

test('an archive the unpushed guard refuses reaches the catch, is not retried by the next pass, and writes no event', async () => {
  const { a } = branchAheadOfPushedHead();
  await queuedItsa(a.id);
  const first = await loggedSweep(a);
  assert.deepEqual(first.archived, []);
  assert.equal(first.lines.filter((l) => /archive failed: can't archive .*not on any remote/.test(l)).length, 1, 'the guard refused inside archive()');
  const second = await loggedSweep(a);
  assert.deepEqual(second.archived, []);
  assert.deepEqual(second.lines, [], 'the next pass does not try again');
  assert.equal(db.listEvents(a.id, 100).filter((e) => e.type === 'archive:idle-shutdown').length, 0);
  assert.equal(state(a), 'shut_down');
});

test('a unpushed branch caught by the sweep itself is kept without reaching archive()', async () => {
  const { a } = developer({ pushed: false });
  await queuedItsa(a.id);
  const r = await loggedSweep(a);
  assert.deepEqual(r.archived, []);
  assert.deepEqual(r.lines, []);
  assert.equal(state(a), 'shut_down');
});

// A remote-tracking ref whose object is missing: status and rev-parse still work, rev-list --remotes fails.
function breakRemotes(d) {
  const dir = join(d.ws.worktree.repo, '.git', 'refs', 'remotes', 'origin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'broken'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
}

test('a git error in the clean-and-pushed check keeps the agent, logs once, and is not retried', async () => {
  const d = developer();
  await queuedItsa(d.a.id);
  breakRemotes(d);
  const first = await loggedSweep(d.a);
  assert.deepEqual(first.archived, []);
  assert.equal(first.lines.filter((l) => /couldn't check its worktree/.test(l)).length, 1);
  const second = await loggedSweep(d.a);
  assert.deepEqual(second.archived, []);
  assert.deepEqual(second.lines, [], 'the next pass does not run git again');
  assert.equal(db.listEvents(d.a.id, 100).filter((e) => e.type === 'archive:idle-shutdown').length, 0);
  assert.equal(state(d.a), 'shut_down');
  assert.ok(db.getAgent(d.a.id).workspace, 'the worktree is untouched');
});

test('a git error does not stop the pass: the next agent is still archived', async () => {
  const bad = developer();
  await queuedItsa(bad.a.id);
  breakRemotes(bad);
  const good = developer();
  await queuedItsa(good.a.id);
  const at = Math.max(...[bad.a, good.a].map((x) => Date.parse(db.getAgent(x.id).updated_at))) + 15 * MIN;
  const archived = await lifecycle.archiveIdleShutdowns(at);
  assert.ok(archived.includes(good.a.name));
  assert.ok(!archived.includes(bad.a.name));
  assert.equal(state(bad.a), 'shut_down');
});

test('a clean worktree on a detached HEAD with an unpushed commit is kept', async () => {
  const { ws, a } = developer();
  await queuedItsa(a.id);
  gitIn(ws.cwd, 'checkout', '-q', '--detach');
  gitIn(ws.cwd, 'commit', '--allow-empty', '-qm', 'only here');
  assert.ok(!(await sweep(a)).includes(a.name));
  assert.equal(state(a), 'shut_down');
});

// S-2885: the 12 h rule archives a merged, ITSA-free agent despite a permission request stuck for longer
// than its window, and closes the request; the queued rule is blocked by any pending request.
const HOUR = 3_600_000;
function mergedDeveloper() {
  const d = developer();
  gitIn(d.ws.worktree.repo, 'update-ref', 'refs/remotes/origin/main', gitIn(d.ws.cwd, 'rev-parse', 'HEAD'));
  return d;
}
// Earlier tests' agents also qualify at 13 h and share the per-pass check budget, so run passes until this agent is reached.
async function idlePasses(a, at) {
  const archived = [];
  for (let i = 0; i < 6; i++) archived.push(...(await lifecycle.archiveIdleShutdowns(at)));
  return archived.includes(a.name);
}
const ageRequest = (id, at) => db.open().prepare('UPDATE permission_requests SET created_at = ? WHERE id = ?').run(new Date(at).toISOString(), id);

test('the 12 h rule archives past a permission request older than its window, withdraws it and its ask mail, and writes the event', async () => {
  const { a } = mergedDeveloper();
  const req = await permissions.requestPermission(db.getAgent(a.id), 'push', 'stuck', '', false, {}, 'human');
  const asks = db.permissionMailIds(req.id);
  assert.ok(asks.length, 'the ask mail exists');
  const at = Date.parse(db.getAgent(a.id).updated_at) + 13 * HOUR;
  ageRequest(req.id, at - 13 * HOUR);
  assert.ok(await idlePasses(a, at));
  assert.equal(state(a), 'archived');
  const row = db.getPermissionRequest(req.id);
  assert.equal(row.status, 'withdrawn');
  assert.ok(row.decided_at);
  assert.equal(db.hasPendingPermission(a.id), false);
  assert.ok(db.listEvents(a.id, 100).some((e) => e.type === 'permission:withdrawn' && JSON.stringify(e.data ?? e).includes(req.id)), 'the withdrawal is an event');
  assert.ok(asks.every((id) => db.open().prepare('SELECT 1 FROM mail_recipients WHERE mail_id = ? AND read_at IS NULL').get(id) === undefined), 'the ask mail no longer sits unread in an inbox');
  assert.equal(db.listEvents(a.id, 100).filter((e) => e.type === 'archive:idle-shutdown').length, 1);
});

test('a failing withdrawal does not undo the archive or lose its event', async () => {
  const { a } = mergedDeveloper();
  const req = db.createPermissionRequest(a.id, 'push', 'stuck', '');
  const at = Date.parse(db.getAgent(a.id).updated_at) + 13 * HOUR;
  ageRequest(req.id, at - 13 * HOUR);
  db.open().exec("CREATE TRIGGER boom_withdraw BEFORE UPDATE OF status ON permission_requests BEGIN SELECT RAISE(ABORT, 'boom'); END");
  try {
    assert.ok(await idlePasses(a, at));
  } finally {
    db.open().exec('DROP TRIGGER boom_withdraw');
  }
  assert.equal(state(a), 'archived');
  assert.equal(db.listEvents(a.id, 100).filter((e) => e.type === 'archive:idle-shutdown').length, 1);
});

test('the 12 h rule keeps an agent whose permission request is younger than its window', async () => {
  const { a } = mergedDeveloper();
  const req = db.createPermissionRequest(a.id, 'push', 'fresh', '');
  const at = Date.parse(db.getAgent(a.id).updated_at) + 13 * HOUR;
  ageRequest(req.id, at - HOUR);
  assert.ok(!(await idlePasses(a, at)));
  assert.equal(state(a), 'shut_down');
  assert.equal(db.getPermissionRequest(req.id).status, 'pending');
});

// S-3016: a stale request's waits go with it, the stam wait and the agent's wait_for on the human tied to it.
// The stam wait is what requestPermission adds; the declared one is what wait_for on:'human' adds when the request is pending.
const stamWait = (a, req) => db.addWait({ agent_id: a.id, kind: 'human', target: req.id, detail: 'your approval', source: 'stam' });
const declaredWait = (a, req) => db.addWait({ agent_id: a.id, kind: 'human', target: req.id, detail: 'the push', source: 'declared', data: JSON.stringify({ on: 'human' }) });

test('S-3016: the 12 h rule clears the stam wait and the declared wait on the human tied to a stale request', async () => {
  const { a } = mergedDeveloper();
  const req = db.createPermissionRequest(a.id, 'push', 'stuck', '');
  stamWait(a, req);
  declaredWait(a, req);
  const at = Date.parse(db.getAgent(a.id).updated_at) + 13 * HOUR;
  ageRequest(req.id, at - 13 * HOUR);
  assert.ok(await idlePasses(a, at));
  assert.equal(state(a), 'archived');
  assert.equal(db.getPermissionRequest(req.id).status, 'withdrawn');
  assert.deepEqual(db.listWaits(a.id), [], 'no wait row is left behind');
});

test('S-3016: the 12 h rule clears the reviewers wait of a stale delegate ask', async () => {
  const { a } = mergedDeveloper();
  const req = db.createPermissionRequest(a.id, 'push', 'stuck', '', false, null, 'delegate');
  db.addWait({ agent_id: a.id, kind: 'agent', target: null, detail: 'your parent or the chief of staff', source: 'stam', data: req.id });
  const at = Date.parse(db.getAgent(a.id).updated_at) + 13 * HOUR;
  ageRequest(req.id, at - 13 * HOUR);
  assert.ok(await idlePasses(a, at));
  assert.equal(state(a), 'archived');
  assert.equal(db.getPermissionRequest(req.id).status, 'withdrawn');
  assert.deepEqual(db.listWaits(a.id), [], 'no wait row is left behind');
});

test('S-3016: unrelated waits of a stale-request agent stay, and still keep it from the 12 h archive', async () => {
  const { a } = mergedDeveloper();
  const req = db.createPermissionRequest(a.id, 'push', 'stuck', '');
  stamWait(a, req);
  const event = db.addWait({ agent_id: a.id, kind: 'event', source: 'declared', detail: 'a CI run', data: JSON.stringify({ on: 'event', filter: {} }) });
  const agentWait = db.addWait({ agent_id: a.id, kind: 'agent', target: 'some-other-agent', source: 'declared', detail: "reply from someone" });
  const otherThread = db.addWait({ agent_id: a.id, kind: 'human', source: 'declared', detail: 'reply on another thread', data: JSON.stringify({ on: 'human', thread: 'm-other' }) });
  const at = Date.parse(db.getAgent(a.id).updated_at) + 13 * HOUR;
  ageRequest(req.id, at - 13 * HOUR);
  assert.ok(!(await idlePasses(a, at)));
  assert.equal(state(a), 'shut_down');
  // Nothing withdraws the stale request while the agent is kept, so its stam wait stays too.
  const left = db.listWaits(a.id).map((w) => w.id);
  for (const w of [event, agentWait, otherThread]) assert.ok(left.includes(w.id), `${w.kind} wait stays`);
});

test('S-3016: a failing wait clear does not stop the other withdrawals or the archive', async () => {
  const { a } = mergedDeveloper();
  const first = db.createPermissionRequest(a.id, 'push', 'one', '');
  const second = db.createPermissionRequest(a.id, 'push', 'two', '');
  stamWait(a, first);
  stamWait(a, second);
  const at = Date.parse(db.getAgent(a.id).updated_at) + 13 * HOUR;
  ageRequest(first.id, at - 13 * HOUR);
  ageRequest(second.id, at - 13 * HOUR);
  db.open().exec("CREATE TRIGGER boom_clear BEFORE DELETE ON waits BEGIN SELECT RAISE(ABORT, 'boom'); END");
  try {
    assert.ok(await idlePasses(a, at));
  } finally {
    db.open().exec('DROP TRIGGER boom_clear');
  }
  assert.equal(state(a), 'archived');
  assert.equal(db.getPermissionRequest(first.id).status, 'withdrawn');
  assert.equal(db.getPermissionRequest(second.id).status, 'withdrawn');
  assert.ok(db.listEvents(a.id, 100).some((e) => e.type === 'permission:wait-clear-failed'), 'the failed clear is an event');
});

// S-3080: a delegate ask's wait on its reviewers is tied to the ask: the 12 h rule archives past it and clears it.
test('S-3080: a stale delegate ask’s wait on its reviewers is tied to the ask, so the 12 h rule clears it', async () => {
  const parent = developer().a;
  db.updateAgent(parent.id, { lifecycle: 'active' });
  const { ws, a } = developer({ parent: parent.id });
  gitIn(ws.worktree.repo, 'update-ref', 'refs/remotes/origin/main', gitIn(ws.cwd, 'rev-parse', 'HEAD'));
  const req = await permissions.requestPermission(db.getAgent(a.id), 'push', 'stuck', '', false, {}, 'delegate');
  assert.equal(req.audience, 'delegate');
  assert.deepEqual(db.listWaits(a.id).map((w) => w.data), [req.id]);
  const at = Date.parse(db.getAgent(a.id).updated_at) + 13 * HOUR;
  ageRequest(req.id, at - 13 * HOUR);
  assert.ok(await idlePasses(a, at));
  assert.equal(state(a), 'archived');
  assert.equal(db.getPermissionRequest(req.id).status, 'withdrawn');
  assert.deepEqual(db.listWaits(a.id), [], 'no wait row is left behind');
});

// S-3080: a wait tied to an ITSA's ask (wait_for on the human in its thread) holds the agent while the ask is open,
// and once the ITSA leaves its human status the 12 h rule archives the agent.
test('S-3080: a wait tied to an open ITSA ask keeps the agent, and the ask leaving its human status releases it', async () => {
  const { a } = mergedDeveloper();
  const owner = developer().a;
  const x = await itsa.create({ title: `Ask ${++n}`, by: 'human', owner: owner.id, status: 'in_progress' });
  await itsa.post(x.key, { by: owner.id, body: 'Need a call.' });
  await itsa.set(x.key, { status: 'needs_input' }, owner.id);
  const w = await waits.declare(a.id, { on: 'human', thread: itsa.must(x.id).thread_id, note: 'the call' });
  assert.equal(w.target, x.id);
  const at = Date.parse(db.getAgent(a.id).updated_at) + 13 * HOUR;
  assert.ok(!(await idlePasses(a, at)), 'a live ask keeps the agent');
  assert.equal(state(a), 'shut_down');
  await itsa.set(x.key, { status: 'in_progress' }, owner.id);
  assert.deepEqual(db.listWaits(a.id), []);
  assert.ok(await idlePasses(a, at), 'the ask is settled, so the agent is archived');
  assert.equal(state(a), 'archived');
});

test('the queued rule is blocked by a pending permission request, however old', async () => {
  const { a } = developer();
  await queuedItsa(a.id);
  const req = db.createPermissionRequest(a.id, 'push', 'stuck', '');
  const at = Date.parse(db.getAgent(a.id).updated_at) + 15 * MIN;
  ageRequest(req.id, at - 30 * HOUR);
  assert.deepEqual(await lifecycle.archiveIdleShutdowns(at), []);
  assert.equal(state(a), 'shut_down');
  assert.equal(db.getPermissionRequest(req.id).status, 'pending');
});
