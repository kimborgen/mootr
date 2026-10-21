#!/usr/bin/env node
// Unit tests for lessons from similar work (S-725): the query (ranking, the floor, excluded
// statuses, the embedder down), the rendering (empty, size, details), the setting (default, k
// clamped, off), and the wiring over a throwaway db with the stub embedder. No model runs.
// Run with `node --test test/retro-lessons.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './scrub-env.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STAM_HOME = mkdtempSync(join(tmpdir(), 'stam-lessons-unit-'));
process.env.STAM_EMBEDDER = 'stub';
const { lessonsFor, renderLessons, LESSON_FLOOR, LESSON_MAX_CHARS } = await import('../src/retro.ts');

const item = (n, status = 'idea', extra = {}) => ({
  id: `id${n}`,
  key: `S-${n}`,
  summary: `item ${n}`,
  body: `Kind: improve\nTarget: none\nReporter: alice (m, developer)\nOn: S-1\n\ndetails of ${n}\nsecond line ${n}\nthird line ${n}`,
  status,
  ...extra,
});
// A store whose similarity to any text is the given score per id.
const deps = (items, scores, calls = []) => ({
  items: () => items,
  similar: async (text, ids) => {
    calls.push({ text, ids });
    return scores ? Object.entries(scores).filter(([id]) => ids.has(id)).map(([id, score]) => ({ id, score })) : null;
  },
});

test('the k best above the floor come back, best first', async () => {
  const d = deps([1, 2, 3, 4, 5].map((n) => item(n)), { id1: 0.5, id2: 0.9, id3: 0.7, id4: 0.8, id5: 0.6 });
  assert.deepEqual((await lessonsFor(d, 'a task', 3)).map((x) => x.key), ['S-2', 'S-4', 'S-3']);
  assert.deepEqual((await lessonsFor(d, 'a task', 1)).map((x) => x.key), ['S-2']);
});

test('a match below the floor is dropped, so nothing relevant gives nothing', async () => {
  const d = deps([item(1), item(2)], { id1: LESSON_FLOOR - 0.01, id2: LESSON_FLOOR });
  assert.deepEqual((await lessonsFor(d, 'a task', 4)).map((x) => x.key), ['S-2']);
  assert.deepEqual(await lessonsFor(deps([item(1)], { id1: 0.05 }), 'a task', 4), []);
});

test('open and done items count; duplicate, wont_do and canceled do not', async () => {
  const items = [item(1, 'idea'), item(2, 'done'), item(3, 'duplicate'), item(4, 'wont_do'), item(5, 'canceled'), item(6, 'in_progress')];
  const calls = [];
  const d = deps(items, Object.fromEntries(items.map((x) => [x.id, 0.9])), calls);
  assert.deepEqual((await lessonsFor(d, 'task', 8)).map((x) => x.key).sort(), ['S-1', 'S-2', 'S-6']);
  assert.deepEqual([...calls[0].ids].sort(), ['id1', 'id2', 'id6'], 'excluded items are never scored');
});

test('no embedder, a failing embedder, an empty task, no items, or k below 1 give nothing and never throw', async () => {
  assert.deepEqual(await lessonsFor(deps([item(1)], null), 'task', 4), []);
  assert.deepEqual(await lessonsFor({ items: () => [item(1)], similar: async () => { throw new Error('boom'); } }, 'task', 4), []);
  assert.deepEqual(await lessonsFor(deps([item(1)], { id1: 0.9 }), '  \n ', 4), []);
  assert.deepEqual(await lessonsFor(deps([], { id1: 0.9 }), 'task', 4), []);
  assert.deepEqual(await lessonsFor(deps([item(1)], { id1: 0.9 }), 'task', 0), []);
});

test('the block has the heading, the key, the summary and two lines of details; empty when no hits', () => {
  const text = renderLessons([{ ...item(7), score: 0.9 }]);
  assert.match(text, /^# Lessons from similar work/);
  assert.match(text, /- S-7 item 7: details of 7 second line 7$/);
  assert.match(renderLessons([{ ...item(8, 'idea', { summary: 'ends with a period.' }), score: 1 }]), /- S-8 ends with a period: details/);
  assert.ok(!text.includes('third line'), 'only the first two lines of details');
  assert.ok(!text.includes('Reporter:'), 'the header lines are not details');
  assert.equal(renderLessons([]), '');
});

test('the block stays within the size budget however long the items are', () => {
  const long = (n) => ({ ...item(n, 'idea', { body: `Kind: improve\n\n${'x'.repeat(5000)}`, summary: 'y'.repeat(400) }), score: 0.9 });
  const text = renderLessons([1, 2, 3, 4, 5, 6, 7, 8].map(long));
  const lines = text.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.length >= 1 && lines.length < 8, `${lines.length} items`);
  assert.ok(lines.join('\n').length <= LESSON_MAX_CHARS + 20, `${lines.join('\n').length} chars`);
});

