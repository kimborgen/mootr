import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, tempHome } from './tmphome.mjs';

// S-2125: the banners and reconcile loops share one async tmux snapshot that doesn't block the event loop
// while tmux answers. A stub `tmux` on PATH sleeps (per subcommand, from files in its folder) and logs each call.
const SLOW_MS = 300;
// The longest the event loop may stall during a round; the stub's sleep is six times this.
const BUDGET_MS = 50;
const dir = tempDir('stam-snapshot-async-');
const home = tempHome('stam-snapshot-async-home-');
const log = join(dir, 'calls');
const set = (name, value) => writeFileSync(join(dir, name), String(value));
const calls = (re = /./) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => re.test(l)) : []);
writeFileSync(
  join(dir, 'tmux'),
  `#!/bin/sh
D='${dir}'
cmd=$3
echo "$*" >> "$D/calls"
sleep "$(cat "$D/sleep-$cmd" 2>/dev/null || echo 0.3)"
# A held command waits until the test creates the release file.
while [ -e "$D/hold-$cmd" ] && [ ! -e "$D/release-$cmd" ]; do sleep 0.02; done
echo "done $cmd" >> "$D/calls"
agent=$(cat "$D/agent" 2>/dev/null || echo none)
srv=$(cat "$D/server" 2>/dev/null || echo 4242)
case "$cmd" in
  list-panes) printf '%s 1700000000\\t%s\\t1\\t0\\t1700000001\\t1\\t%%1\\n' "$srv" "$agent" ;;
  display-message) printf '%s 1700000000\\t%s\\n' "$srv" "$agent" ;;
  capture-pane) echo 'MENU shown' ;;
  send-keys) ;;
  *) exit 2 ;;
esac
`,
);
chmodSync(join(dir, 'tmux'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.STAM_TMUX_SOCKET = `stam-test-snapshot-async-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], banners: [{ harness: 'fake', match: 'MENU', keys: ['Enter'] }] }));

let tmux, db, daemon;
before(async () => {
  tmux = await import('../src/tmux.ts');
  db = await import('../src/db.ts');
  daemon = await import('../src/daemon.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent(activity = 'idle') {
  const id = db.newAgentId();
  const cwd = join(home, `work-${++n}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `c${n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity });
  return id;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => {
  for (let i = 0; i < 400 && !fn(); i++) await sleep(25);
  assert.ok(fn(), 'timed out');
};

// The longest gap between 5 ms timer ticks while fn runs, and for 40 ms after it (a block in its last segment).
async function worstStall(fn) {
  let last = performance.now();
  let worst = 0;
  const t = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  try {
    await fn();
    await sleep(40);
  } finally {
    clearInterval(t);
  }
  return worst;
}

test('the sync snapshot blocks for the whole tmux call (the problem)', () => {
  const t0 = performance.now();
  tmux.snapshot();
  const blocked = performance.now() - t0;
  console.log(`# sync snapshot: event loop blocked ${Math.round(blocked)} ms`);
  assert.ok(blocked >= SLOW_MS * 0.8, `${blocked}`);
});

test('a real banners + reconcile round (snapshot, capture, owner, send-keys) blocks the loop under the budget', async () => {
  const id = agent();
  set('agent', id);
  await sleep(1100); // past the sync test's use of the clock; nothing shared yet
  const stall = await worstStall(async () => {
    await Promise.all([daemon.bannersTick(), daemon.reconcileTick()]);
    await until(() => calls(/ send-keys /).length === 1 && db.listEvents(id, 50).some((e) => e.type === 'banner:dismissed'));
  });
  console.log(`# async round: event loop blocked ${Math.round(stall)} ms`);
  assert.ok(stall < BUDGET_MS, `blocked ${stall} ms, budget ${BUDGET_MS}`);
  assert.equal(calls(/ list-panes /).length >= 1, true);
});

test('concurrent callers share one tmux call, and the answer is reused briefly', async () => {
  await sleep(1100);
  const before = calls(/ list-panes /).length;
  const [a, b] = await Promise.all([tmux.sharedSnapshot(), tmux.sharedSnapshot()]);
  assert.equal(a, b);
  assert.equal(a.pane.get(n && [...a.pane.keys()][0]), '%1');
  assert.equal(await tmux.sharedSnapshot(), a);
  assert.equal(calls(/ list-panes /).length - before, 1);
  await sleep(1100);
  await tmux.sharedSnapshot();
  assert.equal(calls(/ list-panes /).length - before, 2);
});

