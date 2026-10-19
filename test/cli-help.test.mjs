#!/usr/bin/env node
// `stam SUB --help` and `stam SUB -h` print usage, exit 0, and never act (S-1236). The subcommand
// list is read from the `case` labels of main() in src/cli.ts, so a new subcommand is covered
// without editing this file. Each run talks to a stub daemon that records every request: a help
// run must send none. Run with `node --test test/cli-help.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NO_HELP = new Set(['hook', 'statusline', 'mcp', 'mcp-proxy', 'daemon']);
const HEADER = 'stam: run and coordinate coding agents';

// Every `case 'NAME':` directly under main()'s switch (four spaces in; the nested switches sit deeper).
const commands = [...readFileSync(CLI, 'utf8').matchAll(/^    case '([^']+)':/gm)].map((m) => m[1]);

// Runs `stam ...args` against a stub daemon; resolves with the exit code, output, and every request seen.
function run(args) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"stub"}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const home = tempDir('stam-cli-help-');
      const env = { ...process.env, STAM_HOME: home, STAM_URL: `http://127.0.0.1:${server.address().port}`, STAM_TOKEN: 'test' };
      const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => {
        server.close();
        rmSync(home, { recursive: true, force: true });
        resolve({ code, out, err, seen });
      });
    });
  });
}

// Runs the cases a few at a time: each one starts a node process, and the whole list is long.
async function inBatches(items, fn, size = 8) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

test('the subcommand list is read from the switch', () => {
  assert.ok(commands.length > 40, `found ${commands.length} cases`);
  assert.ok(commands.includes('prune') && commands.includes('itsa') && commands.includes('deploy'));
});

test('every subcommand: --help and -h print usage, exit 0, and send no request', async () => {
  const cases = commands.filter((c) => !NO_HELP.has(c)).flatMap((c) => [[c, '--help'], [c, '-h']]);
  await inBatches(cases, async ([cmd, flag]) => {
    const r = await run([cmd, flag]);
    assert.equal(r.code, 0, `${cmd} ${flag}: ${r.err}`);
    assert.equal(r.err, '', `${cmd} ${flag} wrote to stderr`);
    // An alias line (`stam pause|unpause AGENT`) names the command inside its `|` list.
    assert.ok(new RegExp(`stam (\\S+\\|)?${cmd}\\b`).test(r.out) || r.out.includes(HEADER), `${cmd} ${flag} printed no usage: ${r.out}`);
    assert.deepEqual(r.seen, [], `${cmd} ${flag} made a request`);
  });
});

test('--help with no subcommand prints all of usage', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith(HEADER), r.out);
  assert.deepEqual(r.seen, []);
});

test('-h after a --flag is help, and nothing runs', async () => {
  // A boolean flag before -h (prune --dry-run -h) must not let the command run.
  for (const args of [['itsa', 'set', 'S-1', '--summary', '-h'], ['prune', '--dry-run', '-h']]) {
    const r = await run(args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.ok(new RegExp(`stam (\\S+\\|)?${args[0]}\\b`).test(r.out), r.out);
    assert.deepEqual(r.seen, [], `${args.join(' ')} made a request`);
  }
});

test('args after -- are never help', async () => {
  // `ls` ignores its positionals and asks the daemon for the agents, so the request shows it ran.
  const r = await run(['ls', '--', '--help']);
  assert.ok(r.seen.length > 0, 'no request reached the stub daemon');
  assert.ok(!r.out.includes(HEADER), r.out);
});
