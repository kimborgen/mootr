// S-1817: the duplicate-selector check (web/check/dup-selectors.mjs) counts a plain selector's rules in one scope, fails when a selector has
// more rules than its baseline count, and passes the same selector under different at-rule scopes. Fixture CSS only, plus one run on the
// shipped stylesheets against their baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFiles, compare, duplicateGroups, readBaseline } from '../web/check/dup-selectors.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const groups = (css) => duplicateGroups('fixture.css', css);
const entry = (selector, count, scope = '') => ({ file: 'fixture.css', scope, selector, count, reason: 'fixture' });

test('a selector defined twice in the base scope is a duplicate, with both lines', () => {
  const css = '.card { color: red; }\n\n.card { margin: 0; }\n';
  assert.deepEqual(groups(css), [{ file: 'fixture.css', scope: '', selector: '.card', lines: [1, 3] }]);
});

test('the same selector in two different media queries passes', () => {
  const css = '@media (max-width: 760px) { .card { color: red; } }\n@media (min-width: 900px) { .card { color: blue; } }\n';
  assert.deepEqual(groups(css), []);
});

test('the same selector in the base scope and under a media query passes', () => {
  const css = '.card { color: red; }\n@media (max-width: 760px) {\n  .card { color: blue; }\n}\n';
  assert.deepEqual(groups(css), []);
});

test('the same selector twice under the same media query is a duplicate in that scope', () => {
  const css = '@media (max-width: 760px) {\n  .card { color: red; }\n  .card { color: blue; }\n}\n';
  assert.deepEqual(groups(css), [{ file: 'fixture.css', scope: '@media (max-width: 760px) {}', selector: '.card', lines: [2, 3] }]);
});

test('whitespace in a selector list is normalised before comparing', () => {
  const css = '.a,\n  .b { color: red; }\n.a, .b {\n  margin: 0; }\n';
  assert.equal(groups(css).length, 1);
});

test('comments and strings holding braces or semicolons do not confuse the parser', () => {
  const css = [
    '/* a comment with { braces } and ; semicolons */',
    '.label[data-x="}{"] { content: "}"; }',
    '/* .ghost { never parsed } */',
    ".note::before { content: '{ ; }'; }",
    '.label[data-x="}{"] { color: red; }',
    '',
  ].join('\n');
  const found = groups(css);
  assert.deepEqual(found, [{ file: 'fixture.css', scope: '', selector: '.label[data-x="}{"]', lines: [2, 5] }]);
});

test('a selector not in the baseline fails the check', () => {
  const result = compare(groups('.card { color: red; }\n.card { color: blue; }\n'), []);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].selector, '.card');
  assert.deepEqual(result.failures[0].lines, [1, 2]);
});

test('a selector with more rules than its baseline count fails the check', () => {
  const css = '.card { color: red; }\n.card { color: blue; }\n.card { margin: 0; }\n';
  const result = compare(groups(css), [entry('.card', 2)]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].allowed, 2);
  assert.deepEqual(result.failures[0].lines, [1, 2, 3]);
  assert.deepEqual(result.stale, []);
});

test('a selector with fewer rules than its baseline count is stale', () => {
  const result = compare(groups('.card { color: red; }\n.card { color: blue; }\n'), [entry('.card', 3)]);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.stale.map((s) => s.selector), ['.card']);
});

test('a baseline entry that no longer duplicates is stale', () => {
  const result = compare(groups('.card { color: red; }\n'), [entry('.card', 2)]);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.stale.map((s) => s.selector), ['.card']);
});

test('a baseline entry that still matches its count passes', () => {
  const result = compare(groups('.card { color: red; }\n.card { color: blue; }\n'), [entry('.card', 2)]);
  assert.deepEqual(result, { failures: [], stale: [] });
});

test('the shipped stylesheets pass against the baseline', () => {
  const result = checkFiles(root, undefined, readBaseline(root));
  assert.deepEqual(result.failures.map((f) => `${f.file}:${f.lines.join(',')} ${f.selector}`), []);
  assert.deepEqual(result.stale.map((s) => s.selector), []);
});
