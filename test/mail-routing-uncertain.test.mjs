#!/usr/bin/env node
// Mail the human sends without picking a recipient (S-1462) carries a "routing uncertain" note for its recipient; the flag is
// ignored from an agent. Throwaway STAM_HOME, no daemon. Run with `node --test test/mail-routing-uncertain.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-routing-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-routing-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, mail, templates;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });

before(async () => {
  db = await import('../src/db.ts');
  mail = await import('../src/mail.ts');
  templates = await import('../src/templates.ts');
  db.open();
  agent('a1', 'alice');
  agent('a2', 'bob');
});
after(() => rmSync(home, { recursive: true, force: true }));

test('the human\'s routing_uncertain mail carries the note, shown to the recipient and not in the body', async () => {
  const note = templates.render('routing-uncertain', {});
  assert.match(note, /^Routing was uncertain: the user typed this without picking a recipient/);
  const m = await mail.sendMail({ from: 'human', to: ['alice'], subject: 'Q', body: 'what is up?', routing_uncertain: true });
  const stored = db.getMail(m.id);
  assert.equal(stored.note, note);
  assert.equal(stored.body, 'what is up?');
  assert.equal(db.readMail('a1', [m.id])[0].note, note);
});

test('without the flag there is no note', async () => {
  const m = await mail.sendMail({ from: 'human', to: ['alice'], subject: 'Q2', body: 'x' });
  assert.equal(db.getMail(m.id).note ?? null, null);
});

test('an agent\'s routing_uncertain is ignored', async () => {
  const m = await mail.sendMail({ from: 'a2', to: ['alice'], subject: 'Q3', body: 'x', routing_uncertain: true });
  assert.equal(db.getMail(m.id).note ?? null, null);
});

test('looking_at adds the looking-at note, alone or after the routing note, and is ignored from an agent', async () => {
  const at = templates.render('looking-at', { context: 'Usage · tokens' });
  assert.equal(at, 'The human was looking at: Usage · tokens (may or may not be relevant).');
  const a = await mail.sendMail({ from: 'human', to: ['alice'], subject: 'L1', body: 'x', looking_at: 'Usage · tokens' });
  assert.equal(db.getMail(a.id).note, at);
  const b = await mail.sendMail({ from: 'human', to: ['alice'], subject: 'L2', body: 'x', looking_at: 'Usage · tokens', routing_uncertain: true });
  assert.equal(db.getMail(b.id).note, `${templates.render('routing-uncertain', {})}\n\n${at}`);
  const c = await mail.sendMail({ from: 'a2', to: ['alice'], subject: 'L3', body: 'x', looking_at: 'Usage · tokens' });
  assert.equal(db.getMail(c.id).note ?? null, null);
});

test('looking_at collapses whitespace and is cut at 200 characters', async () => {
  const m = await mail.sendMail({ from: 'human', to: ['alice'], subject: 'L4', body: 'x', looking_at: `  a\n\n  b   ${'z'.repeat(300)}` });
  const note = db.getMail(m.id).note;
  const ctx = note.replace('The human was looking at: ', '').replace(' (may or may not be relevant).', '');
  assert.equal(ctx.length, 200);
  assert.ok(ctx.startsWith('a b zzz'));
  assert.ok(!/\s{2}|\n/.test(ctx));
  const blank = await mail.sendMail({ from: 'human', to: ['alice'], subject: 'L5', body: 'x', looking_at: '   ' });
  assert.equal(db.getMail(blank.id).note ?? null, null);
});
