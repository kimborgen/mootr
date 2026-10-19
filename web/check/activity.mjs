// The Activity tab (S-1011, S-1012) at 360 px light and dark and at 1440 px light: the tiles, Where
// the time goes, the Bottlenecks, What finished issues cost and Agents by tree draw, one column on a
// phone (tiles, time, bottlenecks, finished-issue costs, agents by tree) with no sideways scroll and
// touch-sized controls, two columns on a desktop, Cost switches the categories and Show all opens
// every bottleneck. Tapping a tree scopes the tab (the crumb and the URL say so) and back clears it.
// Run it with the realistic fixture so it is checked at real scale:
//   SEED_ACTIVITY=1 web/check/run.sh activity
// Screenshots (whole page): OUT_DIR/activity-<size>-<theme>.png, and activity-scoped-<size>-<theme>.png
// for the scoped tab. Exits 1 if any check failed.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out, ...flags] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node activity.mjs BASE_URL OUT_DIR [--only=360-light]'); process.exit(2); }
const only = flags.find((f) => f.startsWith('--only='))?.slice(7);
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';

const SIZES = [
  { tag: '360-light', theme: 'light', phone: true, viewport: { width: 360, height: 740 } },
  { tag: '360-dark', theme: 'dark', phone: true, viewport: { width: 360, height: 740 } },
  { tag: '1440-light', theme: 'light', viewport: { width: 1440, height: 900 } },
];
let failed = 0;
// The page scrolls inside its pane, so a full-page shot is the viewport: grow the viewport to the
// Usage pane's content for the shot, then put it back.
const tall = async (p, s, path) => {
  const h = await p.evaluate(() => { const u = document.querySelector('.usage'); let el = u; while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement; return Math.ceil((el?.scrollHeight ?? 0) - (el?.clientHeight ?? 0) + innerHeight); });
  await p.setViewportSize({ width: s.viewport.width, height: Math.max(s.viewport.height, h) });
  await p.waitForTimeout(400);
  await p.screenshot({ path });
  await p.setViewportSize(s.viewport);
};
const check = (tag, name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ': ' + String(detail).slice(0, 300) : ''}`);
};

const browser = await chromium.launch(chromiumLaunchOptions());
for (const s of SIZES) {
  if (only && only !== s.tag) continue;
  const ctx = await browser.newContext(s.phone ? { ...devices['Pixel 7'], viewport: s.viewport, colorScheme: s.theme } : { viewport: s.viewport, colorScheme: s.theme })
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t) } catch {} }, s.theme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(30000);
  p.on('pageerror', (e) => check(s.tag, 'no page error', false, e.message));
  try {
    await p.goto(`${u.origin}/#token=${token}&view=usage&tab=activity&period=7d`);
    await p.waitForSelector('.usage .activity-tab .ax-tiles');
    await p.waitForTimeout(500);
    const tiles = await p.locator('.ax-tiles .mb-mlabel').allTextContents();
    check(s.tag, 'the four tiles', tiles.join('|') === 'Working|Waiting on you|Friction|Cost per working hour', tiles.join('|'));
    check(s.tag, 'the clock has a legend row per group', await p.locator('.ax-time [data-group]').count() === 5);
    // The bound comes from the rows' kinds, not a count: at most five ranked categories, then at most
    // one "N more" and one Unclassified, which comes last.
    const cats = await p.locator('.ax-time [data-category]').evaluateAll((els) => els.map((e) => e.getAttribute('data-category')));
    const ranked = cats.filter((k) => k !== 'more' && k !== 'unclassified');
    const uncl = cats.indexOf('unclassified');
    check(s.tag, 'working by category: five ranked, then N more and Unclassified last', cats.length >= 1 && ranked.length <= 5
      && cats.filter((k) => k === 'more').length <= 1 && (uncl === -1 || uncl === cats.length - 1) && (!cats.includes('more') || ranked.length === 5), cats.join(','));
    const bns = await p.locator('.ax-bn').count();
    check(s.tag, 'the top eight bottlenecks at most', bns >= 1 && bns <= 8, bns);
    check(s.tag, 'no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('.activity-tab *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 1)));
    const cfgs = await p.locator('.ax-cfg tbody tr').count();
    check(s.tag, 'finished-issue costs: a row per model, each with a range mark', cfgs >= 1 && await p.locator('.ax-cfg .ax-range .dt').count() === cfgs, cfgs);
    const roots = await p.locator('.ax-tree:not(.child)').count();
    check(s.tag, 'agents by tree: the top eight roots at most, with children', roots >= 1 && roots <= 8 && await p.locator('.ax-tree.child').count() >= 1, roots);
    const box = async (sel) => p.locator(sel).first().boundingBox();
    const [tb, time, bn, cfg, trees] = [await box('.ax-tiles'), await box('.ax-time'), await box('.ax-bottlenecks'), await box('.ax-configs'), await box('.ax-trees')];
    if (s.phone) {
      const order = [tb, time, bn, cfg, trees]
      check(s.tag, 'one column: tiles, time, bottlenecks, finished-issue costs, agents by tree', order.every((b, i) => i === 0 || (order[i - 1].y + order[i - 1].height <= b.y + 1 && Math.abs(b.x - time.x) < 1 && Math.abs(b.width - tb.width) < 2)), JSON.stringify(order));
      check(s.tag, 'controls meet the touch size', await p.evaluate(() => [...document.querySelectorAll('.activity-tab button:not(.ax-agent-name)')].filter((b) => b.offsetParent).every((b) => b.getBoundingClientRect().height >= 43.5)));
    } else {
      check(s.tag, 'two columns: time left, bottlenecks right', time.x < bn.x && Math.abs(time.y - bn.y) < 2, JSON.stringify({ time, bn }));
      check(s.tag, 'finished-issue costs under the time, agents by tree under the bottlenecks', Math.abs(cfg.x - time.x) < 1 && cfg.y >= time.y + time.height && Math.abs(trees.x - bn.x) < 1 && trees.y >= bn.y + bn.height, JSON.stringify({ cfg, trees }));
    }
    await tall(p, s, `${out}/activity-${s.tag}.png`);
    // Cost switches the categories to their estimated cost; Show all opens every bottleneck.
    await p.locator('.ax-time .seg button:has-text("Cost")').click();
    check(s.tag, 'Cost marks the categories est.', (await p.locator('.ax-cat-label').innerText()).includes('est.'));
    const more = p.locator('.ax-bottlenecks .ax-more');
    if (await more.count()) {
      const n = Number((await more.innerText()).match(/\d+/)?.[0]);
      await more.click();
      check(s.tag, 'Show all opens every bottleneck', await p.locator('.ax-bn').count() === n, n);
    }
    await tall(p, s, `${out}/activity-cost-all-${s.tag}.png`);
    // Tapping the first tree scopes the whole tab: the crumb names it, the URL carries it, back clears it.
    const first = p.locator('.ax-tree:not(.child)').first();
    const name = await first.locator('b').innerText();
    await first.click();
    // Wait on state, not time: the crumb names the tree, the URL carries it, and the scoped answer
    // has drawn (one root).
    const scopedNow = (want) => p.waitForFunction((n) => {
      const crumb = document.querySelector('.ax-scope')?.textContent ?? '';
      return decodeURIComponent(location.hash).includes('scope=tree:') && crumb.includes(n) && !!document.querySelector('.ax-scope .ax-crumb')
        && document.querySelectorAll('.ax-tree:not(.child)').length === 1;
    }, want, { timeout: 30000 });
    await scopedNow(name).catch(() => {});
    check(s.tag, 'a tapped tree scopes the tab', (await p.locator('.ax-scope').innerText()).includes(name) && decodeURIComponent(p.url()).includes('scope=tree:'), p.url());
    const kids = await p.locator('.ax-tree.child').count();
    const showAll = p.locator('.ax-trees .ax-tree-more');
    check(s.tag, 'scoped: one root, its top ten children at most', await p.locator('.ax-tree:not(.child)').count() === 1 && kids >= 1 && kids <= 10, kids);
    check(s.tag, 'scoped: no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('.activity-tab *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 1)));
    await tall(p, s, `${out}/activity-scoped-${s.tag}.png`);
    if (await showAll.count()) {
      const n = Number((await showAll.innerText()).match(/\d+/)?.[0]);
      await showAll.click();
      await p.waitForFunction((m) => document.querySelectorAll('.ax-tree.child').length === m, n, { timeout: 10000 }).catch(() => {});
      check(s.tag, 'scoped: Show all lists every child', await p.locator('.ax-tree.child').count() === n, n);
    }
    await p.goBack();
    await p.waitForFunction(() => !decodeURIComponent(location.hash).includes('scope=') && !document.querySelector('.ax-scope .ax-crumb') && !!document.querySelector('.ax-tiles'), null, { timeout: 30000 }).catch(() => {});
    check(s.tag, 'back clears the scope', !(await p.locator('.ax-scope .ax-crumb').count()), await p.locator('.ax-scope').innerText());
  } catch (e) {
    check(s.tag, 'activity tab', false, e.message.split('\n')[0]);
    await p.screenshot({ path: `${out}/failed-activity-${s.tag}.png`, fullPage: true }).catch(() => {});
  }
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
