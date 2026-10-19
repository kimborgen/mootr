// The Usage Overview's limits band and tiles on a realistic fixture: three accounts, one near its
// limit, a stale one, an OpenRouter credit with a budget and an allocation, a blocked agent.
//   node web/check/limits.mjs BASE_URL OUT_DIR
// /api/usage, /api/usage/series and /api/usage/issues are answered from the fixture below, so the
// shots show how the page draws data it can't always get from a throwaway daemon. Models are paired
// with their real harness (Claude Code: Opus, Sonnet, Haiku; Codex: gpt-6.1-sol; OpenCode: DeepSeek).
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node limits.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(new URL('..', import.meta.url).pathname)('playwright-core');

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const H = 3_600_000;
const proj = (used, rate, resetsInMs, hitInMs) => ({ estimate: true, used_percentage: used, percent_per_hour: rate, reaches_100_at: hitInMs ? iso(hitInMs) : null, resets_at: iso(resetsInMs), ...(hitInMs ? {} : { note: 'resets before reaching 100%' }) });
const shares = (p) => ({ estimate: true, since: iso(-5 * H), change: 5, other: 1, agents: [], trees: [], projection: p });
const acct = (account, harness, windows, over = {}) => ({ account, match: { harness }, windows, updated_at: iso(-2 * 60_000), age_ms: 2 * 60_000, stale: false, paid: { today: { usd: null, source: 'unknown' }, week: { usd: null, source: 'unknown' }, month: { usd: null, source: 'unknown' } }, balance: null, budget: null, shares: null, ...over });
const accounts = [
  // Claude's paid estimate is 0 with an unknown source (src/readings.ts): it must not read as $0.00.
  acct('Claude Max', 'claude', { five_hour: { used_percentage: 62, resets_at: (now + 1.2 * H) / 1000 }, seven_day: { used_percentage: 48, resets_at: (now + 70 * H) / 1000 } },
    { paid: { today: { usd: 0, source: 'unknown' }, week: { usd: 0, source: 'unknown' }, month: { usd: 0, source: 'unknown' } }, shares: { five_hour: shares({
      // The 7-day pace at 100% on a five-hour meter (S-1604): its wider tick must stay whole at the right edge, apart from the 24h tick.
      ...proj(62, 9, 1.2 * H, 0.7 * H),
      pace_7d: { estimate: true, percent_per_hour: 9, covered_hours: 160, at_reset: 100, reaches_100_at: iso(0.7 * H) },
      pace_24h: { estimate: true, percent_per_hour: 4, covered_hours: 22, at_reset: 85, reaches_100_at: null },
    }), seven_day: shares({
      // A quiet week and a busy last day (S-1523): 7-day pace ends near 62%, the 24h pace reaches 100% first.
      ...proj(48, 0.5, 70 * H),
      pace_7d: { estimate: true, percent_per_hour: 0.2, covered_hours: 160, at_reset: 62, reaches_100_at: null },
      pace_24h: { estimate: true, percent_per_hour: 1.1, covered_hours: 22, at_reset: 100, reaches_100_at: iso(47 * H) },
    }) } }),
  acct('Codex Plus', 'codex', { five_hour: { used_percentage: 12, resets_at: (now + 3 * H) / 1000 }, seven_day: { used_percentage: 71, resets_at: (now + 40 * H) / 1000 } },
    { age_ms: 95 * 60_000, stale: true, paid: { today: { usd: 0, source: 'unknown' }, week: { usd: 0, source: 'unknown' }, month: { usd: 0, source: 'estimate' } }, shares: { five_hour: shares(proj(12, 2, 3 * H)), seven_day: shares(proj(71, 0.6, 40 * H)) } }),
  acct('openrouter', 'opencode', {}, { balance: 6.2, paid: { today: { usd: 0.4, source: 'exact' }, week: { usd: 1.9, source: 'exact' }, month: { usd: 3.8, source: 'exact' } }, budget: { usd: 10, per: 'month', spent: 3.8, remaining: 6.2 } }),
  // Stam's own model calls, on their own budget (S-1077): low at 90%. Drawn in the Agents/System split, not as a card.
  acct('openrouter-system', 'stam', {}, { paid: { today: { usd: 2.7, source: 'exact' }, week: { usd: 2.7, source: 'exact' }, month: { usd: 2.7, source: 'exact' } }, budget: { usd: 3, per: 'day', spent: 2.7, remaining: 0.3 } }),
];
const days = Array.from({ length: 7 }, (_, i) => ({ day: new Date(now - (6 - i) * 86_400_000).toISOString().slice(0, 10), cost_usd: [52, 61, 24, 12, 64, 71, 81][i], tokens_in: 1000, tokens_out: 1000 }));
const prevDays = Array.from({ length: 7 }, (_, i) => ({ day: new Date(now - (13 - i) * 86_400_000).toISOString().slice(0, 10), cost_usd: [40, 35, 50, 42, 38, 55, 50][i] }))
const tot = (c) => ({ cost_usd: c, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0 });
const row = (agent, harness, model, today) => ({ agent, harness, model, today: tot(today), lifetime: tot(today) });
const issue = (key, config, cost, daysAgo) => ({ key, title: key, kind: 'issue', status: 'done', closed_at: iso(-daysAgo * 86_400_000), own: { ...tot(cost), manager_cost_usd: 0 }, total: tot(cost), agents: 1, config, weekly_percent: null });
const fixture = {
  '/api/usage': (real) => ({ ...real, accounts, openrouter_reserve: { reserve: 1, remaining: 0.3 }, by_day: days, today: { ...real.today, cost_usd: 81 },
    allocations: [{ id: 'a1', root: 'helper', root_id: 'x', account: 'openrouter', kind: 'usd', window: '', percent: null, amount: 5, period: 'month', used: 1.2, used_percent: 24 }],
    blocked: [{ agent_id: 'none', agent: 'kid', lifecycle: 'paused', paused_by: [], blockers: [{ kind: 'limit', account: 'Claude Max', reason: 'five-hour window at 100%', since: iso(-H), clear: null }] }],
    by_agent: [row('cos', 'claude', 'claude-opus-5-5', 21), row('oss-sweep', 'opencode', 'openrouter/deepseek/deepseek-v4.1-flash', 12), row('rev', 'codex', 'gpt-6.1-sol', 8), row('dev', 'claude', 'claude-haiku-5-5', 3)] }),
  '/api/usage/series': () => ({ days: 6, group: 'tree', bucket: 'day',
    groups: [{ id: 'cos', name: 'cos' }, { id: 'oss', name: 'oss-sweep' }, { id: 'auth', name: 'human-auth' }],
    rows: days.map((d) => ({ t: d.day, cost_usd: d.cost_usd, groups: { cos: { cost_usd: d.cost_usd * 0.5 }, oss: { cost_usd: d.cost_usd * 0.3 }, auth: { cost_usd: d.cost_usd * 0.2 } } })),
    previous_rows: prevDays.map((d) => ({ t: d.day, cost_usd: d.cost_usd, groups: { cos: { cost_usd: d.cost_usd * 0.5 }, oss: { cost_usd: d.cost_usd * 0.3 }, auth: { cost_usd: d.cost_usd * 0.2 } } })),
    total: { cost_usd: 365 }, previous: { cost_usd: 310 } }),
  '/api/usage/issues': () => ({ note: '', issues: [issue('S-641', 'claude · claude-opus-5-5', 18.4, 1), issue('S-628', 'claude · claude-sonnet-5-5', 11.2, 2), issue('S-633', 'opencode · openrouter/deepseek/deepseek-v4.1-flash', 0.9, 3), issue('S-619', 'claude · claude-haiku-5-5', 2.1, 5), issue('S-600', 'codex · gpt-6.1-sol', 4.4, 20)], by_config: [], unattributed: tot(0) }),
};

