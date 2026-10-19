#!/usr/bin/env node
// Settings read split (S-386, S-380 change 1): the home reads only settings.json; a non-home daemon
// reads shared keys from settings.shared.json and only LOCAL_KEYS from settings.json. No network.
// Throwaway STAM_HOMEs, no daemon: `node --test test/settings-split.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-settings-split-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `settings-split-test-${process.pid}`;
const file = join(home, 'settings.json');
const cacheFile = join(home, 'settings.shared.json');
const s = await import('../src/settings.ts');
const { MACHINE } = await import('../src/config.ts');
const save = (obj) => { writeFileSync(file, JSON.stringify(obj)); s.settingsChanged(); };
const cache = (settings, rev = 1) => s.writeSharedCache(JSON.stringify({ rev, settings }));

test('home and itsa.home resolve: home ?? itsa.home ?? this machine', () => {
  save({});
  assert.equal(s.settings().home, MACHINE);
  assert.equal(s.isSettingsHome(), true);
  save({ itsa: { home: 'elsewhere' } });
  assert.equal(s.settings().home, 'elsewhere');
  assert.equal(s.settings().itsa.home, 'elsewhere');
  save({ home: 'top', itsa: { home: 'elsewhere' } });
  assert.equal(s.settings().itsa.home, 'top');
  assert.equal(s.isSettingsHome(), false);
});

test('localPart and sharedPart split by LOCAL_KEYS, deep paths included', () => {
  const o = { home: 'a', peers: [1], context: { warnTokens: 5 }, itsa: { home: 'a', keyPrefix: 'S' }, debug: { stallMs: 9 }, retro: { lastDigest: 'x', steward: { enabled: false } } };
  assert.deepEqual(s.localPart(o), { home: 'a', peers: [1], itsa: { home: 'a' }, debug: { stallMs: 9 }, retro: { lastDigest: 'x' } });
  assert.deepEqual(s.sharedPart(o), { context: { warnTokens: 5 }, itsa: { keyPrefix: 'S' }, debug: {}, retro: { steward: { enabled: false } } });
  assert.ok(s.LOCAL_KEYS.includes('resourceWarn.lastWarned'));
});

test('the home reads only its file, even with a cache present', () => {
  save({ context: { warnTokens: 111 } });
  cache({ context: { warnTokens: 222 } });
  assert.equal(s.settings().context.warnTokens, 111);
});

test('a non-home daemon with a cache merges: local keys win, shared keys in the file are ignored', () => {
  save({ home: 'other', context: { warnTokens: 111 }, search: { embedder: 'off' }, debug: { stallMs: 7 } });
  cache({ context: { warnTokens: 222 }, search: { embedder: 'local' }, debug: { stallMs: 1 }, staleWorkingMinutes: 42 });
  const v = s.settings();
  assert.equal(v.context.warnTokens, 222);
  assert.equal(v.staleWorkingMinutes, 42);
  assert.equal(v.search.embedder, 'off');
  assert.equal(v.debug.stallMs, 7);
  assert.equal(v.home, 'other');
});

test('no cache: the local file is read whole', async () => {
  const { rmSync } = await import('node:fs');
  rmSync(cacheFile, { force: true });
  save({ home: 'other', context: { warnTokens: 333 } });
  assert.equal(s.settings().context.warnTokens, 333);
});

test('a cache change invalidates the memo', () => {
  save({ home: 'other' });
  cache({ context: { warnTokens: 1 } }, 1);
  assert.equal(s.settings().context.warnTokens, 1);
  const before = s.settingsReads();
  s.settings();
  assert.equal(s.settingsReads(), before);
  // An external replace with a later mtime, no settingsChanged call.
  writeFileSync(cacheFile, JSON.stringify({ rev: 2, settings: { context: { warnTokens: 2 } } }));
  const at = new Date(Date.now() + 5000);
  utimesSync(cacheFile, at, at);
  assert.equal(s.settings().context.warnTokens, 2);
});

test('a corrupt cache keeps the last good value and is not cached', () => {
  save({ home: 'other' });
  cache({ context: { warnTokens: 5 } });
  const good = s.settings();
  assert.equal(good.context.warnTokens, 5);
  writeFileSync(cacheFile, '{not json');
  s.settingsChanged();
  assert.equal(s.settings().context.warnTokens, 5);
  const before = s.settingsReads();
  s.settings();
  assert.equal(s.settingsReads() - before, 0, 'memoized under the corrupt cache\'s stat key');
  cache({ context: { warnTokens: 6 } });
  assert.equal(s.settings().context.warnTokens, 6);
});

