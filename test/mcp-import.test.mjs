#!/usr/bin/env node
// The import scan (S-52): reads each harness's own config from a throwaway HOME and reports
// the servers it finds, marked against what stam already has. Free: only files in a temp
// folder, no daemon and no model. `node --test test/mcp-import.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome, tempDir } from './tmphome.mjs';

const home = tempHome('stam-mcp-import-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let scanHarnesses, stripJsonc, sameServer;
before(async () => ({ scanHarnesses, stripJsonc, sameServer } = await import('../src/mcp-import.ts')));
after(() => rmSync(home, { recursive: true, force: true }));

// A project folder with a .mcp.json, and a git repo whose root holds one (found through the
// agent's folder even though the agent starts in a subfolder).
const cwd = tempDir('stam-mcp-cwd-');
writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { ctx: { command: 'ctx-server' } } }));
const repo = tempDir('stam-mcp-repo-');
execFileSync('git', ['init', '-q'], { cwd: repo });
const sub = join(repo, 'sub');
mkdirSync(sub);
writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { rooty: { url: 'https://root/mcp' } } }));

writeFileSync(join(home, '.claude.json'), JSON.stringify({
  mcpServers: {
    shared: { command: 'npx', args: ['-y', 'srv'] },
    local: { command: 'node', args: ['s.js'] },
    stam: { command: 'stam', args: ['mcp'] },
  },
  projects: { '/work/proj': { mcpServers: { proj: { type: 'sse', url: 'https://x/sse' } } } },
}));
mkdirSync(join(home, '.codex'), { recursive: true });
writeFileSync(join(home, '.codex', 'config.toml'), `
[mcp_servers.codexone]
command = "c"
args = ["--a"]

[mcp_servers.codexenv]
url = "https://codex/mcp"
bearer_token_env_var = "CODEX_TOKEN"
`);
mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
writeFileSync(join(home, '.config', 'opencode', 'opencode.jsonc'), `{
  // OpenCode's user config
  "mcp": { "oc": { "type": "remote", "url": "https://oc/mcp" } },
}`);

const existing = { shared: { command: 'npx', args: ['-y', 'srv'] }, local: { command: 'old' } };
const found = () => scanHarnesses({ home, cwds: [cwd, sub], existing });
const byName = () => Object.fromEntries(found().map((e) => [e.name, e]));

test('JSONC comments and trailing commas are stripped', () => {
  const parsed = JSON.parse(stripJsonc('{ // c\n "a": [1,2,], /* x */ "b": true,\n}'));
  assert.deepEqual(parsed, { a: [1, 2], b: true });
});

test('the scan skips stam and reads each harness file', () => {
  const names = found().map((e) => e.name).sort();
  assert.deepEqual(names, ['codexenv', 'codexone', 'ctx', 'local', 'oc', 'proj', 'rooty', 'shared']);
});

test('a server stam already has identically is marked same', () => {
  assert.equal(byName().shared.status, 'same');
  assert.equal(byName().shared.group, '~/.claude.json');
});

test('a server that differs shows what differs, with values masked', () => {
  const e = byName().local;
  assert.equal(e.status, 'differs');
  assert.deepEqual(e.differences, ['command: old → node', 'args: — → ["s.js"]']);
});

test('a Claude project server keeps its project path and its SSE note', () => {
  const e = byName().proj;
  assert.equal(e.group, '~/.claude.json · /work/proj');
  assert.equal(e.path, '/work/proj');
  assert.equal(e.status, 'new');
  assert.match(e.note, /streamable HTTP/);
});

test('.mcp.json is read from an agent folder and a git root', () => {
  assert.equal(byName().ctx.group, join(cwd, '.mcp.json'));
  assert.equal(byName().rooty.group, join(repo, '.mcp.json'));
});

test('Codex TOML is read, and an env-var bearer becomes a note', () => {
  assert.deepEqual(byName().codexone.server, { command: 'c', args: ['--a'] });
  assert.equal(byName().codexone.group, '~/.codex/config.toml');
  assert.match(byName().codexenv.note, /CODEX_TOKEN/);
});

test('OpenCode .jsonc is read', () => {
  assert.equal(byName().oc.group, '~/.config/opencode/opencode.jsonc');
  assert.deepEqual(byName().oc.server, { url: 'https://oc/mcp' });
});

test('sameServer compares maps by key, not order', () => {
  assert.equal(sameServer({ command: 'x', env: { A: '1', B: '2' } }, { command: 'x', env: { B: '2', A: '1' } }), true);
  assert.equal(sameServer({ command: 'x' }, { command: 'y' }), false);
  assert.equal(sameServer({ command: 'x', enabled: true }, { command: 'x' }), true);
});
