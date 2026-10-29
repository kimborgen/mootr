#!/usr/bin/env node
// S-2848 B5d: src/allocations.ts run on the cases of allocations_test.go, over a throwaway home with the same settings
// and registry prices. Argv: the case list as JSON, the settings, the registry. Prints {case name: [step result, ...]}
// as JSON, each result JSON.stringify'd: a set's {allocation, warning} or {error}, a clear's {cleared} or {error}, a
// view's rows, and a check's new cost notices and the mail they sent.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-alloc-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `alloc-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
const [casesJSON, settingsJSON, registryJSON] = process.argv.slice(2);
writeFileSync(join(home, 'settings.json'), settingsJSON);
writeFileSync(join(home, 'registry.json'), registryJSON);

const db = await import(new URL('src/db.ts', root));
const allocations = await import(new URL('src/allocations.ts', root));

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const MIN = 60_000;
const iso = (t) => new Date(t).toISOString();

// The cost notices and their mail since the last check, the mail once every recipient's has gone out.
let noticesSeen = 0;
let mailSeen = 0;
async function fresh() {
  const d = db.open();
  let rows = [];
  try {
    rows = d.prepare('SELECT id, key, kind, account, window, agent_id, managers FROM cost_notices ORDER BY created_at, rowid').all().slice(noticesSeen);
  } catch {}
  noticesSeen += rows.length;
  const want = mailSeen + rows.reduce((n, r) => n + JSON.parse(r.managers).length, 0);
  const query = "SELECT r.agent_id AS too, m.subject, m.body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.from_id = 'system:cost' ORDER BY m.rowid";
  for (let i = 0; i < 500 && d.prepare(query).all().length < want; i++) await new Promise((r) => setTimeout(r, 10));
  const mail = d.prepare(query).all().slice(mailSeen);
  mailSeen += mail.length;
  return {
    notices: rows.map((r) => [r.id, r.key, r.kind, r.account, r.window, r.agent_id ?? 'null', r.managers].join('|')),
    mails: mail.map((m) => [m.too, m.subject, m.body].join('|')),
  };
}

const cases = JSON.parse(casesJSON);
const out = {};
for (const c of cases) {
  const d = db.open();
  for (const t of ['usage', 'usage_samples', 'window_readings', 'agent_parents', 'peer_agents', 'agents', 'mail_recipients', 'mail']) d.exec(`DELETE FROM ${t}`);
  // The modules made these tables once and remember it, so they are emptied, never dropped.
  for (const t of ['cost_notices', 'allocations']) {
    try {
      d.exec(`DELETE FROM ${t}`);
    } catch {}
  }
  noticesSeen = 0;
  mailSeen = 0;
  for (const a of c.agents ?? []) {
    db.createAgent({ id: a.id, name: `n-${a.id}`, role: 'test', machine: 'test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: a.parent || null, session_id: null });
  }
  for (const [child, parent] of c.adopted ?? []) d.prepare('INSERT INTO agent_parents (child_id, parent_id) VALUES (?, ?)').run(child, parent);
  for (const p of c.peers ?? []) d.prepare("INSERT INTO peer_agents (id, name, machine, updated_at, parents) VALUES (?, ?, 'peer', ?, ?)").run(p.id, `n-${p.id}`, iso(T0), JSON.stringify(p.parents));
  if (c.rows?.length) allocations.list();
  for (const r of c.rows ?? []) {
    d.prepare("INSERT INTO allocations (id, root_id, account, kind, window, percent, amount, period, set_by, set_at, note) VALUES (?, ?, 'openrouter', 'usd', '', NULL, ?, 'day', 'human', ?, NULL)").run(r.id, r.root, r.amount, iso(T0));
  }
  for (const s of c.samples ?? []) {
    d.prepare("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, 'max', 'claude', 'test-a', ?, ?, 0, 0, 0)")
      .run(s.agent, iso(T0 + s.minute * MIN), s.in);
  }
  for (const r of c.readings ?? []) {
    d.prepare("INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES ('claude', ?, ?, ?, ?)").run(r.window ?? 'five_hour', iso(T0 + r.at), r.used, r.resets ?? null);
  }
  for (const u of c.usage ?? []) {
    d.prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES (?, ?, ?, ?, ?, ?, ?)').run(u.agent, u.day, 'claude', 'test-a', u.account, u.cost, u.paid);
  }
  const results = [];
  for (const s of c.steps) {
    const now = T0 + (s.now ?? 0);
    let r;
    try {
      if (s.op === 'set') {
        // set stamps the wall clock: each set gets its own millisecond, so the view's order by set_at is the steps'.
        for (const last = Date.now(); Date.now() === last; );
        r = allocations.set(s.input, s.by);
      }
      else if (s.op === 'clear') r = { cleared: allocations.clear(s.idFrom == null ? s.input : { ...s.input, id: JSON.parse(results[s.idFrom]).allocation.id }, s.by) };
      else if (s.op === 'usage') {
        for (const u of s.usage) d.prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES (?, ?, ?, ?, ?, ?, ?)').run(u.agent, u.day, 'claude', 'test-a', u.account, u.cost, u.paid);
        r = 'usage';
      }
      else if (s.op === 'view') r = allocations.view(s.tree, now);
      else if (s.op === 'checkWindow') {
        allocations.checkWindow(s.name, s.window, now);
        r = await fresh();
      } else {
        allocations.checkUsd(s.account, now);
        r = await fresh();
      }
    } catch (e) {
      r = { error: e instanceof Error ? e.message : String(e) };
    }
    results.push(JSON.stringify(r));
  }
  out[c.name] = results;
}
console.log(JSON.stringify(out));
process.exit(0);
