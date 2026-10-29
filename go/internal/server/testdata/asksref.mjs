// Builds a home holding asks of every kind (permission requests of each kind and outcome, ITSAs waiting on the human and
// settled out of a human status, open and settled decision mails), copies its stam.db to stam.pre.db, and writes
// src/asks.ts localAsks over it to expect.json, for go/internal/server's Needs you list parity test (S-3831, S-4154), and the
// open ask each agent and ITSA waits on (src/asks.ts openAskLinks, S-3977) to open-ask.json, for the open_ask parity test (S-4021).
// Never the live home.
//
//   node go/internal/server/testdata/asksref.mjs DIR
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: asksref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`asksref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
delete process.env.OPENROUTER_API_KEY;
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('asksref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const itsa = await import('../../../../src/itsa.ts');
const human = await import('../../../../src/itsa-human.ts');
const asks = await import('../../../../src/asks.ts');

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'aw1', name: 'worker-one', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'aw2', name: 'worker-two', role: 'developer', parent_id: 'aboss' });
writeFileSync(`${home}/settings.json`, JSON.stringify({ itsa: { ownerNotices: 'off' } }));
const d = db.open();
const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const tick = () => new Promise((r) => setTimeout(r, 3));

// Permission requests: every kind and outcome, a delegate ask (off the list), one settled with no decision time (its created
// time decides), one decided more than a day ago (out), one from an agent no daemon knows (no name), and a secret in each text.
const SECRET = 'STAM-SENTINEL-SECRET-7f3a'; // gitleaks:allow
const perm = d.prepare(`INSERT INTO permission_requests (id, agent_id, action, reason, details, status, created_at, decided_at, kind, dialog, payload, audience, text, home_thread, home_itsa)
  VALUES (?, ?, ?, 'a reason', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const [id, agent, kind, status, audience, created, decided, thread, about] of [
  ['pOPEN', 'aw1', 'request', 'pending', 'human', ago(3), null, 'mhome', 'ihome'],
  ['pHELD', 'aw1', 'dialog', 'held', 'human', ago(2.9), null, null, null],
  ['pSET', 'aboss', 'settings', 'pending', 'human', ago(2.8), null, null, null],
  ['pDELEG', 'aw1', 'request', 'pending', 'delegate', ago(2.7), null, null, null],
  ['pDENIED', 'aw1', 'request', 'denied', 'human', ago(5), ago(1), null, null],
  ['pAPPROVED', 'aw1', 'request', 'approved', 'human', ago(5), ago(1.5), null, null],
  ['pTYPED', 'aw1', 'input', 'approved', 'human', ago(5), ago(2), null, null],
  ['pEXPIRED', 'aw1', 'input', 'expired', 'human', ago(5), ago(2.5), null, null],
  ['pFAILED', 'agone', 'input', 'failed', 'human', ago(5), ago(3), null, null],
  ['pNODECIDE', 'aw1', 'request', 'withdrawn', 'human', ago(4), null, null, null],
  ['pOLD', 'aw1', 'request', 'denied', 'human', ago(30), ago(25), null, null],
  ['pOLDNODECIDE', 'aw1', 'request', 'withdrawn', 'human', ago(26), null, null, null],
  ['pDELEGDONE', 'aw1', 'request', 'denied', 'delegate', ago(5), ago(1), null, null],
]) {
  perm.run(id, agent, `do it ${SECRET}`, `details ${SECRET}`, status, created, decided, kind, kind === 'dialog' ? 1 : 0, kind === 'settings' ? `{"secret":"${SECRET}"}` : null, audience, kind === 'input' ? `typed ${SECRET}` : null, thread, about);
}

