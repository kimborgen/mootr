#!/usr/bin/env node
// Unit tests for build step 11 of docs/cost-policy.md: cost notices routed to the
// responsible manager. Runs against a throwaway STAM_HOME with no daemon, no network, and
// no models: `node --test test/cost-notices.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-cost-notices-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `cost-notices-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// The base settings every test starts from; `over` shallow-merges cost and humanMail.
function writeSettings(over = {}) {
  const base = {
    chiefOfStaff: 'cos',
    humanMail: { when: 'necessary' },
    cost: {
      subscriptionWarnPercent: [80, 95],
      instructions: 'Never spend extra credits.',
      accounts: {
        claude: { match: { harness: 'claude' } },
        openrouter: { match: { harness: 'opencode', model: 'openrouter/' }, subscription: false },
      },
    },
  };
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ ...base, ...over, cost: { ...base.cost, ...(over.cost ?? {}) }, humanMail: { ...base.humanMail, ...(over.humanMail ?? {}) } }),
  );
}
writeSettings();

let db, blockers, costNotices, usage, mail;
before(async () => {
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  costNotices = await import('../src/cost-notices.ts');
  usage = await import('../src/usage.ts');
  mail = await import('../src/mail.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent(name, fields = {}) {
  const id = `cn-${++n}-${name}`;
  db.createAgent({ id, name, role: 'test', machine: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null, ...fields });
  return db.getAgent(id);
}
const setActivity = (a, activity) => db.updateAgent(a.id, { activity });
const sorted = (ids) => [...ids].sort();
const inboxSubjects = (box) => db.inbox(box, false, 50).map((m) => m.subject);

beforeEach(() => {
  costNotices.notices(0); // creates the cost_notices table before it is cleared
  const d = db.open();
  for (const t of ['cost_notices', 'blockers', 'agent_parents', 'agents', 'window_readings', 'usage_samples', 'subscriptions', 'mail_recipients', 'mail', 'events']) d.exec(`DELETE FROM ${t}`);
  writeSettings();
});

test('managerOf > nested trees, a root goes to the chief of staff, and multiple parents', () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  const dev = agent('dev', { parent_id: cost.id });
  assert.deepEqual(costNotices.managerOf(dev.id), [cost.id], 'a child is managed by its parent');
  assert.deepEqual(costNotices.managerOf(cost.id), [cos.id], 'a nested manager is managed by its parent');
  assert.deepEqual(costNotices.managerOf(cos.id), [], 'the chief of staff has no manager above it');

  const orphan = agent('orphan');
  assert.deepEqual(costNotices.managerOf(orphan.id), [cos.id], 'a root without a parent is managed by the chief of staff');

  const p1 = agent('p1', { parent_id: cos.id });
  const p2 = agent('p2', { parent_id: cos.id });
  const multi = agent('multi', { parent_id: p1.id });
  db.addParent(multi.id, p2.id);
  assert.deepEqual(sorted(costNotices.managerOf(multi.id)), sorted([p1.id, p2.id]), 'both parents manage the child');
});

test('window > warns the managers of trees on the account, once per window and reset', () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  agent('dev', { parent_id: cost.id });
  const R = Math.floor(Date.now() / 1000) + 3600;
  costNotices.windowWarning('claude', 'five_hour', 82, 80, R, Date.now());
  const first = costNotices.notices();
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'window');
  assert.equal(first[0].account, 'claude');
  assert.deepEqual(sorted(first[0].managers), sorted([cos.id, cost.id]), 'the manager of every active agent on the account');

  costNotices.windowWarning('claude', 'five_hour', 83, 80, R, Date.now());
  assert.equal(costNotices.notices().length, 1, 'the same window and reset is not re-notified');

  costNotices.windowWarning('claude', 'five_hour', 82, 80, R + 18000, Date.now());
  assert.equal(costNotices.notices().length, 2, 'a new reset re-arms the warning');
});

