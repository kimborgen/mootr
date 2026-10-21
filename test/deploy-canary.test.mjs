#!/usr/bin/env node
// The pre-deploy canary (S-1749, scripts/canary.mjs), on synthetic dbs only, never the live one.
// With fake releases (a small HTTP server standing in for `daemon run`): a release that stalls on every activity change
// fails against a clean baseline, the same release passes, a baseline that won't start or a missing db is an error, a
// SIGTERM stops the daemons and removes the run folder, and a run killed outright is swept by the next. With the real
// daemon of this checkout as both releases: the canary never reaches the live port, the live tmux socket, tmux, or a
// harness, runs at nice 10 above the test's own, and leaves no backup or copy behind.
// Run with `node --test test/deploy-canary.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { getPriority, tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CANARY = join(ROOT, 'scripts/canary.mjs');
const { canary, canaryConfig, canaryWorst, copyDb, judge, sweepStale } = await import(CANARY);

// `nice -n 10` is relative: under a niced gate (S-2107) the scratch daemon lands at the gate's niceness plus 10, at most 19.
const NICE = Math.min(19, getPriority() + 10);

const work = tempDir('stam-canary-test-');
after(() => rmSync(work, { recursive: true, force: true }));

// A fake release: `src/cli.ts` answers the health routes with the token it writes, and the hook and statusline POSTs.
// In mode `stall` each POST blocks the loop 200 ms and reports it as a stall, as aa181742's children waits did (S-1725).
// In mode `dead` it exits at once; `reject` answers every POST 500, `partial` every other one; `slowstart` blocks the
// loop 500 ms three times, reported as stalls, before it writes its token, and never after; `flaky` stalls on its first
// run only. A release with an `overload` file (S-2076) shares a counter of /api/health/db requests with every release
// that names the same counter, and answers requests FROM to TO of that shared count 300 ms late, without blocking its
// loop: a burst of machine load that lands on whichever daemons are being probed then. `drift` is good on its first run
// and stalls like 'stall' on every run after (the load rose after the first baseline); `fade` is good on its first run
// and exits at once on every run after (S-2151).
const FAKE_DAEMON = `import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let mode = readFileSync(join(import.meta.dirname, '..', 'mode'), 'utf8').trim();
// flaky: stalls like 'stall' on its first run, then runs clean (S-1862).
if (mode === 'flaky') {
  const ran = join(import.meta.dirname, '..', 'ran');
  try { readFileSync(ran); mode = 'good'; } catch { writeFileSync(ran, '1'); mode = 'stall'; }
}
// drift and fade count their runs in a file beside the release (S-2151).
if (mode === 'drift' || mode === 'fade') {
  const runs = join(import.meta.dirname, '..', 'runs');
  let count = 0;
  try { count = Number(readFileSync(runs, 'utf8')); } catch {}
  writeFileSync(runs, String(count + 1));
  mode = count === 0 ? 'good' : mode === 'drift' ? 'stall' : 'dead';
}
if (mode === 'dead') process.exit(1);
let overload;
try { overload = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'overload'), 'utf8')); } catch {}
const overloaded = () => {
  if (!overload) return false;
  let n = 0;
  try { n = Number(readFileSync(overload.counter, 'utf8')) || 0; } catch {}
  writeFileSync(overload.counter, String(++n));
  return n >= overload.from && n <= overload.to;
};
const stalls = [];
let n = 0;
if (mode === 'slowstart') {
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    while (Date.now() - t < 500);
    stalls.push({ at: new Date().toISOString(), ms: 500, label: 'unlabelled #' + n++ });
  }
}
writeFileSync(join(process.env.STAM_HOME, 'token'), 'tok\\n');
let posts = 0;
createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer tok') return send(401, {});
    if (req.url === '/api/health') return send(200, { ok: true, release: process.env.STAM_RELEASE_ID, stalls: stalls.slice(-20) });
    if (req.url === '/api/health/db') return overloaded() ? setTimeout(() => send(200, { ok: true }), 300) : send(200, { ok: true });
    if (req.method === 'POST' && /^\\/api\\/(hook|statusline)\\/claude\\//.test(req.url)) {
      posts++;
      if (mode === 'reject' || (mode === 'partial' && posts % 2 === 0)) return send(500, { error: 'broken' });
      if (mode === 'stall') {
        const t = Date.now();
        while (Date.now() - t < 200);
        stalls.push({ at: new Date().toISOString(), ms: 200, label: 'activity change: children waits #' + n++ });
      }
      return send(200, {});
    }
    send(404, {});
  });
}).listen(Number(process.env.STAM_PORT), '127.0.0.1');
`;

