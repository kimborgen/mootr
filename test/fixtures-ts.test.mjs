#!/usr/bin/env node
// The cross-language fixtures (S-2386): every case in api/fixtures/NAME/cases.json runs through
// today's TS code and must give the stored output, and each file must be what
// scripts/fixtures-regen.mjs writes, so a TS change that moves an output fails here until the
// fixtures are regenerated on purpose. Free: pure functions and a throwaway STAM_HOME, no daemon.
// Run with `node --test test/fixtures-ts.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, observe, render } from '../scripts/fixtures-lib.mjs';

const root = join(import.meta.dirname, '..', 'api', 'fixtures');

test('every fixture has a folder, and every folder a fixture', () => {
  const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(dirs, Object.keys(FIXTURES).sort());
});

for (const name of Object.keys(FIXTURES)) {
  const text = readFileSync(join(root, name, 'cases.json'), 'utf8');
  const file = JSON.parse(text);

  test(`${name}: the file is the one the regen script writes`, () => {
    assert.equal(text, render(name), `api/fixtures/${name}/cases.json is stale: node scripts/fixtures-regen.mjs ${name}`);
  });

  test(`${name}: the file names are unique and each case has an input and output`, () => {
    assert.equal(file.fixture, name);
    assert.ok(file.cases.length > 0);
    assert.equal(new Set(file.cases.map((c) => c.name)).size, file.cases.length);
    for (const c of file.cases) assert.ok('input' in c && 'output' in c, c.name);
  });

  for (const c of file.cases) {
    test(`${name}: ${c.name}`, () => {
      assert.deepEqual(observe(name, c), c.output);
    });
  }
}
