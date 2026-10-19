#!/usr/bin/env node
// Withdrawing an ask from the human (S-425, src/withdraw.ts withdrawAsk, src/cost-notices.ts): a sender
// withdraws its decision mail and it leaves the decision list and the human's attention; a stranger, a
// mail already answered, a mail not sent to the human, and a permission or ITSA ask are refused; a
// manager's cost ack withdraws the human's copy of the notice. Throwaway STAM_HOME, no daemon, no
// peers, no models: `node --test test/withdraw-ask.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-withdraw-ask-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `withdraw-ask-test-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub'; // no model install or download
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

function writeSettings(over = {}) {
  const base = {
    chiefOfStaff: null,
    humanMail: { when: 'important' },
    cost: { subscriptionWarnPercent: [80, 95], instructions: 'Never spend extra credits.', accounts: { claude: { match: { harness: 'claude' } } } },
  };
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ ...base, ...over, cost: { ...base.cost, ...(over.cost ?? {}) }, humanMail: { ...base.humanMail, ...(over.humanMail ?? {}) } }));
}
writeSettings();

let db, withdraw, costNotices, mail;
function agent(id, fields = {}) {
  db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null, ...fields });
}
before(async () => {
  db = await import('../src/db.ts');
  withdraw = await import('../src/withdraw.ts');
  costNotices = await import('../src/cost-notices.ts');
  mail = await import('../src/mail.ts');
  agent('w-parent');
  agent('w-child', { parent_id: 'w-parent' });
  agent('w-stranger');
});
after(() => rmSync(home, { recursive: true, force: true }));

const DECISION = '```decision\nPick one?\n- A: yes (recommended)\n- B: no\n```';
// A decision mail from the child to the human, in its own thread.
function decision(id, thread, extra = {}) {
  db.createMail({ id, from_id: 'w-child', from_name: 'w-child', subject: `Decide ${id}`, body: DECISION, thread_id: thread, reply_to: null, ...extra }, ['human']);
  if (!extra.permission_id && extra.kind !== 'ask') db.addDecisionMail(id, thread);
}
const humanCopy = (id) => db.threadMail(db.mailThreadId(id)).find((m) => m.id === id).recipients.find((r) => r.id === 'human');

test('the sender withdraws its decision mail: it leaves the list, and the human copy is read and withdrawn', async () => {
  decision('d1', 'wt1');
  assert.ok(db.decisionMails().some((m) => m.mail_id === 'd1'));
  const note = 'Withdrawn by @w-child: answered in the terminal';
  const done = await withdraw.withdrawAsk('d1', 'w-child', 'answered in the terminal', { boss: false });
  assert.deepEqual(done, [{ id: 'd1', thread_id: 'wt1', ids: ['d1'] }]);
  assert.ok(!db.decisionMails().some((m) => m.mail_id === 'd1'), 'GET /api/mail/decisions no longer lists it');
  const r = humanCopy('d1');
  assert.ok(r.read_at && r.withdrawn_at, 'the human copy is read and withdrawn');
  assert.equal(r.withdrawn_by, 'w-child');
  assert.equal(r.withdrawn_note, note);
  const { archived } = db.splitArchived('human', [{ thread_id: 'wt1', mails: [{ id: 'd1' }] }]);
  assert.equal(archived.length, 1, 'the thread is archived');
});

test('a parent, the chief of staff or the assistant may withdraw, and a stranger is refused', async () => {
  decision('d2', 'wt2');
  await assert.rejects(withdraw.withdrawAsk('d2', 'w-stranger', 'x', { boss: false }), (e) => e.status === 403);
  assert.ok(db.decisionMails().some((m) => m.mail_id === 'd2'), 'the refused mail still waits');
  assert.equal(humanCopy('d2').withdrawn_at ?? null, null);
  await withdraw.withdrawAsk('d2', 'w-parent', 'moot', { boss: false });
  assert.ok(!db.decisionMails().some((m) => m.mail_id === 'd2'));

  decision('d3', 'wt3');
  await withdraw.withdrawAsk('d3', 'w-stranger', 'moot', { boss: true });
  assert.equal(humanCopy('d3').withdrawn_by, 'w-stranger', 'a boss caller (chief of staff or assistant) may withdraw');
});

test('a decision the human deferred (Decide later) can\'t be withdrawn, and stays with them', async () => {
  decision('d9', 'wt9');
  // The human's own reply, sent as the web sends it: Decide later defers the thread (S-353).
  await mail.sendMail({ from: 'human', to: ['w-child'], subject: 'Re: Decide d9', body: "Deferring this one: still open, I'll decide later.", reply_to: 'd9' });
  assert.ok(db.isThreadDeferred('wt9'), 'the reply defers the thread');
  await assert.rejects(withdraw.withdrawAsk('d9', 'w-child', 'moot', { boss: false }), (e) => e.status === 409 && /Decide later/.test(e.message));
  assert.ok(db.decisionMails().some((m) => m.mail_id === 'd9'), 'the decision row survives');
  assert.equal(humanCopy('d9').withdrawn_at ?? null, null, 'the human copy survives');
});

