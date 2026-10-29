#!/usr/bin/env node
// S-2848 B5b: src/reconcile.ts run on the cases of recon_matches_test.go, over a throwaway home. Argv: the case list as
// JSON. Prints {case name: {usage, recon}} as JSON: every usage row (agent|day|account|cost_usd|unreconciled_usd, sorted)
// and ledger_recon's row (billed_used|carry|exact_pending) after the case's steps. Each case starts from empty tables.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-recon-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `recon-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
// One OpenRouter account by its match, and a subscription account whose rows reconciliation never reads.
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ peers: [], cost: { accounts: { 'or-team': { match: { harness: 'opencode', model: 'openrouter/' } }, claude: { match: { harness: 'claude' } } } } }),
);

const db = await import(new URL('src/db.ts', root));
const recon = await import(new URL('src/reconcile.ts', root));

const report = db.open().prepare(
  `INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, unreconciled_usd) VALUES (?, ?, 'opencode', 'openrouter/m', ?, ?, ?)
   ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, unreconciled_usd = unreconciled_usd + excluded.unreconciled_usd`,
);
const fmt = (v) => (v == null ? 'NULL' : String(v));

const cases = JSON.parse(process.argv[2]);
const out = {};
for (const c of cases) {
  db.open().exec('DELETE FROM usage; DELETE FROM ledger_recon');
  let snap = { rows: [] };
  for (const s of c.steps) {
    switch (s.op) {
      // A report: cost_usd and, on an OpenRouter account, unreconciled_usd grow by usd (src/usage.ts report).
      case 'report':
        report.run(s.agent, s.day, s.account, s.usd, s.account === 'claude' ? 0 : s.usd);
        break;
      case 'exact':
        recon.addExactPending(s.usd);
        break;
      case 'snap':
        snap = recon.snapshot();
        break;
      case 'reconcile':
        recon.reconcile(snap, s.total);
        break;
      default:
        throw new Error(`unknown op ${s.op}`);
    }
  }
  const usage = db.open().prepare('SELECT agent_id, day, account, cost_usd, unreconciled_usd FROM usage ORDER BY agent_id, day, account').all()
    .map((r) => [r.agent_id, r.day, r.account, fmt(r.cost_usd), fmt(r.unreconciled_usd)].join('|'));
  const r = db.open().prepare('SELECT billed_used, carry, exact_pending FROM ledger_recon WHERE id = 1').get();
  out[c.name] = { usage, recon: r ? [fmt(r.billed_used), fmt(r.carry), fmt(r.exact_pending)].join('|') : '' };
}
console.log(JSON.stringify(out));
process.exit(0);