function fakeRelease(name, mode, overload) {
  const dir = join(work, 'releases-src', name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'cli.ts'), FAKE_DAEMON);
  writeFileSync(join(dir, 'mode'), `${mode}\n`);
  if (overload) writeFileSync(join(dir, 'overload'), JSON.stringify(overload));
  return dir;
}

// A live home with a synthetic db of `agents` Claude Code agents (only what the canary reads), and the canary's config:
// the baseline and the build's release given, short load, no slow rule (the machine's load mustn't decide).
function setup(name, { baseline, next, agents = 4, db = true, env = {} } = {}) {
  const dir = join(work, name);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  if (db) {
    const d = new DatabaseSync(join(home, 'stam.db'));
    d.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, harness TEXT)');
    for (let i = 0; i < agents; i++) d.prepare("INSERT INTO agents VALUES (?, 'claude')").run(`A${i}`);
    d.close();
  }
  const c = canaryConfig({
    STAM_HOME: home,
    STAM_CANARY_TMP: join(dir, 'tmp'),
    STAM_CANARY_MACHINE: 'canary-test',
    STAM_CANARY_BASELINE: baseline,
    STAM_CANARY_BUILD_CMD: `echo ${next}`,
    STAM_DEPLOY_REPO: ROOT,
    STAM_CANARY_START_S: '20',
    STAM_CANARY_LOAD_S: '3',
    STAM_CANARY_SAMPLE_MS: '300',
    STAM_DEPLOY_SLOW_S: '5',
    ...env,
  });
  return { dir, home, c };
}

const empty = (dir) => !existsSync(dir) || readdirSync(dir).length === 0;
const quiet = () => {};

test('a release that stalls on every activity change fails against a clean baseline, with its numbers', async () => {
  const { c } = setup('stall', { baseline: fakeRelease('good-a', 'good'), next: fakeRelease('stall-a', 'stall') });
  const r = await canary(c, 'abcdef1234', quiet);
  assert.equal(r.verdict, 'fail', JSON.stringify(r.reasons));
  assert.match(r.reasons.join('\n'), /event-loop stalls under load added up to \d+ ms \(baseline 0 ms, limit 1000 ms\)/);
  assert.ok(r.next.stalls.count >= 5, `stalls counted: ${r.next.stalls.count}`);
  assert.ok(r.base.load.ok > 0 && r.next.load.ok > 0, 'the load reached both daemons');
  assert.equal(r.next.name, 'rerun', 'a regression is rerun before it fails (S-1862)');
  assert.match(r.reasons.join('\n'), /the first run failed too: event-loop stalls/);
  assert.ok(empty(c.tmp), 'the backup and the copies are gone');
});

test('a release that fails once and runs clean on its rerun passes; with the rerun off it fails (S-1862)', async () => {
  const good = fakeRelease('good-flaky', 'good');
  const { c } = setup('flaky', { baseline: good, next: fakeRelease('flaky-a', 'flaky') });
  const lines = [];
  const r = await canary(c, 'abcdef1234', (l) => lines.push(l));
  assert.equal(r.verdict, 'pass', JSON.stringify(r.reasons));
  assert.match(r.first.join('\n'), /event-loop stalls under load/);
  assert.ok(lines.some((l) => /the new release failed .*running it and the baseline once more/.test(l)));
  assert.equal(r.base.name, 'baseline-rerun', 'the rerun is judged against the baseline rerun beside it (S-2076)');
  const off = setup('flaky-off', { baseline: good, next: fakeRelease('flaky-b', 'flaky'), env: { STAM_CANARY_RERUN: '0' } });
  const r2 = await canary(off.c, 'abcdef1234', quiet);
  assert.equal(r2.verdict, 'fail');
  assert.equal(r2.next.name, 'new');
});

