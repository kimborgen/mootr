#!/usr/bin/env node
// Unit tests for the kind, open, and offset options on the ITSA meaning search (S-729): the retro
// search ranks only the kinds it covers (kind `retro` and feedback reports) and only open items,
// and pages the ranked results, so a nearer ITSA of another kind, a closed one, or a run of ones
// the caller can't read cannot crowd a near-duplicate retro item out of the top. The stub embedder
// runs, no model. Run with `node --test test/retro-search.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STAM_HOME = mkdtempSync(join(tmpdir(), 'stam-retro-search-unit-'));
process.env.STAM_EMBEDDER = 'stub';
const itsa = await import('../src/itsa.ts');
const { searchItsas } = await import('../src/itsa-search.ts');
const { backfill } = await import('../src/vectors.ts');
await import('../src/itsa-vectors.ts');

const TEXT = 'playwright browser download is slow';
const query = 'playwright browser download is slow';

test('the kind filter keeps only the kinds it names, so a nearer issue cannot crowd out a retro item', async () => {
  const parent = await itsa.create({ title: 'Retros', kind: 'retros' });
  const retro = await itsa.create({ title: 'Chromium stalls', summary: 'Chromium stalls', body: `Kind: improve\n\n${TEXT}`, kind: 'retro', parent: parent.id });
  const issue = await itsa.create({ title: 'Chromium stalls', summary: 'Chromium stalls', body: TEXT, kind: 'issue' });
  const report = await itsa.create({ title: 'Chromium stalls', summary: 'Chromium stalls', body: `Kind: bug\n\n${TEXT}`, kind: 'feedback-report' });
  await backfill();
  // Unfiltered, all three are hits by meaning.
  const all = await searchItsas(query, { limit: 10 });
  assert.equal(all[0].by, 'meaning', 'the stub embedder ranked by meaning');
  assert.deepEqual(all.map((h) => h.id).sort(), [retro.id, issue.id, report.id].sort());
  // Only kind `retro`: the issue and the report are left out.
  const retros = await searchItsas(query, { limit: 10, kinds: ['retro'] });
  assert.deepEqual(retros.map((h) => h.id), [retro.id]);
  // The retro search's own kinds: retro items and feedback reports, not the issue.
  const retroKinds = await searchItsas(query, { limit: 10, kinds: ['retro', 'feedback-report'] });
  assert.deepEqual(retroKinds.map((h) => h.id).sort(), [retro.id, report.id].sort());
});

test('an empty kinds list means no filter, and a query with no kind match is empty, not an error', async () => {
  const all = await searchItsas(query, { limit: 10, kinds: [] });
  assert.ok(all.length >= 1);
  assert.deepEqual(await searchItsas(query, { limit: 10, kinds: ['nonexistent'] }), []);
});

test('the open filter applies before the limit, so closed matches cannot crowd out an open one', async () => {
  const q = 'migration script drops the table columns';
  const parent = await itsa.create({ title: 'Retros', kind: 'retros' });
  // 30 closed items nearest the query, then one open item slightly further away: without the filter
  // the closed ones fill the top 30 and the open item, at rank 31, is lost.
  for (let i = 0; i < 30; i += 1) {
    await itsa.create({ title: q, summary: q, body: `Kind: improve\n\n${q}`, kind: 'retro', parent: parent.id, status: 'done' });
  }
  const open = await itsa.create({ title: 'Migration script drops the table', summary: 'Migration script drops the table', body: 'Kind: improve\n\nmigration script drops the table', kind: 'retro', parent: parent.id, status: 'idea' });
  await backfill();
  const crowded = await searchItsas(q, { limit: 30, kinds: ['retro'] });
  assert.equal(crowded.length, 30, 'the closed items fill the limit');
  assert.ok(!crowded.some((h) => h.id === open.id), 'the open item is crowded out before the filter');
  const openOnly = await searchItsas(q, { limit: 30, kinds: ['retro'], open: true });
  assert.deepEqual(openOnly.map((h) => h.id), [open.id], 'the open filter drops the closed items before the limit');
});

test('offset pages the ranked results, so a caller can look past the first page', async () => {
  const q = 'offset paging check';
  const parent = await itsa.create({ title: 'Retros', kind: 'retros' });
  const made = [];
  for (let i = 0; i < 3; i += 1) made.push(await itsa.create({ title: `${q} ${i}`, summary: `${q} ${i}`, body: `Kind: improve\n\n${q}`, kind: 'retro', parent: parent.id, status: 'idea' }));
  await backfill();
  const first = await searchItsas(q, { limit: 1, kinds: ['retro'] });
  const rest = await searchItsas(q, { limit: 5, offset: 1, kinds: ['retro'] });
  assert.equal(first.length, 1);
  assert.equal(rest.length, 2);
  assert.ok(!rest.some((h) => h.id === first[0].id), 'the second page skips the first');
  assert.deepEqual([first[0].id, ...rest.map((h) => h.id)].sort(), made.map((x) => x.id).sort());
});
