#!/usr/bin/env node
// The settings files hold secrets — peers' shared tokens and peer tokens — so src/settings.ts
// writes them 0600 and chmods an existing file that was left looser (S-743). The home and the
// token files are kept to this user too. Throwaway STAM_HOME, no daemon, no model.
// `node --test test/settings-file-mode.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-settings-mode-');
process.env.STAM_HOME = home;
delete process.env.STAM_TOKEN;

let s, config;
before(async () => {
  s = await import('../src/settings.ts');
  config = await import('../src/config.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const mode = (p) => statSync(p).mode & 0o777;

test('settings.json is written 0600, and a loose one is tightened on the next write', () => {
  const file = join(home, 'settings.json');
  s.setSetting('humanMail', { when: 'important' });
  assert.equal(mode(file), 0o600, 'a fresh settings.json is 0600');
  chmodSync(file, 0o644);
  s.setSetting('humanMail', { when: 'always' });
  assert.equal(mode(file), 0o600, 'a loose settings.json is tightened on the next write');
});

test('the shared cache is written 0600', () => {
  s.writeSharedCache(JSON.stringify({ rev: 1, settings: {} }));
  assert.equal(mode(join(home, 'settings.shared.json')), 0o600);
});

test('the home and the token files are kept to this user, existing ones included', () => {
  config.ensureToken();
  config.ensurePeerToken();
  assert.equal(mode(join(home, 'token')), 0o600);
  assert.equal(mode(join(home, 'peer-token')), 0o600);
  assert.equal(mode(home), 0o700, 'the home holds the secrets');
  chmodSync(join(home, 'peer-token'), 0o644);
  chmodSync(home, 0o755);
  config.ensureToken();
  config.ensurePeerToken();
  assert.equal(mode(join(home, 'peer-token')), 0o600, 'a loose peer-token is tightened');
  assert.equal(mode(home), 0o700, 'a loose home is tightened');
});