// ITSAs: one waiting on the human (open), one approved (settled), one moved out with no action (withdrawn), one answered with
// another action, and a long title cut to one line.
const make = async (title, owner) => (await itsa.create({ title, owner })).id;
const ask = async (id) => {
  await itsa.post(id, { by: 'human', body: 'ready' });
  await tick();
  await itsa.set(id, { status: 'needs_review' }, 'human');
  await tick();
};
const waiting = await make(`Waiting  on\tthe ${'very '.repeat(40)}human`, 'aw1');
await ask(waiting);
const approved = await make('Approved one', 'aw1');
await ask(approved);
await human.act(approved, 'approve', '', itsa.revOf(itsa.must(approved)));
await tick();
const withdrawn = await make('Withdrawn one', null);
await ask(withdrawn);
await itsa.set(withdrawn, { status: 'in_progress' }, 'human');
await tick();
const answered = await make('Answered one', 'aboss');
await ask(answered);
await human.act(answered, 'changes', 'redo it');
await tick();

// Decision mails: an open one, one about the waiting ITSA (held: the ITSA's row covers it), one answered with a choice, one
// answered without, one withdrawn, one superseded, one deferred (not settled for the list), and one settled a day ago.
const mail = d.prepare("INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id, about_itsa) VALUES (?, ?, ?, ?, 'pick', ?, ?, ?)");
const rcpt = d.prepare("INSERT INTO mail_recipients (mail_id, agent_id) VALUES (?, 'human')");
for (const [id, from, name, subject, created, about] of [
  ['mOPEN', 'aw1', 'worker-one', 'Pick   a\nrelease', ago(4), null],
  ['mHELD', 'aw1', null, 'Held by its ITSA', ago(3.5), waiting],
  ['mCHOSE', 'aboss', null, 'Chosen', ago(6), null],
  ['mPLAIN', 'aw1', 'worker-one', 'Plain answer', ago(6), null],
  ['mWITHDRAWN', 'aw1', 'worker-one', 'Withdrawn decision', ago(6), null],
  ['mSUPER', 'aw1', 'worker-one', 'Superseded decision', ago(6), null],
  ['mDEFER', 'aw1', 'worker-one', 'Deferred decision', ago(6), null],
]) {
  mail.run(id, from, name, subject, created, id, about);
  rcpt.run(id);
  db.addDecisionMail(id, id);
}
db.clearDecisionMails('mCHOSE', 'billing');
await tick();
db.clearDecisionMails('mPLAIN', null);
await tick();
db.removeDecisionMail('mWITHDRAWN', 'withdrawn');
await tick();
db.removeDecisionMail('mSUPER');
await tick();
db.setThreadDeferred('mDEFER', 'mDEFER');
d.prepare("INSERT INTO comms_events (kind, ref, outcome, label, duration_ms, created_at) VALUES ('decision', 'mGONE', 'answered', 'x', NULL, ?)").run(ago(25));
// A settlement whose mail this daemon doesn't hold: the row has no subject or sender.
d.prepare("INSERT INTO comms_events (kind, ref, outcome, label, duration_ms, created_at) VALUES ('decision', 'mELSEWHERE', 'withdrawn', NULL, NULL, ?)").run(ago(0.5));

// A wait on the human through an ITSA in a human status (the agent has no ask of its own), and one through an ITSA that is
// settled (no ask), so openAskLinks reads the wait's target and no more.
db.addWait({ agent_id: 'aw2', kind: 'human', source: 'stam', target: waiting });
db.addWait({ agent_id: 'aw2', kind: 'human', source: 'stam', target: approved });
db.addWait({ agent_id: 'aboss', kind: 'human', source: 'stam', target: withdrawn });

d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);
writeFileSync(`${home}/expect.json`, JSON.stringify(asks.localAsks('test-machine', human.waitingIds())));
// The open ask on each agent and each ITSA, as src/daemon.ts GET /api/agents (open_ask, open_ask_detail) and
// GET /api/itsas/:ref (open_ask_detail) give it.
const links = asks.openAskLinks('test-machine', human.waitingIds());
const detail = (id) => asks.askDetail(links.agents.get(id));
const agents = Object.fromEntries(db.listAgents().map((a) => [a.id, { open_ask: links.agents.get(a.id)?.key ?? null, open_ask_detail: detail(a.id) }]));
const itsas = Object.fromEntries([waiting, approved, withdrawn, answered].map((id) => [id, asks.askDetail(links.itsas.get(id))]));
writeFileSync(`${home}/open-ask.json`, JSON.stringify({ agents, itsas }));
process.exit(0);