test('notice > carries the event id, the share, the instructions, and the options', () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  agent('dev', { parent_id: cost.id });
  setActivity(cost, 'working');
  costNotices.windowWarning('claude', 'five_hour', 82, 80, Math.floor(Date.now() / 1000) + 3600, Date.now());
  const id = costNotices.notices()[0].id;
  const text = mail.inTurnNotice(cost.id) ?? '';
  assert.match(text, new RegExp(id), 'the event id is in the notice');
  assert.match(text, /cost_ack/, 'the ack option is named');
  assert.match(text, /Never spend extra credits\./, "the user's instructions are carried");
  assert.match(text, /Pause the tree until the window resets/, 'the options are listed');
});

test('delivery > a working manager gets an in-turn notice, an idle one gets mail', async () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  agent('dev', { parent_id: cost.id });
  const R = Math.floor(Date.now() / 1000) + 3600;
  setActivity(cost, 'working');
  costNotices.windowWarning('claude', 'five_hour', 82, 80, R, Date.now());
  assert.equal(db.inbox(cost.id, false, 10).length, 0, 'a working manager is not mailed');
  assert.ok((mail.inTurnNotice(cost.id) ?? '').includes('Cost notice'), 'it gets the notice in its turn');

  setActivity(cost, 'idle');
  costNotices.windowWarning('claude', 'five_hour', 82, 80, R + 18000, Date.now());
  // The mail is written asynchronously, so poll until it lands rather than read it at once.
  for (let i = 0; i < 100 && !inboxSubjects(cost.id).some((s) => s.includes('Cost notice')); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(inboxSubjects(cost.id).some((s) => s.includes('Cost notice')), 'an idle manager is mailed');
  const sent = db.inbox(cost.id, false, 10).find((m) => m.subject.includes('Cost notice'));
  assert.equal(sent.from_id, 'system:cost', 'a cost notice is from the cost system sender, not a stand-in agent');
});

test('projection > warns the managers when 100% is within 30 minutes', () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  const dev = agent('dev', { parent_id: cost.id });
  const T0 = Date.parse('2026-10-11T10:00:00.000Z');
  const MIN = 60_000;
  const iso = (t) => new Date(t).toISOString();
  const reading = (minute, used) => db.open().prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)').run('claude', 'five_hour', iso(T0 + minute * MIN + 30_000), used, null);
  const sample = (minute, tokens) => db.open().prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in) VALUES (?, ?, ?, ?, ?, ?)').run(dev.id, 'claude', 'claude', 'claude-opus-5-5', iso(T0 + minute * MIN), tokens);
  reading(0, 90);
  sample(5, 2000);
  reading(5, 92);
  sample(10, 2000);
  sample(20, 2000);
  reading(30, 98);
  sample(30, 2000);
  const now = T0 + 31 * MIN;
  costNotices.checkProjection('claude', 'five_hour', now);
  const notices = costNotices.notices();
  assert.equal(notices.length, 1, 'a projection notice is raised');
  assert.equal(notices[0].kind, 'projection');
  assert.deepEqual(sorted(notices[0].managers), sorted([cos.id, cost.id]));
  // Throttled: a second check just after writes nothing new.
  costNotices.checkProjection('claude', 'five_hour', now + MIN);
  assert.equal(costNotices.notices().length, 1);
});

test("blocker > set and clear reach the blocked agent's manager, a refresh does not", async () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  const dev = agent('dev', { parent_id: cost.id });
  await blockers.addBlocker(dev, { kind: 'window', account: 'claude', reason: 'five_hour at 100%' });
  const set = costNotices.notices();
  assert.equal(set.length, 1);
  assert.equal(set[0].kind, 'blocker-set');
  assert.deepEqual(set[0].managers, [cost.id], "only the blocked agent's manager");

  await blockers.addBlocker(dev, { kind: 'window', account: 'claude', reason: 'five_hour still at 100%' });
  assert.equal(costNotices.notices().length, 1, 'a refresh of the same blocker does not re-notify');

  await blockers.clearBlocker(dev, 'window', 'claude', 'five_hour reads 12%');
  const all = costNotices.notices();
  assert.equal(all.length, 2);
  const cleared = all.find((x) => x.kind === 'blocker-clear');
  assert.ok(cleared, 'a clear notice was raised');
  assert.deepEqual(cleared.managers, [cost.id]);
});

