#!/usr/bin/env node
// S-1373: archiving an agent archives its idle or shut-down children recursively, and leaves
// working children alone, reparented to the archived agent's parent and named in the result.
// Throwaway STAM_HOME and tmux socket, fake harness, no daemon, no models:
// `node --test test/archive-cascade.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-archive-cascade-');
const socket = `archive-cascade-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));

let db, lifecycle, mail, createWorkspace, daemon;
// Fake-harness state: agent ids whose server still runs a turn with no pane, agent ids whose
// `turnRunning` probe throws, a slow `turnRunning` probe per agent, and launches held open, per
// agent, so a test can make one resolve late.
const turnAlive = new Set();
const turnThrow = new Set();
const turnProbe = new Map();
const launchGates = new Map();
// What stam pushed into each agent, so a test can check the archive's wrap-up went in.
const pushed = new Map();
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  mail = await import('../src/mail.ts');
  daemon = await import('../src/daemon.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  ({ createWorkspace } = await import('../src/workspace.ts'));
  adapters.fake = {
    pushPrompt: async (a, text) => {
      pushed.set(a.id, [...(pushed.get(a.id) ?? []), text]);
      return true;
    },
    launch: async (a) => {
      const gate = launchGates.get(a.id);
      if (gate) await gate.promise;
      return { argv: ['sleep', '600'], env: {} };
    },
    afterLaunch: async () => {},
    turnRunning: async (a) => {
      if (turnThrow.has(a.id)) throw new Error('the server did not answer');
      const probe = turnProbe.get(a.id);
      if (probe) {
        await probe.promise;
        return probe.value;
      }
      return turnAlive.has(a.id);
    },
  };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});


const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);
let n = 0;
function agent({ parent = null, activity = 'idle', lifecycle = 'active' } = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `c${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: parent, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle, activity });
  return db.getAgent(id);
}

test('archiving a manager archives its idle children recursively and reparents the working one', async () => {
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const idle = agent({ parent: mgr.id });
  const grand = agent({ parent: idle.id, lifecycle: 'shut_down', activity: 'unknown' });
  const busy = agent({ parent: mgr.id, activity: 'working' });
  const result = await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.equal(db.getAgent(mgr.id).lifecycle, 'archived');
  assert.equal(db.getAgent(idle.id).lifecycle, 'archived');
  assert.equal(db.getAgent(grand.id).lifecycle, 'archived');
  assert.equal(db.getAgent(busy.id).lifecycle, 'active', 'the working child keeps running');
  assert.deepEqual(db.parentsOf(db.getAgent(busy.id)), [boss.id]);
  assert.match(result, new RegExp(`also archived idle ${idle.name}`));
  assert.match(result, new RegExp(`left alone, now reporting to ${boss.name}: ${busy.name} \\(working\\)`));
});

test('an archived manager with no parent hands a working child to nobody when no chief of staff exists', async () => {
  const mgr = agent();
  const busy = agent({ parent: mgr.id, activity: 'working' });
  await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.equal(db.getAgent(mgr.id).lifecycle, 'archived');
  assert.deepEqual(db.parentsOf(db.getAgent(busy.id)), []);
});

