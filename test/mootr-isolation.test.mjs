#!/usr/bin/env node
// Test isolation and the twin-writing writers (S-2889, S-3345). A stam agent's environment must never reach a test or a daemon
// through a MOOTR_ name: readers take MOOTR_ first, so a MOOTR_ name a parent carries would win over the STAM_ overrides a
// test sets. Writers set both names with one value (S-3345), and the scrubbers drop MOOTR_ names a parent carries as defence.
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
const { withTwins, setEnvVar } = await import('../src/env.ts');
const { agentExec } = await import('../src/agent-exec.ts');

test('the node helper drops the MOOTR_ names a parent carries, so a child reads the STAM_ overrides', () => {
  for (const k of Object.keys(SENTINEL)) assert.equal(process.env[k], undefined, `${k} survived the helper`);
  const home = tempHome('mootr-isolation-');
  // A child stands in for the CLI and the daemon: it reads the config a test's STAM_HOME and STAM_URL give it.
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `const c = await import(${JSON.stringify(join(ROOT, 'src/config.ts'))}); console.log(JSON.stringify([c.STAM_HOME, c.STAM_URL]));`],
  { env: { ...process.env, STAM_HOME: home, STAM_URL: 'http://127.0.0.1:9' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [home, 'http://127.0.0.1:9']);
});

test('the shell helper drops the MOOTR_ names, and a test daemon home sets each MOOTR_ twin to its STAM_ value', () => {
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
  // S-3141: every twin the file names equals its STAM_ name, so neither reader meets a stale value.
  const vars = Object.fromEntries([...text.matchAll(/\b(STAM|MOOTR)_([A-Z_]+)=('[^']*'|\S+)/g)].map((m) => [`${m[1]}_${m[2]}`, m[3]]));
  for (const n of ['HOME', 'PORT', 'URL', 'TMUX_SOCKET', 'MACHINE']) {
    assert.ok(vars[`MOOTR_${n}`], `test.env sets no MOOTR_${n}`);
    assert.equal(vars[`MOOTR_${n}`], vars[`STAM_${n}`], `MOOTR_${n} differs from STAM_${n}`);
  }
});

// S-3345 (P3 of S-2890): writers set each MOOTR_X beside STAM_X with the same value, and never drop a STAM_X write, so a rollback to
// a release that reads only STAM_X still works.
test('serviceEnv writes each STAM_ line with its MOOTR_ twin, and a MOOTR_-only value under both names', () => {
  const text = serviceEnv(['STAM_URL', 'STAM_TOKEN'], { MOOTR_URL: 'http://x:1' }, '/not-a-test-home', false);
  assert.equal(text, 'Environment=STAM_URL=http://x:1\nEnvironment=MOOTR_URL=http://x:1\n');
});

test('withTwins and setEnvVar write each twin with its STAM_ value', () => {
  assert.deepEqual(withTwins({ STAM_AGENT_ID: 'a1', STAM_TOKEN: 't', PATH: '/bin', STAM_URL: '' }),
    { STAM_AGENT_ID: 'a1', STAM_TOKEN: 't', PATH: '/bin', STAM_URL: '', MOOTR_AGENT_ID: 'a1', MOOTR_TOKEN: 't', MOOTR_URL: '' });
  // An explicit twin stays as given.
  assert.equal(withTwins({ STAM_HOME: 'a', MOOTR_HOME: 'b' }).MOOTR_HOME, 'b');
  const env = { MOOTR_TOKEN: 'stale' };
  setEnvVar('TOKEN', 'fresh', env);
  assert.deepEqual(env, { MOOTR_TOKEN: 'fresh', STAM_TOKEN: 'fresh' });
  setEnvVar('TOKEN', undefined, env);
  assert.deepEqual(env, {});
});

test('agentExec gives a child each MOOTR_ twin equal to its STAM_ value, over a stale parent twin', () => {
  process.env.MOOTR_AGENT_ID = 'stale';
  try {
    const out = agentExec(['sh', '-c', 'printf "%s|%s|%s|%s" "$STAM_AGENT_ID" "$MOOTR_AGENT_ID" "$STAM_URL" "$MOOTR_URL"'],
      { STAM_AGENT_ID: 'a1', STAM_URL: 'http://127.0.0.1:9' }, { mode: 'fileSync' });
    assert.equal(out, 'a1|a1|http://127.0.0.1:9|http://127.0.0.1:9');
  } finally {
    delete process.env.MOOTR_AGENT_ID;
  }
});

// The writers: each source file that sets a STAM_ name for a child does it through withTwins, setEnvVar or agentExec (which
// twin it), or writes the MOOTR_ name beside it. A bare `...{ STAM_X: ... }` spread would leave the twin stale.
function sources(dir, exts = ['.ts', '.mjs', '.sh']) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path, exts));
    else if (exts.includes(extname(name)) || (!extname(name) && exts.includes('.sh'))) out.push(path);
  }
  return out;
}
test('sessionCommand passes each STAM_ name with its MOOTR_ twin and no env -u for it', async () => {
  const { sessionCommand } = await import('../src/tmux.ts');
  const words = sessionCommand('a1', '/w', { STAM_AGENT_ID: 'a1', STAM_URL: 'http://127.0.0.1:9', PATH: '/bin' }, ['claude', '--x']);
  const pairs = words.flatMap((w, i) => (words[i - 1] === '-e' ? [w] : []));
  assert.deepEqual(pairs, ['STAM_AGENT_ID=a1', 'STAM_URL=http://127.0.0.1:9', 'PATH=/bin', 'MOOTR_AGENT_ID=a1', 'MOOTR_URL=http://127.0.0.1:9']);
  // The id the session sets is kept under both names; the name and token it doesn't set are dropped under both (S-3329).
  assert.equal(words.at(-1), '/usr/bin/env -u STAM_AGENT_NAME -u MOOTR_AGENT_NAME -u STAM_TOKEN -u MOOTR_TOKEN claude --x', 'the twins are written, and the identity the session does not set is scrubbed');
});