test('a caller arriving after the reuse age still joins a request in flight', async () => {
  await sleep(1100);
  set('sleep-list-panes', 1.5);
  const before = calls(/ list-panes /).length;
  const first = tmux.sharedSnapshot();
  await sleep(1200);
  const late = tmux.sharedSnapshot();
  assert.equal(await late, await first);
  assert.equal(calls(/ list-panes /).length - before, 1, 'no overlapping request');
  rmSync(join(dir, 'sleep-list-panes'));
});

test('a failed snapshot is not reused', async () => {
  await sleep(1100);
  set('sleep-list-panes', 0);
  const path = process.env.PATH;
  const bad = tempDir('stam-snapshot-async-bad-');
  writeFileSync(join(bad, 'tmux'), '#!/bin/sh\necho boom >&2\nexit 2\n');
  chmodSync(join(bad, 'tmux'), 0o755);
  process.env.PATH = `${bad}:${path}`;
  try {
    assert.equal(await tmux.sharedSnapshot(), null);
  } finally {
    process.env.PATH = path;
    rmSync(bad, { recursive: true });
  }
  assert.notEqual(await tmux.sharedSnapshot(), null);
});

test('banners: an agent that starts working during the owner lookup gets no keys', async () => {
  await sleep(1100);
  const id = agent();
  set('agent', id);
  set('sleep-list-panes', 0);
  set('sleep-capture-pane', 0);
  set('sleep-display-message', 0);
  const lookups = () => calls(/ display-message /).filter((l) => !l.startsWith('done')).length;
  const baseline = { lookups: lookups(), keys: calls(/ send-keys /).length };
  set('hold-display-message', 1);
  await daemon.bannersTick();
  await until(() => lookups() === baseline.lookups + 1); // the callback is past its first check, waiting on tmux
  db.updateAgent(id, { activity: 'working' });
  set('release-display-message', 1);
  await until(() => calls(/^done display-message/).length === baseline.lookups + 1);
  await sleep(100); // the callback's remaining microtasks; a send-keys would follow at once
  assert.equal(calls(/ send-keys /).length, baseline.keys, 'no keys after the agent started working');
  assert.equal(db.listEvents(id, 50).some((e) => e.type === 'banner:dismissed'), false);
  for (const f of ['hold-display-message', 'release-display-message', 'sleep-display-message']) rmSync(join(dir, f));
});

test('reconcile: an agent resumed after the snapshot began is not taken for exited', async () => {
  await sleep(1100);
  set('agent', 'other'); // tmux lists a session of another name only: the agents below have none
  set('sleep-list-panes', 0);
  // The first pass sets the server it saw, so the next is not a lost server.
  daemon.reconcile(await tmux.snapshotAsync());
  const gone = agent('working');
  const resumed = agent('working');
  await sleep(30);
  const snap = await tmux.snapshotAsync();
  db.updateAgent(resumed, { activity: 'idle' }); // changes after the snapshot began, as a resume does
  daemon.reconcile(snap);
  assert.equal(db.getAgent(gone).lifecycle, 'shut_down', 'an agent unchanged since is taken for exited');
  assert.equal(db.getAgent(resumed).lifecycle, 'active', 'a changed one waits for the next snapshot');
  await sleep(5); // a snapshot that begins in the millisecond of the update would still wait
  daemon.reconcile(await tmux.snapshotAsync());
  assert.equal(db.getAgent(resumed).lifecycle, 'shut_down', 'and is judged on it');
});

test('reconcile: a lost server is kept for an agent held back by the snapshot, and decided by the next one', async () => {
  await sleep(1100);
  const lost = agent('working');
  const back = agent('working');
  await sleep(30);
  set('server', 5555); // another tmux server than the last pass saw
  const snap = await tmux.snapshotAsync();
  db.updateAgent(lost, { activity: 'idle' });
  db.updateAgent(back, { activity: 'idle' });
  daemon.reconcile(snap);
  assert.equal(db.getAgent(lost).lifecycle, 'active', 'held back: the snapshot is older than its change');
  // The next snapshot, from the same server: one agent has a session again (it was resumed), the other has none.
  await sleep(5);
  set('agent', back);
  daemon.reconcile(await tmux.snapshotAsync());
  const now = db.getAgent(lost);
  assert.equal(now.lifecycle, 'shut_down');
  assert.match(now.activity_detail, /resuming/, 'marked lost to be resumed, not exited');
  assert.equal(db.listEvents(lost, 50).some((e) => e.type === 'tmux-lost'), true);
  assert.equal(db.getAgent(back).lifecycle, 'active', 'a resumed agent with its session is left alone');
  rmSync(join(dir, 'server'));
});
