#!/usr/bin/env node
// Unit tests for mail titles (S-297, src/mail-title.ts) against a throwaway STAM_HOME and the
// stub endpoint (test/decide-stub.mjs), no daemon, no network: with no model set no call is
// made; with one, every stored mail (agent or human) gets a cleaned title of at most three words
// and the cost lands under openrouter/mail-title; a failed call stores nothing; the setting
// round-trips through the human's settings patch; clearing the model drops queued work and
// aborts calls in flight, even for mail not yet started; the queue is bounded as mails
// arrive; a title's cost is exact for the OpenRouter reconciliation.
// Run with `node --test test/mail-title.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-title-');
const stubDir = join(home, 'stub');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-title-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
// No search index: the embedder would install a model.
writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { mailCheck: false }, search: { embedder: 'off' } }));

let stub, db, mail, settings, titles, recon;
const calls = () => (existsSync(join(stubDir, 'titles')) ? Number(readFileSync(join(stubDir, 'titles'), 'utf8')) : 0);
const events = (type) => db.open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ?').all('stam', type).map((r) => JSON.parse(r.data));
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const setModel = (model) => settings.patchSettings({ mail: { titles: { model } } });
const summaryOf = (id) => db.getMail(id)?.summary ?? null;
const until = async (fn, what) => {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};
// Waits for the call to settle: a title on the mail, or an error event naming it.
async function settled(id) {
  for (let i = 0; i < 500; i++) {
    if (db.getMail(id)?.title || events('mail-title:error').some((e) => e.id === id)) return db.getMail(id);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no title or error for ${id}`);
}

before(async () => {
  stub = spawn(process.execPath, [join(import.meta.dirname, 'decide-stub.mjs'), stubDir], { stdio: 'ignore' });
  process.on('exit', () => stub.kill());
  for (let i = 0; !existsSync(join(stubDir, 'url')); i++) {
    if (i > 500) throw new Error('the stub did not start');
    await new Promise((r) => setTimeout(r, 10));
  }
  process.env.STAM_OPENROUTER_URL = readFileSync(join(stubDir, 'url'), 'utf8');
  db = await import('../src/db.ts');
  mail = await import('../src/mail.ts');
  settings = await import('../src/settings.ts');
  titles = await import('../src/mail-title.ts');
  recon = await import('../src/reconcile.ts');
  db.open();
  agent('a1', 'alice');
  agent('a2', 'bob');
});
after(() => {
  stub?.kill();
  rmSync(home, { recursive: true, force: true });
});

test('a spent system budget skips the title call', async () => {
  setModel('google/gemma-3-4b-it');
  const day = new Date().toISOString().slice(0, 10);
  settings.patchSettings({ cost: { accounts: { 'openrouter-system': { match: { harness: 'stam' }, budget: { usd: 0.5, per: 'day' } } } } });
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('held-seed', ?, 'openrouter', 'x', 'openrouter-system', 1)").run(day);
  try {
    const before = calls();
    const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Held by budget', body: 'TITLE=Never_asked_held', new_thread: true });
    // The job logs why it skipped the call; once that is there, lift the hold and send a control
    // mail, so the held mail's absence from the stub is read from state, not time.
    await until(() => events('mail-title:skipped').some((e) => e.id === m.id && /system/.test(e.reason)), 'the skipped event');
    db.open().prepare("DELETE FROM usage WHERE agent_id = 'held-seed'").run();
    const control = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'After the hold', body: 'TITLE=Control_mail', new_thread: true });
    await settled(control.id);
    assert.equal(calls(), before + 1, 'only the control mail reached the stub');
    assert.equal(db.getMail(m.id).title, null);
  } finally {
    db.open().prepare("DELETE FROM usage WHERE agent_id = 'held-seed' OR (agent_id = 'stam' AND model = 'mail-title')").run(); // the control call's cost too
    settings.patchSettings({ cost: { accounts: { 'openrouter-system': null } } });
    setModel('');
  }
});

test('the answer is cleaned to at most three words', () => {
  assert.equal(titles.cleanTitle('**Title: Stub mail title words.**'), 'Stub mail title');
  assert.equal(titles.cleanTitle('"Deploy fixed"\nmore text'), 'Deploy fixed');
  assert.equal(titles.cleanTitle('  Token lifetime!  '), 'Token lifetime');
  assert.equal(titles.cleanTitle('x'.repeat(60)), 'x'.repeat(40));
  assert.equal(titles.cleanTitle('  \n '), null);
  assert.equal(titles.cleanTitle(undefined), null);
});

test('the setting round-trips and is off by default', () => {
  assert.equal(settings.settings().mail.titles.model, '');
  setModel('google/gemma-3-4b-it');
  assert.equal(settings.settings().mail.titles.model, 'google/gemma-3-4b-it');
  setModel('');
  assert.equal(settings.settings().mail.titles.model, '');
});

test('with no model set, no call is made; with one, each mail gets a title and a cost', async () => {
  setModel('');
  const before = calls();
  const off = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'No title', body: 'TITLE=Never_asked', new_thread: true });
  setModel('google/gemma-3-4b-it');
  const on = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Deploy the new build today', body: 'The deploy is done.', new_thread: true });
  assert.equal((await settled(on.id)).title, 'Deploy the new');
  // Only the second mail was asked about: the first never reached the stub.
  assert.equal(calls(), before + 1);
  assert.equal(db.getMail(off.id).title, null);
  const row = db.open().prepare("SELECT * FROM usage WHERE agent_id = 'stam' AND model = 'mail-title'").get();
  assert.equal(row.account, 'openrouter-system');
  assert.equal(row.tokens_in, 30);
  assert.equal(row.tokens_out, 4);
  assert.deepEqual(events('decide').at(-1), { purpose: 'mail-title', model: 'google/gemma-3-4b-it-stub', cost: 0.000002, tokens_in: 30, tokens_out: 4 });
});

test('the human’s mail is titled too, and the title shows in the inbox and thread', async () => {
  setModel('google/gemma-3-4b-it');
  const m = await mail.sendMail({ from: 'human', to: ['alice'], subject: 'Question', body: 'TITLE=Token_lifetime', new_thread: true });
  assert.equal((await settled(m.id)).title, 'Token lifetime');
  assert.equal(db.inbox('a1', false, 10).find((x) => x.id === m.id).title, 'Token lifetime');
  assert.equal(db.threadMail(m.thread_id ?? m.id)[0].title, 'Token lifetime');
});

test('a failed call stores no title and is not retried', async () => {
  setModel('google/gemma-3-4b-it');
  const before = calls();
  const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Broken', body: 'STUB:FAIL', new_thread: true });
  assert.equal((await settled(m.id)).title, null);
  assert.equal(calls(), before + 1);
});

test('clearing the model drops queued titles and aborts the calls in flight', async () => {
  writeFileSync(join(stubDir, 'hang'), '');
  setModel('google/gemma-3-4b-it');
  const before = calls();
  const held = [];
  for (const n of [1, 2, 3]) held.push(await mail.sendMail({ from: 'a1', to: ['bob'], subject: `Held ${n}`, body: 'STUB:HANG', new_thread: true }));
  // Two calls reach the stub and wait there; the third waits in the queue.
  await until(() => calls() === before + 2, 'two calls in flight');
  setModel('');
  await until(() => held.slice(0, 2).every((m) => events('mail-title:canceled').some((e) => e.id === m.id)), 'both calls aborted');
  unlinkSync(join(stubDir, 'hang'));
  writeFileSync(join(stubDir, 'release'), '');
  // Back on, a new mail is the next call: the dropped one never ran.
  setModel('google/gemma-3-4b-it');
  const next = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'After the pause', body: 'TITLE=Back_on', new_thread: true });
  assert.equal((await settled(next.id)).title, 'Back on');
  assert.equal(calls(), before + 3);
  for (const m of held) assert.equal(db.getMail(m.id).title, null);
});

test('turning titles off and on before the first call drops the mail queued while on', async () => {
  setModel('');
  const old = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Dropped', body: 'TITLE=Never_asked', new_thread: true });
  setModel('google/gemma-3-4b-it');
  const before = calls();
  // Queued, then dropped and turned back on, all before the deferred pump runs.
  titles.maybeTitleMail(db.getMail(old.id));
  setModel('');
  setModel('google/gemma-3-4b-it');
  const next = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Kept', body: 'TITLE=Kept_title', new_thread: true });
  assert.equal((await settled(next.id)).title, 'Kept title');
  assert.equal(calls(), before + 1);
  assert.equal(db.getMail(old.id).title, null);
});

test('the queue is bounded as mails arrive, before any call starts', async () => {
  setModel('');
  const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Burst', body: 'TITLE=Never_asked', new_thread: true });
  setModel('google/gemma-3-4b-it');
  const before = calls();
  const was = events('mail-title:skipped').length;
  for (let i = 0; i < 105; i++) titles.maybeTitleMail(db.getMail(m.id));
  // Turning off at once drops the hundred queued and reports the five past the bound.
  setModel('');
  assert.deepEqual(events('mail-title:skipped').slice(was), [{ count: 5, reason: 'queue full' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls(), before);
});

test('a title costs exact money, taken out of the next OpenRouter bill unscaled', async () => {
  setModel('google/gemma-3-4b-it');
  const state = () => db.open().prepare('SELECT * FROM ledger_recon WHERE id = 1').get();
  // The first poll only sets the baseline.
  recon.reconcile(recon.snapshot(), 10);
  assert.equal(state().exact_pending, 0);
  const row = () => db.open().prepare("SELECT cost_usd FROM usage WHERE agent_id = 'stam' AND account = 'openrouter-system'").get().cost_usd;
  const was = row();
  const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Billed', body: 'TITLE=Billed_title', new_thread: true });
  await settled(m.id);
  assert.ok(Math.abs(state().exact_pending - 0.000002) < 1e-12, `pending ${state().exact_pending}`);
  assert.ok(Math.abs(row() - was - 0.000002) < 1e-12);
  recon.reconcile(recon.snapshot(), 10.000002);
  assert.ok(Math.abs(state().exact_pending) < 1e-12);
  assert.ok(Math.abs(row() - was - 0.000002) < 1e-12, 'the title cost is not scaled');
});

test('the summary keeps up to five short lines and bullets, cut to 400 characters', () => {
  assert.equal(titles.cleanSummary('**Summary: Pick a token lifetime for SSO: 1h or 12h.**'), 'Pick a token lifetime for SSO: 1h or 12h.');
  assert.equal(titles.cleanSummary('Pick a lifetime for SSO (S-12, PR #7):\n* 1h: safest (recommended)\n- 12h: one login a day\n\n'), 'Pick a lifetime for SSO (S-12, PR #7):\n- 1h: safest (recommended)\n- 12h: one login a day');
  assert.equal(titles.cleanSummary('1\n2\n3\n4\n5\n6\n7\n8'), '1\n2\n3\n4\n5');
  assert.equal(Array.from(titles.cleanSummary('word '.repeat(100))).length <= 400, true);
  assert.equal(titles.cleanSummary('x'.repeat(500)).length, 400);
  assert.equal(titles.cleanSummary('  \n '), null);
  assert.equal(titles.cleanSummary(undefined), null);
});

test('a summary is cut by code points at a word boundary, never inside an emoji', () => {
  const cut = titles.cleanSummary('ab '.repeat(130) + '😀'.repeat(20));
  assert.equal(cut.endsWith('…'), true);
  assert.equal(/[\ud800-\udfff]/.test(cut.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')), false);
  assert.equal(Array.from(cut).length <= 400, true);
  const mid = titles.cleanSummary('x'.repeat(397) + '😀'.repeat(5));
  assert.equal(/[\ud800-\udfff]/.test(mid.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')), false);
  assert.equal(titles.cutText('short', 10), 'short');
});

test('a later paragraph with the ask stays, and only a trailing sign-off is dropped', () => {
  assert.equal(titles.cleanSummary('Spend is up 30%.\n\nApprove $40?'), 'Spend is up 30%.\nApprove $40?');
  assert.equal(titles.cleanSummary('Pick one:\n- 1h\n\nLet me know if you need more.'), 'Pick one:\n- 1h');
  assert.equal(titles.cleanSummary('Pick one:\n\n- 1h\n- 12h\n\nHope this helps!\nFeel free to ask.\nI can also add more.'), 'Pick one:\n- 1h\n- 12h');
  assert.equal(titles.cleanSummary('Deploy is ready.\nIf you approve, it runs at 03:00 tonight.'), 'Deploy is ready.\nIf you approve, it runs at 03:00 tonight.');
  assert.equal(titles.cleanSummary('Pick a lifetime for S-12:\n- 1h (recommended)\n- 12h\nLet me know which one by Friday.'), 'Pick a lifetime for S-12:\n- 1h (recommended)\n- 12h\nLet me know which one by Friday.');
  assert.equal(titles.cleanSummary('Spend is up 30%.\n\nPlease let me know if $40 for test runs is fine.'), 'Spend is up 30%.\nPlease let me know if $40 for test runs is fine.');
  assert.equal(titles.cleanSummary('Hope the fix holds; @ops reports 2 retries since.'), 'Hope the fix holds; @ops reports 2 retries since.');
  assert.equal(titles.cleanSummary('Build is green.\nLet me know if you have questions.'), 'Build is green.');
  // A sign-off in the middle is content, not chatter.
  assert.equal(titles.cleanSummary('Feel free to merge.\nIt is green.'), 'Feel free to merge.\nIt is green.');
  // A "- Title:" bullet is part of the summary, not a label that ends it.
  assert.deepEqual(titles.parseBoth('Title: Rename\nSummary: Options:\n- Title: keep it\n- Name: change it'), { title: 'Rename', summary: 'Options:\n- Title: keep it\n- Name: change it' });
});

test('only a mail to the human has the longer body seen by the model', async () => {
  setModel('google/gemma-3-4b-it');
  const body = 'a '.repeat(1100) + 'STUB:FAIL';
  const agent = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Long to agent', body, new_thread: true });
  await settled(agent.id);
  assert.ok(db.getMail(agent.id).title, 'the agent mail title call never saw the failure marker past 2000 chars');
  const human = await mail.sendMail({ from: 'a1', to: ['human'], subject: 'Long to human', body, new_thread: true });
  await settled(human.id);
  assert.equal(db.getMail(human.id).title, null, 'the human mail call saw the marker within 3000 chars and failed');
});

test('a decision, a blocker and a done mail keep their shape lines through the parser', () => {
  const decision = 'Pick a token lifetime for SSO?\n- 1h: safest (recommended)\n- 12h: one login a day\n- 24h: fewest logins\n- Never: keep sessions open';
  assert.deepEqual(titles.parseBoth(`Title: Token lifetime\nSummary: ${decision}`), { title: 'Token lifetime', summary: decision });
  const blocker = 'Problem: The deploy key expired.\nSolution: Renew the key, then rerun the deploy.';
  assert.deepEqual(titles.parseBoth(`Title: Deploy key\nSummary: ${blocker}`), { title: 'Deploy key', summary: blocker });
  const done = 'Problem: Login failed for SSO users.\nSolution: Raised the token lifetime to 12 hours.\nDeferred: Audit log for logins (S-1290).\nNote: The old 1h tokens still expire at once.';
  assert.deepEqual(titles.parseBoth(`Title: SSO login\nSummary: ${done}`), { title: 'SSO login', summary: done });
  // The labels are content, not a stray label to strip.
  assert.equal(titles.cleanSummary(done), done);
});

test('a decision with four options fits in five lines, and a sixth line is cut', () => {
  const decision = 'Pick a token lifetime?\n- 1h: safest (recommended)\n- 12h: one login a day\n- 24h: fewest logins\n- Never: keep sessions open';
  assert.equal(titles.cleanSummary(decision), decision);
  assert.equal(titles.cleanSummary(`${decision}\n- Extra: sixth line`), decision);
});

test('a long shape is cut at 400 characters, at a line boundary when one is near', () => {
  const line = 'y'.repeat(90);
  const long = Array(5).fill(line).join('\n');
  assert.equal(titles.cleanSummary(long), Array(4).fill(line).join('\n') + '…');
});

test('a multi-line summary is everything after its label, with a preamble or a prefix', () => {
  const want = { title: 'Token lifetime', summary: 'Pick one:\n- 1h (recommended)\n- 12h' };
  assert.deepEqual(titles.parseBoth('Title: Token lifetime\nSummary: Pick one:\n- 1h (recommended)\n- 12h'), want);
  assert.deepEqual(titles.parseBoth('Sure:\n**Title:** Token lifetime\n**Summary:**\nPick one:\n- 1h (recommended)\n- 12h'), want);
  assert.deepEqual(titles.parseBoth('Line 1: Title: Token lifetime\nLine 2: Summary: Pick one:\n- 1h (recommended)\n- 12h'), want);
  assert.deepEqual(titles.parseBoth('Title: Token lifetime Summary: Pick one:\n- 1h (recommended)\n- 12h'), want);
});

test('a multi-line summary from the model is stored whole', async () => {
  setModel('google/gemma-3-4b-it');
  const m = await mail.sendMail({ from: 'a1', to: ['human'], subject: 'Lines', body: 'TITLE=Lifetime SUMMARY=Pick_one__-_1h_recommended__-_12h', new_thread: true });
  await settled(m.id);
  assert.equal(summaryOf(m.id), 'Pick one\n- 1h recommended\n- 12h');
});

test('a mail to the human gets a title and a summary from one call; other mail gets no summary', async () => {
  setModel('google/gemma-3-4b-it');
  const before = calls();
  const toHuman = await mail.sendMail({ from: 'a1', to: ['human'], subject: 'Token lifetime', body: 'TITLE=Token_lifetime SUMMARY=Pick_a_token_lifetime_for_SSO_1h_or_12h', new_thread: true });
  assert.equal((await settled(toHuman.id)).title, 'Token lifetime');
  await until(() => summaryOf(toHuman.id), 'the summary');
  assert.equal(summaryOf(toHuman.id), 'Pick a token lifetime for SSO 1h or 12h');
  const toAgent = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Plain', body: 'TITLE=Plain_mail SUMMARY=Never_stored', new_thread: true });
  assert.equal((await settled(toAgent.id)).title, 'Plain mail');
  assert.equal(summaryOf(toAgent.id), null);
  // One call each, not a second call for the summary.
  assert.equal(calls(), before + 2);
  // The inbox and the thread carry it.
  assert.equal(db.inbox('human', false, 50).find((x) => x.id === toHuman.id).summary, 'Pick a token lifetime for SSO 1h or 12h');
  assert.equal(db.threadMail(toHuman.thread_id ?? toHuman.id)[0].summary, 'Pick a token lifetime for SSO 1h or 12h');
});

test('with titles off a mail to the human gets no summary and no call', async () => {
  setModel('');
  const before = calls();
  const m = await mail.sendMail({ from: 'a1', to: ['human'], subject: 'Off', body: 'SUMMARY=Never_asked', new_thread: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls(), before);
  assert.equal(summaryOf(m.id), null);
});

test('an answer without a summary line keeps the title and stores no summary', async () => {
  setModel('google/gemma-3-4b-it');
  const m = await mail.sendMail({ from: 'a1', to: ['human'], subject: 'No summary', body: 'TITLE=Just_title STUB:NOSUMMARY', new_thread: true });
  assert.equal((await settled(m.id)).title, 'Just title');
  assert.equal(summaryOf(m.id), null);
});

test('a failed call stores no summary', async () => {
  setModel('google/gemma-3-4b-it');
  const m = await mail.sendMail({ from: 'a1', to: ['human'], subject: 'Broken', body: 'STUB:FAIL', new_thread: true });
  assert.equal((await settled(m.id)).title, null);
  assert.equal(summaryOf(m.id), null);
});

test('the title and summary are found by their labels, in any order and layout', () => {
  assert.deepEqual(titles.parseBoth('Title: Token lifetime\nSummary: Pick one'), { title: 'Token lifetime', summary: 'Pick one' });
  assert.deepEqual(titles.parseBoth('Sure, here you go:\nSummary: Pick one\n**Title:** Token lifetime'), { title: 'Token lifetime', summary: 'Pick one' });
  assert.deepEqual(titles.parseBoth('Title: Token lifetime Summary: Pick one'), { title: 'Token lifetime', summary: 'Pick one' });
  assert.deepEqual(titles.parseBoth('Summary: Pick one'), { title: null, summary: 'Pick one' });
  assert.deepEqual(titles.parseBoth('Here is the title and summary:\nTitle: Token lifetime\nSummary: Pick one'), { title: 'Token lifetime', summary: 'Pick one' });
  assert.deepEqual(titles.parseBoth('Line 1: Title: Token lifetime\nLine 2: Summary: Pick one'), { title: 'Token lifetime', summary: 'Pick one' });
  assert.deepEqual(titles.parseBoth('1. Title: Token lifetime\n2. Summary: Pick one'), { title: 'Token lifetime', summary: 'Pick one' });
  assert.deepEqual(titles.parseBoth('- **Title:** Token lifetime\n- **Summary:** Pick one'), { title: 'Token lifetime', summary: 'Pick one' });
  assert.deepEqual(titles.parseBoth('Just a title'), { title: 'Just a title', summary: null });
  assert.deepEqual(titles.parseBoth(undefined), { title: null, summary: null });
});

test('a forwarded summary is kept on the peer copy, and a later forward does not replace it', async () => {
  const send = (summary) => mail.sendMail({ from: 'a1', to: ['human'], subject: 'Forwarded', body: 'x', new_thread: true, forwarded: { from_name: 'alice' }, mail_id: 'fwd-summary-1', summary, title: 'Peer title' });
  await send('From the peer');
  assert.equal(summaryOf('fwd-summary-1'), 'From the peer');
  // The same mail forwarded again, with another summary: the first stays.
  await send('Second forward');
  assert.equal(summaryOf('fwd-summary-1'), 'From the peer');
});

test('instructions overrides reach the model prompt, and empty falls back to the shipped ones (S-1579)', async () => {
  const lastSystem = () => readFileSync(join(stubDir, 'last-system'), 'utf8');
  setModel('google/gemma-3-4b-it');
  try {
    assert.equal(titles.titlePrompt(false), titles.TITLE_PROMPT);
    assert.equal(titles.titlePrompt(true), titles.SUMMARY_PROMPT);
    settings.patchSettings({ tiny: { mailTitles: { titleInstructions: 'Title in Swedish.', summaryInstructions: 'Summarise in Swedish.' } } });
    assert.equal(titles.titlePrompt(true), 'Summarise in Swedish.');
    const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Override prompt', body: 'TITLE=Overridden_title', new_thread: true });
    await settled(m.id);
    assert.equal(lastSystem(), 'Title in Swedish.');
    settings.patchSettings({ tiny: { mailTitles: { titleInstructions: '  ' } } });
    const d = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Default prompt', body: 'TITLE=Default_title', new_thread: true });
    await settled(d.id);
    assert.equal(lastSystem(), titles.TITLE_PROMPT);
  } finally {
    settings.patchSettings({ tiny: { mailTitles: { titleInstructions: '', summaryInstructions: '' } } });
    setModel('');
  }
});

test('a stale title is asked again when shown, once; a row with no hash is stale too (S-1843)', async () => {
  setModel('');
  const stale = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Stale title', body: 'TITLE=Fresh_title', new_thread: true });
  db.setMailTitle(stale.id, 'Old title', 'old-config');
  const bare = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Bare title', body: 'TITLE=Bare_fresh', new_thread: true });
  db.setMailTitle(bare.id, 'Bare old');
  setModel('google/gemma-3-4b-it');
  const before = calls();
  assert.deepEqual(titles.mailTitlesShown([stale.id, bare.id]), { enabled: true, pending: [stale.id, bare.id] });
  await until(() => db.getMail(stale.id).title === 'Fresh title' && db.getMail(bare.id).title === 'Bare fresh', 'both titles replaced');
  assert.equal(calls(), before + 2);
  assert.notEqual(db.mailTitleRow(stale.id).configHash, 'old-config');
  // Current now: nothing is asked, nothing is pending.
  assert.deepEqual(titles.mailTitlesShown([stale.id, bare.id]), { enabled: true, pending: [] });
  assert.equal(calls(), before + 2);
  setModel('');
});

test('with the model off a stale title stays, and nothing is asked', async () => {
  setModel('');
  const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Kept title', body: 'TITLE=Never_asked_off', new_thread: true });
  db.setMailTitle(m.id, 'Kept title old', 'old-config');
  const before = calls();
  assert.deepEqual(titles.mailTitlesShown([m.id]), { enabled: false, pending: [] });
  assert.equal(calls(), before);
  assert.equal(db.getMail(m.id).title, 'Kept title old');
});

test('a settings change regenerates no stale title: they wait until shown', async () => {
  setModel('');
  const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Waiting title', body: 'TITLE=Waiting_new', new_thread: true });
  db.setMailTitle(m.id, 'Waiting old', 'old-config');
  const before = calls();
  setModel('google/gemma-3-4b-it');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls(), before);
  assert.equal(db.getMail(m.id).title, 'Waiting old');
  setModel('');
});

test('a stale title whose new answer fails keeps the old title, and is not pending once the call ends', async () => {
  setModel('');
  const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Failing title', body: 'STUB:FAIL', new_thread: true });
  db.setMailTitle(m.id, 'Failing old', 'old-config');
  setModel('google/gemma-3-4b-it');
  assert.deepEqual(titles.mailTitlesShown([m.id]), { enabled: true, pending: [m.id] });
  await until(() => events('mail-title:error').some((e) => e.id === m.id), 'the regeneration to fail');
  await until(() => !titles.mailTitlesShown([m.id]).pending.length, 'the failed mail to leave the pending list');
  assert.equal(db.getMail(m.id).title, 'Failing old');
  assert.equal(db.mailTitleRow(m.id).configHash, 'old-config');
  setModel('');
});

test('a summary-only answer is current for its config: it is not asked again (S-1843)', async () => {
  setModel('');
  const m = await mail.sendMail({ from: 'a1', to: ['human'], subject: 'Summary only', body: 'STUB:NOTITLE SUMMARY=Only_a_summary', new_thread: true });
  db.setMailTitle(m.id, 'Summary old', 'old-config');
  setModel('google/gemma-3-4b-it');
  const before = calls();
  assert.deepEqual(titles.mailTitlesShown([m.id]), { enabled: true, pending: [m.id] });
  await until(() => db.mailTitleRow(m.id).configHash !== 'old-config', 'the summary-only answer to be recorded');
  assert.equal(calls(), before + 1);
  assert.equal(db.getMail(m.id).summary, 'Only a summary');
  // The title was not in the answer, so the old one stays; the config is recorded, so nothing is queued again.
  assert.equal(db.getMail(m.id).title, 'Summary old');
  assert.deepEqual(titles.mailTitlesShown([m.id]), { enabled: true, pending: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls(), before + 1);
  setModel('');
});

test('a mail queued when it was sent is not queued again by a view that shows it (S-1843)', async () => {
  setModel('google/gemma-3-4b-it');
  const before = calls();
  const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Queued already', body: 'TITLE=Queued_once', new_thread: true });
  // The send-time job is queued (busy) before any call starts: a view names it as pending, and queues nothing new.
  assert.deepEqual(titles.mailTitlesShown([m.id]), { enabled: true, pending: [m.id] });
  assert.equal((await settled(m.id)).title, 'Queued once');
  assert.equal(calls(), before + 1);
  setModel('');
});

test('a peer copy\'s title is never asked for here, even with the model on (S-1843)', async () => {
  setModel('');
  const m = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Peer copy', body: 'TITLE=Peer_fresh', new_thread: true });
  db.setMailTitle(m.id, 'Peer title', db.PEER_TITLE_CONFIG);
  setModel('google/gemma-3-4b-it');
  const before = calls();
  assert.deepEqual(titles.mailTitlesShown([m.id]), { enabled: true, pending: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls(), before);
  assert.equal(db.getMail(m.id).title, 'Peer title');
  setModel('');
});

test('a forwarded copy is a peer\'s whether or not it came with a title or summary (S-1843)', async () => {
  setModel('');
  const plain = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Forwarded plain', body: 'TITLE=Plain_title', forwarded: { from_name: 'peer' }, mail_id: 'mfwd-plain', thread_id: 'tfwd-plain', new_thread: false });
  const summaryOnly = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Forwarded summary', body: 'TITLE=Summary_only', summary: 'Only a summary', forwarded: { from_name: 'peer' }, mail_id: 'mfwd-summary', thread_id: 'tfwd-summary' });
  assert.equal(db.mailTitleRow(plain.id).configHash, db.PEER_TITLE_CONFIG);
  assert.equal(db.mailTitleRow(summaryOnly.id).configHash, db.PEER_TITLE_CONFIG);
  setModel('google/gemma-3-4b-it');
  const before = calls();
  // Shown with the model on: neither copy is asked for here, and nothing is pending.
  assert.deepEqual(titles.mailTitlesShown([plain.id, summaryOnly.id]), { enabled: true, pending: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls(), before);
  assert.equal(db.getMail(summaryOnly.id).summary, 'Only a summary');
  setModel('');
});
