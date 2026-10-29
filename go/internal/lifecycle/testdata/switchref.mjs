#!/usr/bin/env node
// S-2848 B5e: src/cost-switch.ts run on the cases of costswitch_test.go, over a throwaway home with the same settings
// and registry, and two fake harnesses (fake, the predecessors', and fake2, the preset's) as test/cost-switch.test.mjs
// has them. Argv: the case list as JSON, the settings, the registry, the dump queries as JSON. Each case's fixture is
// SQL with {{work}} for the case's folder; its files are written there with their mtime. Prints {case name: {dump,
// prompt, switched, error}}: each dump query's rows (JSON arrays), the successor's takeover prompt (null when its
// launch never got one), the switched notice's mail and events, and the switch's error.
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-switch-ref-');
const socket = `switch-ref-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
process.env.GIT_CEILING_DIRECTORIES = join(home, "work");
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
const [casesJSON, settingsJSON, registryJSON, dumpJSON] = process.argv.slice(2);
writeFileSync(join(home, 'settings.json'), settingsJSON);
writeFileSync(join(home, 'registry.json'), registryJSON);

const db = await import(new URL('src/db.ts', root));
const costSwitch = await import(new URL('src/cost-switch.ts', root));
const costNotices = await import(new URL('src/cost-notices.ts', root));
const { killTmuxServer } = await import(new URL('src/tmux-socket.ts', root));
const { adapters } = await import(new URL('src/adapters/index.ts', root));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mode = {};
let prompt = null;
const fake = (name) => ({
  name,
  pushPrompt: async () => true,
  launch: async () => {
    if (name === 'fake2' && mode.fail === 'launch') throw new Error('harness would not start');
    return { argv: ['sleep', '600'], env: {} };
  },
  afterLaunch: async (a, p) => {
    if (name === 'fake2') {
      prompt = p ?? null;
      for (const q of mode.during ?? []) db.open().exec(q.replaceAll('{{succ}}', a.id));
      if (mode.fail === 'afterLaunch') throw new Error('the first prompt was not taken');
    }
    db.updateAgent(a.id, p ? { activity: 'working', activity_detail: null } : { activity: 'idle', activity_detail: 'session startup' });
  },
  interrupt: async () => true,
  stop: async () => {},
});
adapters.fake = fake('fake');
adapters.fake2 = fake('fake2');

const dump = JSON.parse(dumpJSON);
const cases = JSON.parse(casesJSON);
const out = {};
costNotices.notices(0);
for (const c of cases) {
  killTmuxServer(socket);
  const d = db.open();
  for (const t of ['agents', 'agent_parents', 'mail', 'mail_recipients', 'mail_deliveries', 'thread_archive', 'thread_archive_mail', 'itsas', 'itsa_participants', 'workspace_grants', 'permission_requests', 'events', 'blockers', 'waits', 'cost_notices']) d.exec(`DELETE FROM ${t}`);
  const work = join(home, 'work', c.name);
  mkdirSync(work, { recursive: true });
  for (const f of c.files ?? []) {
    const p = join(work, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.text);
    const t = new Date(f.mtime);
    utimesSync(p, t, t);
  }
  for (const q of c.sql) d.exec(q.replaceAll('{{work}}', work));
  mode = { fail: c.fail, during: c.during };
  prompt = null;
  let error = null;
  try {
    await costSwitch.costSwitch({ agent: c.agent, preset: c.preset, by: c.by, softStopMinutes: 0.003, pollMs: 20 });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // The switched notice's mail goes out in the background: wait until it stops growing.
  const sent = "SELECT r.agent_id AS too, m.subject, m.body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.from_id = 'system:cost' ORDER BY m.rowid, r.agent_id";
  let n = -1;
  for (let i = 0, same = 0; i < 100 && same < 5; i++) {
    await sleep(20);
    const now = d.prepare(sent).all().length;
    same = now === n ? same + 1 : 0;
    n = now;
  }
  const switched = [
    ...d.prepare(sent).all().map((m) => [m.too, m.subject, m.body].join('|')),
    ...d.prepare("SELECT agent_id, data FROM events WHERE type IN ('cost:switched', 'notice:queued') ORDER BY id").all().map((e) => `event|${e.agent_id}|${e.data}`),
  ];
  const rows = {};
  for (const [name, q] of Object.entries(dump)) rows[name] = d.prepare(q).all().map((r) => JSON.stringify(Object.values(r)));
  out[c.name] = { dump: rows, prompt, switched, error, work };
}
killTmuxServer(socket);
// A large output to a pipe is written asynchronously: exit once it is flushed.
process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
