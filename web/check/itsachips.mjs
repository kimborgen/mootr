// An agent's tab links to the ITSAs it owns at the top (S-1452), on a desktop and at 360 px, against
// a test daemon (daemon.sh): a project with an issue under it shows the project alone; two more at
// the top show side by side, and fold into an `N ITSAs` pill in a narrow tab; the chip opens the ITSA
// and never selects or closes the tab. No model runs. Screenshots: OUT_DIR/itsa-chips-*.png.
//   web/check/run.sh itsachips
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node itsachips.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
const call = (method, path, body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'content-type': 'application/json', ...(testHuman ? { 'x-stam-test-human': testHuman } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
let failures = 0;
// The tab's name keeps at least --size-tab-name-min (the active tab of the focused pane).
const floor = async (p, tag, sel = '#w-main .tab.active .label') => {
  const { w, min } = await p.evaluate((q) => ({ w: document.querySelector(q)?.getBoundingClientRect().width ?? 0, min: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size-tab-name-min')) }), sel);
  check(tag, w >= min, `the tab name keeps its ${min} px floor`, w);
};
const check = (tag, ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${JSON.stringify(detail)})`}`); if (!ok) failures++; };

const agent = (await call('GET', '/api/agents')).find((a) => a.lifecycle === 'active');
if (!agent) { console.error('no active agent'); process.exit(2); }
const make = (title, parent) => call('POST', '/api/itsas', { title, parent, owner: agent.id });
const project = await make('Check: Desktop UX');
const child = await make('Check: Tabs under it', project.id);
const browser = await chromium.launch(chromiumLaunchOptions());

async function run(tag, phone) {
  const ctx = await browser.newContext({ colorScheme: 'light', ...(phone ? { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } } : { viewport: { width: 1440, height: 900 } }) });
  if (testHuman) await ctx.route(`${origin}/api/**`, (r) => (r.request().method() === 'GET' ? r.continue() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } })));
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { state: 'attached', timeout: 20000 });
  if (phone) { await p.locator('[data-nav="left"]').tap(); await p.waitForTimeout(300); await p.locator(`#tree .node[data-id="${agent.id}"] .name`).first().tap(); }
  else await p.locator(`#tree .node[data-id="${agent.id}"] .name`).first().click();
  const tab = p.locator(`#w-main .tab[data-key="agent:${agent.id}"]`).first();
  await tab.waitFor();
  const keys = () => p.locator('#w-main .tab.active [data-itsa], #w-main .wait-thin [data-itsa]').evaluateAll((es) => es.map((e) => e.textContent));
  // The agent may own other ITSAs already: the project shows and its issue, under it, does not.
  await p.waitForFunction((k) => [...document.querySelectorAll('#w-main [data-itsa]')].some((e) => e.textContent.includes(k)), project.key, { timeout: 15000 }).catch(() => {});
  const first = (await keys()).join(' ');
  check(tag, first.includes(project.key) && !first.includes(child.key), 'a project and its issue show the project alone', first);
  await p.screenshot({ path: `${out}/itsa-chips-one-${tag}.png` });
  await floor(p, tag);
  const two = await make('Check: Phone strip');
  await make('Check: Tab order');
  // The new ITSAs arrive on the page's poll: the chips follow without a reload, as chips or one pill.
  const grew = await p.waitForFunction((n) => { const es = [...document.querySelectorAll('#w-main [data-itsa]')]; return es.length > n || es.some((e) => /\d+ ITSAs/.test(e.textContent)); }, (await keys()).length, { timeout: 30000 }).then(() => true, () => false);
  const after = await keys();
  check(tag, grew, 'new top ITSAs show without a reload, as chips or one pill', after);
  await p.waitForTimeout(800);
  await floor(p, tag);
  await p.screenshot({ path: `${out}/itsa-chips-several-${tag}.png` });
  // A chip opens its ITSA and leaves its tab alone: on a desktop the chip sits on an inactive tab (the
  // agent's inbox is the active one), and the agent's world still has the inbox active when we come back.
  if (!phone) try {
    await p.locator(`#w-main .tab[data-key="agent:${agent.id}"]`).first().click({ button: 'right', position: { x: 12, y: 10 } });
    await p.locator('.menu [role=menuitem]:has-text("Inbox")').first().click();
    await p.waitForFunction(() => document.querySelectorAll('#w-main .tab').length >= 2);
    const active = () => p.locator('#w-main .tab.active').first().getAttribute('data-key');
    const inboxKey = await active();
    check(tag, inboxKey !== `agent:${agent.id}`, 'the inbox tab is active, so the agent\'s tab is not', inboxKey);
    await p.locator(`#w-main .tab[data-key="agent:${agent.id}"] [data-itsa]`).first().click();
    await p.waitForSelector('.itsa-view');
    await p.screenshot({ path: `${out}/itsa-chips-open-${tag}.png` });
    await p.locator(`#tree .node[data-id="${agent.id}"] .name`).first().click();
    await p.waitForSelector('#w-main .tab.active');
    check(tag, (await active()) === inboxKey, 'a chip on an inactive tab opens its ITSA without activating that tab', await active());
    // The daemon keeps one layout for every page: put it back for the phone run.
    await p.locator('#w-main .tab.active .close').click();
  } catch (e) {
    check(tag, false, 'a chip on an inactive tab', await p.evaluate(() => ({ err: 1, tabs: [...document.querySelectorAll('#w-main .tab')].map((t) => t.dataset.key + (t.classList.contains('active') ? '*' : '') + ':' + t.querySelectorAll('[data-itsa]').length), itsaView: !!document.querySelector('.itsa-view'), world: document.querySelector('#w-main')?.className })).then((d) => d, () => String(e)));
  } else {
    const chip = p.locator('#w-main .wait-thin [data-itsa], #w-main .tab [data-itsa]').first();
    await chip.tap();
    await p.waitForSelector('.itsa-view, .wait-pop');
    check(tag, true, 'a tap on a chip opens an ITSA (or the pill its list)');
    await p.screenshot({ path: `${out}/itsa-chips-open-${tag}.png` });
  }
  await ctx.close();
  return two;
}
// More than one tab: the agent's own and its inbox, opened from the pane menu and closed again (the strip's tabs change size).
async function tabs() {
  const ctx = await browser.newContext({ colorScheme: 'light', ...devices['Pixel 7'], viewport: { width: 360, height: 740 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => check('tabs', false, 'no page error', e.message));
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { state: 'attached', timeout: 20000 });
  const helper = (await call('GET', '/api/agents')).find((a) => a.name === 'helper') ?? agent;
  await p.locator('[data-nav="left"]').tap();
  await p.locator(`#tree .node[data-id="${helper.id}"] .name`).first().tap();
  await p.waitForTimeout(800);
  await p.locator('[data-pane-menu]').tap();
  await p.locator('.menu [role=menuitem]:has-text("Inbox")').tap();
  await p.waitForTimeout(800);
  // Settled: the strip's DOM stops changing (a fit that cycles keeps rewriting it), and the name keeps its floor.
  const churn = await p.evaluate(() => new Promise((done) => { let n = 0; const mo = new MutationObserver((rs) => { n += rs.length; }); mo.observe(document.querySelector('#w-main'), { childList: true, subtree: true, attributes: true }); setTimeout(() => { mo.disconnect(); done(n); }, 1500); }));
  check('tabs', churn === 0, 'the tab strip is settled: its DOM stops changing', churn);
  await floor(p, 'tabs', '#w-main .tab:first-child .label');
  const hit = await p.evaluate(() => { const t = document.querySelector('#w-main .tab'); const r = t.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { tab: [r.left, r.width], hit: e?.className + ' ' + e?.tagName, kids: [...t.children].map((c) => c.className + ':' + Math.round(c.getBoundingClientRect().left) + '+' + Math.round(c.getBoundingClientRect().width)) }; });
  await p.locator('#w-main .tab:first-child .label').tap();
  await p.waitForTimeout(500);
  const key = await p.locator('#w-main .tab.active').first().getAttribute('data-key');
  check('tabs', key === `agent:${helper.id}`, 'a tap on the agent\'s tab selects it', { key, hit });
  await p.screenshot({ path: `${out}/itsa-chips-tabs-360-light.png` });
  await p.locator('#w-main .tab').nth(1).tap();
  await p.locator('#w-main .tab.active .close').tap();
  await p.waitForTimeout(800);
  check('tabs', await p.locator('#w-main .tab').count() === 1, 'the page survives opening and closing a second tab');
  await ctx.close();
}
await tabs();
await run('desktop', false);
await run('360-light', true);
await browser.close();
process.exit(failures ? 1 : 0);
