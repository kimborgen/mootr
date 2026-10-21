#!/usr/bin/env node
// S-1888: the secret files (src/secret-files.ts) reach every harness's deny rules from one list.
// Claude Code's settings deny Read, Edit and Write of each file; OpenCode's session denies read and
// edit of each file and the shell patterns; Codex's sandbox profile has a `none` entry per file. The
// adapters' own tests check their shape; this one checks that every file of the one list is in each.
// Throwaway STAM_HOME, no daemon, no model: `node --test test/secret-files.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tempDir, tempHome } from './tmphome.mjs';

const home = tempHome('stam-secret-files-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `secret-files-test-${process.pid}`;
// A fake OpenCode server on a port of its own, read when opencode.ts loads (see the resume test).
const OC_PORT = 40000 + (process.pid % 10000);
process.env.STAM_OPENCODE_PORT = String(OC_PORT);
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, secrets, claudeRules, opencode, codex, DEFAULT_STAM_HOME;
async function load() {
  if (db) return;
  await import('../src/adapters/index.ts');
  db = await import('../src/db.ts');
  secrets = await import('../src/secret-files.ts');
  claudeRules = await import('../src/adapters/claude-permissions.ts');
  opencode = await import('../src/adapters/opencode.ts');
  codex = await import('../src/adapters/codex.ts');
  DEFAULT_STAM_HOME = (await import('../src/config.ts')).DEFAULT_STAM_HOME;
}

test('the list names the files of the design: credentials, provider keys, MCP tokens and the secret store', async () => {
  await load();
  for (const f of ['token', 'peer-token', 'settings.json', 'settings.shared.json', 'opencode.env', 'voice.env', 'mcp-auth.json', 'secrets.json']) {
    assert.ok(secrets.SECRET_FILES.includes(f), f);
  }
});

test('every file, under the daemon home and the default home, is denied by each harness', async () => {
  await load();
  db.createAgent({ id: 'secret-files-1', name: 'secret-files-1', role: 'test', machine: 'x', harness: 'codex', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  const claude = claudeRules.denyRules();
  const session = opencode.sessionPermissions('auto');
  // A new agent is in the default mode, not bypass, so it has the profile (S-1888).
  const sandbox = codex.agentSandbox(db.getAgent('secret-files-1'))['permissions.stam.filesystem'];
  for (const h of [home, DEFAULT_STAM_HOME]) {
    for (const f of secrets.SECRET_FILES) {
      const p = `${h}/${f}`;
      for (const tool of ['Read', 'Edit', 'Write']) assert.ok(claude.includes(`${tool}(/${p})`), `claude ${tool} ${p}`);
      for (const action of ['read', 'edit']) assert.ok(session.some((r) => r.action === action && r.resource === p && r.effect === 'deny'), `opencode ${action} ${p}`);
      assert.equal(sandbox[p], 'none', `codex ${p}`);
    }
  }
  for (const pattern of secrets.secretCommandPatterns()) {
    assert.ok(claude.includes(`Bash(${pattern})`), `claude ${pattern}`);
    assert.ok(session.some((r) => r.action === 'shell' && r.resource === pattern && r.effect === 'deny'), `opencode ${pattern}`);
  }
});

test('OpenCode names a file inside the agent folder, or its project, relative to that folder, and both forms are denied (S-1891 review)', async () => {
  await load();
  // cwd is the daemon home: a file in it is `token`. cwd is its parent: `stam-.../token`, and for the
  // default home, `stam/token` under the parent of ~/.local/share/stam.
  const inHome = opencode.sessionPermissions('auto', home);
  assert.ok(inHome.some((r) => r.action === 'read' && r.resource === 'token' && r.effect === 'deny'));
  assert.ok(inHome.some((r) => r.action === 'edit' && r.resource === 'token' && r.effect === 'deny'));
  const parent = dirname(home);
  const inParent = opencode.sessionPermissions('auto', parent);
  const rel = home.slice(parent.length + 1);
  assert.ok(inParent.some((r) => r.action === 'read' && r.resource === `${rel}/token` && r.effect === 'deny'), `${rel}/token`);
  const inDefaultParent = opencode.sessionPermissions('auto', dirname(DEFAULT_STAM_HOME));
  assert.ok(inDefaultParent.some((r) => r.action === 'read' && r.resource === 'stam/token' && r.effect === 'deny'));
  // The absolute forms stay: a session in an unrelated folder still has them.
  assert.ok(opencode.sessionPermissions('auto', '/nonexistent-folder').some((r) => r.resource === `${home}/token`));
});

test('a non-bypass Codex thread start, resume and turn send no sandbox param, so the profile stays (S-1891)', async () => {
  await load();
  for (const mode of ['auto', 'default']) {
    const params = JSON.parse(JSON.stringify(codex.permissionParams(mode)));
    assert.ok(!('sandbox' in params), `${mode} start and resume send no sandbox: ${JSON.stringify(params)}`);
  }
  // pushPrompt sends a turn with the same params minus `sandbox` (src/adapters/codex.ts), so no turn carries it either.
  assert.equal(codex.permissionParams('bypass').sandbox, 'danger-full-access');
});

test('a resumed OpenCode session gets its denies again, by PATCH on its route (S-1891)', async () => {
  await load();
  const tmux = await import('../src/tmux.ts');
  const sent = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      sent.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/api/session' ? JSON.stringify({ id: 'ses_resume' }) : '{}');
    });
  });
  await new Promise((r) => server.listen(OC_PORT, '127.0.0.1', r));
  // A live OpenCode server session makes startServer return at once: the fake answers its health check.
  tmux.newSession('_opencode', home, {}, ['sleep', '600']);
  try {
    db.createAgent({ id: 'oc-resume-1', name: 'oc-resume-1', role: 'test', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: home, parent_id: null, session_id: 'ses_resume' });
    await opencode.opencode.launch(db.getAgent('oc-resume-1'), { resume: true });
    const patch = sent.find((s) => s.method === 'PATCH');
    assert.ok(patch, `a PATCH was sent: ${JSON.stringify(sent)}`);
    assert.equal(patch.url, '/api/session/ses_resume');
    assert.ok(patch.body.permissions.some((r) => r.action === 'read' && r.resource === `${home}/token` && r.effect === 'deny'));
    assert.ok(patch.body.permissions.some((r) => r.action === 'read' && r.resource === 'token' && r.effect === 'deny'));
  } finally {
    server.close();
    tmux.killSession('_opencode');
  }
});