test('a release slow when the load rose after the first baseline passes its rerun, judged against a fresh baseline (S-2151)', async () => {
  const { c } = setup('drift', { baseline: fakeRelease('drift-base', 'drift'), next: fakeRelease('drift-a', 'stall') });
  const lines = [];
  const r = await canary(c, 'abcdef1234', (l) => lines.push(l));
  assert.equal(r.verdict, 'pass', JSON.stringify(r.reasons));
  assert.match(r.first.join('\n'), /event-loop stalls under load/, 'the first run was slow');
  assert.equal(r.base.name, 'baseline-rerun', 'the verdict is judged against the fresh baseline');
  assert.equal(r.next.name, 'rerun');
  assert.ok(lines.some((l) => /the rerun is judged against the fresh baseline .*, not the first one/.test(l)));
  assert.ok(empty(c.tmp), 'the copies are gone');
});

test('a release slow against both the first and the fresh baseline fails, judged against the fresh one (S-2151)', async () => {
  const { c } = setup('slow-both', { baseline: fakeRelease('good-e', 'good'), next: fakeRelease('stall-e', 'stall') });
  const r = await canary(c, 'abcdef1234', quiet);
  assert.equal(r.verdict, 'fail', JSON.stringify(r.reasons));
  assert.equal(r.base.name, 'baseline-rerun');
  assert.ok(r.base.load.ok > 0, 'the fresh baseline took the load');
  assert.match(r.reasons.join('\n'), /event-loop stalls under load added up to \d+ ms \(baseline 0 ms/);
  assert.match(r.reasons.join('\n'), /the first run failed too: event-loop stalls/);
});

test('a fresh baseline that never answers is an error, never a pass (S-2151)', async () => {
  const { c } = setup('fresh-dead', { baseline: fakeRelease('fade-base', 'fade'), next: fakeRelease('fade-a', 'stall') });
  const r = await canary(c, 'abcdef1234', quiet);
  assert.equal(r.verdict, 'error', JSON.stringify(r.reasons));
  assert.match(r.reasons[0], /the fresh baseline .* never answered \/api\/health/);
  assert.equal(r.next.name, 'rerun', 'the rerun is kept as next, with the first run\'s reasons in first');
  assert.match(r.first.join('\n'), /event-loop stalls under load/);
  assert.ok(empty(c.tmp));
});

// 66cf0a33 (#677, S-2076): the baseline ran first and the new release later, while the machine was overloaded, and the
// canary held a web-only change on "8 of 29 health probes over 0.1 s (baseline 0)". Side by side and probed in turn,
// both daemons take the same burst, so it can't fail the new one.
test('66cf0a33: a burst of machine load mid-canary lands on the baseline and the new release alike, and passes (S-2076)', async () => {
  const overload = { counter: join(work, 'overload-66cf-count'), from: 5, to: 10 };
  const { c } = setup('overload-66cf', {
    baseline: fakeRelease('good-66cf', 'good', overload),
    next: fakeRelease('new-66cf', 'good', overload),
    env: { STAM_DEPLOY_SLOW_S: '0.2', STAM_CANARY_LOAD_S: '4' },
  });
  const r = await canary(c, 'abcdef1234', quiet);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.reasons));
  assert.equal(r.first, undefined, 'no rerun was needed');
  assert.equal(r.base.db.slow, 3, `baseline: ${JSON.stringify(r.base.db)}`);
  assert.equal(r.next.db.slow, 3, `new: ${JSON.stringify(r.next.db)}`);
  assert.ok(empty(c.tmp));
});

// One release's numbers as judge reads them: probes of n samples, stalls under load, and the load.
const run = ({ n = 30, healthSlow = 0, dbSlow = 0, failed = 0, stallMs = 0, loadOk = 500, loadFailed = 0, started = true } = {}) => ({
  started,
  health: { n, failed, slow: healthSlow, maxS: 0 },
  db: { n, failed: 0, slow: dbSlow, maxS: 0 },
  stalls: { count: 0, totalMs: stallMs, maxMs: 0, labels: {} },
  load: { ok: loadOk, failed: loadFailed },
});

