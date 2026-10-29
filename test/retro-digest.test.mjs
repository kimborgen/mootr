#!/usr/bin/env node
// Unit tests for src/retro-digest.ts (S-161): the digest built from fixed rows (groups ranked by
// +1s then count, up to three keys each, the effort table per model and type, the coverage of
// archived agents, nothing when there is nothing new), the Loop health metrics (S-806: new items and
// +1s per target, recurrence of an answered target, items per archived agent, instruction word
// delta), the date and ISO week labels, when the digest is due (once per slot, a restart doesn't
// resend it), its recipients (S-1059: the Retros owner and participants, with the chief of staff as
// the fallback), and the early start's counts (S-714; light SQL against a throwaway STAM_HOME, no
// daemon or model) with its pure earlyDue, including its minHours wait (S-1059). Run with
// `node --test test/retro-digest.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-retro-digest-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `retro-digest-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const { archiveWindow, buildDigest, buildRetros, dayLabel, digestDue, digestLabel, digestLive, digestRecipients, earlyCounts, earlyDue, isDigestHome, weekLabel, answeredTargets, loopLines, loopMetrics, wordsInDiff } = await import('../src/retro-digest.ts');
const db = await import('../src/db.ts');

const rows = {
  items: [
    { key: 'S-1', kind: 'improve', target: 'waits', plusOnes: 2 },
    { key: 'S-2', kind: 'improve', target: 'waits', plusOnes: 3 },
    { key: 'S-3', kind: 'improve', target: 'waits', plusOnes: 0 },
    { key: 'S-4', kind: 'idea', target: 'none', plusOnes: 1 },
    { key: 'S-5', kind: 'idea', target: 'none', plusOnes: 0 },
    { key: 'S-6', kind: 'idea', target: 'none', plusOnes: 0 },
    { key: 'S-7', kind: 'idea', target: 'none', plusOnes: 0 },
  ],
  rounds: [
    { name: 'a', model: 'claude-haiku-5-5', type: 'developer', effort: { reading: 50, implementing: 30, testing: 20 } },
    { name: 'b', model: 'claude-haiku-5-5', type: 'developer', effort: { reading: 30, implementing: 50, testing: 20 } },
    { name: 'c', model: 'gpt-6.1-sol', type: 'reviewer', effort: { reading: 100 } },
  ],
  archived: [
    { name: 'a', hasRound: true },
    { name: 'b', hasRound: true },
    { name: 'd', hasRound: false },
  ],
};

// The one line that counts the items left out of the threads.
const countLine = (md) => md.split('\n').find((l) => l.includes('without evidence or +1s'));

test('nothing new builds no digest', () => {
  assert.equal(buildDigest({ items: [], rounds: [], archived: [] }, '2026-W41'), null);
});

test('groups are ranked by +1s, then count, and name up to three keys', () => {
  const md = buildDigest(rows, '2026-W41');
  const lines = md.split('\n').filter((l) => l.startsWith('- **'));
  // Only the items with a +1 are shown: waits has 5 +1s over 2 items, none has 1 +1 over 1 item. Waits first.
  assert.equal(lines[0], '- **Kind: improve · Target: waits**: 2 items, 5 +1s. S-2 (3 +1s), S-1 (2 +1s)');
  assert.equal(lines[1], '- **Kind: idea · Target: none**: 1 item, 1 +1. S-4 (1 +1)');
  assert.equal(lines.length, 2);
});

test('items with no evidence and no +1 are counted in one line at the end, by kind', () => {
  const md = buildDigest(rows, '2026-W41');
  // S-3 (improve) and S-5, S-6, S-7 (idea): 4 hidden, idea first as it has more.
  assert.equal(countLine(md), '- 4 more items without evidence or +1s: idea 3, improve 1.');
  assert.equal(md.split('\n').filter((l) => l.includes('without evidence or +1s')).length, 1);
  assert.doesNotMatch(md, /S-3|S-5|S-6|S-7/);
});

test('the count line says item for one hidden item, and kinds tie-break by name', () => {
  const md = buildDigest({ items: [
    { key: 'S-1', kind: 'improve', target: 'none', plusOnes: 1 },
    { key: 'S-2', kind: 'idea', target: 'none', plusOnes: 0 },
    { key: 'S-3', kind: 'bug', target: 'none', plusOnes: 0 },
  ], rounds: [], archived: [] }, 'W');
  assert.equal(countLine(md), '- 2 more items without evidence or +1s: bug 1, idea 1.');
  const one = buildDigest({ items: [
    { key: 'S-1', kind: 'improve', target: 'none', plusOnes: 1 },
    { key: 'S-2', kind: 'idea', target: 'none', plusOnes: 0 },
  ], rounds: [], archived: [] }, 'W');
  assert.equal(countLine(one), '- 1 more item without evidence or +1s: idea 1.');
});