// An agent in a real worktree holding an uncommitted change, so only discard removes it.
function dirty({ parent, lifecycle = 'shut_down', activity = 'unknown' }) {
  const repo = join(home, `repo-${++n}`);
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const ws = createWorkspace({ kind: 'worktree', repo }, `dirty-${n}`);
  writeFileSync(join(ws.cwd, 'a.txt'), 'changed\n');
  const id = db.newAgentId();
  db.createAgent({ id, name: `d${n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: ws.cwd, parent_id: parent, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify(ws), lifecycle, activity });
  return { id, ws };
}

test('a child whose archive fails is reparented, not orphaned, and named in the result', async () => {
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const d = dirty({ parent: mgr.id });
  const result = await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.equal(db.getAgent(d.id).lifecycle, 'shut_down');
  assert.deepEqual(db.parentsOf(db.getAgent(d.id)), [boss.id]);
  assert.match(result, /couldn't archive d\d+/);
});

test('discard applies to the named agent only: a dirty idle child keeps its changes', async () => {
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const d = dirty({ parent: mgr.id });
  await lifecycle.archiveCascade(db.getAgent(mgr.id), true, true);
  assert.equal(db.getAgent(mgr.id).lifecycle, 'archived');
  assert.equal(db.getAgent(d.id).lifecycle, 'shut_down');
  assert.ok(existsSync(join(d.ws.cwd, 'a.txt')), 'the dirty worktree stays');
  assert.deepEqual(db.parentsOf(db.getAgent(d.id)), [boss.id]);
});

test('a failing archive of the manager touches no child', async () => {
  const mgr = agent();
  const idle = agent({ parent: mgr.id });
  const busy = agent({ parent: mgr.id, activity: 'working' });
  db.updateAgent(mgr.id, { lifecycle: 'archived' });
  await assert.rejects(lifecycle.archiveCascade(db.getAgent(mgr.id)), /already archived/);
  assert.equal(db.getAgent(idle.id).lifecycle, 'active');
  assert.deepEqual(db.parentsOf(db.getAgent(busy.id)), [mgr.id]);
});

test('an idle child with another live parent keeps running under it', async () => {
  const boss = agent();
  const other = agent({ activity: 'working' });
  const mgr = agent({ parent: boss.id });
  const shared = agent({ parent: mgr.id });
  db.addParent(shared.id, other.id);
  const result = await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.equal(db.getAgent(shared.id).lifecycle, 'active');
  assert.deepEqual(db.parentsOf(db.getAgent(shared.id)), [other.id]);
  assert.match(result, new RegExp(`${shared.name} \\(also reports to ${other.name}\\)`));
});

test('a busy grandchild goes to the manager\'s live parent, and its note reaches the result', async () => {
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const sub = agent({ parent: mgr.id });
  const busy = agent({ parent: sub.id, activity: 'working' });
  const result = await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.equal(db.getAgent(sub.id).lifecycle, 'archived');
  assert.deepEqual(db.parentsOf(db.getAgent(busy.id)), [boss.id]);
  assert.match(result, new RegExp(`${busy.name} \\(working\\)`));
  assert.ok(events(busy.id, 'parents').length >= 1);
});

test('an idle child whose harness still runs is asked for its final round, not reported archived', async () => {
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const live = agent({ parent: mgr.id });
  turnAlive.add(live.id);
  const result = await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.equal(db.getAgent(live.id).lifecycle, 'active');
  assert.equal(JSON.parse(db.getAgent(live.id).pending_action).type, 'archive');
  assert.match(result, new RegExp(`asked idle ${live.name} for their final round`));
  assert.doesNotMatch(result, /also archived/);
  turnAlive.delete(live.id);
});

test('an idle child in its final round is reparented at once and stays so when its archive fails at the deadline', async () => {
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const d = dirty({ parent: mgr.id, lifecycle: 'active', activity: 'idle' });
  turnAlive.add(d.id);
  await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.deepEqual(db.parentsOf(db.getAgent(d.id)), [boss.id]);
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  assert.equal(db.getAgent(d.id).lifecycle, 'active', 'its archive failed on the dirty worktree');
  assert.deepEqual(db.parentsOf(db.getAgent(d.id)), [boss.id]);
  turnAlive.delete(d.id);
});

// S-1378: children on another machine.
test('the cascade asks the other machines and merges their answers into the result', async () => {
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  let asked;
  const result = await lifecycle.archiveCascade(db.getAgent(mgr.id), false, false, async (parents, fallback) => {
    asked = { parents, fallback };
    return [
      { machine: 'store', report: { archived: ['dev1'], archiving: [], kept: ['dev2 (working)'], failed: [], ids: [] } },
      { machine: 'down', error: 'down is unreachable' },
    ];
  });
  assert.deepEqual(asked, { parents: [mgr.id], fallback: [boss.id] });
  assert.match(result, /also archived idle dev1 on store/);
  assert.match(result, /dev2 \(working\) on store/);
  assert.match(result, /couldn't archive children on down \(down is unreachable; it may still be running there\)/);
  assert.equal(db.getAgent(mgr.id).lifecycle, 'archived');
});

test('a peer runs the cascade over the children it holds of a parent that lives elsewhere', async () => {
  const boss = agent();
  const idle = agent({ parent: 'remote-mgr' });
  const busy = agent({ parent: 'remote-mgr', activity: 'working' });
  const rep = await lifecycle.cascadeForPeer(['remote-mgr'], [boss.id]);
  assert.deepEqual(rep.archived, [idle.name]);
  assert.equal(db.getAgent(idle.id).lifecycle, 'archived');
  assert.deepEqual(db.parentsOf(db.getAgent(busy.id)), [boss.id]);
});

test('a co-parent known to no registry and no peer is dropped; one a peer knows keeps the child', async () => {
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const orphaned = agent({ parent: mgr.id });
  db.addParent(orphaned.id, 'forgotten-agent');
  const kept = agent({ parent: mgr.id });
  db.addParent(kept.id, 'peer-agent');
  db.rememberPeerAgent({ id: 'peer-agent', name: 'peerbob', machine: 'store', lifecycle: 'active' });
  await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.equal(db.getAgent(orphaned.id).lifecycle, 'archived');
  assert.equal(db.getAgent(kept.id).lifecycle, 'active');
  assert.deepEqual(db.parentsOf(db.getAgent(kept.id)), ['peer-agent']);
});

test('a final-round archive that fails at its deadline tells the parent', async () => {
  const boss = agent();
  const d = dirty({ parent: boss.id, lifecycle: 'active', activity: 'idle' });
  turnAlive.add(d.id);
  await lifecycle.archive(db.getAgent(d.id));
  const before = events(boss.id, 'notice:queued').length;
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  assert.equal(db.getAgent(d.id).lifecycle, 'active');
  const notices = events(boss.id, 'notice:queued').slice(before);
  assert.ok(notices.some((e) => (e.data ?? '').includes('failed at its final-round deadline')), 'the parent was told');
  turnAlive.delete(d.id);
});

// S-2452: a standing child is never archived with its parent. It moves to the archived agent's live parent
// (else the chief of staff) when that parent can control it here, and stays unarchived with the reason when not.
async function setChiefOfStaff(name) {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], chiefOfStaff: name }));
  (await import('../src/settings.ts')).settingsChanged();
}

test('a standing idle child is moved to the archived agent\'s parent and not archived; a plain idle child still cascades', async () => {
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const standing = agent({ parent: mgr.id });
  db.updateAgent(standing.id, { standing: 1 });
  const idle = agent({ parent: mgr.id });
  const result = await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.equal(db.getAgent(standing.id).lifecycle, 'active', 'the standing child is not archived');
  assert.deepEqual(db.parentsOf(db.getAgent(standing.id)), [boss.id]);
  assert.equal(db.getAgent(idle.id).lifecycle, 'archived', 'a non-standing idle child still cascades');
  assert.match(result, new RegExp(`moved standing ${standing.name} to ${boss.name}`));
  assert.match(result, new RegExp(`also archived idle ${idle.name}`));
});

test('a standing child whose new parent is registered on another machine stays unarchived, and the result says why', async () => {
  const mgr = agent({ parent: 'remote-boss' });
  const standing = agent({ parent: mgr.id });
  db.updateAgent(standing.id, { standing: 1 });
  const result = await lifecycle.archiveCascade(db.getAgent(mgr.id));
  assert.equal(db.getAgent(standing.id).lifecycle, 'active');
  assert.deepEqual(db.parentsOf(db.getAgent(standing.id)), [mgr.id]);
  assert.match(result, new RegExp(`kept standing ${standing.name} \\(remote-boss can't control it on this machine\\) unarchived`));
  assert.doesNotMatch(result, /moved standing/);
});

test('a standing child of an archived agent with no parent moves to the chief of staff', async () => {
  const cos = agent();
  await setChiefOfStaff(cos.name);
  try {
    const mgr = agent();
    const standing = agent({ parent: mgr.id });
    db.updateAgent(standing.id, { standing: 1 });
    const result = await lifecycle.archiveCascade(db.getAgent(mgr.id));
    assert.equal(db.getAgent(standing.id).lifecycle, 'active');
    assert.deepEqual(db.parentsOf(db.getAgent(standing.id)), [cos.id]);
    assert.match(result, new RegExp(`moved standing ${standing.name} to ${cos.name}`));
  } finally {
    await setChiefOfStaff(null);
  }
});