// The writers: a STAM_ name set for a child goes through withTwins, setEnvVar or agentExec (which twin it), or is written beside
// its MOOTR_ name. Scanned in src/, scripts/ and bin/ (the forms `...{ STAM_X: v }`, `{ ...process.env, STAM_X: v }` and a
// `STAM_X=v cmd` shell prefix) and in go/ (a `"STAM_X="+v` string). Not scanned: a name built from a variable (`STAM_${n}`),
// a multi-line object literal, and a shell `export STAM_X=...` line; the unit tests above cover the runtime writers.
const BARE = [
  /\.\.\.\{\s*STAM_[A-Z_]+:/,
  /\.\.\.process\.env,\s*STAM_[A-Z_]+:/,
];
const GO_WRITE = /"STAM_[A-Z_]+="\s*\+|"STAM_[A-Z_]+=",/;
const SH_WRITE = /(^|\s)STAM_[A-Z_]+=[^\s=]+\s+(exec|sh|node|"\$)/;
test('the writer scan flags a bare STAM_ spread and passes a twinned one', () => {
  assert.ok(BARE.some((re) => re.test('env: { ...process.env, ...{ STAM_HOME: h } }')));
  assert.ok(BARE.some((re) => re.test('env: { ...process.env, STAM_MERGE_STAMP: 1 }')));
  assert.ok(!BARE.some((re) => re.test('env: { ...process.env, ...withTwins({ STAM_HOME: h }) }')));
  assert.ok(GO_WRITE.test('append(env, "STAM_PEER="+name)'));
  assert.ok(SH_WRITE.test('STAM_CLI_NAME=$name exec node x'));
});
test('every src, scripts, bin and go writer of a STAM_ name also writes its MOOTR_ twin', () => {
  const files = [...sources(join(ROOT, 'src'), ['.ts']), ...sources(join(ROOT, 'scripts')), ...sources(join(ROOT, 'bin')),
    ...sources(join(ROOT, 'go'), ['.go'])].filter((f) => !f.endsWith('_test.go'));
  const found = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|#|\*)/.test(line)) return;
      const goBare = f.endsWith('.go') && GO_WRITE.test(line) && !/MOOTR_[A-Z_]+="/.test(line);
      const shBare = !/\.(ts|mjs|go)$/.test(f) && SH_WRITE.test(line) && !/MOOTR_[A-Z_]+=/.test(line);
      if (BARE.some((re) => re.test(line)) || goBare || shBare) found.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});

// The pairing rule (S-3194): a test that overrides a twinned name sets both names to one value, so a reader that prefers MOOTR_X
// never meets a stale or inherited twin of the STAM_X override. A line that writes STAM_X also writes MOOTR_X, and the other way round.
const TWINNED = ['HOME', 'PORT', 'URL', 'TMUX_SOCKET', 'MACHINE', 'BIND', 'OPENCODE_PORT', 'AGENTS_SKILLS', 'TOKEN'];
const writesName = (line, prefix, n) => new RegExp(`(^|[^A-Za-z0-9_$])${prefix}_${n}(=(?!=)|['"]?\\s*:\\s)`).test(line);
function unpaired(line) {
  // A systemd `Environment=NAME=value` line holds one variable, so the unit files a test writes pair the names across two lines.
  if (/^\s*(\/\/|#|Environment=)/.test(line)) return [];
  return TWINNED.filter((n) => writesName(line, 'STAM', n) !== writesName(line, 'MOOTR', n));
}
test('the pairing rule flags a line that writes only one of the twin names', () => {
  assert.deepEqual(unpaired('STAM_URL=x "$STAM" janitor'), ['URL']);
  assert.deepEqual(unpaired('MOOTR_HOME=/h sleep 1'), ['HOME']);
  assert.deepEqual(unpaired("env({ STAM_PORT: '1', PATH: p })"), ['PORT']);
  assert.deepEqual(unpaired('STAM_URL=x MOOTR_URL=x "$STAM" janitor'), []);
  assert.deepEqual(unpaired('echo "$STAM_URL" "${STAM_HOME:-x}"'), []);
});
test('every test and check script that overrides a twinned name sets both names', () => {
  // The sentinel tests name one side on purpose, and doctor.test.mjs sets MOOTR_PORT alone in a child's env to test the precedence.
  // Shell scripts only: a node test's child env is built from process.env, which tmphome.mjs and scrub-env.mjs keep free of MOOTR_ names.
  const files = [...sources(join(ROOT, 'test'), ['.sh']), ...sources(join(ROOT, 'web/check'), ['.sh'])];
  const found = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const names = unpaired(line);
      if (names.length) found.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${names.join(',')}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});
