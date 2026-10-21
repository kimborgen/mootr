#!/usr/bin/env node
// Type templates on the settings home (S-417): a non-home daemon with the home's cache reads a type's
// template from it, never from its own file; the home reads its own files and serves only type-*.md.
// No network, no daemon: `node --test test/type-templates-sync.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-type-templates-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `type-templates-test-${process.pid}`;
const dir = join(home, 'templates');
mkdirSync(dir, { recursive: true });
const s = await import('../src/settings.ts');
const sync = await import('../src/settings-sync.ts');
const t = await import('../src/templates.ts');
const save = (obj) => { writeFileSync(join(home, 'settings.json'), JSON.stringify(obj)); s.settingsChanged(); };

test('the home serves its type templates only, and their change moves the rev', () => {
  save({});
  writeFileSync(join(dir, 'type-dev.md'), 'home dev\n');
  writeFileSync(join(dir, 'some-notice.md'), 'local only\n');
  const a = sync.sharedPayload();
  assert.deepEqual(a.templates, { 'type-dev': 'home dev\n' });
  writeFileSync(join(dir, 'type-dev.md'), 'home dev 2\n');
  assert.notEqual(sync.sharedPayload().rev, a.rev);
});

test('the home reads its own file', () => {
  assert.equal(t.userTemplate('type-dev'), 'home dev 2\n');
});

test('a peer with the home\'s cache reads it, not its own file, and a removed template falls back', () => {
  save({ home: 'elsewhere' });
  s.writeSharedCache(JSON.stringify({ rev: 1, settings: {}, templates: { 'type-dev': 'synced\n' } }));
  assert.equal(t.userTemplate('type-dev'), 'synced\n');
  assert.equal(t.template('type-dev'), 'synced\n');
  // The home dropped it: the peer's own old file is not read.
  s.writeSharedCache(JSON.stringify({ rev: 2, settings: {}, templates: {} }));
  assert.equal(t.userTemplate('type-dev'), null);
  // A template that isn't a type's stays per machine.
  assert.equal(t.userTemplate('some-notice'), 'local only\n');
});

test('a peer whose cache has no templates (older home) reads its own file', () => {
  s.writeSharedCache(JSON.stringify({ rev: 3, settings: {} }));
  assert.equal(t.userTemplate('type-dev'), 'home dev 2\n');
});

test('a type file goes only once the home\'s registry shows its type gone', () => {
  const names = ['type-dev', 'type-old', 'type-masked'];
  const reg = { types: { dev: { description: 'kept' }, masked: null } };
  assert.deepEqual(sync.typeFilesGone(reg, names, {}), ['type-old', 'type-masked']);
  // A home that can't say (no registry, one it couldn't read as {}, or a malformed types) proves nothing.
  assert.deepEqual(sync.typeFilesGone(null, names, {}), []);
  assert.deepEqual(sync.typeFilesGone({}, names, {}), []);
  assert.deepEqual(sync.typeFilesGone({ types: [] }, names, {}), []);
  // A shipped type the home's user types don't name is still the shipped one: kept.
  assert.deepEqual(sync.typeFilesGone({ types: {} }, ['type-developer'], { developer: {} }), []);
});

test('pruneTypeFiles removes a local type file only on the home\'s word', async () => {
  const file = (n) => join(dir, `${n}.md`);
  const exists = (n) => existsSync(file(n));
  save({ home: 'elsewhere' });
  writeFileSync(file('type-dev'), 'local dev\n');
  writeFileSync(file('type-old'), 'local old\n');
  // A home that didn't send its registry (an older home, or a failed fetch) removes nothing.
  await sync.pruneTypeFiles(null);
  assert.equal(exists('type-old'), true);
  // No home to ask: nothing is removed, and no file is read as gone.
  await sync.pruneTypeFiles();
  assert.equal(exists('type-old'), true);
  // The home has the type still: kept. It has gone: removed, and a template that isn't a type's stays.
  await sync.pruneTypeFiles({ types: { dev: {} } });
  assert.equal(exists('type-dev'), true);
  await sync.pruneTypeFiles({ types: {} });
  assert.equal(exists('type-dev'), false);
  assert.equal(exists('type-old'), false);
  writeFileSync(file('some-notice'), 'local only\n');
  await sync.pruneTypeFiles({ types: {} });
  assert.equal(t.userTemplate('some-notice'), 'local only\n');
});

test('a spawn on a peer gets the home\'s brief, not its own file', () => {
  save({ home: 'elsewhere' });
  writeFileSync(join(dir, 'type-dev.md'), 'peer dev own\n');
  s.writeSharedCache(JSON.stringify({ rev: 4, settings: {}, templates: { 'type-dev': 'home brief\n' } }));
  assert.equal(t.template('type-dev', 'dev'), 'home brief\n');
  assert.equal(t.render('type-dev', {}, 'dev'), 'home brief');
});

test('a home that can\'t be reached keeps every type file', async () => {
  // Port 9 (discard) refuses the connection: the home is configured, and not there.
  save({ home: 'elsewhere', peers: [{ name: 'elsewhere', url: 'http://127.0.0.1:9', token: 'unused' }] });
  writeFileSync(join(dir, 'type-gone.md'), 'local gone\n');
  await sync.pruneTypeFiles();
  assert.equal(existsSync(join(dir, 'type-gone.md')), true);
});

test('a registry the home can\'t read keeps every type file', async () => {
  writeFileSync(join(dir, 'type-gone.md'), 'local gone\n');
  for (const reg of [null, {}, { types: [] }, { types: 'x' }]) {
    await sync.pruneTypeFiles(reg);
    assert.equal(existsSync(join(dir, 'type-gone.md')), true, JSON.stringify(reg));
  }
});

test('a home whose answer is an error other than found keeps every type file', async () => {
  // A home that answers 500 to the shared-settings read: the fetch failed, so nothing is proven gone.
  const server = createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fixture: broken' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    save({ home: 'elsewhere', peers: [{ name: 'elsewhere', url: `http://127.0.0.1:${server.address().port}`, token: 'unused' }] });
    writeFileSync(join(dir, 'type-gone.md'), 'local gone\n');
    await sync.pruneTypeFiles();
    assert.equal(existsSync(join(dir, 'type-gone.md')), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a type the home still has keeps its file', async () => {
  writeFileSync(join(dir, 'type-kept.md'), 'local kept\n');
  await sync.pruneTypeFiles({ types: { kept: { description: 'still here' } } });
  assert.equal(existsSync(join(dir, 'type-kept.md')), true);
});

test('a shipped type keeps its file when the home\'s user types don\'t name it', async () => {
  writeFileSync(join(dir, 'type-developer.md'), 'local developer\n');
  await sync.pruneTypeFiles({ types: {} });
  assert.equal(existsSync(join(dir, 'type-developer.md')), true);
  // A shipped type the home masked is gone.
  await sync.pruneTypeFiles({ types: { developer: null } });
  assert.equal(existsSync(join(dir, 'type-developer.md')), false);
});