test("the 0a53045a hold: 3 of 30 db probes slow against 0, with fewer stalls than the baseline, isn't a regression (S-1862)", () => {
  const c = canaryConfig({});
  // The baseline had 11 stalls and 3 slow health probes; the new release 6 stalls, 0 slow health and 3 slow db probes.
  const base = run({ healthSlow: 3, dbSlow: 0, stallMs: 11 * 300 });
  const next = run({ healthSlow: 0, dbSlow: 3, stallMs: 6 * 400 });
  assert.deepEqual(judge(c, base, next), []);
  // The old rule (a flat margin of 2) held it.
  assert.match(judge({ ...c, slowFraction: 0 }, base, next).join(), /3 of 30 db probes over 0.1 s \(baseline 0\)/);
});

test('real regressions still fail the judge: rebuild stalls, a slow release, all load failing, no start (S-1862)', () => {
  const c = canaryConfig({});
  const base = run({ stallMs: 400 });
  // S-1725: a 674 ms rebuild on every activity change.
  assert.match(judge(c, base, run({ stallMs: 674 * 40 })).join(), /event-loop stalls under load added up to 26960 ms/);
  assert.match(judge(c, run(), run({ dbSlow: 10 })).join(), /10 of 30 db probes over 0.1 s/);
  assert.match(judge(c, run(), run({ healthSlow: 30 })).join(), /30 of 30 health probes/);
  assert.match(judge(c, run(), run({ loadOk: 0, loadFailed: 400 })).join(), /load requests failed/);
  assert.match(judge(c, run(), run({ started: false })).join(), /never answered/);
  assert.match(judge(c, run(), run({ failed: 1 })).join(), /1 of 30 health probes failed/);
  // The margin is env-overridable, absolute and relative.
  assert.match(judge(canaryConfig({ STAM_CANARY_SLOW_FRACTION: '0', STAM_CANARY_SLOW_MARGIN: '0' }), run(), run({ dbSlow: 1 })).join(), /1 of 30 db probes/);
  assert.deepEqual(judge(canaryConfig({ STAM_CANARY_STALL_FACTOR: '100' }), base, run({ stallMs: 674 * 40 })), []);
});

// The bound against the watcher's canary timeout lives in deploy-watch-unit, next to the watcher it reads (S-1862).
test("the canary's worst case counts the rerun (S-1862)", () => {
  const c = canaryConfig({});
  const once = canaryWorst({ ...c, rerun: false });
  assert.equal(canaryWorst(c) - once, c.startMs + c.loadMs + 15_000 + 7 * 5000);
});

test('the same release against itself passes, and leaves nothing behind', async () => {
  const good = fakeRelease('good-b', 'good');
  const { c } = setup('pass', { baseline: good, next: good });
  const r = await canary(c, 'abcdef1234', quiet);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.reasons));
  assert.equal(r.next.stalls.count, 0);
  assert.equal(r.next.nice, NICE, `the scratch daemon runs at nice ${NICE}`);
  assert.ok(empty(c.tmp));
});

test('the result names the release the build made, and whether it created or reused it (S-1750)', async () => {
  const good = fakeRelease('good-built', 'good');
  const made = setup('built-created', { baseline: good, next: good, env: { STAM_CANARY_BUILD_CMD: `echo "build-only: created good-built"; echo ${good}` } });
  assert.deepEqual((await canary(made.c, 'abcdef1234', quiet)).built, { release: 'good-built', created: true });
  const reused = setup('built-reused', { baseline: good, next: good, env: { STAM_CANARY_BUILD_CMD: `echo "build-only: reused good-built"; echo ${good}` } });
  assert.deepEqual((await canary(reused.c, 'abcdef1234', quiet)).built, { release: 'good-built', created: false });
});

test("a new release that never answers fails; a baseline that never answers is an error, never a pass", async () => {
  const good = fakeRelease('good-c', 'good');
  const dead = fakeRelease('dead-c', 'dead');
  const one = setup('new-dead', { baseline: good, next: dead });
  const r1 = await canary(one.c, 'abcdef1234', quiet);
  assert.equal(r1.verdict, 'fail');
  assert.match(r1.reasons[0], /never answered \/api\/health/);
  assert.ok(empty(one.c.tmp));
  const two = setup('base-dead', { baseline: dead, next: good });
  const r2 = await canary(two.c, 'abcdef1234', quiet);
  assert.equal(r2.verdict, 'error');
  assert.match(r2.reasons[0], /baseline .* never answered/);
  assert.ok(empty(two.c.tmp));
});

