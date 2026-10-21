#!/usr/bin/env node
// The generated API files are current (S-2388): api/openapi.bundled.yaml, web/src/api/types.gen.ts and,
// where Go is installed, go/internal/api/api.gen.go must equal what `node scripts/api-gen.mjs` makes
// from api/openapi.yaml. No daemon, no network once Go's module cache is warm: `node --test test/api-gen.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './scrub-env.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('generated API files are not stale', () => {
  const r = spawnSync('node', [join(ROOT, 'scripts/api-gen.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
