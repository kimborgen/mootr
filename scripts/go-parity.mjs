#!/usr/bin/env node
// Records how far the Go daemon passes the FREE tests (S-2253, S-2194): runs each named test with
// STAM_DAEMON=go (test/lib.sh) and rewrites docs/migration/parity.json. It runs on storage only, like every
// Go build; refused elsewhere.
//
//   node scripts/go-parity.mjs [--init] [--file PATH] [NAME...]
//
// With no NAME it runs every FREE test from test/run.sh. --init writes no results: every FREE test is added as
// `fail` in module `unassigned` (the baseline). A test already in the file keeps its module; a name the file
// lacks is added; a test not run keeps its last status. go_sha and ts_sha are the last commits that touched
// go/ and src/. STAM_GO_PARITY_ANYHOST=1 lifts the storage-only rule (the unit test sets it).
//
// Each test is tagged `kind` (`node`: a `node --test` file that runs in-process; `e2e`: a shell script) and `daemon`
// (true when an e2e script starts a daemon, so it can exercise the Go one). Only the daemon e2e tests say anything
// about Go, so the headline counts those (`daemonCounts`); the rest are `n/a`. A test whose output has a line
// starting `SKIP` counts as skip, not pass. A failure that looks like a full disk or quota is run once more.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar } from '../src/env.ts';
import { isMain } from './main-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PARITY_FILE = join(ROOT, 'docs/migration/parity.json');

// The FREE list: the names between `FREE="` and the next `"` in test/run.sh text.
export function freeTests(runSh) {
  const m = /^FREE="\n([^"]*)"/m.exec(runSh);
  if (!m) throw new Error('go-parity: no FREE list in test/run.sh');
  return m[1].split(/\s+/).filter(Boolean);
}

// The command test/run.sh runs for a test: its line in the command table, else test/e2e-NAME.sh.
export function commandOf(runSh, name) {
  const head = `    ${name}) echo "`;
  for (const line of runSh.split('\n')) {
    if (line.startsWith(head) && line.endsWith('" ;;')) return line.slice(head.length, -4);
  }
  return `sh test/e2e-${name}.sh`;
}

// What a test is, from its command and (for a shell script) its text: `kind` node or e2e, and `daemon`, whether the
// script starts a daemon (daemon_up, isolate, or `daemon start` on a line that is not a comment).
export function classify(runSh, name, readScript) {
  const cmd = commandOf(runSh, name);
  if (/^node\b/.test(cmd)) return { kind: 'node', daemon: false };
  const file = /\btest\/[\w.-]+\.sh\b/.exec(cmd)?.[0];
  let text = '';
  try { text = file ? readScript(file) : ''; } catch { /* a missing script is not a daemon test */ }
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return { kind: 'e2e', daemon: /\b(daemon_up|isolate)\b|\bdaemon start\b/.test(code) };
}

// The headline: how many of the tests that start a daemon pass, and how many tests are n/a (start none). `tests` is
// {NAME: {status, daemon}}.
export function daemonCounts(tests) {
  const all = Object.values(tests ?? {});
  const daemon = all.filter((t) => t.daemon);
  return { pass: daemon.filter((t) => t.status === 'pass').length, total: daemon.length, skip: daemon.filter((t) => t.status === 'skip').length, na: all.length - daemon.length };
}

// The kept log of a failed test: run.sh names its log folder in its output ("logs kept for the failing tests: DIR", else
// "logs in DIR") and keeps DIR/NAME.log for a failure. '' when there is none; the reason a test failed (a full disk)
// is in that log, not in run.sh's own output.
export function keptLog(output, name) {
  const dir = /logs kept for the failing tests: (\S+)/.exec(output)?.[1] ?? /logs in (\S+)\)/.exec(output)?.[1];
  if (!dir) return '';
  try { return readFileSync(join(dir, `${name}.log`), 'utf8'); } catch { return ''; }
}

// True when a failed run's output looks like a full disk or quota, a failure of the machine, not of the test.
export function looksLikeQuota(output) {
  return /\b(ENOSPC|EDQUOT)\b|No space left on device|Disk quota exceeded/i.test(output);
}

// Status of one test from its run.sh exit code and output: a skipped test passes run.sh but proves nothing.
export function statusOf(name, code, output) {
  if (new RegExp(`^${name}\\s+SKIP\\b`, 'm').test(output)) return 'skip';
  return code === 0 ? 'pass' : 'fail';
}