test('no db, a failed build, or no baseline is an error, and the run folder still goes', async () => {
  const good = fakeRelease('good-d', 'good');
  const nodb = setup('no-db', { baseline: good, next: good, db: false });
  const r1 = await canary(nodb.c, 'abcdef1234', quiet);
  assert.equal(r1.verdict, 'error');
  assert.match(r1.reasons[0], /the db copy failed: no database/);
  assert.ok(empty(nodb.c.tmp));
  const nobuild = setup('no-build', { baseline: good, next: good, env: { STAM_CANARY_BUILD_CMD: 'echo "npm ci failed" >&2; exit 4' } });
  const r2 = await canary(nobuild.c, 'abcdef1234', quiet);
  assert.equal(r2.verdict, 'error');
  assert.match(r2.reasons[0], /building abcdef1234 exited 4: npm ci failed/);
  const nobase = setup('no-base', { next: good });
  const r3 = await canary(nobase.c, 'abcdef1234', quiet);
  assert.equal(r3.verdict, 'error');
  assert.match(r3.reasons[0], /no .*releases\/current to compare with/);
});

test('the db copy finishes while another connection keeps writing, and strips push devices and the peer outbox', async () => {
  const s = setup('busy-copy', { db: false });
  const file = join(s.home, 'stam.db');
  const d = new DatabaseSync(file);
  d.exec("PRAGMA journal_mode = WAL; CREATE TABLE agents (id TEXT PRIMARY KEY, harness TEXT); CREATE TABLE push_devices (id TEXT); CREATE TABLE peer_outbox (id TEXT); CREATE TABLE peer_agents (id TEXT); CREATE TABLE filler (b BLOB)");
  for (let i = 0; i < 30; i++) d.prepare("INSERT INTO agents VALUES (?, 'claude')").run(`B${i}`);
  d.exec("INSERT INTO push_devices VALUES ('phone'); INSERT INTO peer_outbox VALUES ('to-storage'); INSERT INTO peer_agents VALUES ('P1')");
  // Enough pages that the copy takes a while, so the writes below land during it.
  const fill = d.prepare('INSERT INTO filler VALUES (randomblob(4096))');
  d.exec('BEGIN');
  for (let i = 0; i < 20_000; i++) fill.run();
  d.exec('COMMIT');
  // A writer that never pauses, as the live daemon: one commit every millisecond while the copy runs.
  let writes = 0;
  const write = d.prepare('INSERT INTO filler VALUES (randomblob(64))');
  const writer = setInterval(() => {
    write.run();
    writes++;
  }, 1);
  mkdirSync(s.c.tmp, { recursive: true });
  const out = join(s.c.tmp, 'copy.db');
  let agents;
  try {
    agents = await copyDb({ ...s.c, backupMs: 60_000 }, out);
  } finally {
    clearInterval(writer);
    d.close();
  }
  assert.ok(writes > 0, 'the source was written during the copy');
  assert.equal(agents.length, s.c.agents);
  assert.equal(agents[0], 'B29', 'the newest agents first');
  const copy = new DatabaseSync(out, { readOnly: true });
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM push_devices').get().n, 0);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM peer_outbox').get().n, 0);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM peer_agents').get().n, 1, 'peer agents stay: the children counts read them (S-1725)');
  copy.close();
});

test('a db copy past its timeout fails, as an error', async () => {
  const good = fakeRelease('good-g', 'good');
  const s = setup('copy-timeout', { baseline: good, next: good, env: { STAM_CANARY_BACKUP_TIMEOUT_S: '0' } });
  const r = await canary(s.c, 'abcdef1234', quiet);
  assert.equal(r.verdict, 'error');
  assert.match(r.reasons[0], /the db copy failed: timed out/);
  assert.ok(empty(s.c.tmp));
});