test('a mail the human already answered is refused', async () => {
  decision('d4', 'wt4');
  db.clearDecisionMails('wt4'); // what a human reply in the thread does (mail.ts)
  await assert.rejects(withdraw.withdrawAsk('d4', 'w-child', 'x', { boss: false }), (e) => e.status === 409 && /isn't waiting on the human/.test(e.message));
  assert.equal(humanCopy('d4').withdrawn_at ?? null, null);
});

test('a mail not sent to the human is refused, and so is an unknown mail', async () => {
  db.createMail({ id: 'd5', from_id: 'w-child', from_name: 'w-child', subject: 's', body: DECISION, thread_id: 'wt5', reply_to: null }, ['w-parent']);
  db.addDecisionMail('d5', 'wt5');
  await assert.rejects(withdraw.withdrawAsk('d5', 'w-child', 'x', { boss: false }), (e) => e.status === 409 && /wasn't sent to the human/.test(e.message));
  await assert.rejects(withdraw.withdrawAsk('nope', 'w-child', 'x', { boss: false }), (e) => e.status === 404);
});

test('a permission request or an ITSA ask is withdrawn by its own path, not here', async () => {
  decision('d6', 'wt6', { permission_id: 'p1' });
  await assert.rejects(withdraw.withdrawAsk('d6', 'w-child', 'x', { boss: false }), (e) => e.status === 409 && /answer_permission/.test(e.message));
  db.createMail({ id: 'd7', from_id: 'w-child', from_name: 'w-child', subject: 'ask', body: 'Need you', thread_id: 'wt7', reply_to: null, kind: 'ask' }, ['human']);
  await assert.rejects(withdraw.withdrawAsk('d7', 'w-child', 'x', { boss: false }), (e) => e.status === 409 && /move the ITSA/.test(e.message));
  assert.equal(humanCopy('d6').withdrawn_at ?? null, null);
  assert.equal(humanCopy('d7').withdrawn_at ?? null, null);
});

test('a cost ack in the same turn as the notice withdraws the human\'s mail once it is stored', async () => {
  writeSettings({ chiefOfStaff: null, humanMail: { when: 'important' }, cost: { accounts: { codex: { match: { harness: 'codex' } } } } });
  agent('w-manager2');
  costNotices.windowWarning('codex', 'seven_day', 82, 80, Math.floor(Date.now() / 1000) + 7200, Date.now());
  const id = costNotices.notices()[0].id;
  // Acked before the human's mail is stored: no mail id yet, so nothing to withdraw at ack time.
  assert.equal(costNotices.ack(id, 'w-manager2').ok, true);
  assert.equal(costNotices.notice(id).human_mail_id ?? null, null);
  for (let i = 0; i < 500 && !costNotices.notice(id).human_mail_id; i++) await new Promise((r) => setTimeout(r, 10));
  const mailId = costNotices.notice(id).human_mail_id;
  assert.ok(mailId, 'the notice links to the human mail');
  const r = db.open().prepare("SELECT withdrawn_by, withdrawn_at FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'").get(mailId);
  assert.equal(r.withdrawn_by, 'w-manager2', 'the copy is withdrawn once stored, by the manager that acked');
});

test('a manager\'s cost ack withdraws the human\'s copy of the notice that reached them by mail', async () => {
  // A Codex account no agent here is on, so no manager gets the notice and the human does, by mail.
  writeSettings({ chiefOfStaff: null, humanMail: { when: 'important' }, cost: { accounts: { codex: { match: { harness: 'codex' } } } } });
  agent('w-manager');
  costNotices.windowWarning('codex', 'five_hour', 82, 80, Math.floor(Date.now() / 1000) + 3600, Date.now());
  const id = costNotices.notices()[0].id;
  // The human's mail is sent asynchronously; its id lands on the notice once it is stored.
  for (let i = 0; i < 500 && !costNotices.notice(id).human_mail_id; i++) await new Promise((r) => setTimeout(r, 10));
  const mailId = costNotices.notice(id).human_mail_id;
  assert.ok(mailId, 'the notice links to the human mail');
  assert.equal(db.getMail(mailId).subject.includes(id), true);
  assert.equal(db.open().prepare("SELECT withdrawn_at FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'").get(mailId).withdrawn_at, null);

  assert.deepEqual(costNotices.ack(id, 'w-manager'), { ok: true, event: id });
  const r = db.open().prepare("SELECT withdrawn_by, withdrawn_note, read_at FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'").get(mailId);
  assert.equal(r.withdrawn_by, 'w-manager');
  assert.match(r.withdrawn_note, new RegExp(`cost notice ${id} handled`));
  assert.ok(r.read_at);
});
