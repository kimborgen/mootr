// test/run.sh's LIGHT list (S-1288, S-1768) sends a run of only listed tests to the light slot pool.
// Each entry must be a plain `node --test` file that starts no daemon, tmux, browser or server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = readFileSync(`${root}test/run.sh`, 'utf8');

const light = run.match(/^LIGHT="\n([^"]*)"/m)[1].split('\n').filter(Boolean);
const free = new Set(run.match(/^FREE="\n([^"]*)"/m)[1].split('\n').filter(Boolean));
const heavy = /tmux|chromium|playwright|createServer|\.listen\(|[^a-zA-Z]spawn\(|flock|systemctl|fake-codex|daemon run|stam-fast|decide-stub|spawnProcess\(|execFile\(|\bfork\(|new Worker|monitorEventLoopDelay|assert[\w.]*\([^\n]*(performance\.now|Date\.now\(\) -)/;
// It reads only the test file's own text: a spawn inside src or in an imported helper isn't seen, and a wall-clock bound
// split over several lines isn't either. Wall-clock asserts and event-loop delay bounds flake beside heavy runs, so they
// stay out of LIGHT.
const comment = /^\s*(\/\/|\*|#)/;

test('LIGHT > kept sorted, no repeats', () => {
  assert.deepEqual(light, [...new Set(light)].sort());
});

for (const name of light) {
  test(`LIGHT > ${name} is a free daemon-free node --test file`, () => {
    assert.ok(free.has(name), `${name} isn't in FREE`);
    const m = run.match(new RegExp(`^    ${name}\\) echo "node --test (test/[\\w.-]+)"`, 'm'));
    assert.ok(m, `${name} isn't a plain node --test file in cmd()`);
    const body = readFileSync(root + m[1], 'utf8').split('\n').filter((l) => !comment.test(l)).join('\n');
    const hit = body.match(heavy);
    // suggest-rescore-unit runs the decide stub, a model stub with no daemon, tmux or browser; this file names the patterns.
    if (name !== 'suggest-rescore-unit' && name !== 'light-list-unit') assert.equal(hit, null, `${m[1]} starts a daemon, tmux, browser or server: ${hit}`);
  });
}