test('a db with no agents to put load on is an error, never a pass', async () => {
  const good = fakeRelease('good-h', 'good');
  const none = setup('no-agents', { baseline: good, next: good, agents: 0 });
  const r1 = await canary(none.c, 'abcdef1234', quiet);
  assert.equal(r1.verdict, 'error');
  assert.match(r1.reasons[0], /no Claude Code agents/);
  const noTable = setup('no-agents-table', { baseline: good, next: good, db: false });
  const d = new DatabaseSync(join(noTable.home, 'stam.db'));
  d.exec('CREATE TABLE other (x)');
  d.close();
  const r2 = await canary(noTable.c, 'abcdef1234', quiet);
  assert.equal(r2.verdict, 'error');
  assert.match(r2.reasons[0], /the db copy failed: .*no such table: agents/);
});

test('a build past its timeout is killed with everything it started', async () => {
  const good = fakeRelease('good-i', 'good');
  const s = setup('build-timeout', { baseline: good, next: good });
  const pidFile = join(s.dir, 'grandchild.pid');
  const c = { ...s.c, build: `sleep 300 & echo $! > ${pidFile}; wait`, buildMs: 1000 };
  const r = await canary(c, 'abcdef1234', quiet);
  assert.equal(r.verdict, 'error');
  assert.match(r.reasons[0], /building abcdef1234 timed out/);
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  await until(() => {
    try {
      process.kill(grandchild, 0);
      return false;
    } catch {
      return true;
    }
  }, 10_000);
  assert.ok(empty(s.c.tmp));
});

test('an abort stops the run as an error and removes its folder', async () => {
  const good = fakeRelease('good-j', 'good');
  const s = setup('abort', { baseline: good, next: good, env: { STAM_CANARY_LOAD_S: '120' } });
  const ac = new AbortController();
  const lines = [];
  const pending = canary(s.c, 'abcdef1234', (l) => lines.push(l), ac.signal);
  await until(() => existsSync(s.c.tmp) && readdirSync(s.c.tmp).some((n) => existsSync(join(s.c.tmp, n, 'baseline', 'daemon.pid'))));
  ac.abort();
  const r = await pending;
  assert.equal(r.verdict, 'error');
  assert.deepEqual(r.reasons, ['canceled']);
  assert.ok(empty(s.c.tmp));
});

test('a release that takes none of the load fails, against a clean baseline and a partly failing one', async () => {
  const reject = fakeRelease('reject-k', 'reject');
  const clean = setup('reject-vs-clean', { baseline: fakeRelease('good-k', 'good'), next: reject });
  const r1 = await canary(clean.c, 'abcdef1234', quiet);
  assert.equal(r1.verdict, 'fail', JSON.stringify(r1.reasons));
  assert.equal(r1.next.load.ok, 0);
  assert.match(r1.reasons.join('\n'), /load requests failed/);
  const partial = setup('reject-vs-partial', { baseline: fakeRelease('partial-k', 'partial'), next: reject });
  const r2 = await canary(partial.c, 'abcdef1234', quiet);
  assert.equal(r2.verdict, 'fail', JSON.stringify(r2.reasons));
  assert.ok(r2.base.load.failed > 0 && r2.base.load.ok > 0, 'the baseline failed part of the load');
  assert.match(r2.reasons.join('\n'), /load requests failed/);
});

test('an abort before the run never starts the build', async () => {
  const good = fakeRelease('good-l', 'good');
  const s = setup('pre-abort', { baseline: good, next: good });
  const marker = join(s.dir, 'built');
  const r = await canary({ ...s.c, build: `touch ${marker}; echo ${good}` }, 'abcdef1234', quiet, AbortSignal.abort());
  assert.equal(r.verdict, 'error');
  assert.deepEqual(r.reasons, ['canceled']);
  assert.equal(existsSync(marker), false, 'the build never ran');
  assert.ok(empty(s.c.tmp));
});

test("stalls before the load are the daemon's startup: reported apart, and not judged", async () => {
  const slow = fakeRelease('slowstart-m', 'slowstart');
  const s = setup('startup-stalls', { baseline: fakeRelease('good-m', 'good'), next: slow });
  const r = await canary(s.c, 'abcdef1234', quiet);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.reasons));
  assert.equal(r.next.startup.count, 3);
  assert.equal(r.next.startup.totalMs, 1500);
  assert.equal(r.next.stalls.count, 0);
});

