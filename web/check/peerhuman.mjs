// The human answers a permission request and acts on an ITSA that live on a peer machine, from the page of
// a daemon that doesn't relay them (auth.humanStrict, S-544), on a phone (390 px) and a desktop (1280 px).
// Run by web/check/peerhuman.sh, which starts both daemons:
//   node web/check/peerhuman.mjs MAIN_URL MAIN_TOKEN FAR_URL FAR_TOKEN TEST_HUMAN_KEY OUT_DIR
// Per size: a permission answer and an ITSA act go to far's own origin with no token and take effect there;
// with far unreachable the page says "Couldn't reach far" and sends nothing. Prints one line per check and
// exits 1 if any failed. Screenshots: OUT_DIR/peerhuman-<size>-<permission|itsa|unreachable>.png.
import './chromium-lock.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { chromiumExe } from './chromium-launch.mjs';
import { homedir } from 'node:os';
import { findPlaywright } from './find-playwright.mjs';

const [main, mainToken, far, farToken, testHuman, out] = process.argv.slice(2);
if (!out) { console.error('usage: node peerhuman.mjs MAIN_URL MAIN_TOKEN FAR_URL FAR_TOKEN TEST_HUMAN_KEY OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium } = findPlaywright();
// Revision 1217 first (the pinned one), else the newest headless shell Playwright installed.
const pinned = `${process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? process.env.PLAYWRIGHT_BROWSERS_PATH : `${homedir()}/.cache/ms-playwright`}/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell`;
const exe = existsSync(pinned) ? pinned : chromiumExe();
const browser = await chromium.launch({ executablePath: exe, args: ['--disable-dev-shm-usage'] });
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`); if (!ok) failures++; };
const farApi = async (method, path, body) => {
  const r = await fetch(far + path, { method, headers: { authorization: 'Bearer ' + farToken, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return r.json().catch(() => ({}));
};

// far holds an agent, two permission requests (one answered over a working link, one while far is down), and
// two ITSAs waiting on the human, per size.
const agent = (await (await fetch(far + '/api/register', { method: 'POST', headers: { authorization: 'Bearer ' + farToken, 'content-type': 'application/json', 'x-stam-human': '1' }, body: JSON.stringify({ name: 'bob', role: 'test', harness: 'claude' }) })).json()).id;
const perm = (action) => farApi('POST', '/api/permissions', { agent, action, reason: 'peerhuman check', audience: 'human' });
const waitingItsa = async (title) => {
  const it = await farApi('POST', '/api/itsas', { title, by: agent });
  await farApi('POST', `/api/itsas/${it.id}/post`, { body: 'Ready for you.', by: agent });
  await farApi('PATCH', `/api/itsas/${it.id}`, { status: 'needs_approval', by: agent });
  return it;
};

for (const size of [{ n: 'phone', w: 360, h: 780, phone: true }, { n: 'desktop', w: 1280, h: 800 }]) {
  const tag = size.n;
  const p1 = await perm(`Deploy ${tag}`), p2 = await perm(`Deploy ${tag} while far is down`);
  const i1 = await waitingItsa(`Ship ${tag}`), i2 = await waitingItsa(`Ship ${tag} while far is down`);
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, isMobile: !!size.phone, hasTouch: !!size.phone });
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  if (process.env.DEBUG) { p.on('request', (r) => { if (r.method() !== 'GET') console.log('request', r.method(), r.url()) }); p.on('response', async (r) => { if (r.request().method() !== 'GET') console.log('response', r.status(), r.url(), r.request().url().includes('/answer') || r.request().url().includes('/act') ? (await r.text().catch(() => '')).slice(0, 200) + ' REQHDR ' + JSON.stringify(r.request().headers()).slice(0, 400) : '') }); p.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 300))); p.on('pageerror', (e) => console.log('pageerror', e.message)); }
  // The test key stands in for tailscale serve on both; the page never sends it. What the page sends far is recorded.
  let farDown = false;
  const toFar = [];
  await ctx.route(`${far}/api/**`, (r) => {
    if (farDown) return r.abort('connectionrefused');
    toFar.push({ method: r.request().method(), path: new URL(r.request().url()).pathname, auth: r.request().headers().authorization ?? null });
    return r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } });
  });
  await ctx.route(`${main}/api/**`, (r) => r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  const tap = (loc) => (size.phone ? loc.tap() : loc.click());
  await p.goto(main + '/#token=' + mainToken);
  await p.waitForSelector('#tree .node', { timeout: 20000 }).catch(() => {});
  const openMail = async () => { if (size.phone) await p.locator('[data-nav="mail"]').tap(); await p.waitForTimeout(400); };

  // 1. A permission request on far.
  await openMail();
  await p.locator(`.mrow[title*="Deploy ${tag}"]`).first().waitFor({ timeout: 20000 }).catch(() => {});
  await tap(p.locator(`.mrow[title*="Deploy ${tag}"]:not([title*="while far is down"])`).first());
  await p.waitForSelector('.thread-view:visible .perm.pending', { timeout: 15000 });
  await tap(p.locator('.thread-view:visible .perm.pending [data-approve="1"]'));
  await p.locator(size.phone ? '.thread-reply textarea:visible' : '#w-bottom textarea').fill('Approved from the peer check.');
  await p.screenshot({ path: `${out}/peerhuman-${tag}-permission.png` });
  await tap(p.locator(size.phone ? '.thread-reply .cmp-send:visible' : '#w-bottom .cmp-send'));
  for (let i = 0; i < 60 && (await farApi('GET', '/api/permissions')).find?.((x) => x.id === p1.id)?.status !== 'approved'; i++) await p.waitForTimeout(250);
  check(`${tag}: the permission request on far is approved`, (await farApi('GET', '/api/permissions')).find((x) => x.id === p1.id)?.status === 'approved');
  check(`${tag}: the answer went to far's origin with no token`, toFar.some((x) => x.method === 'POST' && x.path === `/api/permissions/${p1.id}/answer` && x.auth === null), JSON.stringify(toFar.slice(-3)));

  // 2. An ITSA waiting on the human, on far.
  if (size.phone) await p.locator('[data-nav="mail"]').tap();
  // On the phone the Inbox page lists the ask as its thread's row, with the ITSA's chip.
  const row = size.phone ? p.locator(`#inbox-view .mrow:has([data-chip="itsa"][title="${i1.title}"])`).first() : p.locator(`#mail-side .mrow[data-att-itsa="${i1.id}"]`);
  await row.waitFor({ timeout: 20000 }).catch(() => {});
  await tap(row);
  const view = p.locator(`.itsa-view[data-itsa="${i1.id}"]`);
  await view.locator('.itsa-ask').waitFor({ timeout: 15000 });
  await tap(view.locator('.itsa-ask [data-act=approve]'));
  await (size.phone ? view.locator('.itsa-reply textarea') : p.locator('#w-bottom textarea')).fill('Approved from the peer check.');
  await p.screenshot({ path: `${out}/peerhuman-${tag}-itsa.png` });
  await tap((size.phone ? view.locator('.itsa-reply .cmp-send') : p.locator('#w-bottom .cmp-send')));
  for (let i = 0; i < 60 && (await farApi('GET', `/api/itsas/${i1.id}`)).status === 'needs_approval'; i++) await p.waitForTimeout(250);
  check(`${tag}: the ITSA on far moved on`, (await farApi('GET', `/api/itsas/${i1.id}`)).status !== 'needs_approval', (await farApi('GET', `/api/itsas/${i1.id}`)).status);
  check(`${tag}: the act went to far's origin with no token`, toFar.some((x) => x.method === 'POST' && x.path === `/api/itsas/${i1.id}/act` && x.auth === null), JSON.stringify(toFar.slice(-3)));

  // 3. With far unreachable the page says so and sends nothing.
  farDown = true;
  const before = toFar.length;
  await p.goto(main + '/#token=' + mainToken);
  await p.reload();
  await p.waitForSelector('#tree .node', { timeout: 20000 }).catch(() => {});
  await openMail();
  await tap(p.locator(`.mrow[title*="Deploy ${tag} while far is down"]`).first());
  await p.waitForSelector('.thread-view:visible .perm.pending', { timeout: 15000 });
  await tap(p.locator('.thread-view:visible .perm.pending [data-approve="1"]'));
  await p.locator(size.phone ? '.thread-reply textarea:visible' : '#w-bottom textarea').fill('Far is down.');
  await tap(p.locator(size.phone ? '.thread-reply .cmp-send:visible' : '#w-bottom .cmp-send'));
  await p.waitForTimeout(1500);
  const body = (await p.locator('body').innerText()) + ' ' + (await p.locator('.ob-why').allInnerTexts()).join(' ');
  check(`${tag}: an unreachable far is named`, /Couldn't reach far/.test(body), body.slice(0, 200));
  check(`${tag}: nothing reached far`, toFar.length === before);
  farDown = false;
  check(`${tag}: far still holds the request`, (await farApi('GET', '/api/permissions')).find((x) => x.id === p2.id)?.status === 'pending');
  await p.screenshot({ path: `${out}/peerhuman-${tag}-unreachable.png` });
  await ctx.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
