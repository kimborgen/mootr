#!/usr/bin/env node
// S-2848 B5c: src/attribution.ts run on the cases of attribution_test.go, over a throwaway home with the same settings
// and registry prices. Argv: the case list as JSON. Prints {case name: [query result, ...]} as JSON. Each case starts
// from empty agents, samples and readings; numbers are printed with String(n), maps as sorted "key=value" lists.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-attr-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `attr-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
const [casesJSON, settingsJSON, registryJSON] = process.argv.slice(2);
writeFileSync(join(home, 'settings.json'), settingsJSON);
writeFileSync(join(home, 'registry.json'), registryJSON);

const db = await import(new URL('src/db.ts', root));
const attr = await import(new URL('src/attribution.ts', root));

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const MIN = 60_000;
const iso = (t) => new Date(t).toISOString();
const num = (v) => (v == null ? 'null' : String(v));
const map = (o) => Object.entries(o).map(([k, v]) => `${k}=${num(v)}`).sort();

const cases = JSON.parse(casesJSON);
const out = {};
for (const c of cases) {
  const d = db.open();
  for (const t of ['usage_samples', 'window_readings', 'agent_parents', 'peer_agents', 'agents']) d.exec(`DELETE FROM ${t}`);
  for (const a of c.agents ?? []) {
    db.createAgent({ id: a.id, name: `n-${a.id}`, role: 'test', machine: 'test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: a.parent || null, session_id: null });
  }
  for (const [child, parent] of c.adopted ?? []) d.prepare('INSERT INTO agent_parents (child_id, parent_id) VALUES (?, ?)').run(child, parent);
  for (const p of c.peers ?? []) d.prepare("INSERT INTO peer_agents (id, name, machine, updated_at, parents) VALUES (?, ?, 'peer', ?, ?)").run(p.id, `n-${p.id}`, iso(T0), JSON.stringify(p.parents));
  for (const s of c.samples ?? []) {
    d.prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.agent, s.account ?? 'claude', 'claude', s.model ?? 'test-a', iso(T0 + s.minute * MIN), s.in ?? 0, s.out ?? 0, s.cr ?? 0, s.cw ?? 0);
  }
  for (const r of c.readings ?? []) {
    d.prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)')
      .run('claude', r.window ?? 'five_hour', iso(T0 + r.at), r.used, r.resets ?? null);
  }
  const results = [];
  for (const q of c.queries) {
    const now = T0 + q.now;
    if (q.kind === 'calibrate') {
      const cal = attr.calibrate('claude', q.window, T0 + (q.from ?? 0), now);
      results.push({
        intervals: cal.intervals.map((iv) => [iv.from, iv.to, num(iv.change), num(iv.weighted), num(iv.scale_before), num(iv.scale), iv.reset ?? '', num(iv.explained), num(iv.other), ...map(iv.agents).map((x) => `a:${x}`), ...map(iv.models).map((x) => `m:${x}`)].join(' ')),
        scale: num(cal.scale),
        current: cal.current ? `${iso(cal.current.at)} ${num(cal.current.used)} ${num(cal.current.resets_at)}` : '',
      });
    } else {
      const since = q.since == null ? undefined : T0 + q.since;
      const s = attr.windowShares('claude', q.window, since, now);
      const p = s.projection;
      const r = {
        shares: [s.since, num(s.change), num(s.other), num(s.scale), String(s.intervals), ...map(s.agents).map((x) => `a:${x}`), ...map(s.models).map((x) => `m:${x}`)].join(' '),
        projection: [num(p.used_percentage), num(p.percent_per_hour), p.reaches_100_at ?? 'null', p.resets_at ?? 'null', p.note ?? ''].join(' | '),
      };
      if (q.tree) {
        r.members = [...attr.treeMembers(q.tree)];
        r.tree = num(attr.treeShare(q.tree, 'claude', q.window, since, s));
      }
      results.push(r);
    }
  }
  out[c.name] = results;
}
console.log(JSON.stringify(out));
process.exit(0);
