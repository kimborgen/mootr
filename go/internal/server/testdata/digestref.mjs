// The TS side of retro_digest_test.go: builds a home with retro items, feedback reports, a proposal, final rounds,
// archives and activity, copies its stam.db to stam.pre.db, and writes to expect.json what src/retro-digest.ts answers
// over it (the Retros view, an agent type's memory, the digest) and over the pure cases in CASES (a JSON file). Never the
// live home.
//
//   node go/internal/server/testdata/digestref.mjs DIR CASES
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, casesFile] = process.argv.slice(2);
if (!dir || !casesFile) {
  console.error('usage: digestref.mjs DIR CASES');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`digestref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
delete process.env.OPENROUTER_API_KEY;
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('digestref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const itsa = await import('../../../../src/itsa.ts');
const digest = await import('../../../../src/retro-digest.ts');
const { answersOf } = await import('../../../../src/retro-loop.ts');
const { epicOffer } = await import('../../../../src/retro.ts');

const d = db.open();
const SINCE = '2026-10-10T00:00:00.000Z';
const agent = (id, name, type, model) => {
  db.createAgent({ id, name, role: 'test', machine: 'test-machine', harness: 'claude', model, effort: null, cwd: home, parent_id: null, session_id: null });
  d.prepare('UPDATE agents SET type = ? WHERE id = ?').run(type, id);
};
agent('adev1', 'dev1', 'developer', 'opus');
agent('adev2', 'dev2', 'reviewer', 'sol');
agent('adev3', 'dev3', 'developer', null);
agent('alive', 'livey', 'developer', 'opus');

const at = (id, created, closed) => d.prepare('UPDATE itsas SET created_at = ?, closed_at = ? WHERE id = ?').run(created, closed ?? null, id);
const item = async (kind, title, body, created, by = 'adev1') => {
  const x = await itsa.create({ kind, title, body, by });
  at(x.id, created);
  return x;
};
const plusOne = async (x, when, text = '+1 from dev2: same here') => {
  const m = await itsa.post(x.id, { body: text });
  d.prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(when, m.id);
};
const close = async (x, status, created, closed) => {
  await itsa.set(x.id, { status });
  at(x.id, created, closed);
};

const r1 = await item('retro', 'Old CLAUDE line', 'Kind: improve\nTarget: CLAUDE.md\nEvidence: gate\nWhen: always\n\nThe details.', '2026-10-01T00:00:00.000Z');
await plusOne(r1, '2026-10-11T00:00:00.000Z');
await plusOne(r1, '2026-10-02T00:00:00.000Z', 'Reported again by dev3: still');
await plusOne(r1, '2026-10-12T00:00:00.000Z', 'A plain comment');
const r2 = await item('retro', 'An idea', 'Kind: idea\nTarget: type-developer\n\nNo backing.', '2026-10-12T00:00:00.000Z');
const r3 = await item('retro', 'Closed one', 'Kind: improve\nTarget: CLAUDE.md\nEvidence: review\n\nDone.', '2026-10-03T00:00:00.000Z');
await close(r3, 'done', '2026-10-03T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
const r4 = await item('retro', 'Refused one', 'Kind: idea\nTarget: developer-worktree\n\nNo.', '2026-10-04T00:00:00.000Z');
await close(r4, 'wont_do', '2026-10-04T00:00:00.000Z', '2026-10-06T00:00:00.000Z');
await item('retro', 'From a gone agent', 'Kind: went_well\nTarget: AGENTS.md\nReporter: ghost (m3, developer)\n\nIt went well.', '2026-10-13T00:00:00.000Z', null);
d.prepare("UPDATE itsas SET created_by = 'agone' WHERE title = 'From a gone agent'").run();
await item('retro', 'No target', 'Kind: improve\nTarget: NONE\nEvidence: human\n\nUntargeted.', '2026-10-14T00:00:00.000Z', 'adev2');
const r7 = await item('retro', 'Block aimed', 'Kind: instruction\nTarget: developer-change\nEvidence: measured\n\nA block.', '2026-10-15T00:00:00.000Z', 'adev2');
await plusOne(r7, '2026-10-16T00:00:00.000Z');
await plusOne(r7, '2026-10-17T00:00:00.000Z');
await item('retro', 'Same target', 'Kind: improve\nTarget: CLAUDE.md\nEvidence: gate\n\nAgain.', '2026-10-15T00:00:00.000Z', 'adev2');
await item('feedback-report', 'A tool bug', 'Kind: bug\nTool: stam_issue\n\nBroken.', '2026-10-15T00:00:00.000Z');
const f2 = await item('feedback-report', 'Old report', 'Kind: bug\nTool: send_mail\n\nOld.', '2026-10-01T00:00:00.000Z');
await plusOne(f2, '2026-10-18T00:00:00.000Z', 'Reported again by dev1: seen it');

const diff = '```diff\ndiff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n+one two three\n-four\n diff --git a/x b/x\n--- a/src/x.ts\n+++ b/src/x.ts\n+not counted here\n--- a/templates/type-developer.md\n+++ b/templates/type-developer.md\n+  a b  \n```\n';
const p1 = await item('proposal', 'Tighten CLAUDE.md', `Answers: ${r3.key}, ${r1.key} junk\n\n${diff}`, '2026-10-09T00:00:00.000Z');
await close(p1, 'done', '2026-10-09T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
const p2 = await item('proposal', 'Refused', `Answers: ${r1.key}`, '2026-10-09T00:00:00.000Z');
await close(p2, 'wont_do', '2026-10-09T00:00:00.000Z', '2026-10-12T00:00:00.000Z');

// An epic: a project owned by dev1 with work under it, and items On the work from three reporters (one twice).
const proj = await itsa.create({ kind: 'project', title: 'The epic', owner: 'adev1' });
const work = await itsa.create({ title: 'Work under it', parent: proj.id });
for (const [n, who] of [[1, 'dev1 (opus, developer)'], [2, 'dev2'], [3, 'dev3 (x, y)'], [4, 'dev2 (sol, reviewer)']]) {
  await item('retro', `Epic item ${n}`, `Kind: idea\nOn: ${work.key} Work under it\nReporter: ${who}\n\nOn the epic.`, '2026-10-01T00:00:00.000Z');
}
await item('feedback-report', 'Epic report', `Kind: bug\nOn: ${proj.key}\nReporter: dev4\n\nOn the epic.`, '2026-10-01T00:00:00.000Z');

const ev = (agentId, type, data, ts) => {
  db.addEvent(agentId, type, data);
  d.prepare('UPDATE events SET ts = ? WHERE id = (SELECT MAX(id) FROM events)').run(ts);
};
ev('adev1', 'retro_final', { effort: { reading: 50, implementing: 30, testing: 20 }, model: 'opus', type: 'developer', measured: { reading: 40, implementing: 40, testing: 10, waiting: 10 } }, '2026-10-12T00:00:00.000Z');
ev('adev3', 'retro_final', { effort: { reading: 25, implementing: 75 }, model: null, type: 'developer', measured: null }, '2026-10-13T00:00:00.000Z');
ev('adev2', 'retro_final', { effort: { coordination: 100 }, model: 'sol', type: 'reviewer' }, '2026-10-01T00:00:00.000Z');
ev('adev1', 'archive', {}, '2026-10-14T00:00:00.000Z');
ev('adev2', 'archive', {}, '2026-10-14T00:00:00.000Z');
ev('agone', 'archive', {}, '2026-10-15T00:00:00.000Z');
ev('agone', 'archive:round-skipped', { reason: 'it was stuck' }, '2026-10-15T00:00:00.000Z');
const act = d.prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", category) VALUES (?, ?, 1, ?, NULL, ?, ?, ?)');
act.run('alive', 1, 'tool', '2026-10-09T23:00:00.000Z', '2026-10-10T01:00:00.000Z', 'produce.edit');
act.run('alive', 2, 'tool', '2026-10-10T00:30:00.000Z', '2026-10-10T02:00:00.000Z', 'verify.test');
act.run('alive', 3, 'gap', '2026-10-10T02:00:00.000Z', '2026-10-10T03:00:00.000Z', null);
act.run('adev1', 1, 'tool', '2026-10-12T00:00:00.000Z', '2026-10-12T01:00:00.000Z', 'understand.read');

d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
const rows = await digest.gather(SINCE);
const closed = await itsa.set(proj.id, { status: 'done' });
const epicSeeded = await digest.epicRetroOffer(closed.itsa);
writeFileSync(
  `${home}/expect.json`,
  JSON.stringify({
    since: SINCE,
    retros: JSON.stringify(await digest.retros(SINCE)),
    retrosType: JSON.stringify(await digest.retrosOfType('developer')),
    retrosReviewer: JSON.stringify(await digest.retrosOfType('reviewer')),
    digest: digest.buildDigest(rows, '2026-W42'),
    digests: cases.digests.map((c) => digest.buildDigest(c.rows, c.week)),
    retrosOf: cases.digests.map((c) => JSON.stringify(digest.buildRetros(c.rows))),
    loops: cases.loops.map((c) => digest.loopLines(c.loop, c.archived)),
    words: cases.bodies.map((b) => digest.wordsInDiff(b)),
    answers: cases.bodies.map((b) => answersOf(b)),
    labels: cases.labels.map((l) => digest.digestLabel(new Date(l.at), l.day)),
    epic: { key: proj.key, offer: epicSeeded },
    epics: cases.epics.map((c) => epicOffer(c.epic, new Set(c.subtree), c.items, c.share, c.cfg)),
    recipients: cases.recipients.map((r) => digest.digestRecipients(r.retros, (ref) => r.live.includes(ref), r.cos)),
  }),
);
