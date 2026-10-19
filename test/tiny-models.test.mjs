#!/usr/bin/env node
// The tiny-model registry (S-1480, src/tiny-models.ts): it reads through to the settings keys the
// steps already used, the tool summary has its own key with editable instructions and a typed
// getter, and a settings file from before the registry gives the same values as before.
// Throwaway STAM_HOME, no daemon, no model call: `node --test test/tiny-models.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-tiny-models-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `tiny-models-test-${process.pid}`;
const file = join(home, 'settings.json');
const write = (cfg) => writeFileSync(file, JSON.stringify({ peers: [], ...cfg }, null, 2));
write({});
const { settings } = await import('../src/settings.ts');
const t = await import('../src/tiny-models.ts');
const byId = (id) => t.tinyModels().find((m) => m.id === id);

test('the registry lists every tiny step, in order', () => {
  assert.deepEqual(t.tinyModels().map((m) => m.id), ['decisions', 'mailTitles', 'blockSummaries', 'activityClassify', 'toolSummary']);
});

test('decisions names what shares its model and the others name nothing', () => {
  assert.match(byId('decisions').usedBy, /requirement checks/);
  assert.equal(byId('mailTitles').usedBy, null);
});

test('a file with none of the new keys behaves as before', () => {
  const m = byId('mailTitles');
  assert.equal(m.enabled, false);
  assert.equal(m.model, '');
  assert.equal(byId('blockSummaries').enabled, false);
  assert.equal(byId('activityClassify').enabled, false);
  assert.equal(byId('decisions').model, 'microsoft/microsoft-decision-1');
  assert.equal(byId('decisions').enabled, true);
});

test('existing keys read through to their entries', () => {
  write({ mail: { titles: { model: 'google/gemma-3-4b-it' } }, instructions: { summaries: { model: 'x/y' } }, activity: { classify: { enabled: true } }, decisions: { model: 'a/b', mailCheck: false, mailGate: false } });
  assert.equal(byId('mailTitles').enabled, true);
  assert.equal(byId('mailTitles').model, 'google/gemma-3-4b-it');
  assert.equal(byId('blockSummaries').model, 'x/y');
  assert.equal(byId('activityClassify').enabled, true);
  assert.equal(byId('decisions').model, 'a/b');
  assert.equal(byId('decisions').enabled, false);
  assert.equal(byId('mailTitles').instructions.editable, true);
  assert.match(byId('mailTitles').instructions.text, /title/i);
});

test('the tool summary is off by default with the cheap model and shipped instructions', () => {
  write({});
  const c = t.toolSummaryConfig();
  assert.equal(c.enabled, false);
  assert.equal(c.model, 'google/gemma-3-4b-it');
  assert.equal(c.instructions, t.TOOL_SUMMARY_DEFAULT_INSTRUCTIONS);
  assert.match(c.instructions, /"tool"/);
  assert.match(c.instructions, /"doing"/);
  assert.match(c.instructions, /12 words/);
  assert.equal(byId('toolSummary').instructions.editable, true);
});

test('the tool summary reads its own settings, and empty instructions mean the default', () => {
  write({ tiny: { toolSummary: { enabled: true, model: ' foo/bar ', instructions: 'Be brief.' } } });
  let c = t.toolSummaryConfig();
  assert.deepEqual([c.enabled, c.model, c.instructions], [true, 'foo/bar', 'Be brief.']);
  assert.equal(byId('toolSummary').instructions.text, 'Be brief.');
  write({ tiny: { toolSummary: { enabled: 'yes', model: '', instructions: '  ' } } });
  c = t.toolSummaryConfig();
  assert.equal(c.enabled, false);
  assert.equal(c.model, 'google/gemma-3-4b-it');
  assert.equal(c.instructions, t.TOOL_SUMMARY_DEFAULT_INSTRUCTIONS);
  assert.equal(settings().tiny.toolSummary.instructions, '  ');
});

test('every page setting path exists in the settings', () => {
  const s = settings();
  const get = (p) => p.split('.').reduce((x, k) => x?.[k], s);
  for (const m of t.tinyModels()) {
    assert.notEqual(get(m.modelPath), undefined, m.modelPath);
    if (m.toggle) assert.equal(typeof get(m.toggle), 'boolean', m.toggle);
    for (const x of m.extras) assert.notEqual(get(x.path), undefined, x.path);
    if (m.instructions.path) assert.equal(typeof get(m.instructions.path), 'string');
    for (const x of m.more ?? []) assert.equal(typeof get(x.path), 'string', x.path);
  }
});

test('the second mail-title prompt resets to the shipped one when cleared (S-1579)', async () => {
  const mt = await import('../src/mail-title.ts');
  write({ tiny: { mailTitles: { titleInstructions: 'T.', summaryInstructions: 'S.' } } });
  assert.equal(mt.titlePrompt(true), 'S.');
  assert.equal(byId('mailTitles').more[0].text, 'S.');
  write({ tiny: { mailTitles: { titleInstructions: 'T.', summaryInstructions: '' } } });
  assert.equal(settings().tiny.mailTitles.summaryInstructions, '');
  assert.equal(mt.titlePrompt(true), mt.SUMMARY_PROMPT);
  assert.equal(byId('mailTitles').more[0].text, mt.SUMMARY_PROMPT);
  assert.equal(mt.titlePrompt(false), 'T.');
});

test('mail title and block summary prompts are editable, and empty means the shipped default (S-1579)', () => {
  write({});
  assert.equal(byId('mailTitles').instructions.text, byId('mailTitles').instructions.default);
  assert.equal(byId('mailTitles').more[0].text, byId('mailTitles').more[0].default);
  assert.equal(byId('blockSummaries').instructions.editable, true);
  assert.equal(byId('blockSummaries').instructions.note, 'An empty model turns the step off.');
  assert.equal(byId('decisions').instructions.editable, false);
  write({ tiny: { mailTitles: { titleInstructions: 'T.', summaryInstructions: '  ' }, blockSummaries: { instructions: 'B.' } } });
  assert.equal(byId('mailTitles').instructions.text, 'T.');
  assert.equal(byId('mailTitles').more[0].text, byId('mailTitles').more[0].default);
  assert.equal(byId('blockSummaries').instructions.text, 'B.');
  write({ tiny: { mailTitles: { titleInstructions: 5 }, blockSummaries: {} } });
  assert.equal(settings().tiny.mailTitles.titleInstructions, '');
  assert.equal(settings().tiny.blockSummaries.instructions, '');
});