test('the setting defaults on with k 4, clamps k to 1-8, and turns off', async () => {
  const { settings } = await import('../src/settings.ts');
  assert.deepEqual(settings().retro.lessons, { enabled: true, k: 4 });
});

const withSettings = (retro) => {
  writeFileSync(join(process.env.STAM_HOME, 'settings.json'), JSON.stringify({ retro }));
};

test('settings.json k is clamped and enabled:false is kept', async () => {
  const { settings } = await import('../src/settings.ts');
  const read = (retro) => {
    withSettings(retro);
    return settings().retro.lessons;
  };
  assert.deepEqual(read({ lessons: { k: 99 } }), { enabled: true, k: 8 });
  assert.deepEqual(read({ lessons: { k: 0 } }), { enabled: true, k: 1 });
  assert.deepEqual(read({ lessons: { k: 2.5 } }), { enabled: true, k: 4 });
  assert.deepEqual(read({ lessons: { enabled: false, k: 3 } }), { enabled: false, k: 3 });
  withSettings({});
});

test('over the db: the nearest retro items under Retros come back, others are left out; off gives nothing', async () => {
  const db = await import('../src/db.ts');
  const itsa = await import('../src/itsa.ts');
  const { backfill } = await import('../src/vectors.ts');
  await import('../src/itsa-vectors.ts');
  const { lessonsPrompt, taskText } = await import('../src/retro-lessons.ts');
  const { settings } = await import('../src/settings.ts');
  const parent = await itsa.create({ title: 'Retros', kind: 'retros' });
  const mk = (title, body, extra = {}) => itsa.create({ title, summary: title, body: `Kind: improve\nTarget: none\n\n${body}`, kind: 'retro', parent: parent.id, ...extra });
  const near = await mk('Playwright browser downloads stall the test run', 'chromium download stalls the test run for minutes');
  await mk('Banana bread recipe', 'flour sugar eggs and bananas in the oven');
  const dup = await mk('Playwright browser downloads stall the test run again', 'chromium download stalls the test run', { status: 'duplicate' });
  await itsa.create({ title: 'Playwright browser downloads stall the test run', summary: 'x', body: 'Kind: improve\n\nchromium download', kind: 'issue' });
  await backfill();
  const agent = { id: 'a1', type: 'developer', role: 'fix playwright chromium download stalls in the test run', first_prompt: 'The playwright chromium download stalls the test run.' };
  db.upsertAgent?.(agent);
  const text = await lessonsPrompt(agent);
  assert.match(text, new RegExp(`- ${near.key} Playwright`), text);
  assert.ok(!text.includes('Banana'), 'the unrelated item is below the floor');
  assert.ok(!text.includes(dup.key), 'a duplicate is left out');
  assert.ok(taskText(agent).startsWith('developer\n'));
  withSettings({ lessons: { enabled: false } });
  assert.equal(settings().retro.lessons.enabled, false);
  assert.equal(await lessonsPrompt(agent), '');
});

test('a slow embedder gives no lessons after the cap, with a timedOut event; the cache keeps an empty block and forgets on archive', async () => {
  withSettings({});
  const db = await import('../src/db.ts');
  const { deps, lessonsPrompt, warmLessons, cachedLessons, forgetLessons, LESSONS_TIMEOUT_MS } = await import('../src/retro-lessons.ts');
  const agent = db.createAgent({ id: 'slow1', name: 'slow', role: 'x', machine: 'm', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  const real = deps.similar;
  deps.similar = () => new Promise(() => {});
  try {
    const t0 = Date.now();
    assert.equal(await warmLessons({ ...agent, first_prompt: 'a task' }), '');
    assert.ok(Date.now() - t0 < LESSONS_TIMEOUT_MS + 1000, 'returns at the cap');
  } finally {
    deps.similar = real;
  }
  const ev = db.listEvents('slow1').find((e) => e.type === 'retro:lessons');
  assert.ok(JSON.parse(ev.data).timedOut, ev.data);
  assert.equal(cachedLessons('slow1'), '', 'an empty block is cached, so a read does not recompute');
  assert.equal(cachedLessons('nobody'), undefined);
  forgetLessons('slow1');
  assert.equal(cachedLessons('slow1'), undefined);
});
