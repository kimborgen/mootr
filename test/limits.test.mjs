#!/usr/bin/env node
// Unit test for build step 1 of docs/cost-policy.md: every fixture in
// test/fixtures/limits/ run through the adapter's classifyError, against a throwaway
// STAM_HOME, no live agents, no network. Run with
// `node --test test/limits.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-limits-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `limits-test-${process.pid}`;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'limits');
const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8'));
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();

let adapters;
before(async () => {
  ({ adapters } = await import('../src/adapters/index.ts'));
});
after(() => rmSync(home, { recursive: true, force: true }));

test('every adapter implements classifyError', () => {
  for (const [name, adapter] of Object.entries(adapters)) assert.equal(typeof adapter.classifyError, 'function', `${name} has no classifyError`);
});

test('manifest and fixtures agree', () => {
  assert.deepEqual(Object.keys(manifest).sort(), fixtureFiles, 'manifest.json and the fixture files list different cases');
});

for (const file of fixtureFiles) {
  const entry = manifest[file];
  test(`${file} -> ${entry.class}`, () => {
    const adapter = adapters[entry.adapter];
    assert.ok(adapter, `unknown adapter ${entry.adapter} for ${file}`);
    assert.equal(typeof adapter.classifyError, 'function', `${entry.adapter} has no classifyError`);
    const payload = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
    assert.equal(adapter.classifyError(payload), entry.class);
  });
}

test('classifyError never throws on junk', () => {
  for (const [name, adapter] of Object.entries(adapters)) {
    for (const junk of [{}, { hook_event_name: 'Stop' }, { type: 'unknown.event' }, { turn: { status: 'failed' } }]) {
      assert.doesNotThrow(() => adapter.classifyError(junk), `${name}.classifyError threw on ${JSON.stringify(junk)}`);
    }
  }
});