const browser = await chromium.launch(chromiumLaunchOptions());
let bad = 0;
for (const [name, vp, phone] of [['1440', { width: 1440, height: 1000 }, false], ['360', { width: 360, height: 2400 }, true]]) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone, colorScheme: 'light' });
  const p = await ctx.newPage();
  await p.route(/\/api\/usage(\/series|\/issues)?(\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const f = fixture[path];
    if (!f) return route.continue();
    const real = path === '/api/usage' ? await (await route.fetch()).json() : null;
    await route.fulfill({ json: f(real) });
  });
  await p.goto(base + '&view=usage&tab=overview&period=7d');
  await p.waitForSelector('.usage .lim-card', { timeout: 20000 });
  await p.waitForTimeout(800);
  const checks = {
    'three limit cards': (await p.locator('.usage .lim-band > .lim-cards > .lim-card').count()) === 3,
    'a hatched forecast on a meter': (await p.locator('.usage .lim-meter .proj').count()) >= 2,
    'the warning 100% line': /100% ≈/.test(await p.locator('.usage .lim-band > .lim-cards > .lim-card').first().innerText()),
    'a stale reading says so': /stale, 95 min old/.test(await p.locator('.usage .lim-band > .lim-cards > .lim-card').nth(1).innerText()),
    'credit on the agents account': /left/.test(await p.locator('.usage .lim-band > .lim-cards > .lim-card').nth(2).innerText()),
    'agents and system budgets side by side': (await p.locator('.usage .lim-split-card').count()) === 2 && /Agents[\s\S]*of \$10(\.00)?\/month/.test(await p.locator('.usage .lim-split-card').nth(0).innerText()) && /System[\s\S]*of \$3(\.00)?\/day/.test(await p.locator('.usage .lim-split-card').nth(1).innerText()),
    'the low system budget is flagged': (await p.locator('.usage .lim-split-card.low .badge.warn').count()) === 1,
    'the system reserve line is flagged low at the credit left': /Reserve \$1(\.00)? · credit left \$0\.30/.test(await p.locator('.usage .lim-split-card .lim-reserve.low').innerText().catch(() => '')),
    'the split is two across on desktop and one column on the phone': await p.evaluate((phone) => { const [a, b] = [...document.querySelectorAll('.usage .lim-split-card')].map((e) => e.getBoundingClientRect()); return phone ? a.left === b.left && b.top > a.top : a.top === b.top && b.left > a.left; }, phone),
    'trend up 18%': /▲ 18%/.test(await p.locator('.usage .tiles').innerText()),
    'a blocked line with Open': await p.locator('.usage .lim-blocked .btn', { hasText: 'Open' }).isVisible(),
    'no $0.00 on a subscription card': !/\$0\.00/.test(await p.locator('.usage .lim-band > .lim-cards > .lim-card').first().innerText() + await p.locator('.usage .lim-band > .lim-cards > .lim-card').nth(1).innerText()),
    'real money counts both OpenRouter accounts': /Real money · month\s*\$6\.50/i.test((await p.locator('.usage .tiles').innerText()).replace(/\n/g, ' ')),
    'no sideways scroll': await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  };
  for (const [k, v] of Object.entries(checks)) { console.log(`${v ? 'ok  ' : 'FAIL'} [${name}] ${k}`); if (!v) bad++; }
  await p.screenshot({ path: `${out}/limits-${name}-light.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
