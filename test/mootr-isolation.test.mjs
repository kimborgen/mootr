#!/usr/bin/env node
// Test isolation and the STAM_-only writers (S-2889). A stam agent's environment must never reach a test or a daemon
// through a MOOTR_ name: readers take MOOTR_ first, so a MOOTR_ name a parent carries would win over the STAM_ overrides a
// test sets. Until the cutover (S-2890), stam writes STAM_ names only, and the scrubbers drop MOOTR_ names as defence.
// Covers the shared node helper (test/tmphome.mjs), the shell helper (test/lib.sh), serviceEnv, and the source tree's writers.
// Free: `node --test test/mootr-isolation.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
// The parent's MOOTR_ names, set before the helper loads: a test process that inherited them.
const SENTINEL = {
  MOOTR_URL: 'http://sentinel.invalid:1',
  MOOTR_TOKEN: 'sentinel-token',
  MOOTR_AGENT_ID: 'sentinel-agent',
  MOOTR_HOME: '/sentinel/home',
  MOOTR_TMUX_SOCKET: 'sentinel-socket',
};
Object.assign(process.env, SENTINEL);
const { tempDir, tempHome } = await import('./tmphome.mjs');
const { serviceEnv } = await import('../src/test-env.ts');

test('the node helper drops the MOOTR_ names a parent carries, so a child reads the STAM_ overrides', () => {
  for (const k of Object.keys(SENTINEL)) assert.equal(process.env[k], undefined, `${k} survived the helper`);
  const home = tempHome('mootr-isolation-');
  // A child stands in for the CLI and the daemon: it reads the config a test's STAM_HOME and STAM_URL give it.
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `const c = await import(${JSON.stringify(join(ROOT, 'src/config.ts'))}); console.log(JSON.stringify([c.STAM_HOME, c.STAM_URL]));`],
  { env: { ...process.env, STAM_HOME: home, STAM_URL: 'http://127.0.0.1:9' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [home, 'http://127.0.0.1:9']);
});

test('the shell helper drops the MOOTR_ names, and a test daemon home names only STAM_ values', () => {
  const tmp = tempDir('mootr-isolation-sh-');
  const out = execFileSync('sh', ['-c', [
    '. ./test/lib.sh',
    'printf "%s|%s|%s\\n" "${MOOTR_URL-unset}" "${MOOTR_AGENT_ID-unset}" "$STAM_TEST_OWNER"',
    'daemon_home main',
    'cat "$TEST_TMP/main/test.env"',
  ].join('\n')], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, STAM_TEST_ROOT: ROOT, STAM_TEST_TMPDIR: tmp, ...SENTINEL },
    encoding: 'utf8',
  });
  const [seen, ...env] = out.split('\n');
  // The owner name is the agent id's (cut to 12 characters), so only the endpoints and the home are checked for the sentinel.
  assert.ok(seen.startsWith('unset|unset|'), 'the shell helper saw a MOOTR_ name');
  const text = env.join('\n');
  for (const v of ['sentinel.invalid', 'sentinel-token', '/sentinel/home', 'sentinel-socket']) assert.ok(!text.includes(v), `test.env names ${v}`);
  assert.ok(!/MOOTR_/.test(text), 'test.env names a MOOTR_ variable');
});

test('serviceEnv writes STAM_ lines only: a MOOTR_-only value is written under its STAM_ name', () => {
  const text = serviceEnv(['STAM_URL', 'STAM_TOKEN'], { MOOTR_URL: 'http://x:1' }, '/not-a-test-home', false);
  assert.equal(text, 'Environment=STAM_URL=http://x:1\n');
});

// The writers: no source file sets a MOOTR_ name (an object key, an assignment, or a template key), so an agent's
// environment, a unit and a test home carry STAM_ names only. The reads (`env[`MOOTR_${n}`]`, `${MOOTR_X:-...}`) are fine.
const WRITES = [
  /(^|[{,])\s*['"]?MOOTR_[A-Z0-9_]+['"]?\s*:\s/,
  /MOOTR_[A-Z0-9_]+=(?!=)/,
  /`MOOTR_\$\{[^`]*`\]?\s*=(?!=)/,
];
function sources(dir, exts = ['.ts', '.mjs', '.sh']) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path, exts));
    else if (exts.includes(extname(name)) || (!extname(name) && exts.includes('.sh'))) out.push(path);
  }
  return out;
}
test('no source file writes a MOOTR_ name: writers set STAM_ only (S-2890 switches them)', () => {
  // test/ (shell and node), web/check and go/ are scanned too (S-3140), so a test never writes a MOOTR_ name either; the scrub
  // lists name MOOTR_ in strings the patterns skip, and test/mootr-*.test.mjs hold sentinels on purpose.
  const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'scripts')), ...sources(join(ROOT, 'bin')),
    ...sources(join(ROOT, 'test')), ...sources(join(ROOT, 'web/check')), ...sources(join(ROOT, 'go'), ['.go', '.mjs', '.sh'])];
  const found = [];
  for (const f of files) {
    // doctor.test.mjs sets MOOTR_PORT in a child's explicit env on purpose, to test the precedence.
    if (/test\/(mootr-[a-z-]+|doctor)\.test\.mjs$/.test(f) || f.endsWith('go/internal/testenv/testenv_test.go')) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|#)/.test(line)) return;
      if (WRITES.some((re) => re.test(line))) found.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});
