#!/usr/bin/env node
// Unit tests for src/retro.ts (S-158): the standing Retros parent (created once, under the root
// of S-1's tree when S-1 exists), filing an item as a retro ITSA with the reporter as participant
// and the On line, search across retro items and feedback reports by meaning (with the word
// fallback) with Kind, +1 counts and details, a +1 comment that refuses other ITSAs, and no mail.
// A fake API stands in for the daemon, so no daemon or network. Run with
// `node --test test/retro.test.mjs`.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { fileRetro, retroParent, searchRetros, plusOne, runRetro, epicOffer, headerFields, COUNTED } = await import('../src/retro.ts');
const { report } = await import('../src/feedback.ts');

// An in-memory stand-in for the daemon routes the retro module calls. `meaning` is what the
// embedding search route answers: an array of hits, 'keyword' for a keyword-only answer (no
// embedder), 'fail' for a route error, or nothing for no meaning hits.
function fakeApi({ s1 = null, agents = [{ id: 'a1', name: 'alice', model: 'claude-haiku-5-5', type: 'developer' }], meaning } = {}) {
  const itsas = [];
  const posts = [];
  const mails = [];
  const finals = [];
  const searches = [];
  let seq = 100;
  let ids = 0;
  const api = async (method, path, body) => {
    const url = new URL(path, 'http://daemon');
    const q = url.searchParams;
    if (method === 'GET' && url.pathname === '/api/itsas') {
      let rows = itsas;
      if (q.has('kind')) rows = rows.filter((x) => x.kind === q.get('kind'));
      if (q.has('participant')) rows = rows.filter((x) => x.participants.includes(q.get('participant')));
      return rows;
    }
    if (method === 'GET' && url.pathname === '/api/itsas/S-1') {
      if (!s1) throw new Error('404 no such ITSA');
      return s1;
    }
    if (method === 'GET' && url.pathname === '/api/itsas/search') {
      searches.push({ kind: q.get('kind'), open: q.get('open'), offset: q.get('offset') });
      if (meaning === 'fail') throw Object.assign(new Error('the search route is down'), { status: 500 });
      if (meaning === 'keyword') return [{ by: 'keyword' }];
      // As the route does: open=1 drops closed matches, the ranking is best first, and the page is
      // limit hits from offset (S-729).
      const hits = (meaning ?? []).filter((h) => q.get('open') !== '1' || itsas.some((x) => x.id === h.id && !x.closed_at)).sort((a, b) => b.score - a.score);
      const limit = Math.min(30, Math.max(1, Number(q.get('limit') ?? 10)));
      const offset = Math.max(0, Number(q.get('offset') ?? 0));
      return hits.slice(offset, offset + limit);
    }
    // The daemon refuses an OpenCode caller's thread read, which names no agent, and a
    // non-participant's even when named (S-796): the +1 path must never need this route.
    if (method === 'GET' && url.pathname.endsWith('/thread')) {
      throw Object.assign(new Error('the OpenCode server must name the agent that reads the threads'), { status: 403 });
    }
    // The +1 count alone (S-796): the counted comments, with no thread content.
    if (method === 'GET' && url.pathname.endsWith('/plus-ones')) {
      const id = url.pathname.split('/')[3];
      return { count: posts.filter((p) => p.id === id && COUNTED.test(p.body ?? '')).length };
    }
    if (method === 'GET' && url.pathname.startsWith('/api/itsas/')) {
      const ref = url.pathname.split('/').pop();
      const row = itsas.find((x) => x.id === ref || x.key === ref);
      if (!row) throw new Error(`404 no such ITSA ${ref}`);
      return row;
    }
    if (method === 'GET' && url.pathname === '/api/agents') {
      return agents;
    }
    if (method === 'POST' && url.pathname === '/api/itsas') {
      // Keys run S-101, S-102, ... as the daemon's do; the Retros parent is R-1.
      const key = body.kind === 'retros' ? 'R-1' : `S-${(seq += 1)}`;
      const { by: _by, parent, participants, ...rest } = body;
      const row = { id: `id${(ids += 1)}`, key, closed_at: null, updated_at: new Date(Date.UTC(2026, 9, 12, 0, ids)).toISOString(), status: 'backlog', body: null, ...rest, parent_id: parent ?? null, participants: [...(participants ?? [])] };
      itsas.push(row);
      return row;
    }
    if (method === 'POST' && url.pathname.endsWith('/post')) {
      const id = url.pathname.split('/')[3];
      const row = itsas.find((x) => x.id === id);
      posts.push({ id, body: body.body, by: body.by, ts: new Date(Date.UTC(2026, 9, 12, 1, posts.length)).toISOString() });
      if (!row.participants.includes(body.by)) row.participants.push(body.by);
      return {};
    }
    if (method === 'POST' && /^\/api\/agents\/[^/]+\/retro-final$/.test(url.pathname)) {
      finals.push({ id: url.pathname.split('/')[3], ...body });
      return {};
    }
    if (method === 'GET' && url.pathname === '/api/chief-of-staff') return { chiefOfStaff: 'cos' };
    if (method === 'POST' && url.pathname === '/api/mail') {
      mails.push(body);
      return {};
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  // Test helper: an ITSA made by hand, with the fields the search and +1 read.
  const add = (row) => {
    const full = { id: `id${(ids += 1)}`, key: `S-${(seq += 1)}`, closed_at: null, status: 'ready', participants: [], updated_at: '2026-10-01T00:00:00Z', body: null, summary: null, kind: null, parent_id: null, ...row };
    itsas.push(full);
    return full;
  };
  return { api, itsas, posts, mails, finals, searches, add };
}

const count = (f, kind) => f.itsas.filter((x) => x.kind === kind).length;

let f;
beforeEach(() => {
  f = fakeApi();
});

test('the standing Retros parent is a root when S-1 does not exist, and is created once', async () => {
  const a = await retroParent(f.api, 'alice');
  const b = await retroParent(f.api, 'alice');
  assert.equal(a.title, 'Retros');
  assert.equal(a.kind, 'retros');
  assert.equal(a.parent_id, null);
  assert.equal(b.id, a.id);
  assert.equal(count(f, 'retros'), 1);
});

test('the parent goes under the root of S-1 when S-1 exists', async () => {
  const g = fakeApi({ s1: { id: 'mid', parent_chain: [{ id: 'root', key: 'S-0', title: 'Root', status: 'ready' }] } });
  assert.equal((await retroParent(g.api, 'alice')).parent_id, 'root');
  const h = fakeApi({ s1: { id: 's1-id', parent_chain: [] } });
  assert.equal((await retroParent(h.api, 'alice')).parent_id, 's1-id');
});

test('an item is filed as a retro ITSA in idea under Retros, with the reporter and no mail', async () => {
  const text = await fileRetro(f.api, 'a1', { kind: 'improve', summary: 'send_mail  drops reply_to', details: 'It ignored reply_to on the second send.', target: 'send_mail' });
  const parent = f.itsas.find((x) => x.kind === 'retros');
  const r = f.itsas.find((x) => x.kind === 'retro');
  assert.equal(text, 'Filed S-101 "send_mail drops reply_to" [idea] under Retros.');
  assert.equal(r.status, 'idea');
  assert.equal(r.parent_id, parent.id);
  assert.equal(r.title, 'send_mail drops reply_to');
  assert.deepEqual(r.participants, ['a1']);
  assert.equal(r.body, 'Kind: improve\nTarget: send_mail\nEvidence: none\nReporter: alice (claude-haiku-5-5, developer)\n\nIt ignored reply_to on the second send.');
  assert.equal(f.mails.length, 0);
});

test('a title is stored as the ITSA title and the summary as the summary; without one the summary is the title', async () => {
  const text = await fileRetro(f.api, 'a1', { kind: 'improve', title: ' Reply_to  dropped ', summary: 'send_mail drops reply_to on the second send', details: 'd', target: 'send_mail' });
  const r = f.itsas.find((x) => x.kind === 'retro');
  assert.equal(text, 'Filed S-101 "Reply_to dropped" [idea] under Retros.');
  assert.equal(r.title, 'Reply_to dropped');
  assert.equal(r.summary, 'send_mail drops reply_to on the second send');
});

test('two reports on one tool with the same title but different summaries are two reports', async () => {
  const issue = (summary) => ({ kind: 'stam_issue', feedback_kind: 'bug', title: 'Wait loop', summary, details: 'd', tool: 'wait_for' });
  await runRetro(f.api, 'a1', issue('wait_for hangs on idle panes'));
  await runRetro(f.api, 'a1', issue('wait_for ignores timeout_minutes'));
  assert.equal(f.itsas.filter((x) => x.kind === 'feedback-report').length, 2);
  await runRetro(f.api, 'a1', issue('wait_for ignores timeout_minutes'));
  assert.equal(f.itsas.filter((x) => x.kind === 'feedback-report').length, 2);
});

test('an older caller without a title falls back to the summary', async () => {
  const text = await fileRetro(f.api, 'a1', { kind: 'improve', summary: 'Mail is slow', details: 'd', target: 'send_mail' });
  assert.equal(text, 'Filed S-101 "Mail is slow" [idea] under Retros.');
  assert.equal(f.itsas.find((x) => x.kind === 'retro').title, 'Mail is slow');
});

test('improve and instruction items are refused without a target, and nothing is filed (S-1228)', async () => {
  const msg = /target is required for improve and instruction items: name the template, block, tool, script or file/;
  for (const kind of ['improve', 'instruction']) {
    const g = fakeApi();
    await assert.rejects(fileRetro(g.api, 'a1', { kind, summary: 'x', details: 'y' }), msg, `${kind} with no target`);
    await assert.rejects(fileRetro(g.api, 'a1', { kind, summary: 'x', details: 'y', target: 'none' }), msg, `${kind} with none`);
    await assert.rejects(fileRetro(g.api, 'a1', { kind, summary: 'x', details: 'y', target: ' NONE ' }), msg, `${kind} with NONE`);
    await assert.rejects(fileRetro(g.api, 'a1', { kind, summary: 'x', details: 'y', target: '   ' }), msg, `${kind} with blank`);
    assert.equal(g.itsas.length, 0, `${kind} files nothing`);
  }
});

test('idea and went_well items still file without a target, and improve with a target files', async () => {
  const g = fakeApi();
  await fileRetro(g.api, 'a1', { kind: 'idea', summary: 'an idea', details: 'x' });
  await fileRetro(g.api, 'a1', { kind: 'went_well', summary: 'a trick', details: 'y' });
  assert.equal(count(g, 'retro'), 2);
  await fileRetro(g.api, 'a1', { kind: 'improve', summary: 'a lesson', details: 'z', target: 'type-reviewer' });
  assert.equal(count(g, 'retro'), 3);
  assert.match(g.itsas.find((x) => x.summary === 'a lesson').body, /^Kind: improve\nTarget: type-reviewer\n/);
});

test('stam_issue passes its title to the report and the reply shows it', async () => {
  const text = await runRetro(f.api, 'a1', { kind: 'stam_issue', feedback_kind: 'bug', title: 'Reply_to dropped', summary: 'send_mail drops reply_to', details: 'd' });
  assert.match(text, /^Filed S-\d+ "Reply_to dropped" \[backlog\]/);
  const r = f.itsas.find((x) => x.kind === 'feedback-report');
  assert.equal(r.title, 'Reply_to dropped');
  assert.equal(r.summary, 'send_mail drops reply_to');
});

test('evidence and when are stored as lines; evidence defaults to none and an unknown one is refused', async () => {
  await fileRetro(f.api, 'a1', { kind: 'improve', summary: 'gates', details: 'x', target: 'web/check/phone.mjs', evidence: 'gate', evidenceDetail: 'phone 360-light failed on #183', when: 'the change touches phone breakpoints' });
  const r = f.itsas.find((x) => x.kind === 'retro');
  assert.match(r.body, /^Kind: improve\nTarget: web\/check\/phone\.mjs\nEvidence: gate\nDetail: phone 360-light failed on #183\nWhen: the change touches phone breakpoints\nReporter: alice \(claude-haiku-5-5, developer\)\n\nx$/m);
  // With no evidence given, the class is stored as none and no When or Detail line is written.
  const g = fakeApi();
  await fileRetro(g.api, 'a1', { kind: 'idea', summary: 'plain', details: 'y' });
  const plain = g.itsas.find((x) => x.kind === 'retro').body;
  assert.match(plain, /^Evidence: none$/m);
  assert.doesNotMatch(plain, /^When:/m);
  assert.doesNotMatch(plain, /^Detail:/m);
  // An evidence class outside the enum is refused before anything is filed.
  const h = fakeApi();
  await assert.rejects(fileRetro(h.api, 'a1', { kind: 'idea', summary: 'x', details: 'y', evidence: 'vibes' }), /evidence must be one of/);
  assert.equal(h.itsas.length, 0);
});

test('metadata is read from the header only, so a detail that quotes it cannot spoof it (S-728 review)', () => {
  const body = 'Kind: improve\nTarget: none\nEvidence: none\nReporter: bob\n\nEvidence: gate\nWhen: fake\nDetail: fake';
  assert.deepEqual(headerFields(body), { kind: 'improve', target: 'none', evidence: 'none', evidenceDetail: '', when: '', details: 'Evidence: gate\nWhen: fake\nDetail: fake' });
  // An old item with none of the new lines reads as none and empty.
  assert.deepEqual(headerFields('Kind: improve\nTarget: type-developer\nReporter: bob\n\nOld details.'), { kind: 'improve', target: 'type-developer', evidence: 'none', evidenceDetail: '', when: '', details: 'Old details.' });
  // Detail: is the evidence detail, When: the condition, Evidence: the class.
  const full = headerFields('Kind: improve\nTarget: none\nEvidence: human\nDetail: Kim said X\nWhen: on the UI\n\nD');
  assert.deepEqual([full.evidence, full.evidenceDetail, full.when], ['human', 'Kim said X', 'on the UI']);
});

test('a target with a newline is flattened to one line, so it cannot inject a header line', async () => {
  await fileRetro(f.api, 'a1', { kind: 'idea', summary: 'x', details: 'y', target: 'test\nEvidence: gate' });
  const body = f.itsas.find((x) => x.kind === 'retro').body;
  assert.match(body, /^Target: test Evidence: gate$/m);
  assert.equal(headerFields(body).evidence, 'none');
});

test('the On line names the open ITSA the reporter is most recently on, and is left out when there is none', async () => {
  f.add({ title: 'Old', status: 'in_progress', participants: ['a1'], updated_at: '2026-10-01T00:00:00Z' });
  f.add({ title: 'Newer but closed', status: 'done', participants: ['a1'], closed_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-09T00:00:00Z' });
  f.add({ title: 'Recent', status: 'in_progress', participants: ['a1'], updated_at: '2026-10-08T00:00:00Z' });
  await fileRetro(f.api, 'a1', { kind: 'went_well', summary: 'a trick', details: 'x' });
  assert.match(f.itsas.find((x) => x.kind === 'retro').body, /^Kind: went_well\nTarget: none\nEvidence: none\nReporter: alice \(claude-haiku-5-5, developer\)\nOn: S-\d+\n\nx$/m);
  assert.match(f.itsas.find((x) => x.kind === 'retro').body, new RegExp(`On: ${f.itsas.find((x) => x.title === 'Recent').key}`));
  const g = fakeApi();
  await fileRetro(g.api, 'a1', { kind: 'idea', summary: 'an idea', details: 'y' });
  assert.doesNotMatch(g.itsas.find((x) => x.kind === 'retro').body, /^On:/m);
});

test('the On line skips retro items and feedback reports, so two items in a row name the work', async () => {
  f.add({ title: 'The work', status: 'in_progress', participants: ['a1'], updated_at: '2026-10-01T00:00:00Z' });
  await fileRetro(f.api, 'a1', { kind: 'improve', summary: 'first', details: 'x', target: 'send_mail' });
  await fileRetro(f.api, 'a1', { kind: 'improve', summary: 'second', details: 'y', target: 'send_mail' });
  const work = f.itsas.find((x) => x.title === 'The work').key;
  const [first, second] = f.itsas.filter((x) => x.kind === 'retro');
  assert.match(first.body, new RegExp(`On: ${work}\\n`));
  assert.match(second.body, new RegExp(`On: ${work}\\n`));
});

test('search falls back to word overlap when the embedder is not ready, with Kind, +1 counts and details', async () => {
  const weak = f.add({ kind: 'retro', title: 'Mail is slow', summary: 'Mail is slow', body: 'Kind: idea\nTarget: none\nReporter: bob\n\nslow', status: 'idea' });
  const strong = f.add({ kind: 'feedback-report', title: 'send mail drops reply_to', summary: 'send mail drops reply_to', body: 'Kind: bug\nTool: send_mail\nReporter: bob\n\nreply_to lost', status: 'backlog' });
  f.add({ kind: 'retro', title: 'send mail drops reply_to', summary: 'send mail drops reply_to', body: 'Kind: improve\nTarget: send_mail\n\nclosed one', status: 'done', closed_at: '2026-10-02T00:00:00Z' });
  f.add({ kind: null, title: 'send mail drops reply_to', summary: null, body: 'not a retro', status: 'ready' });
  await plusOne(f.api, 'a1', strong.key, 'same on my run');
  const text = await searchRetros(f.api, 'Send, mail reply_to');
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Ranked by keyword.');
  assert.equal(lines[1], `${strong.key} "send mail drops reply_to" [backlog] · Kind: bug · 1 +1 · reply_to lost`);
  assert.equal(lines[2], `${weak.key} "Mail is slow" [idea] · Kind: idea · 0 +1s · slow`);
});

test('search ranks open retro items by meaning when the embedder is ready, best first, over the retro kinds only', async () => {
  const hits = [];
  const g = fakeApi({ meaning: hits });
  const near = g.add({ kind: 'retro', title: 'Chromium download stalls', summary: 'Chromium download stalls', body: 'Kind: improve\n\nplaywright browser download is slow', status: 'idea' });
  const mid = g.add({ kind: 'retro', title: 'Browser lock', summary: 'Browser lock', body: 'Kind: improve\n\nthe shared chromium lock', status: 'idea' });
  // The word-only item shares the query's words but is not near by meaning: it must not appear.
  g.add({ kind: 'retro', title: 'Chromium download stalls the run', summary: 'Chromium download stalls the run', body: 'Kind: improve\n\nword overlap', status: 'idea' });
  await plusOne(g.api, 'a1', near.key, 'same on my run');
  // Out of order on purpose: the search keeps the route's ranking, best first.
  hits.push({ id: mid.id, by: 'meaning', score: 0.6 }, { id: near.id, by: 'meaning', score: 0.9 });
  const lines = (await searchRetros(g.api, 'browser download stalls')).split('\n');
  assert.deepEqual(lines, [
    'Ranked by meaning.',
    `${near.key} "Chromium download stalls" [idea] · Kind: improve · 1 +1 · playwright browser download is slow`,
    `${mid.key} "Browser lock" [idea] · Kind: improve · 0 +1s · the shared chromium lock`,
  ]);
  assert.deepEqual(g.searches, [{ kind: 'retro,feedback-report', open: '1', offset: '0' }]);
});

test('the meaning search asks for open items only, so a closed hit cannot fill the three (S-729)', async () => {
  const hits = [];
  const g = fakeApi({ meaning: hits });
  const closed = g.add({ kind: 'retro', title: 'Chromium download stalls', summary: 'Chromium download stalls', body: 'Kind: improve\n\nplaywright browser download is slow', status: 'done', closed_at: '2026-10-02T00:00:00Z' });
  const open = g.add({ kind: 'retro', title: 'Browser lock', summary: 'Browser lock', body: 'Kind: improve\n\nthe shared chromium lock', status: 'idea' });
  hits.push({ id: closed.id, by: 'meaning', score: 0.95 }, { id: open.id, by: 'meaning', score: 0.5 });
  const lines = (await searchRetros(g.api, 'browser download stalls')).split('\n');
  assert.equal(lines.length, 2, 'the prefix and the one open hit');
  assert.match(lines[1], new RegExp(`^${open.key} `));
});

test('the search pages past matches whose count the daemon refuses until it has the rest (S-729)', async () => {
  const hits = [];
  const g = fakeApi({ meaning: hits });
  const rows = [];
  for (let i = 0; i < 31; i += 1) rows.push(g.add({ kind: 'retro', title: `item ${i}`, summary: `item ${i}`, body: `Kind: improve\n\nd${i}`, status: 'idea' }));
  rows.forEach((r, i) => hits.push({ id: r.id, by: 'meaning', score: i < 30 ? 1 - i / 1000 : 0.1 }));
  const readable = rows[30];
  // The daemon refuses the count of the first 30 (403); the 31st is countable.
  const guarded = async (method, path, body) => {
    if (method === 'GET' && rows.slice(0, 30).some((r) => path === `/api/itsas/${r.id}/plus-ones`)) {
      throw Object.assign(new Error("x can't read the count"), { status: 403 });
    }
    return g.api(method, path, body);
  };
  const text = await searchRetros(guarded, 'item');
  assert.equal(text, `Ranked by meaning.\n${readable.key} "item 30" [idea] · Kind: improve · 0 +1s · d30`);
  assert.deepEqual(g.searches.map((s) => s.offset), ['0', '30'], 'the search paged past the first 30');
});

test('when every meaning match is uncountable, the word search finds a countable one (S-729)', async () => {
  const hits = [];
  const g = fakeApi({ meaning: hits });
  const hidden = g.add({ kind: 'retro', title: 'wait loop', summary: 'wait loop', body: 'Kind: improve\n\nwait', status: 'idea' });
  const readable = g.add({ kind: 'retro', title: 'wait loop too', summary: 'wait loop too', body: 'Kind: improve\n\nwait', status: 'idea' });
  hits.push({ id: hidden.id, by: 'meaning', score: 0.9 });
  const guarded = async (method, path, body) => {
    if (method === 'GET' && path === `/api/itsas/${hidden.id}/plus-ones`) throw Object.assign(new Error('x'), { status: 403 });
    return g.api(method, path, body);
  };
  const text = await searchRetros(guarded, 'wait');
  assert.equal(text, `Ranked by keyword.\n${readable.key} "wait loop too" [idea] · Kind: improve · 0 +1s · wait`);
});

test('a failing meaning route or a keyword-only answer falls back to word overlap, never throwing', async () => {
  for (const mode of ['fail', 'keyword']) {
    const g = fakeApi({ meaning: mode });
    const a = g.add({ kind: 'retro', title: 'Wait loops hang', summary: 'Wait loops hang', body: 'Kind: improve\n\nwait', status: 'idea' });
    const text = await searchRetros(g.api, 'wait');
    assert.match(text, /^Ranked by keyword\./, mode);
    assert.match(text, new RegExp(`${a.key} "Wait loops hang"`), mode);
  }
});

test('search skips a match whose count the daemon refuses, and returns the rest (S-709, S-732)', async () => {
  const hits = [];
  const g = fakeApi({ meaning: hits });
  const hidden = g.add({ kind: 'retro', title: 'send mail drops reply_to', summary: 'send mail drops reply_to', body: 'Kind: bug\n\nreply_to lost', status: 'backlog' });
  const readable = g.add({ kind: 'retro', title: 'Mail is slow', summary: 'Mail is slow', body: 'Kind: idea\n\nslow', status: 'idea' });
  // The daemon refuses the count of an item the caller may not read, with a 403.
  const guarded = async (method, path, body) => {
    if (method === 'GET' && path === `/api/itsas/${hidden.id}/plus-ones`) {
      throw Object.assign(new Error(`human-auth can't read the threads of ${hidden.key}: only its owner and participants may`), { status: 403 });
    }
    return g.api(method, path, body);
  };
  // The uncountable match is nearer (0.9 to 0.5), so it is tried first and skipped.
  hits.push({ id: hidden.id, by: 'meaning', score: 0.9 }, { id: readable.id, by: 'meaning', score: 0.5 });
  const text = await searchRetros(guarded, 'send mail reply_to slow');
  assert.equal(text, `Ranked by meaning.\n${readable.key} "Mail is slow" [idea] · Kind: idea · 0 +1s · slow`);
});

test('search caps the hits at three and says so when nothing matches', async () => {
  const hits = [];
  const g = fakeApi({ meaning: hits });
  const rows = [0, 1, 2, 3].map((i) => g.add({ kind: 'retro', title: `wait loop ${i}`, summary: `wait loop ${i}`, body: `Kind: improve\n\nw${i}`, status: 'idea' }));
  rows.forEach((r, i) => hits.push({ id: r.id, by: 'meaning', score: 0.9 - i * 0.1 }));
  assert.equal((await searchRetros(g.api, 'wait')).split('\n').length, 4, 'the prefix and three hits');
  for (let i = 0; i < 7; i += 1) f.add({ kind: 'retro', title: `wait loop ${i}`, summary: `wait loop ${i}`, body: 'Kind: improve\n\n' });
  assert.equal((await searchRetros(f.api, 'wait')).split('\n').length, 4, 'the word fallback is capped at three too');
  assert.match(await searchRetros(f.api, 'nothing like this'), /^No open retro items or feedback reports match "nothing like this"/);
  await assert.rejects(searchRetros(f.api, ' , '), /needs at least one word/);
});

test('a +1 posts a comment with the reporter and counts it; feedback repeats count too', async () => {
  const r = await fileRetro(f.api, 'a1', { kind: 'improve', summary: 'waits hang', details: 'first run', target: 'waits' });
  const key = r.match(/^Filed (S-\d+)/)[1];
  f.add({ kind: 'feedback-report', key: 'S-900', title: 'x', summary: 'x', body: 'Kind: bug\n' });
  const ref = f.itsas.find((x) => x.key === 'S-900');
  f.posts.push({ id: ref.id, body: 'Reported again by someone:\n\nagain', by: 'z', ts: '2026-10-12T02:00:00Z' });
  assert.equal(await plusOne(f.api, 'a1', key, 'the same on my run'), `+1 on ${key} "waits hang": 1 +1 now.`);
  assert.equal(f.posts.at(-1).body, '+1 from alice: the same on my run');
  assert.equal(await plusOne(f.api, 'a1', 'S-900', 'me too'), '+1 on S-900 "x": 2 +1s now.');
  assert.ok(f.itsas.find((x) => x.key === key).participants.includes('a1'));
});

test('a +1 is refused for an ITSA that is not a retro item or feedback report, and an empty one for details', async () => {
  const other = f.add({ kind: 'initiative', title: 'Other', status: 'ready' });
  await assert.rejects(plusOne(f.api, 'a1', other.key, 'x'), /is not a retro item or feedback report/);
  assert.equal(f.posts.length, 0);
  const r = await fileRetro(f.api, 'a1', { kind: 'idea', summary: 'an idea', details: 'x' });
  await assert.rejects(plusOne(f.api, 'a1', r.match(/S-\d+/)[0], '  '), /details is required/);
});

test('a +1 and a search read the count route, never the thread, so an OpenCode caller works (S-796)', async () => {
  // The fake refuses every thread read as the daemon refuses an OpenCode server that names no
  // agent, and a non-participant even when named: the count route is the only way through.
  const r = await fileRetro(f.api, 'a1', { kind: 'improve', summary: 'waits hang', details: 'first run', target: 'waits' });
  const key = r.match(/S-\d+/)[0];
  assert.match(await plusOne(f.api, 'a1', key, 'same on my run'), new RegExp(`^\\+1 on ${key} "waits hang": 1 \\+1 now\\.$`));
  assert.match(await searchRetros(f.api, 'waits hang'), new RegExp(`${key} "waits hang" \\[idea\\] · Kind: improve · 1 \\+1 · first run`));
});

test('a +1 whose count cannot be read still lands and says so (S-796)', async () => {
  const r = await fileRetro(f.api, 'a1', { kind: 'idea', summary: 'an idea', details: 'x' });
  const key = r.match(/S-\d+/)[0];
  const api = async (method, path, body) => {
    if (method === 'GET' && path.endsWith('/plus-ones')) throw Object.assign(new Error('the count route is down'), { status: 500 });
    return f.api(method, path, body);
  };
  assert.equal(await plusOne(api, 'a1', key, 'mine too'), `+1 on ${key} "an idea": the +1 landed, but its count couldn't be read.`);
  assert.equal(f.posts.length, 1, 'the +1 was posted');
});

test('bad input is refused before anything is filed', async () => {
  await assert.rejects(runRetro(f.api, 'a1', { kind: 'gripe', summary: 'x', details: 'y' }), /kind must be one of/);
  await assert.rejects(runRetro(f.api, 'a1', { kind: 'idea', summary: '  \n ', details: 'y' }), /summary is required/);
  await assert.rejects(runRetro(f.api, 'a1', { kind: 'idea', summary: 'x', details: ' ' }), /details is required/);
  assert.equal(f.itsas.length, 0);
});

test('runRetro routes by field: search, then +1, then file', async () => {
  const filed = await runRetro(f.api, 'a1', { kind: 'went_well', summary: 'batch edits', details: 'one call for three files' });
  assert.match(filed, /^Filed S-\d+ "batch edits" \[idea\] under Retros\.$/);
  assert.match(await runRetro(f.api, 'a1', { search: 'batch' }), /batch edits" \[idea\] · Kind: went_well · 0 \+1s/);
  const key = filed.match(/S-\d+/)[0];
  assert.match(await runRetro(f.api, 'a1', { plus_one: key, details: 'mine too' }), /^\+1 on S-\d+ .* 1 \+1 now\.$/);
});

test('the final round stores the effort split as a retro_final event, not an ITSA', async () => {
  const f = fakeApi();
  const out = await runRetro(f.api, 'a1', { final: true, effort: { reading: 40, implementing: 30, testing: 20, waiting: 0, review_fixes: 5, coordination: 5 } });
  assert.match(out, /^Recorded the final retro round for a1: reading 40%, implementing 30%/);
  assert.deepEqual(f.finals, [{ id: 'a1', by: 'a1', effort: { reading: 40, implementing: 30, testing: 20, waiting: 0, review_fixes: 5, coordination: 5 } }]);
  assert.equal(f.itsas.length, 0);
});

test('the final round refuses a missing effort, an unknown area, and a value outside 0-100', async () => {
  const f = fakeApi();
  await assert.rejects(runRetro(f.api, 'a1', { final: true }), /effort is required/);
  await assert.rejects(runRetro(f.api, 'a1', { final: true, effort: { napping: 10 } }), /effort napping is not one of/);
  await assert.rejects(runRetro(f.api, 'a1', { final: true, effort: { reading: 101 } }), /must be a percentage from 0 to 100/);
  await assert.rejects(runRetro(f.api, 'a1', { final: true, effort: { reading: NaN } }), /must be a percentage/);
  assert.equal(f.finals.length, 0);
});

test('the archive wrap-up asks for the final round, forced or not; a shutdown does not', async () => {
  const { archiveWrapUp } = await import('../src/lifecycle.ts');
  const { render } = await import('../src/templates.ts');
  const shutdown = render('shutdown-prepare', {});
  const archive = archiveWrapUp();
  assert.ok(archive.startsWith(shutdown));
  assert.match(archive, /call `retro` with `final: true` and `effort`/);
  assert.match(archive, /up to three retro items/);
  assert.doesNotMatch(shutdown, /final: true/);
});

test('the retro paragraph is in every agent\'s system prompt and stays short', async () => {
  const { render } = await import('../src/templates.ts');
  const paragraph = render('retro', {});
  assert.match(paragraph, /^# Retros/);
  assert.match(paragraph, /`retro`/);
  assert.ok(paragraph.split(/\s+/).length < 100, 'under about 100 words');
  const prompt = render('system-prompt', { id: 'a1', name: 'alice', role: 'x', org: '', instructions: '', cost: '', retro: paragraph, itsa: '', human_mail: '' });
  assert.ok(prompt.includes(paragraph));
});

const issue = { kind: 'stam_issue', feedback_kind: 'bug', summary: 'search misses words', details: 'two words, one hit', tool: 'retro' };

test('retro kind=stam_issue files a feedback report under Feedback, with one mail to the chief of staff', async () => {
  const text = await runRetro(f.api, 'a1', issue);
  assert.match(text, /^Filed S-\d+ "search misses words" \[backlog\] under Feedback, and told the chief of staff\.$/);
  const row = f.itsas.find((x) => x.kind === 'feedback-report');
  assert.match(row.body, /^Kind: bug\nTool: retro\nReporter: a1\n/);
  assert.equal(f.itsas.find((x) => x.kind === 'feedback').title, 'Feedback');
  assert.equal(row.parent_id, f.itsas.find((x) => x.kind === 'feedback').id);
  assert.equal(count(f, 'retro'), 0);
  assert.equal(f.mails.length, 1);
  assert.deepEqual(f.mails[0].to, ['cos']);
});

test('a repeat of an open stam_issue with the same tool and summary is a comment, not a second report or mail', async () => {
  await runRetro(f.api, 'a1', issue);
  const again = await runRetro(f.api, 'a1', { ...issue, details: 'and again' });
  assert.match(again, /^Already reported as S-\d+ "search misses words"; added your report there as a comment\.$/);
  assert.equal(count(f, 'feedback-report'), 1);
  assert.equal(f.mails.length, 1);
  assert.equal(f.posts.length, 1);
});

test('a bad feedback_kind or an empty summary on stam_issue is refused before anything is filed', async () => {
  await assert.rejects(runRetro(f.api, 'a1', { ...issue, feedback_kind: 'gripe' }), /kind must be one of/);
  await assert.rejects(runRetro(f.api, 'a1', { ...issue, summary: ' ' }), /summary is required/);
  assert.equal(f.itsas.length, 0);
});

test('the feedback alias is retro kind=stam_issue: same fields, same result as the report', async () => {
  const direct = fakeApi();
  const viaRetro = await runRetro(f.api, 'a1', issue);
  const viaReport = await report(direct.api, 'a1', { kind: 'bug', summary: 'search misses words', details: 'two words, one hit', tool: 'retro' });
  assert.equal(viaRetro, viaReport);
  assert.equal(f.mails.length, direct.mails.length);
});

// The epic retro offer (S-163): the counting, the reporter threshold, the share rule, and non-epics.
const cfg = { minReporters: 3, maxWindowShare: 50 };
const item = (key, on, reporter) => ({ key, body: `Kind: improve\nTarget: none\nReporter: ${reporter} (claude-haiku-5-5, developer)\nOn: ${on}\n\ndetails` });
const epic = { key: 'S-10', kind: 'project' };
const subtree = new Set(['S-10', 'S-11', 'S-12']);

test('an epic with 3 distinct reporters under its subtree gets the offer, and one with 2 does not', () => {
  const three = [item('S-20', 'S-11', 'alice'), item('S-21', 'S-12', 'bob'), item('S-22', 'S-11', 'carol')];
  const text = epicOffer(epic, subtree, three, 40, cfg);
  assert.ok(text, 'an offer with 3 reporters');
  assert.match(text, /^# Epic retro\n\nS-10 closed with 3 retro items from several reporters: S-20, S-21, S-22\.$/m);
  assert.equal(epicOffer(epic, subtree, [item('S-20', 'S-11', 'alice'), item('S-21', 'S-12', 'bob'), item('S-22', 'S-11', 'bob')], 40, cfg), null);
});

test('only items On the subtree count: items On another ITSA, or with no On line, do not', () => {
  const items = [item('S-20', 'S-11', 'alice'), item('S-21', 'S-12', 'bob'), item('S-22', 'S-99', 'carol'), { key: 'S-23', body: 'Reporter: dan\n\nno On line' }];
  assert.equal(epicOffer(epic, subtree, items, 40, cfg), null);
});

test('a tree under 50% of its 5-hour window gets the ring, at 50% or more the solo retro, and an unknown share the solo retro', () => {
  const items = [item('S-20', 'S-11', 'alice'), item('S-21', 'S-12', 'bob'), item('S-22', 'S-11', 'carol')];
  const ring = epicOffer(epic, subtree, items, 40, cfg);
  assert.match(ring, /`ring_create` with format `rounds`, `max_rounds` 1/);
  assert.match(ring, /`On:` names S-10\./);
  const solo = epicOffer(epic, subtree, items, 60, cfg);
  assert.doesNotMatch(solo, /ring_create/);
  assert.match(solo, /Write the epic retro yourself from these items/);
  assert.match(epicOffer(epic, subtree, items, null, cfg), /Write the epic retro yourself/);
  assert.doesNotMatch(epicOffer(epic, subtree, items, 50, cfg), /ring_create/);
});

test('the offer is short: the template and the step stay under 200 words', () => {
  const items = [item('S-20', 'S-11', 'alice'), item('S-21', 'S-12', 'bob'), item('S-22', 'S-11', 'carol')];
  for (const share of [40, 60]) assert.ok(epicOffer(epic, subtree, items, share, cfg).split(/\s+/).length < 200);
});

test('a non-epic kind gets no offer, whatever the items', () => {
  const items = [item('S-20', 'S-11', 'alice'), item('S-21', 'S-12', 'bob'), item('S-22', 'S-11', 'carol')];
  assert.equal(epicOffer({ key: 'S-10', kind: 'issue' }, subtree, items, 40, cfg), null);
  assert.equal(epicOffer({ key: 'S-10', kind: 'milestone' }, subtree, items, 40, cfg), null);
  assert.ok(epicOffer({ key: 'S-10', kind: 'initiative' }, subtree, items, 40, cfg));
});
