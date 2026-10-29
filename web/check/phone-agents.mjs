// The phone Agents list (S-3281) on a test daemon seeded with seed-phone-list.mjs: node phone-agents.mjs BASE_URL OUT_DIR
// At 360 and 430 px it shows the Live list, the Archived list, a deep row with its cap and parent hint, a long-press
// menu, and the scope chips scrolled sideways; it taps a row and checks the agent's world opens, and drags the list
// by touch and checks no menu opens. Then it shoots the desktop at 1440 px. Prints one line per check; exits 1 on a fail.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node phone-agents.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const origin = new URL(base).origin;
const token = new URLSearchParams(new URL(base).hash.slice(1)).get('token') ?? '';
let failed = 0;
const check = (tag, name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ': ' + detail : ''}`); };

async function open(ctx) {
  const p = await ctx.newPage();
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('[data-nav="left"]', { timeout: 30000 });
  await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:agents'));
  await p.waitForSelector('section.agents-phone .arow', { timeout: 20000 });
  await p.waitForTimeout(400);
  return p;
}
// A short pause on the page, then a screenshot of the Agents list.
const shot = async (p, name) => { await p.waitForTimeout(300); await p.screenshot({ path: `${out}/${name}.png` }); };
const press = (p, id, ms) => p.evaluate(([id, ms]) => {
  const row = document.querySelector(`.arow[data-id="${id}"] .arow-main`);
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: r.left + 20, clientY: r.top + 10 }));
  return new Promise((res) => setTimeout(() => { row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' })); res(); }, ms));
}, [id, ms]);

for (const [name, device] of [['360', devices['Pixel 7']], ['430', devices['iPhone 15']]]) {
  const size = name === '360' ? { width: 360, height: 740 } : { width: 430, height: 860 };
  const ctx = await browser.newContext({ ...device, viewport: size, colorScheme: 'light' });
  const p = await open(ctx);
  const tag = name + '-light';
  const live = await p.locator('section.agents-phone .arow').count();
  check(tag, 'the Live list has at least the 26 live agents', live >= 26, `${live} rows`);
  const deepPad = await p.locator('.arow[data-id="pl-a6"]').evaluate((el) => el.style.paddingLeft);
  check(tag, 'a row 5 deep is capped at 3 levels (44 px)', deepPad === '44px', deepPad);
  const hint = await p.locator('.arow[data-id="pl-a6"] .arow-parent').textContent().catch(() => null);
  check(tag, 'a deep row shows its parent hint', !!hint && hint.includes('fixture-a-level4'), String(hint));
  await shot(p, `live-${name}`);
  // Deep row: scroll it into view and shoot the cap and the hint.
  await p.locator('.arow[data-id="pl-a6"]').scrollIntoViewIfNeeded();
  await shot(p, `deep-${name}`);

  // Chips scrolled sideways: the row overflows at this width or not; shot it scrolled to its end.
  const overflow = await p.locator('.agents-chips').evaluate((el) => el.scrollWidth - el.clientWidth);
  await p.locator('.agents-chips').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await shot(p, `chips-${name}`);
  check(tag, 'the scope chips do not wrap', (await p.locator('.agents-chips').evaluate((el) => el.getBoundingClientRect().height)) < 60, `overflow ${overflow}px`);

  // Archived list.
  await p.locator('.agents-chip[data-scope-chip="archived"]').tap();
  await p.waitForTimeout(300);
  const archived = await p.locator('section.agents-phone .arow').count();
  check(tag, 'Archived lists the archived agents (first page of 100)', archived === 40, `${archived} rows`);
  await shot(p, `archived-${name}`);
  // A folded archived parent keeps its chevron, and its archived child hides until it unfolds (S-3281).
  await p.locator('.arow[data-id="pl-r0"] [data-chev]').tap();
  await p.waitForTimeout(300);
  check(tag, 'a folded archived parent hides its archived child', (await p.locator('.arow[data-id="pl-r1"]').count()) === 0);
  check(tag, 'a folded archived parent says how many children it hides', (await p.locator('.arow[data-id="pl-r0"] .arow-kids').textContent().catch(() => '')) === '1 child');
  await p.locator('.arow[data-id="pl-r0"] [data-chev]').tap();
  await p.waitForTimeout(300);
  check(tag, 'unfolding the archived parent shows its child', (await p.locator('.arow[data-id="pl-r1"]').count()) === 1);
  await p.locator('.agents-chip[data-scope-chip="live"]').tap();
  await p.waitForTimeout(300);

  // Tap a row: the agent's world opens.
  await p.locator('.arow[data-id="pl-a0"] .arow-main').tap();
  await p.waitForTimeout(500);
  const world = await p.evaluate(() => window.stamDebug.shell.currentWorld());
  check(tag, 'a tap opens the agent\'s world', world === 'pl-a0', String(world));
  await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:agents'));
  await p.waitForSelector('section.agents-phone .arow', { timeout: 20000 });

  // Long press: the menu opens at the row, and the tap after it doesn't fire.
  await press(p, 'pl-a2', 600);
  await p.waitForTimeout(300);
  const menu = await p.locator('[role="menu"]').count();
  check(tag, 'a long press opens agentMenu', menu >= 1, `${menu} menu(s)`);
  await shot(p, `menu-${name}`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  const before = await p.evaluate(() => window.stamDebug.shell.currentWorld());
  check(tag, 'the menu closes and the hold did not open the agent', before !== 'pl-a2', String(before));

  // Scroll by touch: a drag past the slop cancels the hold, so no menu opens.
  await p.evaluate(() => {
    const row = document.querySelector('.arow[data-id="pl-a1"] .arow-main');
    const r = row.getBoundingClientRect();
    const fire = (type, y) => row.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: r.left + 20, clientY: y }));
    fire('pointerdown', r.top + 10);
    fire('pointermove', r.top + 60);
  });
  await p.waitForTimeout(600);
  check(tag, 'a touch drag over the list opens no menu', (await p.locator('[role="menu"]').count()) === 0);
  await p.evaluate(() => document.querySelector('.arow[data-id="pl-a1"] .arow-main').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' })));
  await ctx.close();
}

// At 320 px the chips overflow: the row scrolls sideways, and the page doesn't scroll sideways.
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 320, height: 640 }, colorScheme: 'light' });
  const p = await open(ctx);
  const tag = '320-light';
  const overflow = await p.locator('.agents-chips').evaluate((el) => el.scrollWidth - el.clientWidth);
  check(tag, 'the scope chips overflow and scroll sideways', overflow > 0, `${overflow}px`);
  await p.locator('.agents-chips').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await shot(p, 'chips-320');
  const page = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(tag, 'the page has no sideways scroll', page <= 0, `${page}px`);
  await ctx.close();
}

// Desktop at 1440, unchanged: the table, not the list.
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
const dp = await dctx.newPage();
await dp.goto(origin + '/#token=' + token);
await dp.waitForSelector('[data-nav="left"], .agents-desk, #tree', { timeout: 30000 }).catch(() => {});
await dp.evaluate(() => window.stamDebug.shell.showAgentWorld('w:agents'));
await dp.waitForSelector('section.agents-desk', { timeout: 20000 });
check('1440', 'the desk shows its table, not the phone list', (await dp.locator('section.agents-phone').count()) === 0 && (await dp.locator('section.agents-desk').count()) === 1);
await shot(dp, 'desk-1440');
await dctx.close();
await browser.close();
console.log(failed ? `${failed} failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