// A build killed mid-check (src/deploy.ts check()) leaves what setsid takes out of its group: the check daemon's tmux
// server, and its stam-check-* home. The build here starts both the way check() does, then hangs past its timeout.
test("a build killed mid-check takes its check daemon's tmux server and home with it", async () => {
  const good = fakeRelease('good-n', 'good');
  const s = setup('check-leftovers', { baseline: good, next: good });
  const checkHome = mkdtempSync(join(tmpdir(), 'stam-check-canarytest-'));
  const socket = `stam-check-canarytest-${process.pid}`;
  const build = `export STAM_HOME=${checkHome} STAM_TMUX_SOCKET=${socket}; tmux -L ${socket} new-session -d -s check 'sleep 300' && sleep 300`;
  try {
    const r = await canary({ ...s.c, build, buildMs: 3000 }, 'abcdef1234', quiet);
    assert.equal(r.verdict, 'error');
    assert.match(r.reasons[0], /timed out/);
    assert.notEqual(spawnSync('tmux', ['-L', socket, 'has-session'], { stdio: 'ignore' }).status, 0, 'the check tmux server is gone');
    assert.equal(existsSync(checkHome), false, 'the check home is gone');
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    rmSync(checkHome, { recursive: true, force: true });
  }
});

// The CLI's environment for a setup: what canaryConfig read, as env.
const cliEnv = (s, extra = {}) => ({
  ...process.env,
  STAM_HOME: s.home,
  STAM_CANARY_TMP: s.c.tmp,
  STAM_CANARY_MACHINE: s.c.machine,
  STAM_CANARY_BUILD_CMD: s.c.build,
  STAM_DEPLOY_REPO: ROOT,
  STAM_CANARY_START_S: '20',
  STAM_CANARY_SAMPLE_MS: '300',
  STAM_DEPLOY_SLOW_S: '5',
  ...(s.c.baseline ? { STAM_CANARY_BASELINE: s.c.baseline } : {}),
  ...extra,
});

// Waits (on state) until `check` is true, polling every 50 ms, up to `ms`.
async function until(check, ms = 30_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a SIGTERM mid-run stops the daemon and removes the backup and the copy', async () => {
  const good = fakeRelease('good-e', 'good');
  const s = setup('sigterm', { baseline: good, next: good });
  const child = spawn(process.execPath, ['--no-warnings', CANARY, 'abcdef1234'], { env: cliEnv(s, { STAM_CANARY_LOAD_S: '120' }), stdio: 'ignore' });
  const runOf = () => (existsSync(s.c.tmp) ? readdirSync(s.c.tmp).find((n) => n.startsWith(`run-${child.pid}-`)) : undefined);
  const pidFile = () => join(s.c.tmp, runOf() ?? 'none', 'baseline', 'daemon.pid');
  await until(() => runOf() && existsSync(pidFile()) && existsSync(join(s.c.tmp, runOf(), 'copy.db')));
  const daemon = Number(readFileSync(pidFile(), 'utf8'));
  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.ok(empty(s.c.tmp), 'the run folder, backup included, is gone');
  await until(() => {
    try {
      process.kill(daemon, 0);
      return false;
    } catch {
      return true;
    }
  }, 10_000);
});

test("a run killed outright is swept by the next: its daemon stopped by pid and cwd, its folder removed", async () => {
  const s = setup('sweep', {});
  // A pid that is gone: a finished child's.
  const dead = spawnSync('true').pid;
  const home = join(s.c.tmp, `run-${dead}-abc123`, 'new');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(s.c.tmp, `run-${dead}-abc123`, 'copy.db'), 'x');
  const left = spawn('sleep', ['300'], { cwd: home, detached: true, stdio: 'ignore' });
  writeFileSync(join(home, 'daemon.pid'), String(left.pid));
  // A run folder whose canary is alive (this test) is left alone.
  mkdirSync(join(s.c.tmp, `run-${process.pid}-def456`), { recursive: true });
  const gone = new Promise((done) => left.on('exit', done));
  sweepStale(s.c);
  await gone;
  assert.deepEqual(readdirSync(s.c.tmp), [`run-${process.pid}-def456`]);
});

