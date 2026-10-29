#!/usr/bin/env node
// Unit tests for the comms stats (S-3826): counts by recipient and kind, permission timings, what waits now, the
// 1-30 day clamp, and that no text (mail subject or body, permission action, reason or details) reaches the result.
// Runs against a throwaway STAM_HOME; no daemon, no models: `node --test test/comms-stats.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-comms-stats-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, stats;
before(async () => {
  db = await import('../src/db.ts');
  stats = await import('../src/comms-stats.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const MIN = 60_000;
const iso = (minAgo) => new Date(NOW - minAgo * MIN).toISOString();
const run = (sql, ...a) => db.open().prepare(sql).run(...a);
const MARK = 'ZXQ-SECRET-MARKER';
let n = 0;
const mail = (from, to, o = {}) => {
  const id = `m${++n}`;
  run('INSERT INTO mail (id, from_id, subject, body, created_at, notice, permission_id, kind, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, from, o.subject ?? `s ${MARK}`, o.body ?? `b ${MARK}`, o.at ?? iso(10), o.notice ?? 0, o.perm ?? null, o.kind ?? null, o.thread ?? null);
  for (const t of [].concat(to)) run('INSERT INTO mail_recipients (mail_id, agent_id, read_at) VALUES (?, ?, ?)', id, t, o.read ?? null);
  return id;
};
const agent = (name) => {
  const id = db.newAgentId();
  db.createAgent({ id, name, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  return id;
};

test('clampDays bounds the window to 1-30 and defaults to 7', () => {
  assert.equal(stats.clampDays(undefined), 7);
  assert.equal(stats.clampDays(null), 7);
  assert.equal(stats.clampDays(''), 7);
  assert.equal(stats.clampDays('abc'), 7);
  assert.equal(stats.clampDays(0), 1);
  assert.equal(stats.clampDays(-5), 1);
  assert.equal(stats.clampDays(999), 30);
  assert.equal(stats.clampDays('3'), 3);
});

test('counts mail by recipient and kind, with unread and top senders', () => {
  const amy = agent('amy');
  const intake = agent('intake');
  mail(amy, intake);
  mail(amy, intake, { read: iso(1) });
  mail('human', amy);
  mail('system:deploy-watch', amy, { notice: 1 });
  mail(amy, 'human', { kind: 'comment' });
  mail(amy, 'human', { perm: 'p1' });
  mail(amy, amy, { at: iso(60 * 24 * 20) }); // outside a 7-day window
  const r = stats.commsStats(7, NOW);
  const by = Object.fromEntries(r.deliveries.map((x) => [x.name, x]));
  assert.equal(by.intake.total, 2);
  assert.equal(by.intake.unread, 1);
  assert.deepEqual(by.intake.topSenders, [{ sender: 'amy', n: 2 }]);
  assert.equal(by.amy.kinds.from_human, 1);
  assert.equal(by.amy.kinds.notice, 1);
  assert.equal(by.amy.total, 2);
  assert.equal(by.human.kinds.itsa_comment, 1);
  assert.equal(by.human.kinds.permission_ask, 1);
  assert.equal(r.human.received.total, 2);
  assert.equal(r.human.received.bySender.amy, 2);
  assert.equal(stats.commsStats(30, NOW).deliveries.find((x) => x.name === 'amy').total, 3);
});

test('counts human threads and the ones the human wrote in', () => {
  const amy = agent('thr');
  mail(amy, 'human', { thread: 't-a' });
  mail('human', amy, { thread: 't-a' });
  mail(amy, 'human', { thread: 't-b' });
  const r = stats.commsStats(7, NOW);
  assert.ok(r.human.threads.total >= 2);
  assert.ok(r.human.threads.repliedByHuman >= 1 && r.human.threads.repliedByHuman < r.human.threads.total);
});

test('permission requests: kind, audience, status, who decided, p50 and p90 minutes', () => {
  const a = agent('perm');
  const ins = (id, status, by, created, decided, audience = 'human') =>
    run('INSERT INTO permission_requests (id, agent_id, action, reason, details, status, decided_by, created_at, decided_at, kind, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, a, `act ${MARK}`, `why ${MARK}`, `det ${MARK}`, status, by, created, decided, 'request', audience);
  for (const m of [1, 2, 3, 4, 10]) ins(`q${m}`, 'approved', 'human', iso(100), iso(100 - m));
  ins('qd', 'approved', 'cos', iso(100), iso(95), 'delegate');
  ins('qp', 'pending', null, iso(300), null);
  const p = stats.commsStats(7, NOW).permissions.find((x) => x.kind === 'request');
  assert.equal(p.total, 7);
  assert.equal(p.status.approved, 6);
  assert.equal(p.status.pending, 1);
  assert.equal(p.decidedBy.human, 5);
  assert.equal(p.decidedBy.delegate, 1);
  assert.equal(p.audience.delegate, 1);
  assert.equal(p.decidedMinutes.n, 6);
  assert.equal(p.decidedMinutes.p50, 3);
  assert.equal(p.decidedMinutes.p90, 10);
  const open = stats.commsStats(7, NOW).open.pendingAsks.find((x) => x.kind === 'request');
  assert.equal(open.n, 1);
  assert.equal(open.oldestMinutes, 300);
});

test('open now: ITSAs in human statuses, decision mails, deferred threads, waits on the human', () => {
  run(`INSERT INTO itsas (id, key, kind, title, status, created_by, created_at, updated_at) VALUES ('i1', 'S-9001', 'issue', ?, 'needs_input', 't', ?, ?)`, `title ${MARK}`, iso(120), iso(90));
  run(`INSERT INTO itsas (id, key, kind, title, status, created_by, created_at, updated_at) VALUES ('i2', 'S-9002', 'issue', 'x', 'in_progress', 't', ?, ?)`, iso(120), iso(90));
  run("INSERT INTO decision_mails (mail_id, thread_id) VALUES ('dm1', 'dt1')");
  run("INSERT INTO thread_deferred (thread_id, mail_id) VALUES ('dt1', 'dm1')");
  const a = agent('waiter');
  run("INSERT INTO waits (id, agent_id, kind, since, source) VALUES ('w1', ?, 'human', ?, 'declared')", a, iso(60));
  run("INSERT INTO waits (id, agent_id, kind, since, source) VALUES ('w2', ?, 'human', ?, 'declared')", a, iso(20));
  run("INSERT INTO waits (id, agent_id, kind, since, source) VALUES ('w3', ?, 'agent', ?, 'declared')", a, iso(20));
  const r = stats.commsStats(7, NOW);
  assert.deepEqual(r.open.itsasInHumanStatus, [{ key: 'S-9001', status: 'needs_input', inStatusMinutes: 90 }]);
  run("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES ('i1', ?, 't', 'status', '{}')", iso(30));
  assert.equal(stats.commsStats(7, NOW).open.itsasInHumanStatus[0].inStatusMinutes, 30);
  assert.equal(r.open.decisionMails, 1);
  assert.equal(r.open.threadsDeferred, 1);
  assert.deepEqual(r.waitsOnHuman, { open: 2, openedInWindow: 2, meanOpenMinutes: 40 });
});

const events = () => db.open().prepare('SELECT * FROM comms_events ORDER BY id').all();

test('answer times: a closed human wait, a settled decision, a deferral and an escalation are recorded', () => {
  const a = agent('answers');
  const w = db.addWait({ agent_id: a, kind: 'human', source: 'declared', detail: `d ${MARK}` });
  const other = db.addWait({ agent_id: a, kind: 'agent', source: 'declared', target: 'x' });
  db.open().prepare('UPDATE waits SET since = ? WHERE id = ?').run(new Date(Date.now() - 10 * MIN).toISOString(), w.id);
  assert.ok(db.clearWait(w.id, 'reply'));
  assert.ok(db.clearWait(other.id)); // not a wait on the human: no event
  const ws = events().filter((e) => e.kind === 'wait');
  assert.equal(ws.length, 1);
  assert.equal(ws[0].outcome, 'reply');
  assert.ok(Math.abs(ws[0].duration_ms / MIN - 10) < 0.5);

  const dm = mail(a, 'human', { thread: 'ta', at: new Date(Date.now() - 4 * MIN).toISOString() });
  db.addDecisionMail(dm, 'ta');
  db.clearDecisionMails('ta', 'Ship it');
  const d1 = events().filter((e) => e.kind === 'decision' && e.ref === dm);
  assert.equal(d1.length, 1);
  assert.deepEqual([d1[0].outcome, d1[0].label], ['answered', 'Ship it']);
  assert.ok(Math.abs(d1[0].duration_ms / MIN - 4) < 0.5);
  db.clearDecisionMails('ta'); // nothing left: no second event
  assert.equal(events().filter((e) => e.ref === dm).length, 1);

  const dm2 = mail(a, 'human', { thread: 'tb' });
  db.addDecisionMail(dm2, 'tb');
  db.setThreadDeferred('tb', 'h1');
  const dm3 = mail(a, 'human', { thread: 'tc' });
  db.addDecisionMail(dm3, 'tc');
  db.removeDecisionMail(dm3);
  db.setThreadDeferred('tb', 'h2'); // deferred again: no repeat event
  assert.deepEqual(events().filter((e) => e.ref === dm2 || e.ref === dm3).map((e) => e.outcome), ['deferred', 'superseded']);

  run('INSERT INTO permission_requests (id, agent_id, action, reason, details, status, created_at, kind, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'qe1', a, `act ${MARK}`, `why ${MARK}`, `det ${MARK}`, 'pending', new Date(Date.now() - 6 * MIN).toISOString(), 'request', 'delegate');
  assert.ok(db.escalatePermissionRequest('qe1'));
  assert.ok(!db.escalatePermissionRequest('qe1')); // already the human's: no second event
  const esc = events().filter((e) => e.kind === 'escalation');
  assert.equal(esc.length, 1);
  assert.ok(Math.abs(esc[0].duration_ms / MIN - 6) < 0.5);
});

test('answer times are reported with p50 and p90, and the window and the 60-day prune apply', async () => {
  const at = (minAgo) => new Date(NOW - minAgo * MIN).toISOString();
  const ins = (kind, ref, outcome, label, min, created) =>
    run('INSERT INTO comms_events (kind, ref, outcome, label, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)', kind, ref, outcome, label, min == null ? null : min * MIN, created);
  run('DELETE FROM comms_events');
  for (const m of [1, 2, 3, 4, 10]) ins('wait', `w${m}`, 'reply', null, m, at(30));
  ins('wait', 'wt', 'timeout', null, 60, at(30));
  ins('wait', 'wold', 'reply', null, 99, at(60 * 24 * 20)); // outside a 7-day window
  for (const m of [5, 15]) ins('decision', `d${m}`, 'answered', m === 5 ? 'A' : null, m, at(20));
  ins('decision', 'dd', 'deferred', null, 3, at(20));
  ins('decision', 'ds', 'superseded', null, 3, at(20));
  ins('escalation', 'e1', 'escalated', null, 30, at(10));
  const r = stats.commsStats(7, NOW).answers;
  assert.deepEqual(r.waitsClosed, { total: 6, byOutcome: { reply: 5, timeout: 1 }, minutes: { n: 6, p50: 3, p90: 60 } });
  assert.deepEqual(r.decisions, { total: 4, answered: 2, deferred: 1, byOutcome: { answered: 2, deferred: 1, superseded: 1 }, withChoice: 1, answeredMinutes: { n: 2, p50: 5, p90: 15 } });
  assert.deepEqual(r.escalations, { total: 1, minutesToEscalate: { n: 1, p50: 30, p90: 30 } });
  assert.equal(stats.commsStats(30, NOW).answers.waitsClosed.total, 7);

  const usage = await import('../src/usage.ts');
  ins('wait', 'wprune', 'reply', null, 1, new Date(NOW - 61 * 86_400_000).toISOString());
  ins('wait', 'wkeep', 'reply', null, 1, new Date(NOW - 59 * 86_400_000).toISOString());
  usage.pruneSamples(NOW + 2 * 3_600_000);
  const refs = db.open().prepare('SELECT ref FROM comms_events').all().map((x) => x.ref);
  assert.ok(!refs.includes('wprune') && refs.includes('wkeep'));
});

test('chosenOption reads only the standard form', async () => {
  const { chosenOption } = await import('../src/mail.ts');
  assert.equal(chosenOption('> Q?\n\nChose **Ship it**.\n\nthanks'), 'Ship it');
  assert.equal(chosenOption('Chose **A**.\n\nChose **B**.'), null); // two decisions: no single label
  assert.equal(chosenOption('Picked **A**, **B**.'), null);
  assert.equal(chosenOption('I chose **A** myself'), null);
  assert.equal(chosenOption('Deferring this one: still open, I\'ll decide later.'), null);
});

test('no text reaches the result: the marker in bodies, subjects, actions, reasons, details and titles is absent', () => {
  const json = JSON.stringify(stats.commsStats(30, NOW));
  assert.ok(!JSON.stringify(events()).includes(MARK), 'a marker string leaked into comms_events');
  assert.ok(!json.includes(MARK), 'a marker string leaked into the stats');
  assert.ok(!json.includes('s ZXQ') && !json.includes('act ') && !json.includes('why '));
});

test('a realistic fixture of 20,000 mails: logs the time', () => {
  const a = agent('bulk');
  const d = db.open();
  d.exec('BEGIN');
  const im = d.prepare('INSERT INTO mail (id, from_id, subject, body, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)');
  const ir = d.prepare('INSERT INTO mail_recipients (mail_id, agent_id, read_at) VALUES (?, ?, ?)');
  for (let i = 0; i < 20000; i++) {
    im.run(`bulk${i}`, i % 3 ? a : 'human', 'subject', 'body', iso(i % (60 * 24 * 20)), i % 7 ? null : 'comment');
    ir.run(`bulk${i}`, i % 5 ? a : 'human', i % 4 ? iso(1) : null);
  }
  d.exec('COMMIT');
  const t = performance.now();
  const r = stats.commsStats(30, NOW);
  const ms = performance.now() - t;
  console.log(`comms stats on 20,000 mails: ${ms.toFixed(1)} ms`);
  assert.ok(r.deliveries.length > 0);
});

test('a database from before comms_events gets the table on open, and a restart keeps its rows', () => {
  const d = db.open();
  run("INSERT INTO comms_events (kind, ref, outcome, duration_ms, created_at) VALUES ('wait', 'wkeep2', 'reply', 1, ?)", iso(1));
  const count = () => execFileSync(process.execPath, ['--input-type=module', '-e',
    "const db = await import('./src/db.ts'); console.log(db.open().prepare(\"SELECT COUNT(*) AS n FROM comms_events WHERE ref = 'wkeep2'\").get().n)"],
    { env: { ...process.env, STAM_HOME: home }, encoding: 'utf8' }).trim();
  assert.equal(count(), '1'); // a new process (a restart) reads the row back
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  d.exec('DROP INDEX comms_events_at');
  d.exec('DROP TABLE comms_events');
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e',
    "const db = await import('./src/db.ts'); console.log(db.open().prepare(\"SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('comms_events','comms_events_at')\").get().n)"],
    { env: { ...process.env, STAM_HOME: home }, encoding: 'utf8' }).trim(), '2');
});
