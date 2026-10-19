#!/usr/bin/env node
// S-2128: the daemon's timers (banners every 3 s, reconcile every 5 s, stale-working every 10 s, and the pending
// archive sweep inside reconcile) read live agents, not every agent ever made. With 2000 archived agents beside 50
// live ones, a round of all four reads only the live rows and stays under a time budget. A stub `tmux` answers the
// snapshot. Run with `node --test test/agent-reads.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, tempHome } from './tmphome.mjs';

const ARCHIVED = 2000;
const LIVE = 50;
// A round of the four timers over 2050 agents takes a few ms; the budget leaves room for a slow machine.
const BUDGET_MS = 250;
const dir = tempDir('stam-agent-reads-');
const home = tempHome('stam-agent-reads-home-');
writeFileSync(
  join(dir, 'tmux'),
  `#!/bin/sh
case "$3" in
  list-panes) printf '4242 1700000000\\tnone\\t1\\t0\\t1700000001\\t1\\t%%1\\n' ;;
  *) exit 2 ;;
esac
`,
);
chmodSync(join(dir, 'tmux'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.STAM_TMUX_SOCKET = `stam-test-agent-reads-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], banners: [{ harness: 'fake', match: 'MENU', keys: ['Enter'] }] }));

let db, daemon, lifecycle, handle;
before(async () => {
  db = await import('../src/db.ts');
  daemon = await import('../src/daemon.ts');
  lifecycle = await import('../src/lifecycle.ts');
  handle = db.open();
  for (let i = 0; i < ARCHIVED + LIVE; i++) {
    const id = db.newAgentId();
    const cwd = join(home, `w-${i}`);
    mkdirSync(cwd);
    db.createAgent({ id, name: `a${i}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `s-${id}` });
    db.updateAgent(id, i < ARCHIVED ? { lifecycle: 'archived', activity: 'unknown' } : { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity: 'working' });
  }
});
after(() => rmSync(home, { recursive: true, force: true }));

// Counts the rows every `FROM agents` statement returns while fn runs.
async function rowsRead(fn) {
  let rows = 0;
  const prepare = handle.prepare.bind(handle);
  handle.prepare = (sql) => {
    const st = prepare(sql);
    if (!/FROM agents/i.test(sql)) return st;
    return new Proxy(st, {
      get(t, k) {
        const v = t[k];
        if (typeof v !== 'function') return v;
        return (...args) => {
          const r = v.apply(t, args);
          rows += Array.isArray(r) ? r.length : r ? 1 : 0;
          return r;
        };
      },
    });
  };
  try {
    await fn();
  } finally {
    handle.prepare = prepare;
  }
  return rows;
}

test('listLiveAgents leaves archived agents out; listPendingAgents reads only agents with a pending action', () => {
  assert.equal(db.listLiveAgents().length, LIVE);
  assert.equal(db.listAgents().length, ARCHIVED + LIVE);
  assert.equal(db.listPendingAgents().length, 0);
  const id = db.listLiveAgents()[0].id;
  db.updateAgent(id, { pending_action: JSON.stringify({ type: 'compact' }) });
  assert.deepEqual(db.listPendingAgents().map((a) => a.id), [id]);
  db.updateAgent(id, { pending_action: null });
});

test('the partial indexes serve the live and pending reads', () => {
  const plan = (sql) => handle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  assert.match(plan("SELECT * FROM agents WHERE lifecycle != 'archived' ORDER BY created_at"), /agents_live/);
  assert.match(plan('SELECT * FROM agents WHERE pending_action IS NOT NULL ORDER BY created_at'), /agents_pending/);
});

test('one banners + reconcile + stale-working + archive-sweep round reads only live rows, within the budget', async () => {
  await daemon.reconcileTick(); // the first pass does start-up work; the round measured is a steady one
  let ms = 0;
  const rows = await rowsRead(async () => {
    const t0 = performance.now();
    await daemon.bannersTick();
    await daemon.reconcileTick();
    daemon.reconcileStaleWorking();
    await lifecycle.runDueArchives();
    ms = performance.now() - t0;
  });
  console.log(`# round: ${rows} agent rows read in ${Math.round(ms)} ms`);
  // banners, reconcile and stale-working each read the 50 live rows and the sweep none; per-agent lookups (getAgent) add a few more per agent.
  assert.ok(rows <= 6 * LIVE, `${rows} agent rows read, more than the live ones`);
  assert.ok(ms < BUDGET_MS, `round took ${Math.round(ms)} ms, budget ${BUDGET_MS}`);
});