// The real daemon of this checkout as both releases, on a db the real schema made, with the live home's sentinels:
// the live port answers nothing but counts, the live tmux socket has a name no call may use, and a tmux and harness
// first on the canary's own PATH record any call that gets past the canary's stubs.
test('with the real daemon: no live port, live socket, tmux, or harness is touched, and nothing is left behind', async () => {
  const s = setup('isolation', { baseline: ROOT, next: ROOT, db: false });
  const made = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    const db = await import(${JSON.stringify(join(ROOT, 'src/db.ts'))});
    let parent = null;
    for (let i = 0; i < 12; i++) {
      const id = 'C' + i;
      db.createAgent({ id, name: 'c' + i, role: 'r', machine: 'canary-test', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
      parent = id;
    }
    db.open().close();
  `], { env: { ...process.env, STAM_HOME: s.home, STAM_EMBEDDER: 'stub', STAM_TMUX_SOCKET: `canary-schema-${process.pid}` }, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  mkdirSync(join(s.home, 'releases'));
  symlinkSync(ROOT, join(s.home, 'releases', 'current'));
  const hash = () => createHash('sha256').update(readFileSync(join(s.home, 'stam.db'))).digest('hex');
  const before = { files: readdirSync(s.home).sort(), db: hash() };

  let liveHits = 0;
  const live = createServer((req, res) => {
    liveHits++;
    res.end();
  });
  await new Promise((r) => live.listen(0, '127.0.0.1', r));
  const recorder = join(s.dir, 'recorder');
  const recorded = join(s.dir, 'recorded.log');
  mkdirSync(recorder);
  for (const name of ['tmux', 'claude', 'codex', 'opencode']) {
    writeFileSync(join(recorder, name), `#!/bin/sh\necho "${name} $*" >> '${recorded}'\nexit 1\n`);
    chmodSync(join(recorder, name), 0o755);
  }
  const socket = `canary-live-sentinel-${process.pid}`;
  const env = cliEnv(s, {
    STAM_CANARY_BASELINE: join(s.home, 'releases', 'current'),
    STAM_CANARY_LOAD_S: '4',
    STAM_CANARY_START_S: '90',
    STAM_CANARY_STALL_MARGIN_MS: '1000000',
    STAM_PORT: String(live.address().port),
    STAM_TMUX_SOCKET: socket,
    PATH: `${recorder}:${process.env.PATH}`,
  });
  const child = spawn(process.execPath, ['--no-warnings', CANARY, 'abcdef1234'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((done) => child.on('exit', done));
  live.close();
  assert.equal(code, 0, out);
  const lines = out.split('\n').filter((l) => /^canary: (baseline|new) /.test(l));
  assert.equal(lines.length, 2, out);
  for (const line of lines) {
    assert.match(line, new RegExp(`at nice ${NICE} `));
    const ok = Number(/load (\d+) ok/.exec(line)?.[1]);
    assert.ok(ok > 0, `the load reached the daemon: ${line}`);
    const stubs = /stub calls: (.*)$/.exec(line)?.[1] ?? '';
    // The codex adapter starts its app-server when the daemon starts, which its stub answers (as deploy's own check
    // answers it with /bin/false). No agent's harness starts: no claude or opencode call, and none past the stubs (below).
    assert.doesNotMatch(stubs, /claude|opencode/, `no agent's harness was started: ${line}`);
    assert.match(stubs, /tmux \d+/, 'tmux calls hit the stub');
  }
  assert.equal(liveHits, 0, 'nothing reached the live port');
  assert.equal(existsSync(recorded) ? readFileSync(recorded, 'utf8') : '', '', 'no tmux or harness past the stubs ran');
  assert.doesNotMatch(out, new RegExp(socket), 'the live socket is never named');
  // The backup's read-only connection leaves SQLite's WAL sidecars, which the live db has anyway while its daemon runs.
  const files = readdirSync(s.home).filter((f) => f !== 'stam.db-wal' && f !== 'stam.db-shm').sort();
  assert.deepEqual({ files, db: hash() }, before, 'the live home and its db are unchanged');
  assert.ok(empty(s.c.tmp), 'no backup or copy is left');
});
