#!/usr/bin/env node
// Unit tests for S-2064: a human reply that answers an agent's decision reaches the asker only, not every ITSA
// participant (S-1366). An ITSA's assistant relay joins the thread as a participant, so before this an answer
// went to it too. Throwaway STAM_HOME, no daemon, no network. Run with `node --test test/mail-reply-only.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-reply-only-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-reply-only-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, mail, x, ask;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const recipientsOf = (sent) => db.threadMail(sent.thread_id).find((m) => m.id === sent.id).recipients.map((r) => r.id).sort();

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  mail = await import('../src/mail.ts');
  db.open();
  for (const [id, name] of [['r1', 'retro'], ['as1', 'assistant'], ['o1', 'owner'], ['b1', 'bob']]) agent(id, name);
  x = await itsa.create({ title: 'Reply only', by: 'human', owner: 'owner', participants: ['bob'] });
  // The relay: the assistant posts into the ITSA thread, which makes it a participant.
  await itsa.post(x.key, { by: 'assistant', body: 'GitHub event: checks passed' });
  // The asker's decision, in the same thread.
  ask = await itsa.post(x.key, { by: 'retro', body: 'Merge #453?' });
});
after(() => {
  rmSync(home, { recursive: true, force: true });
});

test('the assistant relay is a participant, so an ITSA post with no `only` still fans out to it', async () => {
  assert.ok(itsa.participants(x.id).includes('as1'));
  const sent = await mail.sendMail({ from: 'human', to: ['r1'], inferred: ['r1'], subject: 'x', body: '> Merge #453?\n\nChose **Yes**.', reply_to: ask.id });
  assert.deepEqual(recipientsOf(sent), ['as1', 'b1', 'o1', 'r1']);
});

test('a human reply that answers a decision with `only` reaches the asker alone', async () => {
  const sent = await mail.sendMail({ from: 'human', to: ['r1'], inferred: ['r1'], only: ['r1'], subject: 'x', body: '> Merge #453?\n\nChose **Yes**.', reply_to: ask.id });
  assert.deepEqual(recipientsOf(sent), ['r1']);
  assert.equal(db.getMail(sent.id).itsa_id, x.id);
});

test('a recipient the human adds by hand still gets it with `only`', async () => {
  const sent = await mail.sendMail({ from: 'human', to: ['r1', 'b1'], inferred: ['r1'], only: ['r1'], subject: 'x', body: 'Chose **Yes**.', reply_to: ask.id });
  assert.deepEqual(recipientsOf(sent), ['b1', 'r1']);
});

test('`only` from an agent is ignored: ITSA posts keep the fan-out', async () => {
  const m = await itsa.post(x.key, { by: 'bob', body: 'narrowing attempt', only: ['r1'] });
  assert.ok(db.threadMail(m.thread_id).find((r) => r.id === m.id).recipients.some((r) => r.id === 'as1'));
});
