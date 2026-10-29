#!/usr/bin/env node
// S-3250: the decisions of src/lifecycle.ts settleStart and startStalled for the cases in stuckstart_matches_test.go, run on
// the TypeScript daemon's functions over a throwaway home and tmux socket with a fake harness. Argv: the case list as JSON.
// Prints {case name: result} as JSON. Each case is an agent with its ops applied, then one check.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-stuck-ref-');
const socket = `stuck-ref-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], stuckStartMinutes: 15 }));

const db = await import(new URL('src/db.ts', root));
const lifecycle = await import(new URL('src/lifecycle.ts', root));
const { adapters } = await import(new URL('src/adapters/index.ts', root));

// The harness sits at its empty prompt once it is resumed here (the Go live harness draws its ready screen).
const ready = new Set();
adapters.fake = {
  pushPrompt: async () => true,
  launch: async () => ({ argv: ['sleep', '600'], env: {} }),
  afterLaunch: async () => {},
  atPrompt: (a) => ready.has(a.id),
};

let n = 0;
function agent() {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  db.createAgent({ id, name: `s${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity: 'idle' });
  return id;
}
const get = (id) => db.getAgent(id);

// The Go case list's ops, in the same meaning.
async function apply(id, op) {
  switch (op) {
    case 'resume': {
      const { launched } = await lifecycle.startHarness(get(id), undefined, true);
      await launched;
      ready.add(id);
      return;
    }
    case 'block':
      db.open().prepare('INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'window', 'claude-max', 'five_hour at 100%', new Date().toISOString(), null);
      return;
    case 'pause':
      db.updateAgent(id, { lifecycle: 'paused', paused_by: JSON.stringify(['human']) });
      return;
    case 'working':
      db.updateAgent(id, { activity: 'working' });
      return;
    case 'with-prompt':
      db.updateAgent(id, { activity_detail: 'with prompt' });
      return;
    case 'pending-archive':
      db.updateAgent(id, { pending_action: JSON.stringify({ type: 'archive', force: false }) });
      return;
    default:
      throw new Error(`unknown op ${op}`);
  }
}

const cases = JSON.parse(process.argv[2]);
const out = {};
for (const c of cases) {
  const id = agent();
  for (const op of c.ops) await apply(id, op);
  // The Go row copy for another machine: the same row, read as that machine reads it.
  const row = c.row === 'peer' ? { ...get(id), machine: 'peer' } : get(id);
  const now = Date.now() + c.minutes * 60_000;
  out[c.name] = c.check === 'settle' ? await lifecycle.settleStart(row, c.alive) : lifecycle.startStalled(row, c.alive, now);
}
console.log(JSON.stringify(out));
spawnSync('tmux', ['-L', socket, 'kill-server']);
process.exit(0);
