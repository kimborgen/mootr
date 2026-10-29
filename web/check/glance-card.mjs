// The phone Work page's cards are the board's issue card, drawn from the issue layout (S-3560, S-1438 PR 9), in the
// real app on a throwaway daemon: the phone at 360 (light, dark) and 430, the same Work items on the desktop board at
// 1440, and a layout change (the owner moved from META to BADGES, as the editor saves it) that reaches an open phone page
// and a reloaded one. Each page is asserted to be as wide as asked.
//   node web/check/glance-card.mjs BASE_URL OUT_DIR
// It writes the issue layout to the daemon's settings, so it needs a throwaway daemon. Exits 1 when a check fails.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node glance-card.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const hash = new URLSearchParams(u.hash.slice(1));
const token = hash.get('token') ?? '';
const testHuman = hash.get('testHuman') ?? '';
const origin = u.origin;
const human = { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'x-stam-test-human': testHuman, 'content-type': 'application/json' };
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed++; };

const layout = (owner) => ({
  slots: { TOP: ['parent', 'kind', 'health'], META: owner === 'meta' ? ['status', 'rollup', 'links', 'owner'] : ['status', 'rollup', 'links'], BADGES: owner === 'meta' ? [] : ['owner'], FOOT: [] },
  titleLines: 3, seen: [], chosen: true,
});
const saveLayout = (owner) => fetch(origin + '/api/config/settings', { method: 'PATCH', headers: human, body: JSON.stringify({ patch: { cardLayouts: { issue: layout(owner) } } }) });

const browser = await chromium.launch(chromiumLaunchOptions());
const open = async (device, viewport, scheme) => {
  const ctx = await browser.newContext({ ...device, viewport, colorScheme: scheme });
  await ctx.addInitScript((s) => { try { localStorage.setItem('stam/theme', s) } catch {} }, scheme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  await p.route('**/api/config/settings', (route) => route.continue({ headers: { ...route.request().headers(), 'x-stam-test-human': testHuman } }));
  p.on('pageerror', (e) => check(`no page errors (${viewport.width})`, false, e.message));
  await p.goto(`${origin}/#token=${token}&testHuman=${testHuman}`);
  return { ctx, p };
};
const glance = async (p) => {
  await p.waitForSelector('#tree .node', { state: 'attached', timeout: 20000 });
  if (!(await p.locator('#tree .node').first().isVisible())) await p.locator('[data-nav="left"]').tap();
  await p.locator('[data-nav="issues"]').tap();
  await p.locator('#issues-work').tap();
  await p.locator('.work-view:visible .w-glance').waitFor();
  await p.waitForSelector('.wg-card .bcard');
};
const wide = async (p, w, name) => check(`${name}: the page is ${w} px wide, no sideways scroll`, await p.evaluate((w) => innerWidth === w && document.documentElement.scrollWidth <= w, w));
const shot = async (p, name) => { await p.waitForTimeout(500); await p.screenshot({ path: `${out}/${name}.png` }); };
const badgesOf = (p) => p.locator('.wg-card .bc-badges').count();

await saveLayout('meta');
for (const [name, device, width, height, scheme] of [['360-light', devices['Pixel 7'], 360, 740, 'light'], ['360-dark', devices['Pixel 7'], 360, 740, 'dark'], ['430-light', devices['iPhone 15'], 430, 860, 'light']]) {
  const { ctx, p } = await open(device, { width, height }, scheme);
  await glance(p);
  await wide(p, width, `phone ${name}`);
  check(`phone ${name}: the cards are the board's issue card, with its key, title and status`, await p.locator('.wg-card .bcard .ikey').count() > 0 && await p.locator('.wg-card .bcard .bc-title').count() > 0 && await p.locator('.wg-card .bcard .bc-status').count() > 0);
  check(`phone ${name}: no move button on a card`, await p.locator('.wg-card .bc-menu').count() === 0);
  await shot(p, `phone-${name}`);
  if (name === '360-light') {
    // A right-click stands in for the long-press (the same menu): it names the link, since the card shows icons only.
    const link = p.locator('.wg-card [data-cell=github] .bc-link, .wg-card [data-cell=branch] .bc-link').first();
    await link.scrollIntoViewIfNeeded();
    await link.click({ button: 'right' });
    await p.waitForSelector('.menu');
    const name = await link.getAttribute('aria-label');
    check('phone 360-light: the link menu names the link', !!name && (await p.locator('.menu').innerText()).includes(name), name);
    check('phone 360-light: the link menu offers a way to open it', (await p.locator('.menu').innerText()).includes('Open'), '');
    // A link cell has no filter value to filter to: no (Blank) Filter or Exclude (S-3608).
    const phoneMenu = await p.locator('.menu').innerText()
    check('phone 360-light: the link menu offers no Filter or Exclude', !phoneMenu.includes('Filter to this value') && !phoneMenu.includes('Exclude this value'), phoneMenu)
    await shot(p, 'phone-360-light-link-menu');
    await p.keyboard.press('Escape');
    check('phone 360-light: the default layout has no badges row', await badgesOf(p) === 0);
    // The owner moves to BADGES: the open page redraws on its next settings read, and a reload shows it.
    await saveLayout('badges');
    await p.waitForFunction(() => document.querySelectorAll('.wg-card .bc-badges').length > 0, null, { timeout: 15000 }).then(() => check('phone 360-light: a saved layout redraws the open page', true), () => check('phone 360-light: a saved layout redraws the open page', false, 'no badges row in 15 s'));
    await shot(p, 'phone-360-light-owner-in-badges');
    await p.reload();
    await glance(p);
    check('phone 360-light: after a reload the badges row is still there', await badgesOf(p) > 0);
    await saveLayout('meta');
  }
  await ctx.close();
}
{
  const { ctx, p } = await open({}, { width: 1440, height: 900 }, 'light');
  await p.waitForFunction(() => window.stamDebug?.shell);
  await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:board:all'));
  await p.waitForSelector('.board-view .bcard', { timeout: 20000 });
  await wide(p, 1440, 'desktop board');
  await shot(p, 'desktop-board-1440');
  // The table's right-click menu on a links cell: it names the link, as the phone's long-press menu does.
  await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:work'));
  await p.waitForSelector('.w-row .w-link-body', { timeout: 20000 });
  await wide(p, 1440, 'desktop table');
  const chip = p.locator('.w-row:not(.w-need) .w-link.k-github .w-link-body').first();
  const label = (await chip.innerText()).trim();
  await chip.click({ button: 'right' });
  await p.waitForSelector('.menu');
  check('desktop table: the links cell menu names the link and offers Open', (await p.locator('.menu').innerText()).includes(label) && (await p.locator('.menu').innerText()).includes('Open'), label);
  // A link cell has no filter value to filter to: no (Blank) Filter or Exclude (S-3608).
  const tableMenu = await p.locator('.menu').innerText()
  check('desktop table: the links cell menu offers no Filter or Exclude', !tableMenu.includes('Filter to this value') && !tableMenu.includes('Exclude this value'), tableMenu)
  await shot(p, 'desktop-table-link-menu-1440');
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
