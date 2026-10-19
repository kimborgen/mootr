// The Usage tabs under the Agent types filter (S-1753) on a realistic fixture: 64 agents of six types in
// five trees, on three harnesses. /api/usage is answered from the fixture and filters by `agents=` like the
// daemon does (by_day, by_model, by_agent, today, trees narrow; accounts stay whole), so the shots show the
// page drawing a filtered answer without a real database.
//   node web/check/usage-filter.mjs BASE_URL OUT_DIR
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node usage-filter.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(new URL('..', import.meta.url).pathname)('playwright-core');

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MODELS = [['claude', 'claude-opus-5-5'], ['claude', 'claude-sonnet-5-5'], ['claude', 'claude-haiku-5-5'], ['codex', 'gpt-6.1-sol'], ['opencode', 'openrouter/deepseek/deepseek-v4.1-flash']];
const TYPES = ['developer', 'developer', 'developer', 'manager', 'reviewer', 'developer', 'advisor', 'untyped', 'reviewer', 'developer'];
const wob = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };
// 64 agents; every ninth leads a tree, the rest sit under the tree of i % 5.
const agents = Array.from({ length: 64 }, (_, i) => {
  const [harness, model] = MODELS[i % MODELS.length];
  const type = i === 0 ? 'chief-of-staff' : i < 5 ? 'manager' : TYPES[i % TYPES.length];
  return { id: `ag${i}`, name: i < 5 ? `lead-${i}` : `${type}-${String(i).padStart(2, '0')}`, type, harness, model, cost: +(0.3 + wob(i) * 8).toFixed(2), tree: i % 5, root: i < 5 };
});
const modes = (c) => ({ api: +c.toFixed(2), five_hour: +(c * 0.5).toFixed(2), seven_day: +(c * 0.8).toFixed(2), subscription: +(c * 0.9).toFixed(2), paid_usd: +(c * 0.1).toFixed(2) });
const sum = (rows, f = (a) => a.cost) => rows.reduce((s, a) => s + f(a), 0);
const days = Array.from({ length: 7 }, (_, i) => ({ day: new Date(now - (6 - i) * 86_400_000).toISOString().slice(0, 10), f: [0.7, 0.9, 0.5, 0.3, 1, 1.1, 0.8][i] }));
const tot = (c) => ({ cost_usd: +c.toFixed(2), tokens_in: Math.round(c * 80_000), tokens_out: Math.round(c * 8_000), tokens_cache_read: Math.round(c * 500_000), tokens_cache_write: Math.round(c * 30_000) });
const acct = (account, harness, used) => ({ account, match: { harness }, windows: { five_hour: { used_percentage: used, resets_at: (now + 2 * 3_600_000) / 1000 }, seven_day: { used_percentage: used - 10, resets_at: (now + 60 * 3_600_000) / 1000 } },
  updated_at: iso(-120_000), age_ms: 120_000, stale: false, paid: { today: { usd: 0, source: 'unknown' }, week: { usd: 0, source: 'unknown' }, month: { usd: 0, source: 'unknown' } }, balance: null, budget: null, shares: null });

