// Launches one agent with the TS daemon's own Claude Code adapter (src/adapters/claude.ts launch), for
// go/internal/adapters/claude's golden test (S-2804). DIR is a test home (never the live home) and FAKEHOME the user
// home; the caller sets STAM_TEST_TMPDIR and STAM_CLAUDE_BIN. The agent comes as JSON on stdin:
//
//   {"agent": {id, name, role, machine, model, effort, cwd, session_id, type, permission_mode, personal_workspace},
//    "grants": ["/path", ...], "resume": false}
//
// It prints the launch spec, the files the launch wrote (text and mode), the plugin folder, stam's own command, and
// the system prompt's slots other modules rendered (org, cost, lessons, workspace, itsa, requirements, granted), which
// the Go launch takes as its Parts.
//
//   node go/internal/adapters/claude/testdata/ts-launch.mjs DIR FAKEHOME < agent.json
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dir, fakeHome] = process.argv.slice(2);
if (!dir || !fakeHome) {
  console.error('usage: ts-launch.mjs DIR FAKEHOME');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.HOME = resolve(fakeHome);
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
delete process.env.STAM_RELEASE_ID;
const config = await import('../../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('ts-launch: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../../src/db.ts');
// Through the index, as the daemon loads it: claude.ts imported first meets an import cycle.
const { adapters } = await import('../../../../../src/adapters/index.ts');
const { claude } = adapters;
const { orgPrompt, managerCostPrompt } = await import('../../../../../src/org.ts');
const { cachedLessons } = await import('../../../../../src/retro-lessons.ts');
const { workspacePrompt } = await import('../../../../../src/workspace-prompt.ts');
const { itsaPrompt } = await import('../../../../../src/itsa-owners.ts');
const { prompt: requirementsPrompt } = await import('../../../../../src/requirements.ts');
const { grantedPaths } = await import('../../../../../src/workspace-share.ts');

const input = JSON.parse(readFileSync(0, 'utf8'));
const a = input.agent;
db.createAgent({ id: a.id, name: a.name, role: a.role, machine: a.machine, harness: 'claude', model: a.model, effort: a.effort, cwd: a.cwd, parent_id: null, session_id: a.session_id });
db.updateAgent(a.id, { type: a.type, permission_mode: a.permission_mode, personal_workspace: a.personal_workspace });
for (const path of input.grants ?? [])
  db.open().prepare('INSERT INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)').run(path, a.id, 'read', a.id, '2026-01-01T00:00:00Z');
const agent = db.getAgent(a.id);
const spec = await claude.launch(agent, { resume: !!input.resume });

const agentDir = join(config.STAM_HOME, 'agents', a.id);
const files = {};
for (const f of readdirSync(agentDir).sort()) {
  const p = join(agentDir, f);
  files[f] = { text: readFileSync(p, 'utf8'), mode: statSync(p).mode & 0o777 };
}
const pluginDir = join(config.STAM_HOME, 'claude-plugin');
let plugin = null;
if (existsSync(pluginDir)) {
  const skills = {};
  for (const s of readdirSync(join(pluginDir, 'skills')).sort()) {
    const p = join(pluginDir, 'skills', s);
    skills[s] = lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null;
  }
  plugin = { manifest: readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'), skills };
}
const out = {
  spec,
  files,
  dirModes: { agents: statSync(join(config.STAM_HOME, 'agents')).mode & 0o777, agent: statSync(agentDir).mode & 0o777 },
  plugin,
  bin: config.STAM_BIN,
  parts: {
    org: orgPrompt(agent),
    cost: managerCostPrompt(agent),
    lessons: cachedLessons(a.id) ?? '',
    workspace: workspacePrompt(agent),
    itsa: itsaPrompt(a.id),
    requirements: requirementsPrompt(),
    granted: grantedPaths(a.id),
  },
};
// Synchronous, so process.exit can't cut the result short on a pipe.
writeSync(1, JSON.stringify(out));
process.exit(0);