test('credits > low OpenRouter credit reaches the trees that use it, once per top-up', () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  agent('oc', { parent_id: cost.id, harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash' });
  const now = Date.now();
  costNotices.lowCredits(1.5, 2, '10:10', now);
  const notices = costNotices.notices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'credits-low');
  assert.deepEqual(notices[0].managers, [cost.id], 'the manager of the OpenRouter tree');
  costNotices.lowCredits(1.4, 2, '10:10', now);
  assert.equal(costNotices.notices().length, 1, 'the same capacity is not re-notified');
  costNotices.lowCredits(11.5, 2, '20:10', now);
  assert.equal(costNotices.notices().length, 2, 'a top-up re-arms the notice');
});

test('ack > records the handler and refuses a second ack', () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  agent('dev', { parent_id: cost.id });
  costNotices.windowWarning('claude', 'five_hour', 82, 80, Math.floor(Date.now() / 1000) + 3600, Date.now());
  const id = costNotices.notices()[0].id;
  assert.deepEqual(costNotices.ack(id, cost.id), { ok: true, event: id });
  const stored = costNotices.notice(id);
  assert.equal(stored.acked_by, cost.id);
  assert.ok(stored.acked_at, 'the ack is timestamped');
  assert.ok(db.listEvents(cost.id).some((e) => e.type === 'cost:ack'), 'the ack is recorded as an event');
  const again = costNotices.ack(id, cost.id);
  assert.equal(again.ok, false);
  assert.match(again.error, /already acknowledged/);
  assert.equal(costNotices.ack('cn-nope', cost.id).ok, false);
});

test('human mail > a warning is sent only when humanMail.when allows it', async () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  agent('dev', { parent_id: cost.id });
  const R1 = Math.floor(Date.now() / 1000) + 3600;
  writeSettings({ humanMail: { when: 'necessary' } });
  usage.reportSubscription('claude', { five_hour: { used_percentage: 82, resets_at: R1 } }, Date.now());
  assert.equal(costNotices.notices().length, 1, 'the manager is still notified');
  assert.ok(!inboxSubjects('human').some((s) => s.includes('usage at 82%')), 'the human is not mailed under necessary');

  writeSettings({ humanMail: { when: 'important' } });
  usage.reportSubscription('claude', { five_hour: { used_percentage: 96, resets_at: R1 + 18000 } }, Date.now());
  // The human's mail is sent asynchronously, so poll until it lands rather than read it at once.
  for (let i = 0; i < 100 && !inboxSubjects('human').some((s) => s.includes('usage at 96%')); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(inboxSubjects('human').some((s) => s.includes('usage at 96%')), 'the human is mailed under important');
});

test('fallback > with no manager, the human is told only when humanMail.when allows it', () => {
  writeSettings({ chiefOfStaff: null, humanMail: { when: 'important' } });
  agent('orphan');
  const R = Math.floor(Date.now() / 1000) + 3600;
  costNotices.windowWarning('claude', 'five_hour', 82, 80, R, Date.now());
  assert.equal(costNotices.notices().length, 1);
  assert.deepEqual(costNotices.notices()[0].managers, ['human'], 'the human is the fallback manager');

  writeSettings({ chiefOfStaff: null, humanMail: { when: 'necessary' } });
  costNotices.windowWarning('claude', 'five_hour', 82, 80, R + 18000, Date.now());
  assert.equal(costNotices.notices().length, 1, 'nothing is recorded when the human does not want it either');
});