test('a corrupt cache does not keep a last good value from another home', () => {
  save({ home: 'other' });
  cache({ context: { warnTokens: 5 } });
  assert.equal(s.settings().context.warnTokens, 5);
  save({ home: 'third', context: { warnTokens: 77 } });
  writeFileSync(cacheFile, '{not json');
  s.settingsChanged();
  assert.equal(s.settings().context.warnTokens, 77);
});

test('writeSharedCache is atomic and readSharedCache reads it', () => {
  cache({ a: 1 }, 7);
  assert.deepEqual(s.readSharedCache(), { rev: 7, settings: { a: 1 } });
  writeFileSync(cacheFile, '[]');
  assert.equal(s.readSharedCache(), null);
});

test('the registry and instructions come from the cache on a non-home daemon, else the local files (S-387)', async () => {
  const { registry } = await import('../src/registry.ts');
  const { globalInstructions } = await import('../src/instructions.ts');
  writeFileSync(join(home, 'registry.json'), JSON.stringify({ types: { mine: { description: 'local', harness: 'claude' } } }));
  writeFileSync(join(home, 'instructions.md'), 'local text');
  // A cache from before S-387 has neither: the local files.
  save({ home: 'other' });
  cache({});
  assert.equal(s.readSharedCache().registry, undefined);
  assert.ok(registry().types.mine);
  assert.equal(globalInstructions(), 'local text');
  s.writeSharedCache(JSON.stringify({ rev: 2, settings: {}, registry: { types: { theirs: { description: 'home', harness: 'claude' } } }, instructions: 'home text' }));
  assert.equal(registry().types.mine, undefined);
  assert.equal(registry().types.theirs.description, 'home');
  assert.equal(globalInstructions(), 'home text');
  // Each caller gets its own copy.
  registry().types.theirs.description = 'changed';
  assert.equal(registry().types.theirs.description, 'home');
  // The home reads its own files, with the cache present.
  save({});
  assert.ok(registry().types.mine);
  assert.equal(registry().types.theirs, undefined);
  assert.equal(globalInstructions(), 'local text');
});

test('ensureSettings on a non-home daemon with a cache adds no shared defaults', () => {
  save({ home: 'other' });
  cache({ context: { warnTokens: 5 } });
  s.ensureSettings();
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.context, undefined);
  assert.equal(disk.staleWorkingMinutes, undefined);
  assert.deepEqual(Object.keys(disk.itsa).sort(), ['home', 'repos']);
  assert.deepEqual(s.sharedPart(disk), { auth: {}, debug: {}, files: {}, itsa: {}, resourceWarn: {}, retro: {}, search: {} });
});

test('ensureSettings on the home still adds every default', () => {
  save({});
  s.ensureSettings();
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(disk.context && disk.itsa);
});

test('a patch of retro or resourceWarn keeps the file\'s lastDigest and lastWarned', () => {
  save({ retro: { lastDigest: '2026-10-14T09:00:00.000Z', digest: { day: 'daily' } }, resourceWarn: { lastWarned: { cpu: 5 }, cpu: 1 } });
  const out = (r) => JSON.parse(r.text);
  // A page's older copy, or none at all, doesn't replace it.
  let r = out(s.patchSettings({ retro: { lastDigest: '2026-10-13T09:00:00.000Z', digest: { day: 'fri' } }, resourceWarn: { lastWarned: { cpu: 1 }, cpu: 2 } }));
  assert.equal(r.retro.lastDigest, '2026-10-14T09:00:00.000Z');
  assert.equal(r.retro.digest.day, 'fri');
  assert.equal(r.resourceWarn.lastWarned.cpu, 5);
  assert.equal(r.resourceWarn.cpu, 2);
  r = out(s.patchSettings({ retro: { steward: { enabled: false } } }));
  assert.equal(r.retro.lastDigest, '2026-10-14T09:00:00.000Z');
  // No lastDigest in the file yet: a sent null doesn't set one.
  save({});
  r = out(s.patchSettings({ retro: { lastDigest: null, steward: { enabled: false } } }));
  assert.equal('lastDigest' in r.retro, false);
});
