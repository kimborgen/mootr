// test/run.sh names each test in FREE (and SMOKE) and dispatches it in cmd() (S-3013). A name in one list but not the
// others made the runner say "no test NAME", or run a missing test/e2e-NAME.sh. This reads run.sh's text and checks the lists agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = readFileSync(`${root}test/run.sh`, 'utf8');

const names = (list) => run.match(new RegExp(`^${list}="\\n([^"]*)"`, 'm'))[1].split('\n').filter(Boolean);
const free = names('FREE');
const smoke = names('SMOKE');

const start = run.indexOf('\ncmd() {');
const end = run.indexOf('\n}\n', start);
const dispatch = new Set([...run.slice(start, end).matchAll(/^    ([a-z][\w-]*)\) echo/gm)].map((m) => m[1]));

const dupes = (list) => list.filter((n, i) => list.indexOf(n) !== i);
const runnable = (n) => dispatch.has(n) || existsSync(`${root}test/e2e-${n}.sh`);

test('FREE > no name repeats', () => {
  assert.deepEqual(dupes(free), []);
});

test('SMOKE > no name repeats', () => {
  assert.deepEqual(dupes(smoke), []);
});

test('FREE and SMOKE > no name in both', () => {
  assert.deepEqual(free.filter((n) => smoke.includes(n)), []);
});

test('FREE and SMOKE > each name has a cmd() entry or a test/e2e-NAME.sh', () => {
  assert.deepEqual([...free, ...smoke].filter((n) => !runnable(n)), []);
});

test('cmd() > each entry is listed in FREE or SMOKE', () => {
  assert.deepEqual([...dispatch].filter((n) => !free.includes(n) && !smoke.includes(n)), []);
});
