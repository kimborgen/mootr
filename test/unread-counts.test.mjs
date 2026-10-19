#!/usr/bin/env node
// The agents list (GET /api/agents) reads every agent's unread mail count in one grouped query (S-344), not one
// query per agent. At 300 agents with mail, the list's unread lookup runs a constant number of statement
// executions, and gives each agent the count unreadCount gives it alone. Counts executions, not time.
// Throwaway STAM_HOME, no daemon: `node --test test/unread-counts.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-unread-counts-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `unread-counts-test-${process.pid}`;
writeFileSync(join(home, 'settings.json'), JSON.stringify({ cost: { subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, global: null, onError: 'soft-stop', accounts: {} } }));
const db = await import('../src/db.ts');

test('the agents list reads unread counts for 300 agents in a constant number of executions', () => {
  for (let i = 0; i < 300; i++) db.createAgent({ id: `id-${i}`, name: `ag-${i}`, role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd: '', parent_id: null, session_id: null });
  const d = db.open();
  const recipient = d.prepare('INSERT INTO mail_recipients (mail_id, agent_id, read_at) VALUES (?, ?, ?)');
  // Agent i gets i % 5 unread mails, and one read mail; agents with i % 3 === 0 also get one more read mail.
  for (let i = 0; i < 300; i++) {
    for (let m = 0; m < i % 5; m++) recipient.run(`m-${i}-${m}`, `id-${i}`, null);
    recipient.run(`r-${i}`, `id-${i}`, '2026-10-13T00:00:00.000Z');
  }

  const prepare = d.prepare.bind(d);
  let executions = 0;
  d.prepare = (sql) => {
    const st = prepare(sql);
    for (const m of ['get', 'all', 'run']) {
      const f = st[m].bind(st);
      st[m] = (...args) => {
        executions++;
        return f(...args);
      };
    }
    return st;
  };
  let counts;
  try {
    counts = db.unreadCounts();
  } finally {
    delete d.prepare;
  }
  assert.ok(executions <= 2, `${executions} statement executions for 300 agents`);
  for (let i = 0; i < 300; i++) assert.equal(counts.get(`id-${i}`) ?? 0, db.unreadCount(`id-${i}`), `unread for id-${i}`);
  assert.equal(counts.get('id-4'), 4);
});
