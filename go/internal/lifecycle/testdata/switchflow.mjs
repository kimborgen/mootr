#!/usr/bin/env node
// S-2848 B5e2: src/cost-switch.ts costSwitch, the whole switch, run on the cases of costswitch_run_test.go over a
// throwaway home with the same settings and registry. Claude Code is a fake here (no terminal of its own: `sleep 600`)
// whose interrupt is never confirmed and whose first prompt starts a turn, as the Go test's fake Claude Code does with
// the hook the test plays. Argv: the case list as JSON, the settings, the registry. Each case's fixture is SQL with
// {{work}} for the case's folder, and its files are written there first. Prints {case name: {result, error, events, blockers, agents, queued, notices, work}}:
// the switch's result or error, every cost:switch and cost:ack event's agent and data, the blockers, the agents'
// lifecycle and forward, the predecessor's queued notices, and the cost notices' acks.
import { join } from 'node:path';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-switch-flow-');
const socket = `switch-flow-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
process.env.GIT_CEILING_DIRECTORIES = join(home, 'work');
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
const [casesJSON, settingsJSON, registryJSON] = process.argv.slice(2);
const { writeFileSync } = await import('node:fs');
writeFileSync(join(home, 'settings.json'), settingsJSON);
writeFileSync(join(home, 'registry.json'), registryJSON);

const db = await import(new URL('src/db.ts', root));
const costSwitch = await import(new URL('src/cost-switch.ts', root));
const costNotices = await import(new URL('src/cost-notices.ts', root));
const { killTmuxServer } = await import(new URL('src/tmux-socket.ts', root));
const { adapters } = await import(new URL('src/adapters/index.ts', root));

adapters.claude = {
  ...adapters.claude,
  pushPrompt: async () => true,
  launch: async () => ({ argv: ['sleep', '600'], env: {} }),
  afterLaunch: async (a, p) => db.updateAgent(a.id, p ? { activity: 'working', activity_detail: null } : { activity: 'idle', activity_detail: 'session startup' }),
  interrupt: async () => false,
  stop: undefined,
};

const cases = JSON.parse(casesJSON);
const out = {};
costNotices.notices(0);
const rows = (q, ...args) => db.open().prepare(q).all(...args).map((r) => JSON.stringify(Object.values(r)));
for (const c of cases) {
  killTmuxServer(socket);
  const d = db.open();
  for (const t of ['agents', 'agent_parents', 'mail', 'mail_recipients', 'mail_deliveries', 'thread_archive', 'thread_archive_mail', 'itsas', 'itsa_participants', 'workspace_grants', 'events', 'blockers', 'waits', 'cost_notices'])
    d.exec(`DELETE FROM ${t}`);
  const work = join(home, 'work', c.name);
  mkdirSync(work, { recursive: true });
  for (const [rel, text] of Object.entries(c.files ?? {})) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), text);
  }
  for (const q of c.sql) d.exec(q.replaceAll('{{work}}', work));
  let result = null;
  let error = null;
  try {
    result = await costSwitch.costSwitch({ agent: c.agent, preset: c.preset, by: c.by, softStopMinutes: 0.003, pollMs: 20 });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const pred = db.getAgent(c.agent);
  out[c.name] = {
    result,
    error,
    events: rows("SELECT agent_id, type, data FROM events WHERE type IN ('cost:switch', 'cost:ack', 'cost:interrupt-error', 'cost:switch-resume-error') ORDER BY id"),
    blockers: rows('SELECT agent_id, kind, account, reason FROM blockers ORDER BY agent_id, kind'),
    agents: rows('SELECT id, name, lifecycle, forwarded_to, harness, model, effort FROM agents ORDER BY name'),
    queued: pred ? rows("SELECT data FROM events WHERE agent_id = ? AND type = 'notice:queued' ORDER BY id", pred.id) : [],
    notices: rows('SELECT id, acked_by FROM cost_notices ORDER BY id'),
    work,
  };
}
killTmuxServer(socket);
process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
