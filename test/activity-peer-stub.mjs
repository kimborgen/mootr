#!/usr/bin/env node
// A machine for test/activity-peers.test.mjs (S-1079): the activity summary's modules on a throwaway home with
// one share of the realistic-scale fixture, no daemon.
//   node test/activity-peer-stub.mjs serve even   serves the digests and attribution routes on a port it prints,
//                                                 plus POST /mutate?agent=ID (one more hour of work, as an
//                                                 ingest) and GET /stats (digests served so far)
//   node test/activity-peer-stub.mjs summary all  prints the summary of its share as JSON (the union's)
// STAM_HOME, STAM_MACHINE and settings.json (itsa.home, cost accounts) come from the caller.
import { createServer } from 'node:http';
import * as db from '../src/db.ts';
import { seedScale, splitFixture } from './activity-fixture.mjs';
import { settled } from './activity-settled.mjs';
import * as summary from '../src/activity-summary.ts';
import { touched } from '../src/activity-changes.ts';

const [mode, part] = process.argv.slice(2);
const now = Number(process.env.SEED_NOW);
const f = seedScale(db, { agents: Number(process.env.PEER_AGENTS ?? 60), days: 3, now });
splitFixture(db, part, { itsas: process.env.ITSAS !== '0' });
// The `stam` pseudo-agent (decisions, voice) has usage rows on every machine; STAM_USD is this one's.
if (process.env.STAM_USD) db.open().prepare(`INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd) VALUES ('stam', '2026-10-15', 'claude', 'm', 'claude', ?, 0, 0, 0, 0, 0)`).run(Number(process.env.STAM_USD));

if (mode === 'summary') {
  const viewer = process.env.VIEWER || undefined;
  try {
    console.log(JSON.stringify(await settled({ days: 3, scope: process.env.SCOPE || undefined, now: now + 60_000, viewer })));
  } catch (e) {
    console.log(JSON.stringify({ error: String(e.message), status: e.status }));
  }
  process.exit(0);
}
if (mode === 'members') {
  // An issue ITSA, its worker (a member) and a worker that is none of: not the owner, creator, a participant or an ancestor's owner.
  const d = db.open();
  const x = d.prepare("SELECT id, key, owner, created_by, parent_id FROM itsas WHERE kind = 'issue' AND owner IS NOT NULL ORDER BY key DESC LIMIT 1").get();
  const related = new Set([x.owner, x.created_by, ...d.prepare('SELECT agent_id FROM itsa_participants WHERE itsa_id = ?').all(x.id).map((r) => r.agent_id)]);
  for (let p = x.parent_id; p; ) {
    const r = d.prepare('SELECT owner, parent_id FROM itsas WHERE id = ?').get(p);
    related.add(r?.owner);
    p = r?.parent_id;
  }
  const outsider = d.prepare("SELECT id FROM agents WHERE type = 'developer' ORDER BY id").all().map((r) => r.id).find((id) => !related.has(id));
  console.log(JSON.stringify({ key: x.key, member: x.owner, outsider }));
  process.exit(0);
}
let served = 0;
let pages = 0;
let bytes = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === '/api/health') return send(200, { ok: true });
    if (url.pathname === '/stats') return send(200, { served, pages, metrics: summary.summaryMetrics(), bytes });
    if (url.pathname === '/mutate') {
      const id = url.searchParams.get('agent');
      const d = db.open();
      const last = d.prepare('SELECT MAX(seq) AS s, MAX("end") AS e FROM activity_items WHERE agent_id = ?').get(id);
      const start = new Date(Date.parse(last.e)).toISOString();
      d.prepare(
        'INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out, category, category_source, confidence) VALUES (?, ?, 1, \'tool\', NULL, ?, ?, NULL, \'tool.test\', 0, 0, 0, 0, NULL, NULL, 1)',
      ).run(id, last.s + 1, start, new Date(Date.parse(start) + 3600_000).toISOString());
      touched(id, Date.parse(start));
      return send(200, { ok: true });
    }
    if (url.searchParams.get('by') === 'attribution') return send(200, summary.attributionExport(url.searchParams.get('sig'), Number(url.searchParams.get('events_after') ?? -1), url.searchParams.get('cont') === '1', url.searchParams.get('rows_since')));
    const page = await summary.digestsPage({
      days: Number(url.searchParams.get('days')),
      since: Number(url.searchParams.get('since')),
      epoch: url.searchParams.get('epoch') ?? '',
      after: url.searchParams.get('after') ?? '',
      now: now + 60_000,
      limit: Number(process.env.PAGE_LIMIT || 0) || undefined,
    });
    served += page.digests.length;
    pages++;
    const text = JSON.stringify(page);
    bytes += text.length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(text);
  } catch (e) {
    send(500, { error: String(e) });
  }
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
