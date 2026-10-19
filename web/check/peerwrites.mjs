// A peer's Settings page saving shared settings on the home (S-414), on a phone (390 px) and a
// desktop (1280 px). Run by web/check/peerwrites.sh, which starts both daemons:
//   node web/check/peerwrites.mjs PEER_URL PEER_TOKEN HOME_URL HOME_TOKEN TEST_HUMAN_KEY OUT_DIR
// For each size: the scope note says shared changes are saved on the home and the shared controls are
// live; picking "When to mail you" saves it on the home, cross-origin from the peer's page; and with the
// home unreachable a pick says so, saves nothing, and puts the control back. Prints one line per check
// and exits 1 if any failed. Screenshots: OUT_DIR/peerwrites-<size>-<saved|unreachable>.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [peer, peerToken, home, homeToken, testHuman, out] = process.argv.slice(2);
if (!out) { console.error('usage: node peerwrites.mjs PEER_URL PEER_TOKEN HOME_URL HOME_TOKEN TEST_HUMAN_KEY OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium } = findPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failures++; };
const homeWhen = async () => JSON.parse((await (await fetch(home + '/api/config/settings', { headers: { authorization: 'Bearer ' + homeToken } })).json()).text).humanMail?.when;
const setHome = (when) => fetch(home + '/api/config/settings', { method: 'PATCH', headers: { authorization: 'Bearer ' + homeToken, 'content-type': 'application/json', 'x-stam-test-human': testHuman }, body: JSON.stringify({ patch: { humanMail: { when } } }) });

for (const size of [{ n: 'phone', w: 390, h: 844, phone: true }, { n: 'desktop', w: 1280, h: 800 }]) {
  await setHome('necessary');
  await fetch(peer + '/api/config/settings/sync', { method: 'POST', headers: { authorization: 'Bearer ' + peerToken } });
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, isMobile: !!size.phone, hasTouch: !!size.phone });
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); localStorage.setItem('stam/settings-section', 'mail'); localStorage.removeItem('stam/settings-item'); } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  if (process.env.DEBUG) { p.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 300))); p.on('pageerror', (e) => console.log('pageerror', e.message)); p.on('crash', () => console.log('CRASH')); p.on('requestfailed', (r) => console.log('reqfail', r.url())) }
  // The test key stands in for tailscale serve on the home; the page itself never sends it.
  let homeDown = false;
  const sent = [];
  await ctx.route(`${home}/api/**`, (r) => {
    if (homeDown) return r.abort('connectionrefused');
    sent.push({ method: r.request().method(), auth: r.request().headers().authorization ?? null });
    return r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } });
  });
  await p.goto(peer + '/#token=' + peerToken);
  await p.waitForSelector('#tree .node', { timeout: 20000 }).catch(() => {});
  if (size.phone && !(await p.locator('#open-config').first().isVisible())) { await p.locator('[data-nav="left"]').first().tap(); await p.waitForTimeout(500); }
  await p.locator('#open-config').first().click();
  await p.waitForSelector('.settings-view .scope-note');
  const note = (await p.locator('.scope-note').first().innerText()).replace(/\s+/g, ' ');
  check(`${size.n}: note says shared changes are saved on home`, /Shared settings live on home; changes to them are saved there/.test(note));
  const card = (label) => p.locator('.settings-inner .choice', { hasText: label }).first();
  check(`${size.n}: shared choice is live`, await card('Everything').isEnabled());

  await card('Everything').click();
  const saved = async () => (await homeWhen()) === 'everything';
  for (let i = 0; i < 40 && !(await saved()); i++) await p.waitForTimeout(100);
  check(`${size.n}: the pick saved on the home`, await saved());
  check(`${size.n}: the page sent it to the home with no token`, sent.some((x) => x.method === 'PATCH' && x.auth === null) && sent.every((x) => x.auth === null));
  await p.waitForTimeout(300);
  check(`${size.n}: the page says Saved`, /Saved/.test(await p.locator('.saved').first().innerText().catch(() => '')) || /Saved/.test(await p.locator('body').innerText()));
  check(`${size.n}: the choice shows the pick`, await card('Everything').evaluate((el) => el.classList.contains('on')));
  await p.screenshot({ path: `${out}/peerwrites-${size.n}-saved.png` });

  homeDown = true;
  await card('Important things').click();
  await p.waitForTimeout(600);
  const body = await p.locator('body').innerText();
  check(`${size.n}: an unreachable home is named, and nothing saved`, /Can't reach home; nothing was saved\./.test(body));
  check(`${size.n}: the home kept its value`, (await homeWhen()) === 'everything');
  check(`${size.n}: the choice went back`, (await card('Everything').evaluate((el) => el.classList.contains('on'))) && !(await card('Important things').evaluate((el) => el.classList.contains('on'))));
  await p.screenshot({ path: `${out}/peerwrites-${size.n}-unreachable.png` });
  await ctx.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
