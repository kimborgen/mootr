#!/usr/bin/env node
// The full suite's failure triage (S-1074) sends as `system:full-suite`, a sender any shared-token caller can name, so it is held to
// agents and ITSA comments: its mail never reaches the human, named directly, through a thread, or as an ITSA post's `to`.
// Throwaway STAM_HOME, no daemon. Run with `node --test test/mail-full-suite-sender.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-fullsuite-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-fullsuite-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, mail;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  mail = await import('../src/mail.ts');
  db.open();
  agent('a1', 'alice');
});
after(() => rmSync(home, { recursive: true, force: true }));

test('full-suite mails an agent, and comments on an ITSA', async () => {
  const m = await mail.sendMail({ system: 'full-suite', to: ['alice'], subject: 'Full suite fails', body: 'x' });
  assert.equal(db.getMail(m.id).from_id, 'system:full-suite');
  const x = await itsa.create({ title: 'Culprit', by: 'human', owner: 'alice' });
  const post = await itsa.post(x.key, { by: 'system:full-suite', body: 'Blamed.' });
  assert.equal(db.getMail(post.id).about_itsa, x.id);
});

test('full-suite mail to the human is refused', async () => {
  await assert.rejects(mail.sendMail({ system: 'full-suite', to: ['human'], subject: 's', body: 'b' }), /not your user/);
  await assert.rejects(mail.sendMail({ system: 'full-suite', to: ['alice', 'human'], subject: 's', body: 'b' }), /not your user/, 'among others too');
});

test('go-parity (S-2297) may not mail the human either', async () => {
  await assert.rejects(mail.sendMail({ system: 'go-parity', to: ['human'], subject: 's', body: 'b' }), /not your user/);
});

test('an ITSA post naming the human, and a reply in a thread that reaches them, are refused', async () => {
  const x = await itsa.create({ title: 'Human in it', by: 'human', owner: 'alice', participants: ['human'] });
  await assert.rejects(itsa.post(x.key, { by: 'system:full-suite', body: 'hi', to: ['human'] }), /not your user/);
  const q = await mail.sendMail({ from: 'a1', to: ['human'], subject: 'Question', body: 'q', new_thread: true, from_stam: true });
  await assert.rejects(mail.sendMail({ system: 'full-suite', to: [], subject: 'Re', body: 'r', reply_to: q.id }), /not your user|no recipients/, 'a reply with no one named does not reach the human');
});

test('deploy-watch keeps its own reach: the refusal is for full-suite only', async () => {
  const m = await mail.sendMail({ system: 'deploy-watch', to: ['human'], subject: 'Deployed', body: 'ok' });
  assert.ok(db.getMail(m.id));
});