// OpenCode's project and cwd are read from the filesystem, and the daemon's STAM_HOME is read at import,
// so a nested layout runs sessionPermissions in a child with its own STAM_HOME (S-1891 review).
function permsIn({ stamHome, cwd }) {
  // The adapters index loads first, as in every other test: opencode-view's import order needs it.
  const index = new URL('../src/adapters/index.ts', import.meta.url).href;
  const src = new URL('../src/adapters/opencode.ts', import.meta.url).href;
  const script = `await import(${JSON.stringify(index)}); const m = await import(${JSON.stringify(src)}); console.log(JSON.stringify(m.sessionPermissions('auto', ${JSON.stringify(cwd)})));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, STAM_HOME: stamHome, STAM_TMUX_SOCKET: `secret-files-child-${process.pid}` },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// A project root (`.git` or `.hg`) with a folder under it as the cwd, and STAM_HOME a sibling of that folder.
function project(marker) {
  const root = tempDir('stam-oc-project-');
  mkdirSync(join(root, marker));
  mkdirSync(join(root, 'subdir'));
  return { stamHome: join(root, 'stam'), cwd: join(root, 'subdir'), root };
}

const denied = (perms, action, resource) => perms.some((r) => r.action === action && r.resource === resource && r.effect === 'deny');

test('nested cwd: a STAM_HOME beside the cwd, inside the project, is denied as ../stam/... (S-1891 review)', () => {
  const { stamHome, cwd } = project('.git');
  const p = permsIn({ stamHome, cwd });
  assert.ok(denied(p, 'read', '../stam/token'));
  assert.ok(denied(p, 'edit', '../stam/settings.json.*'));
  assert.ok(denied(p, 'read', `${stamHome}/token`), 'the absolute form stays');
});

test('a Mercurial project counts as the project root too (S-1891 review)', () => {
  const { stamHome, cwd } = project('.hg');
  assert.ok(denied(permsIn({ stamHome, cwd }), 'read', '../stam/token'));
});

test('a symlinked cwd is denied by both its own name and the folder it points to (S-1891 review)', () => {
  const { stamHome, cwd, root } = project('.git');
  const link = join(root, 'link');
  symlinkSync(cwd, link);
  const p = permsIn({ stamHome, cwd: link });
  assert.ok(denied(p, 'read', '../stam/token'));
});

test('a resume whose permissions PATCH is refused fails the resume (S-1891 review)', async () => {
  await load();
  const tmux = await import('../src/tmux.ts');
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'PATCH') {
        res.writeHead(500);
        res.end('refused');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(OC_PORT, '127.0.0.1', r));
  tmux.newSession('_opencode', home, {}, ['sleep', '600']);
  try {
    db.createAgent({ id: 'oc-resume-2', name: 'oc-resume-2', role: 'test', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: home, parent_id: null, session_id: 'ses_refused' });
    await assert.rejects(opencode.opencode.launch(db.getAgent('oc-resume-2'), { resume: true }), /PATCH/);
  } finally {
    server.close();
    tmux.killSession('_opencode');
  }
});

test('an alias cwd outside its project\'s ancestry: the project is found from the real cwd, and the alias-relative form is denied (S-1891 review)', () => {
  const base = tempDir('stam-oc-alias-');
  const project = join(base, 'data', 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, 'subdir'), { recursive: true });
  mkdirSync(join(base, 'work'));
  const alias = join(base, 'work', 'alias');
  symlinkSync(join(project, 'subdir'), alias);
  const stamHome = join(project, 'stam');
  const p = permsIn({ stamHome, cwd: alias });
  assert.ok(denied(p, 'read', relative(alias, join(stamHome, 'token'))), relative(alias, join(stamHome, 'token')));
  assert.ok(denied(p, 'edit', relative(alias, join(stamHome, 'secrets.json'))));
});

test('a symlinked STAM_HOME: both its names are denied from the project (S-1891 review)', () => {
  const base = tempDir('stam-oc-symhome-');
  const project = join(base, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, 'subdir'));
  mkdirSync(join(project, 'realstam'));
  symlinkSync(join(project, 'realstam'), join(project, 'stam'));
  const cwd = join(project, 'subdir');
  const p = permsIn({ stamHome: join(project, 'stam'), cwd });
  assert.ok(denied(p, 'read', relative(cwd, join(project, 'stam', 'token'))), '../stam/token');
  assert.ok(denied(p, 'read', relative(cwd, join(project, 'realstam', 'token'))), '../realstam/token');
});

test('a cwd of / or with a trailing slash or .. is named without a doubled slash (S-1891 review)', () => {
  const { stamHome, cwd } = project('.git');
  const atRoot = permsIn({ stamHome, cwd: '/' });
  assert.ok(denied(atRoot, 'read', relative('/', join(stamHome, 'token'))), relative('/', join(stamHome, 'token')));
  assert.ok(!atRoot.some((r) => r.resource.includes('//')), 'no doubled slash in a name');
  assert.ok(denied(permsIn({ stamHome, cwd: `${cwd}/` }), 'read', '../stam/token'), 'a trailing slash');
  assert.ok(denied(permsIn({ stamHome, cwd: `${cwd}/../subdir` }), 'read', '../stam/token'), 'a ..');
});

test('a secret file that is itself a symlink: its real target is denied too (S-1891 review)', async () => {
  await load();
  const elsewhere = tempDir('stam-oc-elsewhere-');
  const target = join(elsewhere, 'peer-token');
  writeFileSync(target, 'x');
  symlinkSync(target, join(home, 'peer-token'));
  const p = opencode.sessionPermissions('auto', home);
  assert.ok(denied(p, 'read', realpathSync(target)), realpathSync(target));
  assert.ok(denied(p, 'read', `${home}/peer-token`), 'the given name stays');
});
