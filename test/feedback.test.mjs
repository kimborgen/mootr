#!/usr/bin/env node
// Unit tests for src/feedback.ts (S-156): the standing Feedback parent (created on first use,
// under the root of S-1's tree when S-1 exists), filing a report as a backlog ITSA with the
// reporter as participant, the duplicate guard (same tool and normalized summary: a comment,
// not a new ITSA), and the one quiet mail to the chief of staff. A fake API stands in for the
// daemon, so no daemon or network. Run with `node --test test/feedback.test.mjs`.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { report, feedbackParent, normalize } = await import('../src/feedback.ts');

// An in-memory stand-in for the daemon routes the feedback module calls.
function fakeApi({ s1 = null, cos = 'cos' } = {}) {
  const itsas = [];
  const comments = [];
  const mails = [];
  let n = 0;
  const seen = [];
  const api = async (method, path, body) => {
    seen.push(`${method} ${path}`);
    if (method === 'GET' && path.startsWith('/api/itsas?kind=')) return itsas.filter((x) => x.kind === 'feedback');
    if (method === 'GET' && path === '/api/itsas/S-1') {
      if (!s1) throw new Error('404 no such ITSA');
      return s1;
    }
    if (method === 'GET' && path.startsWith('/api/itsas?parent=')) {
      const parent = path.match(/parent=([^&]+)/)[1];
      return itsas.filter((x) => x.parent_id === parent && x.kind === 'feedback-report');
    }
    if (method === 'GET' && path.startsWith('/api/itsas/')) {
      const id = path.split('/').pop();
      return itsas.find((x) => x.id === id);
    }
    if (method === 'POST' && path === '/api/itsas') {
      n += 1;
      // Reports are S-101, S-102, ...; the parent is F-1, so the keys in the asserts hold.
      const key = body.kind === 'feedback' ? 'F-1' : `S-${100 + itsas.filter((x) => x.kind === 'feedback-report').length + 1}`;
      const row = { id: `id${n}`, key, closed_at: null, participants: [], ...body, parent_id: body.parent ?? null };
      if (!('body' in row)) row.body = null;
      delete row.by;
      itsas.push(row);
      return row;
    }
    if (method === 'POST' && path.endsWith('/post')) {
      comments.push({ id: path.split('/')[3], body: body.body, by: body.by });
      return {};
    }
    if (method === 'GET' && path === '/api/chief-of-staff') return { chiefOfStaff: cos };
    if (method === 'POST' && path === '/api/mail') {
      mails.push(body);
      return {};
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, itsas, comments, mails, seen };
}

const sends = (f) => f.seen.filter((s) => s === 'POST /api/itsas').length;

let f;
beforeEach(() => {
  f = fakeApi();
});

test('normalize drops case, punctuation and spacing', () => {
  assert.equal(normalize('  Send_MAIL drops\nreply_to!! '), 'send mail drops reply to');
});

test('the standing parent is a root when S-1 does not exist, and is reused', async () => {
  const a = await feedbackParent(f.api, 'alice');
  const b = await feedbackParent(f.api, 'alice');
  assert.equal(a.title, 'Feedback');
  assert.equal(a.kind, 'feedback');
  assert.equal(a.parent_id, null);
  assert.equal(b.id, a.id);
  assert.equal(sends(f), 1, 'the parent is created once');
});

test('the parent goes under the root of S-1 when S-1 exists', async () => {
  const g = fakeApi({ s1: { id: 'mid', parent_chain: [{ id: 'root', key: 'S-0', title: 'Root', status: 'ready' }] } });
  const p = await feedbackParent(g.api, 'alice');
  assert.equal(p.parent_id, 'root');
  const h = fakeApi({ s1: { id: 's1-id', parent_chain: [] } });
  assert.equal((await feedbackParent(h.api, 'alice')).parent_id, 's1-id');
});

test('a report becomes a backlog ITSA under the parent, with the reporter and one quiet mail to the chief of staff', async () => {
  const text = await report(f.api, 'alice', { kind: 'bug', summary: 'send_mail drops reply_to', details: 'It ignored reply_to.', tool: 'send_mail' });
  const parent = f.itsas.find((x) => x.title === 'Feedback');
  const r = f.itsas.find((x) => x.kind === 'feedback-report');
  assert.match(text, /^Filed S-101 /);
  assert.equal(r.parent_id, parent.id);
  assert.equal(r.title, 'send_mail drops reply_to');
  assert.deepEqual(r.participants, ['alice']);
  assert.match(r.body, /^Kind: bug\nTool: send_mail\nReporter: alice\n\nIt ignored reply_to\.$/);
  assert.equal(f.mails.length, 1);
  assert.deepEqual(f.mails[0].to, ['cos']);
  assert.equal(f.mails[0].itsa, 'S-101');
  assert.equal(f.mails[0].from, 'alice');
});

test('a repeat of an open report with the same tool and summary becomes a comment, not a new ITSA or mail', async () => {
  await report(f.api, 'alice', { kind: 'bug', summary: 'send_mail drops reply_to', details: 'first', tool: 'send_mail' });
  const text = await report(f.api, 'bob', { kind: 'bug', summary: 'Send mail drops: reply to', details: 'again', tool: 'send_mail' });
  assert.match(text, /^Already reported as S-101/);
  assert.equal(f.itsas.filter((x) => x.kind === 'feedback-report').length, 1);
  assert.equal(f.mails.length, 1);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].by, 'bob');
  assert.match(f.comments[0].body, /again/);
});

test('a different tool, or a closed report, is a new report', async () => {
  await report(f.api, 'alice', { kind: 'bug', summary: 'drops reply_to', details: 'a', tool: 'send_mail' });
  await report(f.api, 'alice', { kind: 'bug', summary: 'drops reply_to', details: 'b', tool: 'itsa_set' });
  assert.equal(f.itsas.filter((x) => x.kind === 'feedback-report').length, 2);
  f.itsas.find((x) => x.key === 'S-101').closed_at = '2026-10-12T10:00:00Z';
  await report(f.api, 'alice', { kind: 'bug', summary: 'drops reply_to', details: 'c', tool: 'send_mail' });
  assert.equal(f.itsas.filter((x) => x.kind === 'feedback-report').length, 3);
});

test('no tool is recorded as none, and no chief of staff means no mail', async () => {
  const g = fakeApi({ cos: null });
  const text = await report(g.api, 'alice', { kind: 'missing_feature', summary: 'a  bulk archive', details: 'x' });
  assert.match(text, /^Filed S-101 .* under Feedback\.$/);
  assert.match(g.itsas.find((x) => x.kind === 'feedback-report').body, /^Kind: missing_feature\nTool: none\n/);
  assert.equal(g.mails.length, 0);
});

test('a bad kind or an empty summary is refused before anything is filed', async () => {
  await assert.rejects(report(f.api, 'alice', { kind: 'gripe', summary: 'x', details: 'y' }), /kind must be one of/);
  await assert.rejects(report(f.api, 'alice', { kind: 'bug', summary: '  \n ', details: 'y' }), /summary is required/);
  assert.equal(f.itsas.length, 0);
});