// Merges results ({NAME: status}) into a parity document, adding every name in `names` that it lacks and
// dropping a name `names` doesn't have (a FREE test that was renamed or removed).
export function mergeParity(doc, names, results, meta, classes = {}) {
  const tests = Object.fromEntries(Object.entries(doc?.tests ?? {}).filter(([n]) => names.includes(n)));
  for (const n of names) tests[n] ??= { module: 'unassigned', status: 'fail' };
  for (const [n, status] of Object.entries(results)) tests[n] = { ...tests[n], module: tests[n]?.module ?? 'unassigned', status };
  // kind and daemon follow the sources, so every run rewrites them for the tests it knows.
  for (const [n, c] of Object.entries(classes)) if (tests[n]) tests[n] = { module: tests[n].module, status: tests[n].status, kind: c.kind, daemon: c.daemon };
  const sorted = Object.fromEntries(Object.entries(tests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { go_sha: meta.go_sha, ts_sha: meta.ts_sha, run_at: meta.run_at, tests: sorted };
}

// The tests of a parity document with a FREE test it lacks counted as not yet run: `fail`, module `unassigned`.
export function withMissing(doc, free) {
  const tests = { ...(doc?.tests ?? {}) };
  for (const n of free) tests[n] ??= { module: 'unassigned', status: 'fail' };
  return tests;
}

// The names in a parity document that are not FREE tests (renamed or removed): warned about, and mergeParity drops them.
export function staleTests(doc, free) {
  return Object.keys(doc?.tests ?? {}).filter((n) => !free.includes(n));
}

// What is wrong with a parity.json text: a bad status or module, a duplicate, unsorted keys. A FREE test the file
// lacks is not a problem: it counts as not yet run (withMissing); a stale name is a warning (staleTests).
export function parityProblems(raw, free) {
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return [`parity.json does not parse: ${e.message}`]; }
  const problems = [];
  const written = [...raw.matchAll(/^    "([^"]+)": \{/gm)].map((m) => m[1]);
  for (const n of new Set(written.filter((n, i) => written.indexOf(n) !== i))) problems.push(`${n} is listed twice`);
  const keys = Object.keys(doc.tests ?? {});
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) problems.push('tests are not sorted by name');
  for (const [n, t] of Object.entries(doc.tests ?? {})) {
    if (!['pass', 'fail', 'skip'].includes(t.status) || typeof t.module !== 'string') problems.push(`${n} has a bad status or module`);
    if (('kind' in t || 'daemon' in t) && (!['node', 'e2e'].includes(t.kind) || typeof t.daemon !== 'boolean')) problems.push(`${n} has a bad kind or daemon`);
  }
  return problems;
}

function lastSha(path) {
  const r = spawnSync('git', ['log', '-1', '--format=%H', '--', path], { cwd: ROOT, encoding: 'utf8' });
  return r.stdout.trim() || null;
}

function main(argv) {
  let file = PARITY_FILE;
  let init = false;
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--init') init = true;
    else if (argv[i] === '--file') file = argv[++i];
    else names.push(argv[i].replace(/^test\//, '').replace(/^e2e-/, '').replace(/\.sh$/, '').replace(/\.test\.mjs$/, ''));
  }
  const all = freeTests(readFileSync(join(ROOT, 'test/run.sh'), 'utf8'));
  for (const n of names) if (!all.includes(n)) { console.error(`go-parity: ${n} is not a FREE test`); process.exit(2); }
  if (!init && !envVar('GO_PARITY_ANYHOST') && hostname() !== 'storage') {
    console.error(`go-parity: runs on storage only (this is ${hostname()}); Go never runs on the ITSA home`);
    process.exit(2);
  }
  let doc = null;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first write */ }
  const toRun = init ? [] : names.length ? names : all;
  const results = {};
  const run = (n) => {
    const r = spawnSync('sh', ['test/run.sh', n], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...{ STAM_DAEMON: 'go' } }, maxBuffer: 1 << 26 });
    return { code: r.status, output: `${r.stdout}${r.stderr}` };
  };
  for (const n of toRun) {
    let r = run(n);
    if (r.code !== 0 && looksLikeQuota(`${r.output}\n${keptLog(r.output, n)}`)) { console.log(`retry ${n}: the failure looks like a full disk`); r = run(n); }
    results[n] = statusOf(n, r.code, r.output);
    console.log(`${results[n].padEnd(5)} ${n}`);
  }
  for (const n of staleTests(doc, all)) console.log(`warn: ${n} is in ${file} but not in the FREE list; this run drops it`);
  const runSh = readFileSync(join(ROOT, 'test/run.sh'), 'utf8');
  const classes = Object.fromEntries(all.map((n) => [n, classify(runSh, n, (f) => readFileSync(join(ROOT, f), 'utf8'))]));
  const out = mergeParity(doc, all, results, { go_sha: lastSha('go'), ts_sha: lastSha('src'), run_at: new Date().toISOString() }, classes);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  const c = daemonCounts(out.tests);
  console.log(`parity: ${c.pass} of ${c.total} daemon e2e tests pass${c.skip ? `, ${c.skip} skipped` : ''}, ${c.na} n/a (${file})`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
