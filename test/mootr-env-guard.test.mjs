#!/usr/bin/env node
// Guard for the test env scrub (S-3140). A reader takes MOOTR_X before STAM_X (src/env.ts), so a test that starts the CLI or a
// daemon, or sets its own STAM_HOME, must first drop the names a stam agent's environment carries, both MOOTR_ and STAM_, or a
// stray one reaches the live home. A node test imports test/tmphome.mjs or test/scrub-env.mjs; a shell test sources test/lib.sh;
// a Go test package that runs node calls testenv.Scrub (go/internal/testenv). Free: `node --test test/mootr-env-guard.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { withMootrTwins } from '../src/env.ts';
import { SCRUBBED } from './scrub-env.mjs';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '..');
const code = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|#|\*)/.test(l)).join('\n');

// The scrub helpers a node test imports, by real path. A file is scrubbed when it statically imports one of them: that import
// resolves from the file's own folder, so a basename match in another folder doesn't count.
const HELPERS = [join(ROOT, 'test/tmphome.mjs'), join(ROOT, 'test/scrub-env.mjs')];
// A file sets its own home in the process: `process.env.STAM_HOME = h`, which runs before any child it spawns.
const NODE_HOME = /process\.env\.STAM_HOME\s*=(?!=)/;
const CHILD_MODULE = /^(node:)?child_process$/;
// Child-process calls by name, bare or as a member (`cp.spawnSync`, `cp['spawnSync']`). A member `exec` isn't a child call by name:
// `re.exec(s)` is a RegExp call, and a file that uses child_process gets it through its import.
const SPAWN_NAMES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);