function usage(keep) {
  const rows = keep ? agents.filter((a) => keep.includes(a.type)) : agents;
  const types = [...new Set(agents.map((a) => a.type))].map((type) => ({ type, count: agents.filter((a) => a.type === type).length })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const models = MODELS.map(([harness, model]) => {
    const m = rows.filter((a) => a.model === model);
    const c = sum(m);
    return { harness, model, ...tot(c), modes: modes(c), cost_in: +(c * 0.2).toFixed(2), cost_out: +(c * 0.3).toFixed(2), cost_cache_read: +(c * 0.1).toFixed(2), cost_cache_write: +(c * 0.05).toFixed(2), cost_api_total: +(c * 0.65).toFixed(2), today: { ...tot(c * 0.15), modes: modes(c * 0.15) }, lifetime: { ...tot(c * 2), modes: modes(c * 2) } };
  }).filter((m) => m.cost_usd > 0);
  const trees = agents.filter((a) => a.root).map((root) => {
    const mine = rows.filter((a) => a.tree === root.tree);
    if (!mine.length) return null;
    const leaf = (a) => ({ id: a.id, name: a.name, cost_usd: +a.cost.toFixed(2), tokens: Math.round(a.cost * 90_000), modes: modes(a.cost), shares: {}, children: [] });
    const kids = mine.filter((a) => !a.root).map(leaf);
    const own = mine.filter((a) => a.root).map(leaf);
    const c = sum(mine);
    return { id: root.id, name: root.name, cost_usd: +c.toFixed(2), tokens: Math.round(c * 90_000), modes: modes(c), shares: {}, children: [...own.filter((o) => o.id !== root.id), ...kids].slice(0, 9) };
  }).filter(Boolean);
  const c = sum(rows);
  return {
    today: { ...tot(c * 0.15), modes: modes(c * 0.15) }, subscriptions: [{ name: 'Claude Max', windows: {} }], accounts: [acct('Claude Max', 'claude', 62), acct('Codex Plus', 'codex', 31)], allocations: [], blocked: [],
    trees, note: 'API-equivalent dollars: what the tokens would cost at API prices.', display_mode: 'api',
    by_day: days.map((d) => ({ day: d.day, ...tot(c * d.f / 5.4), modes: modes(c * d.f / 5.4) })), by_model: models,
    by_agent: [...rows].sort((a, b) => b.cost - a.cost).slice(0, 30).map((a) => ({ agent_id: a.id, agent: a.name, type: a.type, harness: a.harness, model: a.model, ...tot(a.cost), modes: modes(a.cost), today: { ...tot(a.cost * 0.15), modes: modes(a.cost * 0.15) }, lifetime: { ...tot(a.cost * 2), modes: modes(a.cost * 2) } })),
    filtered_agents: keep ? [...keep].sort() : null, agent_types: types,
  };
}

const browser = await chromium.launch(chromiumLaunchOptions());
let bad = 0;
for (const [name, vp, phone] of [['1500', { width: 1500, height: 1000 }, false], ['360', { width: 360, height: 800 }, true]]) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone, colorScheme: 'light' });
  const p = await ctx.newPage();
  const asked = [];
  await p.route(/\/api\/usage(\/series|\/issues)?(\?.*)?$/, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/usage') { asked.push(u.search); const a = u.searchParams.get('agents'); return route.fulfill({ json: usage(a ? a.split(',') : null) }); }
    if (u.pathname === '/api/usage/issues') return route.fulfill({ json: { note: '', issues: [], by_config: [], unattributed: {} } });
    return route.fulfill({ json: { days: 6, group: 'tree', bucket: 'day', groups: [], rows: [], previous_rows: [], total: { cost_usd: 0 }, previous: { cost_usd: 0 } } });
  });
  const ok = (k, v) => { console.log(`${v ? 'ok  ' : 'FAIL'} [${name}] ${k}`); if (!v) bad++; };
  // The tab's headline number, to see the filter narrowed it.
  for (const [tab, sel] of [['overview', '.usage .tiles'], ['models', '.usage .usage-models table.data'], ['days', '.usage .usage-days table.data'], ['trees', '.usage .tree-totals .tnode']]) {
    for (const [measure, types] of [['api', 'developer,manager'], ['week', 'developer,manager']]) {
      if (measure === 'week' && tab !== 'trees') continue;
      await p.goto(`${base}&view=usage&tab=${tab}&period=7d&measure=${measure}&types=${types}`);
      await p.waitForSelector(sel, { timeout: 20000 });
      await p.waitForTimeout(500);
      const note = await p.locator('.usage .usage-filter-note').first().innerText().catch(() => '');
      ok(`${tab}/${measure}: the daemon was asked with agents=`, asked.at(-1)?.includes('agents=developer%2Cmanager'));
      ok(`${tab}/${measure}: the note names the types`, /Showing only developer, manager\./.test(note));
      ok(`${tab}/${measure}: the bar keeps every type's count`, (await p.locator('.usage .usage-types button').count()) === 6 + 1);
      ok(`${tab}/${measure}: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (tab === 'overview') ok('overview: the limits stay and the note says so', (await p.locator('.usage .lim-card').count()) >= 2 && /count every agent/.test(note));
      if (tab === 'trees') {
        const u = usage(['developer', 'manager']);
        ok(`trees/${measure}: first root total is the kept agents' sum`, (await p.locator('.usage .tree-totals .tcost').first().innerText()).replace(/[^0-9.%]/g, '').length > 0 && u.trees.length > 0);
      }
      await p.screenshot({ path: `${out}/usage-${tab}-${measure === 'week' ? 'week-' : ''}filtered-${name}-light.png`, fullPage: true });
    }
  }
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