test('an item with evidence shows even with no +1, and evidence none does not', () => {
  const md = buildDigest({ items: [
    { key: 'S-1', kind: 'improve', target: 'gates', plusOnes: 0, evidence: 'gate' },
    { key: 'S-2', kind: 'improve', target: 'gates', plusOnes: 0, evidence: 'none' },
  ], rounds: [], archived: [] }, 'W');
  const lines = md.split('\n').filter((l) => l.startsWith('- **'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '- **Kind: improve · Target: gates**: 1 item, 0 +1s. S-1 (0 +1s)');
  assert.equal(countLine(md), '- 1 more item without evidence or +1s: improve 1.');
});

test('a feedback report is always shown, though it has no evidence and no +1', () => {
  const md = buildDigest({ items: [
    { key: 'S-1', kind: 'bug', target: 'stam_status', plusOnes: 0, report: true },
    { key: 'S-2', kind: 'idea', target: 'none', plusOnes: 0 },
  ], rounds: [], archived: [] }, 'W');
  const lines = md.split('\n').filter((l) => l.startsWith('- **'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '- **Kind: bug · Target: stam_status**: 1 item, 0 +1s. S-1 (0 +1s)');
  assert.equal(countLine(md), '- 1 more item without evidence or +1s: idea 1.');
});

test('with no shown item the threads say None., then the count line', () => {
  const md = buildDigest({ items: [
    { key: 'S-1', kind: 'idea', target: 'none', plusOnes: 0 },
    { key: 'S-2', kind: 'idea', target: 'none', plusOnes: 0, evidence: 'none' },
  ], rounds: [], archived: [] }, 'W');
  const lines = md.split('\n');
  const at = lines.indexOf('## Threads');
  assert.equal(lines[at + 1], 'None.');
  assert.equal(lines[at + 2], '- 2 more items without evidence or +1s: idea 2.');
});

test('no count line when every item is shown', () => {
  const md = buildDigest({ items: [
    { key: 'S-1', kind: 'idea', target: 'none', plusOnes: 1 },
    { key: 'S-2', kind: 'idea', target: 'none', plusOnes: 0, evidence: 'review' },
  ], rounds: [], archived: [] }, 'W');
  assert.doesNotMatch(md, /without evidence or \+1s/);
  assert.doesNotMatch(md, /None\./);
});

test('the intro says the rest are counted at the end', () => {
  const md = buildDigest(rows, '2026-W41');
  assert.match(md, /^Items filed or \+1'd since the last digest that have evidence or a \+1, by evidence first, then \+1s, grouped by kind and target; the rest are counted at the end\.$/m);
});

test('items sort by evidence first, then +1s, with none last', () => {
  const md = buildDigest({ items: [
    { key: 'S-1', kind: 'improve', target: 'none', plusOnes: 0, evidence: 'none' },
    { key: 'S-2', kind: 'improve', target: 'none', plusOnes: 0, evidence: 'gate' },
    { key: 'S-3', kind: 'improve', target: 'none', plusOnes: 5, evidence: 'human' },
  ], rounds: [], archived: [] }, 'W');
  const line = md.split('\n').find((l) => l.startsWith('- **'));
  // human before gate, whatever the +1 counts; S-1 has no evidence and no +1, so only the count line names it.
  assert.match(line, /S-3 \(5 \+1s\), S-2 \(0 \+1s\)$/);
  assert.equal(countLine(md), '- 1 more item without evidence or +1s: improve 1.');
});

test('groups rank by their strongest evidence before +1 counts', () => {
  const md = buildDigest({ items: [
    { key: 'S-1', kind: 'improve', target: 'waits', plusOnes: 9, evidence: 'none' },
    { key: 'S-2', kind: 'improve', target: 'gates', plusOnes: 0, evidence: 'gate' },
  ], rounds: [], archived: [] }, 'W');
  const lines = md.split('\n').filter((l) => l.startsWith('- **'));
  assert.match(lines[0], /Target: gates/);
  assert.match(lines[1], /Target: waits/);
});

test('an old item without an Evidence line reads as none and lists last', () => {
  const md = buildDigest({ items: [
    { key: 'S-1', kind: 'improve', target: 'none', plusOnes: 99 },
    { key: 'S-2', kind: 'improve', target: 'none', plusOnes: 0, evidence: 'measured' },
  ], rounds: [], archived: [] }, 'W');
  const line = md.split('\n').find((l) => l.startsWith('- **'));
  assert.match(line, /S-2 \(0 \+1s\), S-1 \(99 \+1s\)$/);
});

test('the effort table averages each area per model and type', () => {
  const md = buildDigest(rows, '2026-W41');
  assert.match(md, /\| claude-haiku-5-5 · developer \| 2 \| 40% \(measured –\) \| 40% \(measured –\) \| 20% \(measured –\) \| 0% \(measured –\) \| 0% \(measured –\) \| 0% \(measured –\) \|/);
  assert.match(md, /\| gpt-6.1-sol · reviewer \| 1 \| 100% \(measured –\) \| 0% \(measured –\) \|/);
});

test('coverage counts archived agents with and without a final round', () => {
  const md = buildDigest(rows, '2026-W41');
  assert.match(md, /3 agents archived: 2 with a final round, 1 without \(d\)\./);
});

test('the digest ends with what cos does with it', () => {
  const md = buildDigest(rows, '2026-W41');
  assert.match(md, /^# Retro digest, 2026-W41$/m);
  assert.match(md, /## What to do with it/);
  assert.match(md, /promote a thread that recurs/i);
  assert.match(md, /retro steward \(run by the chief of staff\) drafts proposals from this digest/);
  assert.match(md, /close the items/i);
});

test('an empty part says so', () => {
  const md = buildDigest({ items: [], rounds: [], archived: [{ name: 'x', hasRound: false }] }, 'W');
  assert.match(md, /No final rounds\./);
  assert.match(md, /1 agent archived: 0 with a final round, 1 without \(x\)\./);
});

test('the week label is the ISO week', () => {
  assert.equal(weekLabel(new Date(2026, 9, 12)), '2026-W42');
  assert.equal(weekLabel(new Date(2027, 0, 1)), '2026-W53');
});

test('the digest is due once per weekly slot, not again after it went out', () => {
  const cfg = { enabled: true, day: 'mon', hour: 9 };
  const monday10 = new Date(2026, 9, 12, 10, 0);
  // Due on Monday after 9:00 when nothing has been sent this week.
  assert.equal(digestDue(monday10, cfg, null), true);
  assert.equal(digestDue(monday10, cfg, new Date(2026, 9, 5, 9, 1).toISOString()), true);
  // Sent at 9:01 this Monday: not again.
  assert.equal(digestDue(monday10, cfg, new Date(2026, 9, 12, 9, 1).toISOString()), false);
  // Before this Monday's slot, the last slot was last Monday, so last week's digest holds.
  assert.equal(digestDue(new Date(2026, 9, 12, 8, 0), cfg, new Date(2026, 9, 5, 9, 1).toISOString()), false);
  assert.equal(digestDue(monday10, { ...cfg, enabled: false }, null), false);
  assert.equal(digestDue(new Date(2026, 9, 13, 10, 0), cfg, new Date(2026, 9, 12, 9, 1).toISOString()), false);
});

test('the daily digest is due once per day after its hour', () => {
  const cfg = { enabled: true, day: 'daily', hour: 9 };
  // Before 9:00 the last slot was yesterday's, so yesterday's digest holds.
  assert.equal(digestDue(new Date(2026, 9, 12, 8, 59), cfg, new Date(2026, 9, 11, 9, 1).toISOString()), false);
  // After 9:00 with nothing sent today: due, and with yesterday's sent: due.
  assert.equal(digestDue(new Date(2026, 9, 12, 9, 0), cfg, new Date(2026, 9, 11, 9, 1).toISOString()), true);
  assert.equal(digestDue(new Date(2026, 9, 12, 10, 0), cfg, new Date(2026, 9, 11, 9, 1).toISOString()), true);
  // Sent at 9:01 today: not again today.
  assert.equal(digestDue(new Date(2026, 9, 12, 10, 0), cfg, new Date(2026, 9, 12, 9, 1).toISOString()), false);
  assert.equal(digestDue(new Date(2026, 9, 12, 23, 59), cfg, new Date(2026, 9, 12, 9, 1).toISOString()), false);
  // Due the next day after 9:00.
  assert.equal(digestDue(new Date(2026, 9, 13, 9, 0), cfg, new Date(2026, 9, 12, 9, 1).toISOString()), true);
  assert.equal(digestDue(new Date(2026, 9, 12, 10, 0), cfg, null), true);
  assert.equal(digestDue(new Date(2026, 9, 12, 10, 0), { ...cfg, enabled: false }, null), false);
});

test('the daily digest is labelled with its date, the weekly one with its week', () => {
  assert.equal(digestLabel(new Date(2026, 9, 12, 9, 0), 'daily'), '2026-10-12');
  assert.equal(dayLabel(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(digestLabel(new Date(2026, 9, 12, 9, 0), 'mon'), '2026-W42');
});

test('only the ITSA home sends the digest', () => {
  assert.equal(isDigestHome('storage', 'alpha'), false);
  assert.equal(isDigestHome('alpha', 'alpha'), true);
});

// The Retros view (S-162): open items ranked by +1s then newest, the effort per model and type,
// and the coverage of archived agents.
const retroRows = {
  items: [
    { id: 'i1', key: 'S-10', title: 'Waits hang', kind: 'improve', target: 'waits', plusOnes: 1, status: 'idea', created_at: '2026-10-01T00:00:00.000Z' },
    { id: 'i2', key: 'S-11', title: 'Nice pane', kind: 'went_well', target: 'none', plusOnes: 0, status: 'idea', created_at: '2026-10-05T00:00:00.000Z' },
    { id: 'i3', key: 'S-12', title: 'Chips', kind: 'idea', target: 'web', plusOnes: 1, status: 'idea', created_at: '2026-10-08T00:00:00.000Z' },
  ],
  rounds: [
    { name: 'a', model: 'claude-haiku-5-5', type: 'developer', effort: { reading: 50, implementing: 30, testing: 20 } },
    { name: 'b', model: 'claude-haiku-5-5', type: 'developer', effort: { reading: 30, implementing: 50, testing: 20 } },
    { name: 'c', model: null, type: null, effort: { reading: 100 } },
  ],
  archived: [
    { name: 'a', hasRound: true },
    { name: 'd', hasRound: false },
  ],
};

test('the Retros items rank by +1s, then newest', () => {
  const v = buildRetros(retroRows);
  assert.deepEqual(v.items.map((x) => x.key), ['S-12', 'S-10', 'S-11']);
  assert.equal(v.items[0].id, 'i3');
});

test('the Retros items rank by evidence first, then +1s', () => {
  const v = buildRetros({ items: [
    { id: 'i1', key: 'S-1', title: 'a', kind: 'improve', target: 'none', plusOnes: 3, status: 'idea', created_at: '2026-10-01T00:00:00.000Z', evidence: 'none' },
    { id: 'i2', key: 'S-2', title: 'b', kind: 'improve', target: 'none', plusOnes: 0, status: 'idea', created_at: '2026-10-01T00:00:00.000Z', evidence: 'review' },
  ], rounds: [], archived: [] });
  assert.deepEqual(v.items.map((x) => x.key), ['S-2', 'S-1']);
});

test('the Retros effort averages each area per model and type, with no model shown as null', () => {
  const v = buildRetros(retroRows);
  assert.equal(v.effort.length, 2);
  const dev = v.effort.find((e) => e.type === 'developer');
  assert.equal(dev.rounds, 2);
  assert.equal(dev.avg.reading, 40);
  assert.equal(dev.avg.implementing, 40);
  assert.equal(dev.avg.testing, 20);
  assert.equal(dev.avg.waiting, 0);
  const none = v.effort.find((e) => e.model === null);
  assert.deepEqual([none.rounds, none.type, none.avg.reading], [1, null, 100]);
});

test('the Retros coverage counts archived agents and names those without a final round', () => {
  assert.deepEqual(buildRetros(retroRows).coverage, { archived: 2, withRound: 1, without: ['d'] });
  assert.deepEqual(buildRetros({ items: [], rounds: [], archived: [] }), { items: [], effort: [], coverage: { archived: 0, withRound: 0, without: [] } });
});

// The coverage counts only archives from the first final round on, and none with no round ever.
test('archives count from the first final round when it is later than the window', () => {
  assert.equal(archiveWindow('2026-10-05T00:00:00.000Z', '2026-10-08T12:00:00.000Z'), '2026-10-08T12:00:00.000Z');
  assert.equal(archiveWindow('2026-10-10T00:00:00.000Z', '2026-10-08T12:00:00.000Z'), '2026-10-10T00:00:00.000Z');
  assert.equal(archiveWindow('2026-10-05T00:00:00.000Z', null), null);
});

test('the digest names at most ten agents without a round, then how many more', () => {
  const archived = Array.from({ length: 13 }, (_, i) => ({ name: `a${i + 1}`, hasRound: i < 2 }));
  const md = buildDigest({ items: [], rounds: [{ name: 'x', model: null, type: null, effort: {} }], archived }, 'W');
  assert.match(md, /13 agents archived: 2 with a final round, 11 without \(a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, and 1 more\)\./);
});

// The measured split beside the self-report (S-227).
const measuredRows = {
  items: [],
  rounds: [
    { name: 'a', model: 'claude-haiku-5-5', type: 'developer', effort: { reading: 20, implementing: 60, testing: 20 }, measured: { reading: 34, implementing: 40, testing: 10, waiting: 10, review_fixes: 4, coordination: 2 } },
    { name: 'b', model: 'claude-haiku-5-5', type: 'developer', effort: { reading: 20, implementing: 60, testing: 20 }, measured: { reading: 30, implementing: 50, testing: 10, waiting: 5, review_fixes: 3, coordination: 2 } },
    { name: 'c', model: 'claude-haiku-5-5', type: 'developer', effort: { reading: 40, implementing: 40, testing: 20 } },
  ],
  archived: [
    { name: 'a', hasRound: true },
    { name: 'b', hasRound: true },
    { name: 'c', hasRound: true },
  ],
};

test('the effort cell shows the measured average beside the self-report, and a dash when no round has one', () => {
  const md = buildDigest(measuredRows, '2026-W41');
  const row = md.split('\n').find((l) => l.startsWith('| claude-haiku-5-5 · developer |'));
  // reading: self (20+20+40)/3 = 27, measured (34+30)/2 = 32; implementing: self 53, measured 45; testing: self 20, measured 10.
  assert.match(row, /^\| claude-haiku-5-5 · developer \| 3 \| 27% \(measured 32%\) \| 53% \(measured 45%\) \| 20% \(measured 10%\) \| /);
  // Only an archived agent without a measured split (before the measure): its cells have the dash.
  const none = buildDigest({ ...measuredRows, rounds: [measuredRows.rounds[2]] }, '2026-W41');
  assert.match(none, /\| claude-haiku-5-5 · developer \| 1 \| 40% \(measured –\) \| 40% \(measured –\) \| 20% \(measured –\) \|/);
});

test('the Retros view carries the measured average beside the self-report, or null without one', () => {
  const v = buildRetros({ ...measuredRows, items: [] });
  const dev = v.effort.find((e) => e.type === 'developer');
  assert.deepEqual(dev.measured, { reading: 32, implementing: 45, testing: 10, waiting: 8, review_fixes: 4, coordination: 2 });
  assert.equal(v.effort.find((e) => e.model === 'gpt-6.1-sol'), undefined);
  assert.equal(buildRetros({ ...rows, items: [] }).effort.find((e) => e.type === 'developer').measured, null);
});

test('without any measured round the table is the old one, plus dashes, and no gap line', () => {
  const md = buildDigest(rows, '2026-W41');
  assert.doesNotMatch(md, /Largest self-report gap/);
  assert.doesNotMatch(md, /\(measured [0-9]/);
  assert.match(md, /\| gpt-6\.1-sol · reviewer \| 1 \| 100% \(measured –\) \|/);
});

test('the largest self-report gap is named under the table, with its numbers', () => {
  const md = buildDigest(measuredRows, '2026-W41');
  // Gaps: reading +5, implementing -8, testing -10 (largest), waiting, review_fixes, coordination have no self-report, so they count as 0 self.
  assert.match(md, /Largest self-report gap: testing in claude-haiku-5-5 · developer, 20% self-reported vs 10% measured \(-10 points\)\./);
  const lines = md.split('\n');
  const table = lines.findIndex((l) => l.startsWith('| claude-haiku-5-5'));
  const gap = lines.findIndex((l) => l.startsWith('Largest self-report gap'));
  assert.ok(gap > table);
});

test('live rows: agents not archived yet show a measured split and no self-report', () => {
  const md = buildDigest({ ...measuredRows, live: [
    { name: 'x', model: 'openrouter/deepseek', type: 'developer', measured: { reading: 50, implementing: 30, testing: 10, waiting: 5, review_fixes: 0, coordination: 5 } },
    { name: 'y', model: 'openrouter/deepseek', type: 'developer', measured: { reading: 30, implementing: 50, testing: 10, waiting: 5, review_fixes: 0, coordination: 5 } },
  ] }, '2026-W41');
  assert.match(md, /\| openrouter\/deepseek · developer \(live, not archived\) \| 2 live \| – \(measured 40%\) \| – \(measured 40%\) \|/);
  // Live rows are not self-reports, so they never name the gap.
  assert.match(md, /Largest self-report gap: testing in claude-haiku-5-5/);
});

test('a digest with only live measured rows is not empty', () => {
  const md = buildDigest({ items: [], rounds: [], archived: [], live: [{ name: 'x', model: 'm', type: 't', measured: { reading: 100, implementing: 0, testing: 0, waiting: 0, review_fixes: 0, coordination: 0 } }] }, 'W');
  assert.ok(md);
  assert.match(md, /\(live, not archived\)/);
});

// The Loop health section (S-806): fixed rows for each metric.
const SINCE = '2026-10-08T00:00:00.000Z';
const loop = {
  since: SINCE,
  items: [
    // In the period: waits 1 item + 1 +1, gates 2 items, web 6 items.
    { key: 'S-10', target: 'waits', created_at: '2026-10-09T00:00:00.000Z', plusOnes: [] },
    { key: 'S-11', target: 'waits', created_at: '2026-10-01T00:00:00.000Z', plusOnes: ['2026-10-09T00:00:00.000Z'] },
    { key: 'S-12', target: 'gates', created_at: '2026-10-10T00:00:00.000Z', plusOnes: ['2026-10-07T00:00:00.000Z'] },
    { key: 'S-13', target: 'gates', created_at: '2026-10-10T00:00:00.000Z', plusOnes: [] },
    ...Array.from({ length: 6 }, (_, i) => ({ key: `S-1${4 + i}`, target: 'web', created_at: '2026-10-10T00:00:00.000Z', plusOnes: [] })),
    // Answered by S-500 and closed before the period, so its own filing never counts as recurrence.
    { key: 'S-42', target: 'waits', created_at: '2026-09-01T00:00:00.000Z', plusOnes: [] },
  ],
  answers: [
    { proposal: 'S-500', item: 'S-42', closed_at: '2026-10-08T12:00:00.000Z' },
    { proposal: 'S-512', item: 'S-19', closed_at: '2026-10-08T12:00:00.000Z' },
  ],
  words: [
    { file: 'CLAUDE.md', delta: -20 },
    { file: 'templates/type-developer.md', delta: 6 },
  ],
};

test('the Loop health section reports the totals, the top targets, recurrence and the per-agent rate', () => {
  const md = buildDigest({ ...rows, loop }, '2026-W41');
  const lines = md.split('\n');
  const start = lines.indexOf('## Loop health');
  const end = lines.indexOf('## What to do with it');
  const health = lines.slice(start + 1, end).filter((l) => l.startsWith('- '));
  assert.deepEqual(health, [
    '- 9 new items, 1 +1 since the last digest.',
    // web 6 (6 items, no +1s); gates 2 (2 items); waits 2 (1 item, 1 +1).
    '- Top targets (items/+1s): web 6/0, gates 2/0, waits 1/1.',
    // Recurrence: web 6 items filed after S-512 closed it; waits 1 item and 1 +1 after S-500 closed.
    '- Recurrence: web 6 new (6 items) after S-512 closed; waits 2 new (1 item, 1 +1) after S-500 closed.',
    '- 3.0 items per archived agent (9 items, 3 agents archived).',
    '- Instruction words: -14 net (CLAUDE.md -20, templates/type-developer.md +6).',
  ]);
  // The section sits after Coverage and before what cos does with the digest.
  assert.ok(start > lines.indexOf('## Coverage'));
  assert.ok(start < end);
});

test('the Loop health metrics count only what arrived in the period, and cap the lists at five', () => {
  const m = loopMetrics(loop, 3);
  assert.equal(m.newItems, 9);
  assert.equal(m.newPlusOnes, 1);
  assert.deepEqual(m.targets, [
    { target: 'web', items: 6, plusOnes: 0 },
    { target: 'gates', items: 2, plusOnes: 0 },
    { target: 'waits', items: 1, plusOnes: 1 },
  ]);
  assert.deepEqual(m.recurrence, [
    { key: 'S-512', target: 'web', items: 6, plusOnes: 0 },
    { key: 'S-500', target: 'waits', items: 1, plusOnes: 1 },
  ]);
  assert.equal(m.perAgent, 3);
  assert.equal(m.wordsTotal, -14);

  const many = { ...loop, items: [...loop.items, ...Array.from({ length: 8 }, (_, i) => ({ key: `S-2${i}`, target: `t${i}`, created_at: '2026-10-10T00:00:00.000Z', plusOnes: [] }))] };
  const capped = loopMetrics(many, 0);
  assert.equal(capped.targets.length, 5);
  assert.equal(capped.moreTargets, 6); // web, gates, waits, t0..t7: 11 targets.
});

test('a target a proposal answered with nothing after it reads as no recurrence', () => {
  const quiet = { ...loop, items: [{ key: 'S-42', target: 'waits', created_at: '2026-09-01T00:00:00.000Z', plusOnes: ['2026-09-02T00:00:00.000Z'] }] };
  assert.deepEqual(loopMetrics(quiet, 0).recurrence, [{ key: 'S-500', target: 'waits', items: 0, plusOnes: 0 }]);
  assert.equal(loopLines(quiet, 0)[1], '- Recurrence: waits 0 new after S-500 closed.');
});

test('only a proposal closed as done contributes answers to the recurrence check', () => {
  const p = { key: 'S-500', status: 'done', closed_at: '2026-10-08T12:00:00.000Z', body: 'Answers: S-42, S-43\n\nedits' };
  assert.deepEqual(answeredTargets(p), [
    { proposal: 'S-500', item: 'S-42', closed_at: '2026-10-08T12:00:00.000Z' },
    { proposal: 'S-500', item: 'S-43', closed_at: '2026-10-08T12:00:00.000Z' },
  ]);
  // A refused proposal never applied its edits, so it answers nothing; nor does an open one.
  for (const status of ['wont_do', 'canceled', 'duplicate', 'needs_approval', 'ready_to_merge']) assert.deepEqual(answeredTargets({ ...p, status }), []);
  assert.deepEqual(answeredTargets({ ...p, closed_at: null }), []);
});

test('a metric that cannot be computed leaves its line out instead of showing zero', () => {
  const none = loopLines({ since: SINCE, items: [], answers: [], words: [] }, 0);
  assert.deepEqual(none, ['- 0 new items, 0 +1s since the last digest.']);
  // No probe merged an instruction file, and no agent was archived, so neither line appears.
  const lines = loopLines({ ...loop, words: [] }, 0);
  assert.deepEqual(lines, [
    '- 9 new items, 1 +1 since the last digest.',
    '- Top targets (items/+1s): web 6/0, gates 2/0, waits 1/1.',
    '- Recurrence: web 6 new (6 items) after S-512 closed; waits 2 new (1 item, 1 +1) after S-500 closed.',
  ]);
});

test('a digest with only loop metrics is not empty, but a quiet loop sends nothing', () => {
  const empty = { items: [], rounds: [], archived: [] };
  // A proposal merged with no new items, rounds or archives is a digest worth sending.
  const md = buildDigest({ ...empty, loop: { since: SINCE, items: [], answers: [], words: [{ file: 'CLAUDE.md', delta: -20 }] } }, '2026-W41');
  assert.ok(md);
  assert.match(md, /## Loop health/);
  assert.match(md, /- Instruction words: -20 net \(CLAUDE\.md -20\)\./);
  // Loop rows with nothing in the period keep the old nothing-new answer.
  assert.equal(buildDigest({ ...empty, loop: { since: SINCE, items: [], answers: [], words: [] } }, '2026-W41'), null);
  // Recurrence alone is not news: it would send a digest forever after one close.
  const closed = [{ proposal: 'S-500', item: 'S-42', closed_at: '2026-10-08T12:00:00.000Z' }];
  const one = [{ key: 'S-42', target: 'waits', created_at: '2026-09-01T00:00:00.000Z', plusOnes: [] }];
  assert.equal(buildDigest({ ...empty, loop: { since: SINCE, items: one, answers: closed, words: [] } }, '2026-W41'), null);
});

test('an untargeted item is counted apart, never as a target or recurrence (S-1289)', () => {
  // `none` in any case or whitespace is no target: S-70 and S-71 are new, S-72's two +1s are new,
  // and S-73 was answered by a done proposal, yet its target is none, so no recurrence.
  const untargeted = {
    since: SINCE,
    items: [
      { key: 'S-70', target: 'none', created_at: '2026-10-09T00:00:00.000Z', plusOnes: ['2026-10-10T00:00:00.000Z'] },
      { key: 'S-71', target: ' None ', created_at: '2026-10-09T00:00:00.000Z', plusOnes: [] },
      { key: 'S-72', target: 'NONE', created_at: '2026-10-01T00:00:00.000Z', plusOnes: ['2026-10-09T00:00:00.000Z', '2026-10-09T01:00:00.000Z'] },
      { key: 'S-73', target: 'none', created_at: '2026-09-01T00:00:00.000Z', plusOnes: [] },
    ],
    answers: [{ proposal: 'S-600', item: 'S-73', closed_at: '2026-10-08T12:00:00.000Z' }],
    words: [],
  };
  const m = loopMetrics(untargeted, 0);
  assert.deepEqual(m.untargeted, { items: 2, plusOnes: 3 });
  assert.deepEqual(m.targets, []);
  assert.deepEqual(m.recurrence, []);
  assert.deepEqual(loopLines(untargeted, 0), [
    '- 2 new items, 3 +1s since the last digest.',
    '- Untargeted: 2 items, 3 +1s.',
  ]);
  // The untargeted count sits in the digest, and a digest of only untargeted items is news.
  const md = buildDigest({ items: [], rounds: [], archived: [], loop: untargeted }, '2026-W41');
  assert.match(md, /^- Untargeted: 2 items, 3 \+1s\.$/m);
  assert.doesNotMatch(md, /Top targets|Recurrence:/);
});

test('the untargeted line is left out when there are no untargeted items or +1s', () => {
  assert.equal(loopMetrics(loop, 3).untargeted.items, 0);
  assert.equal(loopMetrics(loop, 3).untargeted.plusOnes, 0);
  assert.ok(!loopLines(loop, 3).some((l) => l.startsWith('- Untargeted')));
});

test('without loop rows the digest has no Loop health section', () => {
  assert.doesNotMatch(buildDigest(rows, '2026-W41'), /## Loop health/);
});

const diffBody = [
  'Two edits, nothing else.',
  '',
  '```diff',
  'diff --git a/CLAUDE.md b/CLAUDE.md',
  '--- a/CLAUDE.md',
  '+++ b/CLAUDE.md',
  '@@ -1,2 +1,3 @@',
  '-old rule about waits',
  '+a shorter rule',
  '+another line here',
  'diff --git a/templates/type-retro-steward.md b/templates/type-retro-steward.md',
  '--- a/templates/type-retro-steward.md',
  '+++ b/templates/type-retro-steward.md',
  '+one more line',
  'diff --git a/src/retro.ts b/src/retro.ts',
  '--- a/src/retro.ts',
  '+++ b/src/retro.ts',
  '+irrelevant source line',
  '```',
].join('\n');

test('the instruction word delta counts words on + lines minus - lines, per instruction file', () => {
  assert.deepEqual(wordsInDiff(diffBody), [
    { file: 'CLAUDE.md', delta: 2 }, // +a shorter rule (3) +another line here (3) -old rule about waits (4)
    { file: 'templates/type-retro-steward.md', delta: 3 }, // +one more line
  ]);
  // A body with no diff block, or with no instruction file in it, counts nothing.
  assert.deepEqual(wordsInDiff('Summary only.'), []);
  assert.deepEqual(wordsInDiff('```diff\n+++ b/src/retro.ts\n+one line\n```'), []);
  assert.deepEqual(wordsInDiff(null), []);
});

// Who gets the digest (S-1059): the Retros ITSA's owner, with its participants copied, instead of
// the chief of staff, who only forwarded it. Only live, non-archived agents count, and the human is
// skipped; an owner that isn't live falls back to the chief of staff.
test('the digest goes to the Retros owner and its participants, skipping the human', () => {
  assert.deepEqual(digestRecipients({ owner: 'a1', participants: ['a2', 'human', 'a3'] }, () => true, 'cos'), ['a1', 'a2', 'a3']);
  // Deduped: a participant that is also the owner is named once.
  assert.deepEqual(digestRecipients({ owner: 'a1', participants: ['a1'] }, () => true, 'cos'), ['a1']);
});

test('with no live owner the digest falls back to the chief of staff', () => {
  const live = (r) => r !== 'a1';
  // An archived owner: the chief of staff takes its place, and the live participants still hear.
  assert.deepEqual(digestRecipients({ owner: 'a1', participants: ['a2'] }, live, 'cos'), ['cos', 'a2']);
  // No Retros ITSA at all, or none live: the chief of staff, as the digest always went.
  assert.deepEqual(digestRecipients(null, live, 'cos'), ['cos']);
  assert.deepEqual(digestRecipients(undefined, () => false, 'cos'), ['cos']);
  // Archived participants are skipped; with no chief of staff either, nobody is left to send to.
  assert.deepEqual(digestRecipients({ owner: null, participants: ['a2', 'human'] }, live, 'cos'), ['cos', 'a2']);
  assert.deepEqual(digestRecipients({ owner: 'a1', participants: [] }, live, null), []);
});

// A participant on a peer machine is live by the peer cache's lifecycle (S-1059): a row with no
// local agent behind it, so the local table alone would drop it.
test('a peer-only participant is live unless the peer cache says archived or shut down', () => {
  const peer = (id, lifecycle) => db.open().prepare('INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES (?,?,?,?,?)').run(id, id, 'storage', '2026-10-15T00:00:00.000Z', lifecycle);
  peer('peer-active', 'active');
  peer('peer-paused', 'paused');
  peer('peer-unknown', null);
  peer('peer-archived', 'archived');
  peer('peer-shut', 'shut_down');
  assert.equal(digestLive('peer-active'), true);
  assert.equal(digestLive('peer-paused'), true);
  assert.equal(digestLive('peer-unknown'), true);
  assert.equal(digestLive('peer-archived'), false);
  assert.equal(digestLive('peer-shut'), false);
  assert.equal(digestLive('nobody-here'), false);
  // The owner is a peer agent too: the digest goes to it, and its peer participant is copied.
  assert.deepEqual(digestRecipients({ owner: 'peer-active', participants: ['peer-paused', 'peer-archived'] }, digestLive, 'cos'), ['peer-active', 'peer-paused']);
});

// The early start (S-714): the digest and steward also go out before the daily slot when enough
// open retro items arrived since the last digest, or one item with enough +1s was +1'd again, and
// at least minHours have passed since the last digest (S-1059).
const EARLY = { enabled: true, newItems: 10, plusOnes: 3, minHours: 3 };
const counts = (newItems, freshPlusOnes = []) => ({ newItems, freshPlusOnes });
// Past the minHours wait, so the thresholds decide these tests.
const PAST = 99;

test('the early start fires at the new-item threshold', () => {
  assert.equal(earlyDue(counts(9), EARLY, PAST), false);
  assert.equal(earlyDue(counts(10), EARLY, PAST), true);
  assert.equal(earlyDue(counts(1), { ...EARLY, newItems: 1 }, PAST), true);
});

test('the early start fires on one item with enough +1s that was +1\'d since the last digest', () => {
  assert.equal(earlyDue(counts(0, [3]), EARLY, PAST), true);
  assert.equal(earlyDue(counts(0, [2]), EARLY, PAST), false);
  assert.equal(earlyDue(counts(0, [1, 2, 3]), EARLY, PAST), true);
  assert.equal(earlyDue(counts(0, [2]), { ...EARLY, plusOnes: 2 }, PAST), true);
});

test('an early start waits minHours since the last digest, whatever has piled up (S-1059)', () => {
  assert.equal(earlyDue(counts(10), EARLY, 2.9), false);
  assert.equal(earlyDue(counts(10), EARLY, 3), true);
  assert.equal(earlyDue(counts(0, [3]), EARLY, 1), false);
  // 0 turns the wait off: the thresholds alone decide.
  assert.equal(earlyDue(counts(10), { ...EARLY, minHours: 0 }, 0), true);
});

test('the early start is off when the setting says so, and with nothing new', () => {
  assert.equal(earlyDue(counts(10, [9]), { ...EARLY, enabled: false }, PAST), false);
  assert.equal(earlyDue(counts(0, []), EARLY, PAST), false);
});

// The early start's counts (S-714): two light queries over the store, so only open retro items
// count, only after the last digest (strictly), and only counted +1s.
const EARLY_SINCE = '2026-10-10T00:00:00.000Z';
const retroItem = (key, { created_at, closed = false, kind = 'retro' }) =>
  db
    .open()
    .prepare('INSERT INTO itsas (id, key, kind, title, status, created_by, created_at, updated_at, thread_id, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(key, key, kind, `title ${key}`, closed ? 'done' : 'idea', 'a1', created_at, created_at, `th-${key}`, closed ? created_at : null);
const comment = (id, thread_id, body, created_at) =>
  db.open().prepare('INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id) VALUES (?,?,?,?,?,?,?)').run(id, 'a2', 'a2', 's', body, created_at, thread_id);

test('the counts read only open retro items created strictly after the last digest', () => {
  retroItem('S-90', { created_at: '2026-10-11T00:00:00.000Z' });              // after
  retroItem('S-91', { created_at: EARLY_SINCE });                                    // the same millisecond: not after
  retroItem('S-92', { created_at: '2026-10-09T00:00:00.000Z' });               // before
  retroItem('S-93', { created_at: '2026-10-11T00:00:00.000Z', closed: true }); // closed
  retroItem('S-94', { created_at: '2026-10-11T00:00:00.000Z', kind: 'feedback-report' });
  assert.equal(earlyCounts(EARLY_SINCE).newItems, 1);
});

test('the counts take only counted +1s strictly after the last digest, and only for open items', () => {
  retroItem('S-95', { created_at: '2026-10-09T00:00:00.000Z' });               // old item, +1'd again
  comment('m1', 'th-S-95', '+1 from a2: me too', '2026-10-11T00:00:00.000Z');
  retroItem('S-96', { created_at: '2026-10-09T00:00:00.000Z' });
  comment('m2', 'th-S-96', '+1 from a2: same millisecond', EARLY_SINCE);        // the same millisecond: not fresh
  comment('m3', 'th-S-96', 'a plain comment', '2026-10-11T00:00:00.000Z'); // not a +1
  retroItem('S-97', { created_at: '2026-10-09T00:00:00.000Z' });
  comment('m4', 'th-S-97', '+1 from a2: one', '2026-10-11T00:00:00.000Z');
  comment('m5', 'th-S-97', '+1 from a3: two', '2026-10-11T00:00:00.000Z');
  comment('m6', 'th-S-97', 'Reported again by a4: three', '2026-10-11T00:00:00.000Z');
  retroItem('S-98', { created_at: '2026-10-09T00:00:00.000Z', closed: true });
  comment('m7', 'th-S-98', '+1 from a2: closed', '2026-10-11T00:00:00.000Z');
  // Fresh items carry their total +1 count: S-95 has 1, S-97 has 3; S-96's +1 is at the boundary, S-98 is closed.
  assert.deepEqual([...earlyCounts(EARLY_SINCE).freshPlusOnes].sort((a, b) => a - b), [1, 3]);
});

test('Coverage names the reason an archive had no final round (S-1402)', () => {
  const md = buildDigest({ items: [], rounds: [], archived: [{ name: 'x', hasRound: false, reason: 'shut_down' }, { name: 'y', hasRound: false }] }, 'W');
  assert.match(md, /2 agents archived: 0 with a final round, 2 without \(x: shut_down, y\)\./);
});

// The digest mail is from the retro system sender, not a stand-in agent (S-1239).
test('the digest is mailed from system:retro to the chief of staff', async () => {
  const { sendDigest } = await import('../src/retro-digest.ts');
  const { setSetting } = await import('../src/settings.ts');
  db.createAgent({ id: db.newAgentId(), name: 'digest-cos', role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  setSetting('chiefOfStaff', 'digest-cos');
  retroItem('S-120', { created_at: new Date().toISOString() });
  const r = await sendDigest(new Date());
  assert.equal(r.sent, true, r.reason);
  const m = db.open().prepare("SELECT from_id, from_name, thread_id, reply_to FROM mail WHERE subject LIKE 'Retro digest:%'").get();
  assert.equal(m.from_id, 'system:retro');
  assert.equal(m.from_name, 'retro');
  assert.equal(m.reply_to, null);
});