// The AST of a node file, or null when it doesn't parse: any parse diagnostic fails the file.
function parseNode(text) {
  const sf = ts.createSourceFile('guard-input.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return sf.parseDiagnostics.length ? null : sf;
}
function visitAll(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => visitAll(child, visit));
}
// Whether the file statically imports a real scrub helper, resolved from the file's own folder (`rel`, the path under the repo).
function importsHelper(sf, rel) {
  return sf.statements.some((s) => ts.isImportDeclaration(s) && s.moduleSpecifier.text.startsWith('.')
    && HELPERS.includes(resolve(ROOT, dirname(rel), s.moduleSpecifier.text)));
}
// Whether the file uses child_process: it imports or requires the module in any form (a namespace, a rename, a default), dynamically
// imports it, or calls a spawn name whatever its receiver. A dynamic import of anything else is unproven, so it counts too.
function usesChildProcess(sf) {
  let found = false;
  visitAll(sf, (node) => {
    if (ts.isImportDeclaration(node) && CHILD_MODULE.test(node.moduleSpecifier.text)) found = true;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && CHILD_MODULE.test(node.moduleReference.expression.text)) found = true;
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const arg = node.arguments[0];
    if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
      if (!arg || !ts.isStringLiteral(arg) || CHILD_MODULE.test(arg.text)) found = true;
    }
    if (ts.isIdentifier(callee) && SPAWN_NAMES.has(callee.text)) found = true;
    if (ts.isPropertyAccessExpression(callee) && SPAWN_NAMES.has(callee.name.text) && callee.name.text !== 'exec') found = true;
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
      && SPAWN_NAMES.has(callee.argumentExpression.text)) found = true;
  });
  return found;
}
// The node file's verdict: it parses, and it is scrubbed by a static import of a real helper. A file that uses child_process, or sets
// its own STAM_HOME, is unscrubbed without one: its spawns inherit the parent env, or its assignment runs before any scrub.
export function nodeUnscrubbed(text, rel = 'test/guard-input.mjs') {
  const sf = parseNode(text);
  if (!sf) return true;
  if (importsHelper(sf, rel)) return false;
  if (usesChildProcess(sf)) return true;
  return NODE_HOME.test(code(text));
}
// A shell file touches a home when it sets STAM_HOME or runs a daemon; lib.sh scrubs.
export function shUnscrubbed(text) {
  const c = code(text);
  return /^\s*(export\s+)?STAM_HOME=|^\s*\S*stam\S* daemon run|^\s*\S*bin\/stamd(\s|$)/m.test(c) && !/lib\.sh|unset[^\n]*MOOTR_|MOOTR_[^\n]*\bunset\b/.test(c);
}
// A Go test package runs node when a test file does; one of its files must call testenv.Scrub.
export function goUnscrubbed(files) {
  return files.some((t) => /exec\.Command\("node"/.test(t)) && !files.some((t) => /testenv\.Scrub\(\)/.test(t));
}

function walk(dir, keep) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(ROOT.length + 1);

// Node files the guard exempts by exact path, each with the reason it needs no scrub. A file not listed here is checked by its
// content, whatever its name. The guard fails a listed file that is gone, has no reason, or that the content check doesn't flag,
// so a rename or a fixed spawn can't leave a stale entry.
export const NODE_EXEMPT = new Map([
  ['test/tmphome.test.mjs', 'tests the tempHome helper: spawns node with the parent env on purpose, to check its cleanup'],
  ['test/fake-systemd.mjs', 'a fake systemctl: its spawn gets an explicit env (PATH and the test\'s keys), not the parent env'],
  ['test/mcp-call.mjs', 'a stdio MCP client: it passes the parent env on purpose to the stam it starts, and its e2e test sources test/lib.sh first'],
  ['test/mcp-proxy-call.mjs', 'as test/mcp-call.mjs: it reads STAM_URL and STAM_TOKEN from the env its e2e test sets after test/lib.sh'],
  ['test/push-helper.mjs', 'driven by test/e2e-push.sh: it reads the STAM_URL and STAM_HOME of its two daemons from the env on purpose'],
  ['test/term-cli.mjs', 'a pty client for stam attach: it passes the env on purpose, and the STAM_ names come from test/lib.sh'],
  ['test/mootr-isolation.test.mjs', 'tests the scrubbers: sets MOOTR_ sentinels in the parent and checks that a child drops them'],
  ['web/check/chromium-lock.mjs', 're-runs a check under the lock with the env its parent gave it; STAM_URL and the rest must survive'],
]);
// The rel paths of the files that the content check flags and the exemptions don't list. Pure, so the cases take fixtures.
export function unscrubbedNodeFiles(files, exempt) {
  return files.filter((f) => !exempt.has(f.rel) && nodeUnscrubbed(f.text, f.rel)).map((f) => f.rel);
}
// The exempt entries that are stale: the file is gone (exists is false), the reason is empty, or the content check (flagged)
// doesn't flag the file, so the exemption hides nothing.
export function staleExempt(exempt, exists, flagged) {
  return [...exempt].filter(([p, reason]) => !reason || !exists(p) || !flagged(p)).map(([p]) => p);
}

test('a node test that uses child_process or sets its home imports a scrub helper first', () => {
  const files = [...walk(join(ROOT, 'test'), (n) => n.endsWith('.mjs')), ...walk(join(ROOT, 'web/check'), (n) => n.endsWith('.mjs'))]
    .map((p) => ({ rel: rel(p), text: readFileSync(p, 'utf8') }));
  assert.deepEqual(unscrubbedNodeFiles(files, NODE_EXEMPT), []);
});

test('a node exemption whose file is gone, has no reason, or is not flagged by content fails the guard', () => {
  const flaggedNow = (p) => nodeUnscrubbed(readFileSync(join(ROOT, p), 'utf8'), p);
  assert.deepEqual(staleExempt(NODE_EXEMPT, (p) => existsSync(join(ROOT, p)), flaggedNow), []);
  assert.deepEqual(staleExempt(new Map([['test/gone.test.mjs', 'was a helper']]), () => false, () => true), ['test/gone.test.mjs']);
  assert.deepEqual(staleExempt(new Map([['test/x.mjs', '']]), () => true, () => true), ['test/x.mjs'], 'an entry with no reason');
  assert.deepEqual(staleExempt(new Map([['test/y.mjs', 'was a spawn']]), () => true, () => false), ['test/y.mjs'], 'an entry the content check does not flag');
});

test('the node exemption is by exact path, so a new file is flagged whatever its name', () => {
  const spawnsCli = "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'prune']);\n";
  const files = [
    { rel: 'test/mootr-renamed.test.mjs', text: spawnsCli },
    { rel: 'test/other/mootr-isolation.test.mjs', text: spawnsCli },
    { rel: 'test/mootr-isolation.test.mjs', text: spawnsCli },
  ];
  const exempt = new Map([['test/mootr-isolation.test.mjs', 'stands in for an exempt file']]);
  assert.deepEqual(unscrubbedNodeFiles(files, exempt), ['test/mootr-renamed.test.mjs', 'test/other/mootr-isolation.test.mjs']);
});

test('a shell test that sets a home or runs a daemon sources test/lib.sh', () => {
  const files = [...walk(join(ROOT, 'test'), (n) => n.endsWith('.sh')), ...walk(join(ROOT, 'web/check'), (n) => n.endsWith('.sh'))]
    .filter((f) => !f.endsWith('test/lib.sh'));
  assert.deepEqual(files.filter((f) => shUnscrubbed(readFileSync(f, 'utf8'))).map(rel), []);
});

test('a Go test package that runs node calls testenv.Scrub', () => {
  const dirs = new Map();
  for (const f of walk(join(ROOT, 'go'), (n) => n.endsWith('_test.go'))) {
    const d = dirname(f);
    dirs.set(d, [...(dirs.get(d) ?? []), readFileSync(f, 'utf8')]);
  }
  assert.deepEqual([...dirs].filter(([, files]) => goUnscrubbed(files)).map(([d]) => rel(d)), []);
});

test('the guard fails a test that skips the scrub', () => {
  const spawnsCli = "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'prune']);\n";
  assert.equal(nodeUnscrubbed(spawnsCli), true, 'a CLI spawn with no scrub');
  assert.equal(nodeUnscrubbed("process.env.STAM_HOME = mkdtempSync('x');\n"), true, 'a home with no scrub');
  assert.equal(nodeUnscrubbed("import './scrub-env.mjs';\n" + spawnsCli), false, 'scrub-env');
  assert.equal(nodeUnscrubbed("import { tempHome } from './tmphome.mjs';\n" + spawnsCli), false, 'tmphome');
  assert.equal(nodeUnscrubbed("spawnSync(process.execPath, [join(ROOT, 'scripts/sweep-test-homes.mjs')], { env: { ...process.env, STAM_HOME: h } });\n"), true, 'a scripts/ spawn with the parent env');
  assert.equal(nodeUnscrubbed("const SENTINEL = { MOOTR_HOME: '/x' };\nspawnSync(process.execPath, ['x.mjs']);\n"), true, 'naming MOOTR_ is not a scrub');
  assert.equal(nodeUnscrubbed("for (const k of ks) delete process.env[`MOOTR_${k}`];\nspawnSync(process.execPath, ['x.mjs']);\n"), true, 'a delete of MOOTR_ names is no scrub');
  assert.equal(nodeUnscrubbed('// spawnSync(cli.ts)\nconst x = 1;\n'), false, 'a comment is not a spawn');
  assert.equal(shUnscrubbed('stam daemon run &\n'), true);
  assert.equal(shUnscrubbed('# MOOTR_HOME\nstam daemon run &\n'), true, 'naming MOOTR_ is not a scrub');
  assert.equal(shUnscrubbed('. ./test/lib.sh\nstam daemon run &\n'), false);
  assert.equal(goUnscrubbed(['exec.Command("node", "x.mjs")']), true);
  assert.equal(goUnscrubbed(['exec.Command("node", "x.mjs")', 'func init() { testenv.Scrub() }']), false);
});

// Cases for the child-process and home rule (S-3449). MUST_FAIL: the guard flags each. MUST_PASS: it passes each. The base guard
// (eac6a508~1) passes each fixture that carries a withMootrTwins line, so those tell the two guards apart.
const CHILD_IMPORT = "import { spawnSync } from 'node:child_process';";
export const MUST_FAIL = [
  ['a child_process file without the helper, with a spread after its home keys', [
    CHILD_IMPORT,
    "const names = withMootrTwins(['STAM_HOME']);",
    "spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')], { env: { STAM_HOME: h, MOOTR_HOME: h, ...process.env } });",
  ].join('\n')],
  ['a child_process file without the helper, that spreads options after env', [
    CHILD_IMPORT,
    "const names = withMootrTwins(['STAM_HOME']);",
    "spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')], { env: { ...process.env, STAM_HOME: h, MOOTR_HOME: h }, ...{ env: process.env } });",
  ].join('\n')],
  ['a child_process file without the helper, with a duplicate env key', [
    CHILD_IMPORT,
    "const names = withMootrTwins(['STAM_HOME']);",
    "spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')], { env: { STAM_HOME: h, MOOTR_HOME: h }, env: process.env });",
  ].join('\n')],
  ['a child_process file without the helper, that renames spawnSync on import', [
    "import { spawnSync as sp } from 'node:child_process';",
    "const names = withMootrTwins(['STAM_HOME']);",
    "sp(process.execPath, [join(ROOT, 'src/cli.ts')], { env: { ...process.env, STAM_HOME: h, MOOTR_HOME: h } });",
  ].join('\n')],
  ['a child_process file without the helper, that imports the module as a namespace', [
    "import * as subprocess from 'node:child_process';",
    "const names = withMootrTwins(['STAM_HOME']);",
    "subprocess.spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')], { env: { ...process.env, STAM_HOME: h, MOOTR_HOME: h } });",
  ].join('\n')],
  ['a child_process default import called by a string key', [
    "import cp from 'node:child_process';",
    "const names = withMootrTwins(['STAM_HOME']);",
    "cp['spawnSync'](process.execPath, [join(ROOT, 'src/cli.ts')], { env: { ...process.env, STAM_HOME: h, MOOTR_HOME: h } });",
  ].join('\n')],
  ['a member-only spawn call with no child_process import', [
    "const names = withMootrTwins(['STAM_HOME']);",
    "runner.spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')]);",
  ].join('\n')],
  ['a basename-only scrub-env import from a different folder', [
    "import { SCRUBBED } from './other/scrub-env.mjs';",
    CHILD_IMPORT,
    "const names = withMootrTwins(['STAM_HOME']);",
    "spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')]);",
  ].join('\n')],
  ['the mail example, with no helper and no other call', [
    "spawnSync(process.execPath, ['src/cli.ts'], { env: { ...process.env, STAM_HOME: h, MOOTR_HOME: h } });",
    "spawnSync(process.execPath, ['src/cli.ts', 'prune']);",
  ].join('\n')],
  ['the mail example with a withMootrTwins line above it', [
    "const names = withMootrTwins(['STAM_HOME']);",
    "spawnSync(process.execPath, ['src/cli.ts'], { env: { ...process.env, STAM_HOME: h, MOOTR_HOME: h } });",
    "spawnSync(process.execPath, ['src/cli.ts', 'prune']);",
  ].join('\n')],
  ['a spawn whose env is passed through a variable, with no helper', [
    "const env = { ...process.env, STAM_HOME: h, MOOTR_HOME: h };",
    "spawnSync(process.execPath, ['src/cli.ts'], { env });",
  ].join('\n')],
  ['a spawn whose inline env lacks MOOTR_HOME, with no helper', [
    "spawnSync(process.execPath, ['src/cli.ts'], { env: { ...process.env, STAM_HOME: h } });",
  ].join('\n')],
  ['a home set by assignment, with the twin only after it, and no helper', [
    "const names = withMootrTwins(['STAM_HOME']);",
    "process.env.STAM_HOME = h;",
    "process.env.MOOTR_HOME = h;",
  ].join('\n')],
  ['a spawn followed by a dynamic import of the helper', [
    CHILD_IMPORT,
    "const names = withMootrTwins(['STAM_HOME']);",
    "spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')]);",
    "await import('./tmphome.mjs');",
  ].join('\n')],
  ['a dynamic import of the helper inside a function nobody calls', [
    CHILD_IMPORT,
    "const names = withMootrTwins(['STAM_HOME']);",
    "function later() { return import('./tmphome.mjs'); }",
    "spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')]);",
  ].join('\n')],
  ['a delete of MOOTR_ names, which is no longer a scrub', [
    CHILD_IMPORT,
    "const names = withMootrTwins(['STAM_HOME']);",
    "for (const k of ks) delete process.env[`MOOTR_${k}`];",
    "spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')]);",
  ].join('\n')],
  ['a file that does not parse, with a spawn and no scrub', [
    "const names = withMootrTwins(['STAM_HOME']);",
    "spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')] {",
  ].join('\n')],
];
export const MUST_PASS = [
  ['a static import of tmphome, with a spawn and no env', [
    "import { tempHome } from './tmphome.mjs';",
    CHILD_IMPORT,
    "spawnSync(process.execPath, [join(ROOT, 'src/cli.ts')]);",
  ].join('\n')],
  ['a file that uses no child process and sets no home', 'const x = 1;\n'],
];

test('a child_process or home file passes only with a static import of a real scrub helper (S-3449)', () => {
  for (const [why, text] of MUST_FAIL) assert.equal(nodeUnscrubbed(text), true, why);
  for (const [why, text] of MUST_PASS) assert.equal(nodeUnscrubbed(text), false, why);
  assert.equal(nodeUnscrubbed(MUST_PASS[0][1], 'test/sub/x.test.mjs'), true, 'a helper import resolves from the file folder, so ./tmphome.mjs is not test/sub/tmphome.mjs');
  assert.equal(nodeUnscrubbed("import './../scrub-env.mjs';\n" + CHILD_IMPORT + '\n', 'test/sub/x.test.mjs'), false, 'a helper reached from a subfolder');
});

test('scrub-env drops every live-reaching name in both spellings, and nothing else', () => {
  assert.deepEqual(withMootrTwins(['STAM_HOME']), ['STAM_HOME', 'MOOTR_HOME']);
  for (const n of ['HOME', 'PORT', 'URL', 'TOKEN', 'MACHINE']) {
    assert.ok(SCRUBBED.includes(`STAM_${n}`) && SCRUBBED.includes(`MOOTR_${n}`), `${n} is scrubbed under both names`);
  }
  assert.ok(!SCRUBBED.includes('STAM_EMBEDDER'));
});

test('a node child that imports scrub-env sees none of the names, and no value reaches the output', () => {
  const out = execChild();
  assert.equal(out, 'HOME=- PORT=- URL=- TOKEN=- MACHINE=- | E=kept');
  assert.ok(!out.includes('live-secret'));
});
import { execFileSync } from 'node:child_process';
function execChild() {
  const env = { PATH: process.env.PATH };
  for (const k of SCRUBBED) env[k] = 'live-secret';
  env.STAM_EMBEDDER = 'kept';
  return execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `await import(${JSON.stringify(join(ROOT, 'test/scrub-env.mjs'))});` +
    "const g = (n) => (process.env['STAM_' + n] ?? process.env['MOOTR_' + n] ?? '-');" +
    "console.log(['HOME','PORT','URL','TOKEN','MACHINE'].map((n) => n + '=' + g(n)).join(' ') + ' | E=' + process.env.STAM_EMBEDDER);"],
  { env, encoding: 'utf8' }).trim();
}
