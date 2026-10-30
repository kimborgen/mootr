// Phone checks: every day-to-day flow by touch, at 360 and 430 px, light and dark, with the
// virtual keyboard simulated by shrinking the viewport. Needs a test daemon (daemon.sh):
// it sends a prompt to the agent, replies in threads, answers the permission, and adds an
// agent (with no prompt), so a few cents of Haiku.
//   node web/check/phone.mjs BASE_URL OUT_DIR [--webkit] [--only=360-light]
// --webkit runs WebKit instead of Chromium (iOS behaviour, closer than Chromium's); set
// WEBKIT_EXE and the library environment it needs. Touch gestures go through the DevTools
// protocol in Chromium (real touch input) and as synthetic touch and pointer events in WebKit.
// Prints one line per check and exits 1 if any failed. Screenshots: OUT_DIR/<step>-<size>-<theme>.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { findPlaywright } from './find-playwright.mjs';
import { PROCESSES } from './process-fixture.mjs';
import { routeFiles } from './files-fixture.mjs';
import { failureDetail } from './failure-detail.mjs';
import { classify, describe, knownKey } from './hit-classify.mjs';
import { OVERLAYS, sampleTargets } from './hit-sample.mjs';

const [base, out, ...flags] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node phone.mjs BASE_URL OUT_DIR [--webkit] [--only=360-light]'); process.exit(2); }
const useWebkit = flags.includes('--webkit');
const only = flags.find((f) => f.startsWith('--only='))?.slice(7);
mkdirSync(out, { recursive: true });

const { chromium, webkit, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
// Stands in for tailscale serve on the human's own routes (daemon.sh's testHuman=).
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const humanHeaders = testHuman ? { 'x-stam-test-human': testHuman } : {};
const origin = u.origin;
// A write that names helper or kid (by or from) goes with that agent's own token (daemon.sh's agents=, S-545).
const agentTokens = JSON.parse(new URLSearchParams(u.hash.slice(1)).get('agents') || '{}');
const api = (path, method = 'GET', body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + (agentTokens[body?.by ?? body?.from] || token), 'x-stam-human': '1', 'content-type': 'application/json', ...humanHeaders }, body: body && JSON.stringify(body) }).then((r) => r.json());

const browser = useWebkit
  ? await webkit.launch({ executablePath: process.env.WEBKIT_EXE, env: process.env })
  : await chromium.launch(chromiumLaunchOptions());
const engine = useWebkit ? 'webkit' : 'chromium';

const SIZES = [
  { name: '360', device: devices['Pixel 7'], viewport: { width: 360, height: 740 } },
  { name: '430', device: devices['iPhone 15'], viewport: { width: 430, height: 860 } },
];
const results = [];
let failed = 0;
// Touch-target overlaps that exist today, tracked in S-2249. Each is the exact quadruple
// step | target | edge | covering element, so a new overlap, or another edge or coverer on the
// same target, still fails. A hit is reported as a `known` line; an entry that matches nothing
// in a run of every viewport is reported as stale, so a fixed overlap leaves the list.
const KNOWN_OVERLAPS = [
  'instructions | {key#2}>…>details.fold:1>div.inst-actions>button.btn[Edit in Settings] | bottom | {key#2}>…>details.fold:3>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:1>div.inst-actions>button.btn[Edit in Settings] | centre | {key#2}>…>summary>span.inst-row>span.inst-label[Role]', // S-2249
  'instructions | {key#2}>…>details.fold:1>div.inst-actions>button.btn[Edit in Settings] | left | {key#2}>…>details.fold:2>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:1>div.inst-actions>button.btn[Edit in Settings] | right | {key#2}>…>summary>span.inst-row>span.inst-label[Role]', // S-2249
  'instructions | {key#2}>…>details.fold:1>div.inst-actions>button.btn[Edit in Settings] | top | {key#2}>…>details.fold:2>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:5>div.inst-actions>button.btn[Edit in Settings] | bottom | {key#2}>…>details.fold:7>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:5>div.inst-actions>button.btn[Edit in Settings] | centre | {key#2}>…>summary>span.inst-row>span.inst-label[Retros]', // S-2249
  'instructions | {key#2}>…>details.fold:5>div.inst-actions>button.btn[Edit in Settings] | left | {key#2}>…>details.fold:6>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:5>div.inst-actions>button.btn[Edit in Settings] | right | {key#2}>…>summary>span.inst-row>span.inst-label[Retros]', // S-2249
  'instructions | {key#2}>…>details.fold:5>div.inst-actions>button.btn[Edit in Settings] | top | {key#2}>…>details.fold:6>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:6>div.inst-actions>button.btn[Edit in Settings] | bottom | {key#2}>…>details.fold:8>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:6>div.inst-actions>button.btn[Edit in Settings] | centre | {key#2}>…>summary>span.inst-row>span.inst-label[ITSAs]', // S-2249
  'instructions | {key#2}>…>details.fold:6>div.inst-actions>button.btn[Edit in Settings] | left | {key#2}>…>details.fold:7>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:6>div.inst-actions>button.btn[Edit in Settings] | right | {key#2}>…>summary>span.inst-row>span.inst-label[ITSAs]', // S-2249
  'instructions | {key#2}>…>details.fold:6>div.inst-actions>button.btn[Edit in Settings] | top | {key#2}>…>details.fold:7>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:7>div.inst-actions>button.btn[Edit in Settings] | bottom | {key#2}>…>details.fold:9>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:7>div.inst-actions>button.btn[Edit in Settings] | centre | {key#2}>…>summary>span.inst-row>span.inst-label[Mail to your user]', // S-2249
  'instructions | {key#2}>…>details.fold:7>div.inst-actions>button.btn[Edit in Settings] | left | {key#2}>…>details.fold:8>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:7>div.inst-actions>button.btn[Edit in Settings] | right | {key#2}>…>summary>span.inst-row>span.inst-label[Mail to your user]', // S-2249
  'instructions | {key#2}>…>details.fold:7>div.inst-actions>button.btn[Edit in Settings] | top | {key#2}>…>details.fold:8>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:8>div.inst-actions>button.btn[Edit in Settings] | bottom | {key#2}>…>details.fold:9>summary>span.inst-path.mono[/path]', // S-2249
  'instructions | {key#2}>…>details.fold:8>div.inst-actions>button.btn[Edit in Settings] | centre | {key#2}>…>summary>span.inst-row>span.inst-label[CLAUDE.md]', // S-2249
  'instructions | {key#2}>…>details.fold:8>div.inst-actions>button.btn[Edit in Settings] | left | {key#2}>…>details.fold:9>summary>span.inst-row', // S-2249
  'instructions | {key#2}>…>details.fold:8>div.inst-actions>button.btn[Edit in Settings] | right | {key#2}>…>summary>span.inst-row>span.inst-label[CLAUDE.md]', // S-2249
  'instructions | {key#2}>…>details.fold:8>div.inst-actions>button.btn[Edit in Settings] | top | {key#2}>…>details.fold:9>summary>span.inst-row', // S-2249
  'prompt input with keyboard | #w-bottom>…>div.cmp-files>div.cmp-file:1>button.cmp-open[Open pasted-#.png] | centre | #w-bottom>…>div.cmp-files>div.cmp-file:1>button.cmp-x[Remove pasted-#.png]', // S-2249
  'prompt input with keyboard | #w-bottom>…>div.cmp-files>div.cmp-file:1>button.cmp-open[Open pasted-#.png] | right | #w-bottom>…>div.cmp-files>div.cmp-file:1>button.cmp-x[Remove pasted-#.png]', // S-2249
  'prompt input with keyboard | #w-bottom>…>div.cmp-files>div.cmp-file:1>button.cmp-open[Open pasted-#.png] | top | #w-bottom>…>div.cmp-files>div.cmp-file:1>button.cmp-x[Remove pasted-#.png]', // S-2249
];
const knownSeen = new Set();
const check = (tag, name, ok, detail = '') => {
  results.push({ tag, name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ': ' + String(detail).replace(/\s+/g, ' ').slice(0, 300) : ''}`);
};

for (const size of SIZES) for (const theme of ['light', 'dark']) {
  const tag = `${size.name}-${theme}`;
  if (only && only !== tag) continue;
  // Only the last run sends (a prompt, replies, the approval, a new agent), so the runs
  // before it find the seeded thread unanswered.
  const sends = tag === (only ?? '430-dark');
  // The daemon keeps one layout for every page; each run starts from the default one.
  const was = await api('/api/layout');
  await api('/api/layout/ops', 'POST', { ops: [...Object.keys(was.agentWorlds).map((world) => ({ op: 'dropWorld', world })), { op: 'current', world: null }] });
  // WebKit-only: a request the service worker answers skips context.route, so the stubbed Process, Files and MCP routes never applied.
  const ctx = await browser.newContext({ ...size.device, viewport: size.viewport, colorScheme: theme, ...(useWebkit ? { serviceWorkers: 'block' } : {}) });
  // Only the push routes get the stand-in header; on every request it would make the
  // page's cross-origin embeds send preflights that fail.
  const asHuman = (route) => route.continue({ headers: { ...route.request().headers(), ...humanHeaders } });
  // The Process view (S-873) draws a stubbed `GET /api/processes`: the daemon route (S-872) is
  // built in parallel, and a fixed answer keeps the drawing the same on every run.
  if (!process.env.STAM_PROCESS_REAL) await ctx.route(`${origin}/api/processes**`, (route) => route.fulfill({ json: PROCESSES }));
  // The Files world and file view (S-1526) read a stubbed Files API (files-fixture.mjs).
  await routeFiles(ctx, origin);
  if (testHuman) await ctx.route(`${origin}/api/push**`, asHuman);
  // The MCP import and test routes prove the human the same way (tailscale serve in real use).
  if (testHuman) await ctx.route(`${origin}/api/mcp/import**`, asHuman);
  if (testHuman) await ctx.route(`${origin}/api/mcp/registry**`, asHuman);
  // The config, template and agent-type writes are human-only too (S-230).
  const writesAsHuman = (route) => (route.request().method() === 'GET' ? route.continue() : asHuman(route));
  if (testHuman) for (const r of ['config', 'templates', 'types']) await ctx.route(`${origin}/api/${r}/**`, writesAsHuman);
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); } catch {} }, theme);
  // WebKit-only: the synthetic touch below dispatches pointer events for a pointer id the browser never
  // started, so setPointerCapture throws NotFoundError (real iOS touch has a live pointer); capture is a no-op.
  if (useWebkit) await ctx.addInitScript(() => { for (const m of ['setPointerCapture', 'releasePointerCapture']) Element.prototype[m] = () => {}; });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => check(tag, 'no page errors', false, e.message));
  p.on('dialog', (d) => d.accept());
  const cdp = useWebkit ? null : await ctx.newCDPSession(p);
  const shot = async (step) => { await p.waitForTimeout(400); await p.screenshot({ path: `${out}/${step}-${tag}.png` }); };
  // A failed step leaves whatever it opened (a sheet, the search, another tab); the page
  // reloads to the Agents tab so the next step starts from a known state instead of failing too.
  // The app reopens the view it was left in (a mail thread, Settings), so Agents is tapped when the tree isn't showing.
  const home = async () => {
    await p.goto('about:blank'); await p.goto(origin + '/#token=' + token);
    await p.waitForSelector('#tree .node', { state: 'attached', timeout: 20000 });
    if (!(await p.locator('#tree .node').first().isVisible())) await p.locator('[data-nav="left"]').tap();
    await p.waitForSelector('#tree .node', { timeout: 20000 });
  };
  const step = async (name, fn) => {
    // WebKit-only: iOS doesn't move the focus to a tapped button, so a field a step typed into keeps it and the
    // keyboard-aware layout hides the bottom navigation; a person puts the keyboard away between steps.
    if (useWebkit) await p.evaluate(() => document.activeElement?.blur()).catch(() => {});
    try { await fn(); } catch (e) {
      check(tag, name, false, failureDetail(e.message));
      await p.screenshot({ path: `${out}/failed-${name.replace(/\W+/g, '-')}-${tag}.png` }).catch(() => {});
      await home().catch((e2) => check(tag, `${name}: reload after the failure`, false, failureDetail(e2.message)));
    }
  };

  // Touch input: real touch through DevTools in Chromium; synthetic events in WebKit.
  const touch = async (type, x, y) => {
    if (cdp) return cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] });
    await p.evaluate(({ type, x, y }) => {
      const el = document.elementFromPoint(x, y) ?? document.body;
      const w = window;
      const pt = { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true };
      const target = w.__touchTarget && type !== 'touchStart' ? w.__touchTarget : el;
      if (type === 'touchStart') w.__touchTarget = el;
      const pev = { touchStart: 'pointerdown', touchMove: 'pointermove', touchEnd: 'pointerup', touchCancel: 'pointercancel' }[type];
      target.dispatchEvent(new PointerEvent(pev, pt));
      // WebKit's Touch constructor is off outside iOS, so the touch lists are plain objects.
      const t = { identifier: 7, target, clientX: x, clientY: y };
      const list = type === 'touchEnd' || type === 'touchCancel' ? [] : [t];
      const ev = new TouchEvent(type.toLowerCase(), { bubbles: true, cancelable: true });
      for (const [k, v] of [['touches', list], ['targetTouches', list], ['changedTouches', [t]]]) Object.defineProperty(ev, k, { value: v });
      target.dispatchEvent(ev);
      // A browser follows an uncancelled tap with a click; WebKit's synthetic events don't, so a
      // short touch that stayed near its start clicks the element it began on.
      if (type === 'touchStart') w.__touchStart = { x, y, at: Date.now(), cancelled: ev.defaultPrevented };
      if (type === 'touchMove' && w.__touchStart && Math.hypot(x - w.__touchStart.x, y - w.__touchStart.y) > 10) w.__touchStart = null;
      if (type === 'touchEnd' && w.__touchStart && !ev.defaultPrevented && !w.__touchStart.cancelled && Date.now() - w.__touchStart.at < 500) {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: w }));
      }
      if (type === 'touchEnd' || type === 'touchCancel') w.__touchStart = null;
    }, { type, x, y });
  };
  const drag = async (x, y, x2, y2, steps = 12) => {
    await touch('touchStart', x, y);
    await p.waitForTimeout(60);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', x + ((x2 - x) * i) / steps, y + ((y2 - y) * i) / steps); await p.waitForTimeout(16); }
    await touch('touchEnd', x2, y2);
  };
  const longPress = async (x, y) => { await touch('touchStart', x, y); await p.waitForTimeout(800); await touch('touchEnd', x, y); };
  const center = async (loc) => { const b = await loc.boundingBox(); if (!b) throw new Error('not on screen'); return [b.x + b.width / 2, b.y + b.height / 2]; };

  // Before a measure reads boxes, the page has settled: fonts have loaded, and no finite animation
  // is still running. A row's spawn or archive play moves it by transform, and getBoundingClientRect
  // reads the moved box (a 44 px row at 0.96 scale measures 42 px). An endless animation (a working
  // dot) never ends, so it is not waited for; the check doesn't measure it.
  const settle = async () => {
    await p.evaluate(() => document.fonts.ready);
    await p.waitForFunction(() => document.getAnimations().every((a) => !['running', 'pending'].includes(a.playState) || a.effect.getComputedTiming().endTime === Infinity), null, { timeout: 5000 }).catch(() => {});
  };
  // Layout checks on whatever shows: no sideways page scroll, nothing wider than the screen
  // that isn't inside a scroller, and touch targets at least 44 px.
  const layout = async (where) => {
    await settle();
    const r = await p.evaluate(() => {
      const W = innerWidth;
      const doc = document.scrollingElement;
      const vis = (el) => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0' && !el.closest('[hidden]'); };
      const scrolls = (el) => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
      const wide = [...document.querySelectorAll('body *')].filter((el) => vis(el) && el.getBoundingClientRect().right > W + 1 && !scrolls(el)).map((el) => el.tagName.toLowerCase() + '.' + [...el.classList].join('.')).slice(0, 5);
      return { scrollW: doc.scrollWidth, W, wide };
    });
    // Targets: controls a finger aims at. Links inside mail prose are text, exempt. A prompt input's
    // text box grows from one line; its whole box is the target.
    const sampled = await p.evaluate(sampleTargets, {
      selector: 'button, [role=button], [role=menuitem], input:not([type=hidden]):not([type=checkbox]):not([type=file]), select, textarea:not(.composer textarea), .cmp-box, .tab, .node, .mrow',
      exclude: '.md .mb-table, .xterm, .mb-chart, .mb-code, .mb-diagram, .msg header',
      overlays: OVERLAYS, inset: 3, edge: useWebkit ? 1.5 : 0,
    });
    r.small = [...new Set(sampled.filter((c) => Math.min(c.w, c.h) < 43.5).map((c) => `${c.t} ${Math.round(c.w)}x${Math.round(c.h)}`))].slice(0, 8);
    check(tag, `${where}: no sideways page scroll`, r.scrollW <= r.W && !r.wide.length, r.wide.join(', '));
    check(tag, `${where}: touch targets at least 44 px`, !r.small.length, r.small.join('; '));
    const classes = sampled.filter((c) => c.samples.some((x) => !x.inside)).map((c) => classify(where, c.t, c.samples, KNOWN_OVERLAPS, knownSeen));
    let fresh = [...new Map(classes.flatMap((c) => c.fresh).map((c) => [describe(c), c])).values()];
    // WebKit-only: the S-2249 overlaps of the Instructions page's Edit in Settings buttons stay, but Safari's line heights
    // change which neighbouring row covers them, so the exact covers in KNOWN_OVERLAPS (Chromium's) don't match. Only a
    // cover that is a neighbouring row's summary (span.inst-row, .inst-label or .inst-path) is that shift; any other cover is a real overlap.
    if (useWebkit && where === 'instructions') fresh = fresh.filter((c) => !(/button\.btn\[Edit in Settings\]/.test(c.target) && /summary>span\.inst-(row|label|path)/.test(c.by)));
    for (const c of classes.flatMap((c) => c.known)) console.log(`known [${tag}] ${where}: ${describe(c)} (S-2249)`);
    for (const c of fresh) console.log(`overlap [${tag}] '${knownKey(where, c.target, c)}', // S-2249`);
    check(tag, `${where}: touch targets are tappable across their whole box`, !fresh.length, fresh.slice(0, 8).map(describe).join('; '));
  };
  // The room a thread leaves its messages: the part of its scroller no pinned header covers.
  // At 360 px it must be at least half the visible viewport.
  const messageRoom = async (where) => {
    if (size.name !== '360') return;
    const r = await p.evaluate(() => {
      const sc = [...document.querySelectorAll('.thread-view .thread-scroll')].find((x) => x.offsetHeight), h = sc.querySelector('.thread-head');
      const b = sc.getBoundingClientRect(), hb = h.getBoundingClientRect();
      const pinned = getComputedStyle(h).position === 'sticky' ? Math.max(0, hb.bottom - b.top) : 0;
      return { room: Math.round(Math.min(b.bottom, innerHeight) - Math.max(b.top, 0) - pinned), vh: innerHeight };
    });
    check(tag, `${where}: the messages get at least half the screen`, r.room >= r.vh / 2, `${r.room} of ${r.vh} px`);
  };
  const navVisible = () => p.locator('#mobile-nav').isVisible();
  // The bottom bar as drawn: each slot's label and whether it is on (S-3346). Checked on every page it visits: no two slots share a label, and exactly one is on.
  const bar = () => p.evaluate(() => [...document.querySelectorAll('#mobile-nav button')].map((b) => ({ nav: b.dataset.nav, label: b.querySelector('.nl')?.textContent ?? '', on: b.classList.contains('on') })));
  const barCheck = async (where) => {
    const b = await bar();
    const labels = b.map((x) => x.label), on = b.filter((x) => x.on).map((x) => x.nav);
    check(tag, `${where}: no two bottom slots share a label`, new Set(labels).size === labels.length, labels.join(', '));
    check(tag, `${where}: exactly one bottom slot is on`, on.length === 1, on.join(', ') || 'none');
    return b;
  };
  // The keyboard: focus shows it, and the visible viewport shrinks by its height.
  const H = size.viewport.height, KB = Math.round(H * 0.42);
  const keyboard = async (up) => { await p.setViewportSize({ width: size.viewport.width, height: up ? H - KB : H }); await p.waitForTimeout(300); };
  const inViewport = async (loc) => { const b = await loc.boundingBox(); const vh = p.viewportSize().height; return !!b && b.y >= 0 && b.y + b.height <= vh + 0.5; };

  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  await p.waitForTimeout(1500);
  const agents = await api('/api/agents');
  const helper = agents.find((a) => a.name === 'helper');

  await step('home', async () => {
    await shot('home');
    const n = await p.locator('#mobile-nav button').count();
    check(tag, 'navigation has agents, mail, issues, main, work, assistant', n === 6, `${n} buttons`);
    check(tag, 'the Agents tab has one search entry, and the agent filter is hidden on the phone', await p.locator('[data-tree-search]').count() === 1 && !(await p.locator('#search').isVisible()));
    check(tag, 'the bottom bar has Work and no Search', await p.locator('#mobile-nav [data-nav="work"]').count() === 1 && await p.locator('#mobile-nav [data-nav="search"]').count() === 0);
    await barCheck('home');
    const fontPx = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#search')).fontSize));
    check(tag, 'inputs are 16 px, so iOS doesn\'t zoom', fontPx >= 16, `${fontPx}px`);
    const vp = await p.evaluate(() => document.querySelector('meta[name=viewport]').content);
    check(tag, 'viewport resizes content for the keyboard', vp.includes('interactive-widget=resizes-content'));
    await layout('agent tree');
    const tools = await p.evaluate(() => {
      const b = document.querySelector('[data-tree-search]').getBoundingClientRect();
      const plus = document.getElementById('new-agent').getBoundingClientRect();
      return { sameRow: Math.abs(b.top - plus.top) < 1, plusH: plus.height, plusW: plus.width, btnH: b.height, filterShown: getComputedStyle(document.querySelector('.tree-tools .search')).display !== 'none' };
    });
    check(tag, 'agent tree: the search entry and + share one row, both 44 px', tools.sameRow && tools.plusH >= 44 && tools.plusW >= 44 && tools.btnH >= 44 && !tools.filterShown, JSON.stringify(tools));
    // The tree shows one short model code per row, all in one fixed-width slot, with the
    // full model name still in the row tooltip.
    const mchips = p.locator('#tree .node .chip');
    const mtexts = await mchips.allTextContents();
    check(tag, 'the tree shows a short model code on every row', mtexts.length >= 2 && mtexts.every((t) => /^[A-Z0-9–]/.test(t.trim())), mtexts.join(' '));
    const mwidths = await mchips.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    check(tag, 'every model code takes the same width', new Set(mwidths).size === 1, mwidths.join(', '));
    const mtip = await p.locator('#tree .node:has(.name:text-is("helper"))').first().getAttribute('title');
    check(tag, 'the full model name is still in the row tooltip', /claude-haiku-5-5/.test(mtip ?? ''), mtip);
    // A parent with a long name, badges and a tree cost (S-318): its row stays on the screen, and its model code too.
    // Its own context, so the mocked agents don't reach the other checks.
    if (size.name === '360') {
      const lc = await browser.newContext({ ...size.device, viewport: size.viewport, colorScheme: theme });
      const lp = await lc.newPage();
      await lc.route((url) => url.origin === origin && url.pathname === '/api/agents', async (route) => {
        const res = await route.fetch();
        const agents = await res.json();
        const parents = new Set(agents.flatMap((a) => a.parents ?? []));
        const m = (api, pct) => ({ api, five_hour: pct, seven_day: pct, subscription: api, paid_usd: 0 });
        const json = agents.map((a) => ({ ...a, name: parents.has(a.id) && !(a.parents ?? []).length ? 'a parent agent with a very long name that goes on' : a.name, cost: { mode: 'api', own: m(1234.5, 3), tree: parents.has(a.id) ? m(9999, 99) : m(1.2, 3) } }));
        await route.fulfill({ response: res, json });
      });
      await lp.goto(origin + '/#token=' + token);
      await lp.waitForSelector('#tree .cost-tree', { timeout: 20000 });
      const row = await lp.evaluate(() => {
        const n = [...document.querySelectorAll('#tree .node')].find((e) => e.querySelector('.cost-tree'));
        return { chipRight: Math.round(n.querySelector('.chip.mcode').getBoundingClientRect().right), rowRight: Math.round(n.getBoundingClientRect().right), W: innerWidth };
      });
      check(tag, 'a parent row with a long name and a tree cost stays on the screen, model code included', row.chipRight <= row.W && row.chipRight <= row.rowRight + 1, JSON.stringify(row));
      await lc.close();
    }
  });

  // The Machines section: one line per computer in the Agents tab, its meters, and the
  // details sheet on tap. Nothing is changed, so this is safe on a live daemon too.
  await step('machines', async () => {
    const rows = p.locator('#machines-side .machine-row');
    check(tag, 'the Agents tab shows the machines', await rows.count() >= 1 && await rows.first().isVisible());
    check(tag, 'a machine line has three labelled meters', await rows.first().locator('.mmeter .ml').count() === 3);
    await layout('machines');
    await rows.first().tap();
    const pop = p.locator('.machines-pop');
    await pop.waitFor();
    check(tag, 'tapping a machine opens a sheet within the screen', await inViewport(pop));
    const text = await pop.innerText();
    check(tag, 'the sheet shows percentages, GB, and per-core', /%/.test(text) && /GB/.test(text) && /core 0/.test(text), text.replace(/\n/g, ' | '));
    await shot('machines');
    await p.touchscreen.tap(size.viewport.width / 2, 20);
    await p.waitForTimeout(300);
    check(tag, 'a tap outside closes the sheet', !(await pop.count()));
    // The scrim is a shadow: the tap lands on the tree's search entry, which must stay shut (S-286).
    check(tag, 'the tap that closes the sheet presses nothing under it', !(await p.locator('#search-palette').count()));
  });

  await step('legend', async () => {
    const ring = await p.locator('#tree .node .glyph .ring').first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
    // WebKit floors a border to whole device pixels (2 px at 2.625x is 5 of 5.25), so it reads up to one device pixel short.
    check(tag, 'legend: the state ring is at least 2 px', ring >= 2 - (useWebkit ? 1 / size.device.deviceScaleFactor : 0) - 0.001, `${ring}px`);
    await p.locator('#tree [data-legend-open]').tap();
    const pop = p.locator('.menu.popover[role=dialog]');
    await pop.waitFor();
    check(tag, 'legend: the ? opens a sheet within the screen', await inViewport(pop));
    check(tag, 'legend: it lists every state', await pop.locator('[data-legend]').count() === 9);
    await shot('legend');
    await layout('legend');
    await pop.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shot('legend-end');
    await p.touchscreen.tap(size.viewport.width / 2, 20);
    await p.waitForTimeout(300);
    check(tag, 'legend: a tap outside closes it', !(await pop.count()));
    check(tag, 'legend: the tap that closes it presses nothing under it', !(await p.locator('#search-palette').count()));
    await p.locator('#tree [data-legend-open]').tap();
    await pop.waitFor();
    await p.locator('.menu.popover [data-legend-close]').tap();
    check(tag, 'legend: its close button closes it', !(await pop.count()));
  });

  await step('open agent', async () => {
    // S-703: a finger's tap, held about 120 ms as on a real phone; Playwright's tap() lifts at once and hid
    // a hold timer that ran out at once (the build wrote the hold token as .4s).
    const [hx, hy] = await center(p.locator(`#tree .node:has(.name:text-is("helper"))`).first().locator('.name'));
    await touch('touchStart', hx, hy); await p.waitForTimeout(120); await touch('touchEnd', hx, hy);
    await p.waitForTimeout(300);
    check(tag, 'a finger-paced tap on an agent opens no action sheet', !(await p.locator('.menu').count()));
    await p.waitForTimeout(2200);
    // An agent with a view opens in its conversation (S-173); this step checks the terminal, so switch to it.
    const toTerminal = p.locator('#w-main .pane.focused .view-switch[data-to="terminal"]');
    if (await toTerminal.isVisible()) { await toTerminal.tap(); await p.waitForTimeout(800); }
    check(tag, 'tapping an agent opens its world and closes the tree', !(await p.locator('#tree').isVisible()) && await p.locator('#w-main .term-view').first().isVisible());
    check(tag, 'the pane has a menu button and a keyboard button', await p.locator('[data-pane-menu]').isVisible() && await p.locator('[data-keyboard]').isVisible());
    check(tag, 'the prompt input shows for the agent', await p.locator('#w-bottom .composer textarea').isVisible());
    const t = await p.evaluate(() => { const s = [...window.stamDebug.sessions].find((x) => x.el.isConnected && x.el.offsetWidth); return s && { cols: s.term.cols, font: s.term.options.fontSize, w: s.el.offsetWidth }; });
    check(tag, 'the terminal fits the width at a legible size', !!t && t.font >= 11 && t.cols * t.font * 0.6 <= t.w + 2, JSON.stringify(t));
    await shot('agent');
    await barCheck('agent world');
    await layout('agent world');
  });

  await step('terminal scroll', async () => {
    await p.evaluate(() => { window.__wheels = 0; document.querySelector('#w-main .term-view .xterm-screen').addEventListener('wheel', () => window.__wheels++); });
    const [x, y] = await center(p.locator('#w-main .term-view').first());
    await drag(x, y - 100, x, y + 120);
    await p.waitForTimeout(200);
    const wheels = await p.evaluate(() => window.__wheels);
    check(tag, 'a touch drag on the terminal scrolls it (as wheel input)', wheels > 3, `${wheels} wheel steps`);
    check(tag, 'a drag on the terminal doesn\'t raise the keyboard', !(await p.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))));
  });

  await step('terminal keys', async () => {
    await p.locator('[data-keyboard]').tap();
    await p.waitForTimeout(300);
    await keyboard(true);
    check(tag, 'the keyboard button focuses the terminal', await p.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')));
    check(tag, 'the key row replaces the prompt input', await p.locator('.key-row').isVisible() && !(await p.locator('#w-bottom .composer').isVisible()));
    check(tag, 'the navigation steps aside while typing', !(await navVisible()));
    check(tag, 'the key row sits above the keyboard', await inViewport(p.locator('.key-row')));
    await shot('terminal-keys');
    await layout('terminal keys');
    await p.locator('.key-row .key[aria-label="Escape"]').tap();
    check(tag, 'tapping a key keeps the terminal focused', await p.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')));
    await p.locator('.key-row [aria-label="Put the keyboard away"]').tap();
    await keyboard(false);
    check(tag, 'putting the keyboard away brings the navigation back', await navVisible());
  });

  await step('prompt input', async () => {
    const ta = p.locator('#w-bottom .composer textarea');
    await ta.tap();
    await keyboard(true);
    check(tag, 'the navigation steps aside for the keyboard', !(await navVisible()));
    // Android's back button puts the keyboard away and leaves the focus in the field.
    await keyboard(false);
    check(tag, 'the keyboard put away with the prompt still focused brings the navigation back', await navVisible() && await p.evaluate(() => document.activeElement?.matches('#w-bottom .composer textarea')));
    await ta.tap();
    await keyboard(true);
    check(tag, 'the keyboard coming back hides the navigation again', !(await navVisible()));
    check(tag, 'the prompt input sits above the keyboard', await inViewport(p.locator('#w-bottom .cmp-box')));
    check(tag, 'the send button is reachable with the keyboard up', await inViewport(p.locator('#w-bottom .cmp-send')));
    await ta.fill('Phone check: reply with only the word ok.');
    await ta.press('Enter');
    check(tag, 'Enter on a touch keyboard adds a line instead of sending', (await ta.inputValue()).includes('\n'));
    await ta.fill('Phone check: reply with only the word ok.');
    // Paste an image, then attach a file through the picker.
    await p.evaluate(() => {
      const dt = new DataTransfer();
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      dt.items.add(new File([png], 'image.png', { type: 'image/png' }));
      document.querySelector('#w-bottom .composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await p.waitForTimeout(300);
    check(tag, 'a pasted image shows as a thumbnail', await p.locator('#w-bottom .cmp-file.img').count() === 1);
    // S-703: a finger-paced tap (about 120 ms down) opens the general picker, not the screenshots one.
    const ab = await p.locator('#w-bottom .cmp-attach').boundingBox();
    const tapped = p.waitForEvent('filechooser');
    await touch('touchStart', ab.x + ab.width / 2, ab.y + ab.height / 2); await p.waitForTimeout(120); await touch('touchEnd', ab.x + ab.width / 2, ab.y + ab.height / 2);
    const chooser = await tapped;
    check(tag, 'a finger-paced tap on the paperclip opens the general picker', (await chooser.element().getAttribute('data-images')) === null);
    await chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('phone check') });
    // WebKit-only skip: these holds are driven by CDP Input.dispatchTouchEvent, which WebKit lacks, and are Android picker behaviour.
    if (!useWebkit) {
      // Long-press opens the image-only picker (Android's photo picker, recent screenshots first).
      const box = await p.locator('#w-bottom .cmp-attach').boundingBox();
      const held = p.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
      const cdp = await p.context().newCDPSession(p);
      const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
      // Every contextmenu event on the paperclip must be cancelled: an uncancelled one is the browser's own menu.
      await p.evaluate(() => { window.__ctx = []; document.querySelector('#w-bottom .cmp-attach').addEventListener('contextmenu', (e) => setTimeout(() => window.__ctx.push(e.defaultPrevented), 0)); });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
      await p.waitForTimeout(450);
      check(tag, 'a held paperclip shows its cue before release', await p.locator('#w-bottom .cmp-attach.holding').count() === 1);
      // S-776: the cue must be visible, not the 1.18:1 wash it once was: an accent ring the resting
      // button doesn't carry.
      const armed = await p.evaluate(() => {
        const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; document.body.appendChild(probe);
        const accent = getComputedStyle(probe).color; probe.remove();
        return { shadow: getComputedStyle(document.querySelector('#w-bottom .cmp-attach')).boxShadow, accent };
      });
      check(tag, 'the cue is an accent ring', armed.shadow.includes(armed.accent), `${armed.shadow} vs ${armed.accent}`);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const lp = await held; // the picker opens from the click that ends the hold
      await cdp.detach();
      await p.waitForTimeout(200);
      // Emulated touch doesn't raise the event, so also send the one Android sends after a hold and see it cancelled.
      await p.evaluate(() => { const b = document.querySelector('#w-bottom .cmp-attach'); b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      const ctx = await p.evaluate(() => window.__ctx);
      check(tag, 'no native context menu shows on the paperclip (every contextmenu event is cancelled)', ctx.length > 0 && ctx.every(Boolean), `${ctx.length} contextmenu event(s)`);
      check(tag, 'the paperclip suppresses the native touch callout and text selection', await p.evaluate(() => { const c = getComputedStyle(document.querySelector('#w-bottom .cmp-attach')); return (c.webkitTouchCallout ?? 'none') === 'none' && c.userSelect === 'none'; }));
      check(tag, 'the hold ends clean', await p.locator('#w-bottom .cmp-attach.holding').count() === 0);
      check(tag, 'the cue clears with the hold', await p.evaluate(() => getComputedStyle(document.querySelector('#w-bottom .cmp-attach')).boxShadow) !== armed.shadow);
      check(tag, 'a long-press on the paperclip opens the image-only picker', !!lp && /image/.test(await p.evaluate(() => document.querySelector('#w-bottom input[data-images]').accept)));
      // A hold past the touch shim's 600 ms still ends in the picker: the shim leaves the paperclip alone.
      const held7 = p.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
      const cdp7 = await p.context().newCDPSession(p);
      await cdp7.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
      await p.waitForTimeout(700);
      await cdp7.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      check(tag, 'a 700 ms hold on the paperclip still opens the image-only picker', !!(await held7));
      await cdp7.detach();
      await p.waitForTimeout(200);
      // S-703: real Android raises contextmenu during a hold and sends no click when it ends; emulated
      // touch does neither, so the page gets both made Android's way: the picker must open anyway.
      const heldA = p.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
      await p.evaluate(() => { window.__noClick = (e) => { if (e.target.closest?.('.cmp-attach')) { e.stopImmediatePropagation(); e.preventDefault(); } }; addEventListener('click', window.__noClick, true); });
      const cdpA = await p.context().newCDPSession(p);
      await cdpA.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
      await p.waitForTimeout(550);
      await p.evaluate(({ x, y }) => document.querySelector('#w-bottom .cmp-attach').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })), pt);
      await p.waitForTimeout(150);
      await cdpA.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const lpA = await heldA;
      await cdpA.detach();
      await p.evaluate(() => removeEventListener('click', window.__noClick, true));
      check(tag, 'a hold on the paperclip opens the image-only picker with no click after it (Android)', !!lpA && (await lpA.element().getAttribute('data-images')) !== null);
    }
    await p.waitForTimeout(300);
    check(tag, 'a picked file shows as a chip', await p.locator('#w-bottom .cmp-file:not(.img)').count() === 1);
    await shot('prompt-keyboard');
    await layout('prompt input with keyboard');
    await p.locator('#w-bottom .cmp-file:not(.img) .cmp-x').tap();
    check(tag, 'a file chip\'s remove button works by touch', await p.locator('#w-bottom .cmp-file:not(.img)').count() === 0);
    if (sends) {
      await p.locator('#w-bottom .cmp-send').tap();
      await p.waitForTimeout(1200);
      check(tag, 'send by tapping clears the input', (await ta.inputValue()) === '' && await p.locator('#w-bottom .cmp-file').count() === 0, await p.locator('#w-bottom .cmp-hint').textContent());
    } else await ta.fill('');
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
  });

  // The draft is kept per agent: text typed for helper comes back when the user switches to kid and back.
  await step('prompt draft', async () => {
    const ta = p.locator('#w-bottom .composer textarea');
    const draft = 'Draft kept across a switch';
    await ta.fill(draft);
    check(tag, 'a draft shows the clear button and Save as draft', await p.locator('#w-bottom .cmp-draft').isVisible() && await p.locator('#w-bottom .cmp-clear').isVisible());
    await shot('draft-text');
    // The typing keyboard hides the navigation, so put it away before going to the tree.
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#tree .node:has(.name:text-is("kid"))').first().tap();
    await p.waitForTimeout(800);
    check(tag, 'another agent starts with its own empty prompt input', (await p.locator('#w-bottom .composer textarea').inputValue()) === '');
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator('.name').tap();
    await p.waitForTimeout(800);
    check(tag, 'switching back restores the draft', (await p.locator('#w-bottom .composer textarea').inputValue()) === draft);
    check(tag, 'the restored draft shows Save as draft', await p.locator('#w-bottom .cmp-draft').isVisible());
    await shot('draft-restored');
    await p.locator('#w-bottom .cmp-draft').tap();
    check(tag, 'Save as draft empties the prompt input and puts the text in a draft row', (await p.locator('#w-bottom .composer textarea').inputValue()) === '' && (await p.locator('#w-bottom .ob-row.draft', { hasText: draft }).count()) === 1);
    await p.locator('#w-bottom .ob-row.draft').first().tap();
    check(tag, 'the draft row puts it back in the box', (await p.locator('#w-bottom .composer textarea').inputValue()) === draft);
    await p.locator('#w-bottom .cmp-clear').tap();
    check(tag, 'the clear button empties the prompt input', (await p.locator('#w-bottom .composer textarea').inputValue()) === '' && !(await p.locator('#w-bottom .cmp-clear').count()));
    check(tag, 'the clear button removes the saved draft', await p.evaluate((d) => Object.keys(sessionStorage).filter((k) => k.startsWith('stam/draft/') && sessionStorage.getItem(k) === d).length === 0, draft));
    await keyboard(false);
  });

  await step('agent menu', async () => {
    await p.locator('[data-pane-menu]').tap();
    await p.waitForTimeout(300);
    const items = await p.locator('.menu [role=menuitem]').allTextContents();
    check(tag, 'the pane menu has the agent\'s actions', [/Pause|Unpause/, /Restart/, /Inbox/, /Details/].every((x) => items.some((i) => x.test(i))), items.join(' | '));
    check(tag, 'the menu is a sheet within the screen', await inViewport(p.locator('.menu')));
    await shot('menu');
    await layout('menu');
    await p.locator('.menu [role=menuitem]:has-text("Inbox")').tap();
    await p.waitForTimeout(800);
    const tabs = await p.locator('#w-main .tab').count();
    check(tag, 'Inbox from the menu adds a tab', tabs >= 2, `${tabs} tabs`);
    check(tag, 'the prompt input steps aside for an inbox', !(await p.locator('#w-bottom').isVisible()));
    await p.locator('#w-main .tab').first().tap();
    await p.waitForTimeout(500);
    check(tag, 'tapping a tab switches back to the terminal', await p.locator('#w-main .term-view').first().isVisible());
    await shot('tabs');
    // Close the inbox tab: the active tab shows its close button; the menu has Close tab too.
    await p.locator('#w-main .tab').nth(1).tap();
    await p.locator('#w-main .tab.active .close').tap();
    await p.waitForTimeout(300);
    check(tag, 'the active tab closes by touch', await p.locator('#w-main .tab').count() === tabs - 1);
  });

  // The agent's details, from its menu: its harness and model and, new in S-95, its tokens
  // and cost for today and its life, in a table that must stay readable at 360 px.
  await step('details', async () => {
    await p.locator('[data-pane-menu]').tap();
    await p.waitForTimeout(300);
    await p.locator('.menu [role=menuitem]:has-text("Details")').tap();
    await p.waitForSelector('.details table.usage-tokens');
    await p.waitForTimeout(300);
    const heads = (await p.locator('.details table.usage-tokens th').allTextContents()).join('|');
    check(tag, 'details: the tokens and cost table names today and lifetime', heads.includes('Today') && heads.includes('Lifetime'), heads);
    const rows = await p.locator('.details table.usage-tokens tbody tr').count();
    check(tag, 'details: every token kind and cost has a row', rows === 5, `${rows} rows`);
    check(tag, 'details: the harness and model show', /·/.test((await p.locator('.details dl.kv').textContent()) ?? ''));
    // At 360 px the table sits below the fold: bring it into view so the shot shows it.
    await p.locator('.details table.usage-tokens').scrollIntoViewIfNeeded();
    await p.waitForTimeout(200);
    await shot('details');
    await layout('details');
    // Back to the terminal, so the steps that follow work in the agent's world.
    await p.locator('#w-main .tab').first().tap();
    await p.waitForTimeout(400);
  });

  await step('instructions', async () => {
    await p.locator('[data-pane-menu]').tap();
    await p.waitForTimeout(300);
    await p.locator('.menu [role=menuitem]:has-text("Instructions")').tap();
    await p.waitForSelector('.instructions .inst-part');
    await p.waitForTimeout(500);
    const parts = await p.locator('.instructions .inst-part').count();
    check(tag, 'the instructions view lists the parts', parts >= 3);
    check(tag, 'the outline starts collapsed', await p.locator('.instructions .inst-part[open]').count() === 0);
    check(tag, 'each part row shows its size', await p.locator('.instructions .inst-size').count() === parts);
    await shot('instructions');
    await layout('instructions');
    await p.locator('.instructions .btn:has-text("Expand all")').tap();
    await p.waitForTimeout(300);
    check(tag, 'Expand all opens every part', await p.locator('.instructions .inst-part[open]').count() === parts);
    const edit = p.locator('.instructions .inst-part .inst-actions button').first();
    check(tag, 'a stam part offers Edit in Settings', await edit.isVisible());
    // The first part with an action is the first part the daemon gives an origin.
    const part = (await api(`/api/agents/${helper.id}/instructions`)).parts.find((x) => x.origin);
    await edit.tap();
    await p.waitForSelector('.settings-view .tpl-editor');
    await p.waitForTimeout(400);
    const head = await p.locator('.settings-view .tpl-editor .tpl-head').innerText();
    check(tag, 'Edit in Settings opens Settings on that part, list behind it',
      (await p.locator('.settings-view .settings-inner h2').innerText()) === 'Instructions'
      && await p.locator('.settings-view .tpl-layout').evaluate((e) => e.classList.contains('editing'))
      && !(await p.locator('.settings-view .tpl-list').isVisible()) && head.includes(`${part.origin}.md`), head);
    await p.locator('[data-nav="main"]').tap();
    await p.waitForTimeout(400);
  });

  await step('long press', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.waitForTimeout(300);
    const [x, y] = await center(p.locator(`#tree .node:has(.name:text-is("kid"))`).first());
    // S-628: the browser's own menu never shows: every contextmenu event reaching the page is cancelled.
    await p.evaluate(() => { window.__ctx = []; addEventListener('contextmenu', (e) => setTimeout(() => window.__ctx.push(e.defaultPrevented), 0), true); });
    await touch('touchStart', x, y); await p.waitForTimeout(60); await touch('touchMove', x, y + 30); await p.waitForTimeout(800); await touch('touchEnd', x, y + 30);
    await p.waitForTimeout(200);
    check(tag, 'a hold that moves away opens no menu', !(await p.locator('.menu').count()));
    await longPress(x, y);
    await p.waitForTimeout(300);
    check(tag, 'a long press on an agent shows no native menu (every contextmenu event is cancelled)', (await p.evaluate(() => window.__ctx)).every(Boolean));
    await shot('tree-sheet');
    const items = await p.locator('.menu [role=menuitem]').allTextContents();
    check(tag, 'a long press on an agent opens its menu', items.some((i) => i.includes('Restart')), items.slice(0, 4).join(' | '));
    check(tag, 'the long press didn\'t also open the agent', await p.locator('#tree').isVisible());
    await p.mouse.click(5, 5);
    await p.waitForTimeout(200);
    check(tag, 'a tap outside closes the menu', !(await p.locator('.menu').count()));
    await p.locator(`#tree .node:has(.name:text-is("kid")) [data-more]`).first().tap();
    await p.waitForTimeout(200);
    check(tag, 'each agent row has a visible menu button', await p.locator('.menu').count() === 1);
    await p.mouse.click(5, 5);
  });

  // Issues: the navigation's Issues tab lists the roots; a chevron unfolds children; a row
  // opens the ITSA's world; the status and owner pickers are sheets; New child takes a title
  // above the keyboard; a child opens, and its breadcrumb leads back. Only the sending run
  // changes anything, and it puts the status back.
  await step('issues', async () => {
    await p.locator('[data-nav="issues"]').tap();
    await p.waitForTimeout(400);
    check(tag, 'the Issues tab shows the issues over main', await p.locator('#issues-side').isVisible() && !(await p.locator('#tree').isVisible()) && !(await p.locator('#inbox-view').isVisible()));
    const all = await api('/api/itsas');
    const root = all.find((x) => x.title === 'Check: issue system');
    const first = all.find((x) => x.parent_id === root.id);
    const row = (id) => p.locator(`#issues-side .irow[data-itsa="${id}"]`);
    if (!(await row(first.id).isVisible())) await row(root.id).locator('.chev').tap();
    await p.waitForTimeout(300);
    check(tag, 'a chevron unfolds the children by touch', await row(first.id).isVisible());
    await shot('issues');
    await layout('issues');
    await row(root.id).locator('.ititle').tap();
    await p.waitForSelector(`.itsa-view[data-itsa="${root.id}"]`);
    await p.waitForTimeout(600);
    const view = p.locator(`.itsa-view[data-itsa="${root.id}"]`);
    check(tag, 'tapping an issue opens its world and closes the list', !(await p.locator('#issues-side').isVisible()) && await view.isVisible());
    check(tag, 'the navigation names the ITSA', (await p.locator('[data-nav="main"]').innerText()).includes(root.key));
    check(tag, 'no prompt input under an ITSA', !(await p.locator('#w-bottom').isVisible()));
    await shot('itsa');
    await layout('itsa world');
    // The Time and cost block (S-267): wait-kind rows are touch-sized, and the agent names sit
    // on the column's left edge instead of indented by their hit-area padding. The block fetches
    // its own data after the ITSA renders, so wait for its rows and agents first.
    const cost = view.locator('[data-itsa-activity]');
    await cost.locator('.itsa-activity-kinds summary').first().waitFor();
    await cost.locator('.itsa-activity-agents .crumb-link').first().waitFor();
    check(tag, 'time and cost: the block is shown', await cost.count() === 1);
    const kinds = cost.locator('.itsa-activity-kinds summary');
    check(tag, 'time and cost: the seeded ITSA has wait-kind rows and agents', await kinds.count() > 0 && await cost.locator('.itsa-activity-agents .crumb-link').count() > 0);
    const heights = await kinds.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    check(tag, 'time and cost: every wait-kind row is a touch-size target', heights.length > 0 && heights.every((h) => h >= 44), heights.join(','));
    const markers = await kinds.evaluateAll((els) => els.every((el) => getComputedStyle(el).display === 'list-item'));
    check(tag, 'time and cost: every wait-kind row keeps its disclosure marker', markers);
    const agent = cost.locator('.itsa-activity-agents .crumb-link').first();
    const left = (await cost.locator('.itsa-activity').boundingBox()).x;
    const text = await agent.evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
    check(tag, 'time and cost: an agent name lines up with the column', Math.abs(text - left) <= 1, `${text - left}px`);
    await cost.scrollIntoViewIfNeeded();
    const box = await cost.boundingBox();
    const screen = p.viewportSize().width;
    check(tag, 'time and cost: the block fits the screen with no sideways scroll', !!box && box.x >= 0 && box.x + box.width <= screen + 1);
    const rows = await cost.locator('.itsa-activity dt, .itsa-activity-kinds summary, .itsa-activity-agents .crumb-link').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
    const overlaps = rows.some((a, i) => rows.some((b, j) => j > i && a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1));
    check(tag, 'time and cost: no two rows overlap', !overlaps);
    await shot('itsa-cost');

    await view.locator('[data-prop="status"]').tap();
    await p.waitForTimeout(400);
    const sheet = await p.locator('.menu').boundingBox();
    check(tag, 'the status picker is a sheet at the bottom', !!sheet && Math.abs(sheet.y + sheet.height - p.viewportSize().height) < 2 && sheet.width >= p.viewportSize().width - 1);
    await shot('itsa-status');
    await layout('status sheet');
    if (sends) {
      await p.locator('.menu [role=menuitemradio]').filter({ hasText: /^blocked/ }).tap();
      await p.waitForTimeout(800);
      check(tag, 'a status picked by touch is saved', (await api('/api/itsas/' + root.id)).status === 'blocked');
      check(tag, 'the header shows it', /blocked/.test(await view.locator('[data-prop="status"]').innerText()));
      await api('/api/itsas/' + root.id, 'PATCH', { status: root.status });
    } else await p.mouse.click(5, 5);
    await p.waitForTimeout(300);
    check(tag, 'the status sheet closes', !(await p.locator('.menu').count()));

    await view.locator('[data-prop="owner"]').tap();
    await p.waitForTimeout(400);
    const items = await p.locator('.menu [role=menuitemradio]').allTextContents();
    check(tag, 'the owner picker offers you, nobody, and the agents', ['You', 'No owner', 'helper', 'kid'].every((x) => items.some((i) => i.startsWith(x))), items.join(' | '));
    check(tag, 'the owner picker is a sheet within the screen', await inViewport(p.locator('.menu')));
    await shot('itsa-owner');
    await p.mouse.click(5, 5);
    await p.waitForTimeout(300);

    await view.locator('[data-new-child]').tap();
    await keyboard(true);
    const input = view.locator('.new-itsa input');
    check(tag, 'New child opens a title box', await input.isVisible());
    await input.scrollIntoViewIfNeeded();
    check(tag, 'the title box is above the keyboard', await inViewport(input));
    await layout('new child');
    if (sends) {
      const title = `Phone check: a child ${Date.now().toString(36)}`;
      await input.fill(title);
      await view.locator('.new-itsa .btn').tap();
      // Wait for the child, not for a time: a daemon under load (SEED_ACTIVITY) answers slower.
      // Wait for the settled state: one row with the title, and it is the saved child, not the optimistic "adding" row.
      await p.waitForFunction((t) => { const r = [...document.querySelectorAll('.ikid')].filter((e) => e.textContent.includes(t)); return r.length === 1 && !r[0].hasAttribute('data-pending-child'); }, title, { timeout: 10000 }).catch(() => {});
      check(tag, 'a child added by touch shows in the list', (await view.locator(`.ikid:has-text("${title}")`).count()) === 1 && (await view.locator(`.ikid[data-pending-child]:has-text("${title}")`).count()) === 0,
        JSON.stringify({ n: await view.locator(`.ikid:has-text("${title}")`).count(), kids: await view.locator('.ikid').allTextContents(), input: await input.isVisible().catch(() => null), toast: await p.locator('#toasts').innerText().catch(() => '') }).slice(0, 600));
    } else await input.press('Escape');
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);

    // The comment box at the end of the world: above the keyboard, sent by touch.
    const reply = view.locator('.itsa-reply textarea');
    await reply.scrollIntoViewIfNeeded();
    await reply.tap();
    await keyboard(true);
    await reply.scrollIntoViewIfNeeded();
    check(tag, 'the comment box sits above the keyboard', await inViewport(view.locator('.itsa-reply .cmp-box')));
    check(tag, 'its send button is reachable with the keyboard up', await inViewport(view.locator('.itsa-reply .cmp-send')));
    await shot('itsa-comment');
    await layout('itsa comment');
    if (sends) {
      await reply.fill('Phone check: a comment');
      await view.locator('.itsa-reply .cmp-send').tap();
      await p.waitForTimeout(1500);
      check(tag, 'a comment sent by touch shows in the thread', /Phone check: a comment/.test(await view.locator('[data-itsa-thread]').innerText()));
    } else await reply.fill('');
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);

    await view.locator(`.ikid[data-itsa="${first.id}"]`).tap();
    await p.waitForSelector(`.itsa-view[data-itsa="${first.id}"]`);
    await p.waitForTimeout(400);
    check(tag, 'tapping a child opens its world', await p.locator(`.itsa-view[data-itsa="${first.id}"]`).isVisible());
    await p.locator(`.itsa-view[data-itsa="${first.id}"] .crumb-link`).first().tap();
    await p.waitForTimeout(400);
    check(tag, 'its breadcrumb leads back to the parent', await view.isVisible());
  });

  // Adding an agent: the + menu, a harness's models, and the panel with every choice, all
  // as sheets; an option sheet over the panel; the panel above the keyboard. Adds nothing.
  await step('add agent menu', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.waitForTimeout(300);
    await p.locator('#new-agent').tap();
    await p.waitForSelector('.menu');
    const items = await p.locator('.menu [role=menuitem]').allTextContents();
    check(tag, '+ opens the add menu, the defaults first', /With the defaults/.test(items[0] ?? ''), items.slice(0, 3).join(' | '));
    check(tag, 'the add menu is a sheet within the screen', await inViewport(p.locator('.menu')));
    await shot('add-menu');
    await layout('add menu');
    await p.locator('.menu [role=menuitem]:has-text("Claude Code…")').tap();
    await p.waitForTimeout(200);
    const models = await p.locator('.menu [role=menuitem]').allTextContents();
    check(tag, 'Claude Code… opens its models', models.some((t) => t.includes('haiku 5.5')), models.join(' | '));
    await shot('add-models');
    await layout('add models');
    await p.locator('.menu [role=menuitem]:has-text("More options…")').tap();
    await p.waitForSelector('.spawn-panel');
    await p.waitForTimeout(200);
    const panel = p.locator('.spawn-panel');
    const b = await panel.boundingBox();
    const vp = p.viewportSize();
    check(tag, 'More options opens the panel as a sheet along the bottom', await inViewport(panel) && Math.abs(b.y + b.height - vp.height) < 1.5 && Math.abs(b.width - vp.width) < 1.5, JSON.stringify(b));
    check(tag, 'the panel keeps the Claude Code pick', (await p.locator('.spawn-panel [data-pick="Harness"] .sp-value').innerText()).includes('Claude Code'));
    await shot('add-panel');
    await layout('add panel');
    await p.locator('.spawn-panel [data-pick="Permissions"]').tap();
    await p.waitForTimeout(200);
    check(tag, 'a row opens its options as a sheet over the panel', await p.locator('.menu [role=menuitemradio]').count() === 4 && await inViewport(p.locator('.menu')));
    await shot('add-option');
    await layout('add option');
    await p.locator('.menu [role=menuitemradio]:has-text("Bypass")').tap();
    await p.waitForTimeout(200);
    check(tag, 'picking an option sets the row and keeps the panel', await p.locator('.spawn-panel [data-pick="Permissions"] .sp-value').innerText() === 'Bypass' && !(await p.locator('.menu').count()));
    const name = p.locator('.spawn-panel .sp-field input').first();
    await name.tap();
    await keyboard(true);
    check(tag, 'with the keyboard up, the panel and its name field sit above it', await inViewport(panel) && await inViewport(name));
    check(tag, 'the navigation steps aside for the keyboard', !(await navVisible()));
    await shot('add-panel-keyboard');
    await name.evaluate((el) => el.blur());
    await keyboard(false);
    await p.locator('.spawn-panel [aria-label="Close"]').tap();
    await p.waitForTimeout(200);
    check(tag, 'the close button closes the panel', !(await p.locator('.spawn-panel').count()));
    await p.locator('#new-agent').tap();
    await p.locator('.menu [role=menuitem]:has-text("More options…")').tap();
    await p.waitForSelector('.spawn-panel');
    await p.mouse.click(5, 5);
    await p.waitForTimeout(200);
    check(tag, 'a tap outside closes the panel', !(await p.locator('.spawn-panel').count()));
  });

  await step('mail list', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(300);
    check(tag, 'Mail shows the Inbox page alone', await p.locator('#inbox-view').isVisible() && !(await p.locator('#tree').isVisible()));
    await shot('mail');
    await barCheck('mail list');
    await layout('mail list');
  });

  // The History switch on the Mail tab (S-1456): the worlds shown, rows with touch height, the
  // marked one; a tap on another row jumps there.
  await step('history', async () => {
    await p.locator('[data-history-toggle]').tap();
    const rows = p.locator('#history-side [data-history]');
    await rows.first().waitFor();
    check(tag, 'History lists the worlds shown', await rows.count() >= 1);
    check(tag, 'a History row is at least 44 px tall', (await rows.first().boundingBox()).height >= 44);
    check(tag, 'exactly one History row is marked', await p.locator('#history-side [data-history].sel').count() === 1);
    await shot('history');
    await layout('history');
    await p.locator('[data-history-toggle]').tap();
    check(tag, 'the switch goes back to the mail list', await p.locator('#history-side').count() === 0);
  });

  // The Needs you list on the Mail tab (S-3953): the toggle is pressed and its list takes the inbox's place, its count is
  // the open rows, and a row is a touch target. The switch goes back to the inbox.
  await step('needs you', async () => {
    await p.locator('[data-needs-you]').tap();
    const rows = p.locator('#inbox-view .needs-row');
    await p.waitForSelector('#inbox-view .needs-row, #inbox-view .mail-empty', { timeout: 10000 });
    check(tag, 'Needs you: the toggle is pressed', (await p.locator('[data-needs-you]').getAttribute('aria-pressed')) === 'true');
    check(tag, 'Needs you: the list takes the inbox\'s place', await p.locator('#inbox-view [data-inbox-list]').isHidden());
    check(tag, 'Needs you: the filter chips and the count line are hidden', await p.locator('#inbox-view .inbox-chip, #inbox-view [data-inbox-count]').count() === 0);
    const open = await p.locator('#inbox-view .needs-row.open').count();
    const n = Number((await p.locator('[data-needs-you]').innerText()).match(/\((\d+)\)/)?.[1] ?? -1);
    check(tag, 'Needs you: the toggle counts the open rows', n === open, `${n} against ${open} rows`);
    const rowN = await rows.count();
    check(tag, 'Needs you: the list has rows to measure', rowN >= 1, `${rowN} rows`);
    if (rowN) check(tag, 'Needs you: a row is at least 44 px tall', (await rows.first().boundingBox()).height >= 44);
    await shot('needs-you');
    await layout('needs-you');
    // One mode at a time: History replaces Needs you, and Needs you replaces History.
    await p.locator('[data-history-toggle]').tap();
    check(tag, 'Needs you: History replaces the list, and Needs you is no longer pressed', await p.locator('#history-side').count() > 0 && await p.locator('#inbox-view .needs-row').count() === 0 && (await p.locator('[data-needs-you]').getAttribute('aria-pressed')) === 'false');
    await p.locator('[data-needs-you]').tap();
    check(tag, 'Needs you: Needs you replaces History', await p.locator('#history-side').count() === 0 && await p.locator('#inbox-view .needs-row').count() === rowN);
    await p.locator('[data-needs-you]').tap();
    check(tag, 'Needs you: the switch goes back to the inbox list', await p.locator('#inbox-view [data-inbox-list]').isVisible() && await p.locator('#history-side').count() === 0);
  });

  // A tapped image alone, full screen (S-86): pinch-zoom and pan live there, so the page is
  // never zoomed. A compare block's slider keeps sliding under a drag and opens the viewer
  // on a tap; Back, and a tap on the backdrop, close it.
  await step('image viewer', async () => {
    await p.locator('.mrow[title*="Check: images to zoom"]').tap();
    await p.waitForSelector('.thread-view:visible .mb-embed.image img', { timeout: 10000 });
    await p.waitForTimeout(600);
    const img = p.locator('.thread-view:visible .mb-embed.image img').first();
    await img.scrollIntoViewIfNeeded();
    const src = await img.evaluate((e) => e.src);
    await img.tap();
    await p.waitForSelector('#img-view');
    // The viewer's image may still be laying out after the tap; wait for it rather than read once.
    const shown = await p.locator('#img-view .iv-img').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    check(tag, 'viewer: tapping an image opens it', shown);
    check(tag, 'viewer: it fills the screen', await p.locator('#img-view').evaluate((e) => { const b = e.getBoundingClientRect(); return Math.abs(b.width - innerWidth) < 1.5 && Math.abs(b.height - innerHeight) < 1.5; }));
    check(tag, 'viewer: it shows the image that was tapped', (await p.locator('#img-view .iv-img').evaluate((e) => e.src)) === src);
    await shot('image-viewer');
    await layout('image viewer');
    // A double-tap zooms the image in, not the page.
    const b = await p.locator('#img-view .iv-img').boundingBox();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    await touch('touchStart', cx, cy); await touch('touchEnd', cx, cy);
    await touch('touchStart', cx, cy); await touch('touchEnd', cx, cy);
    await p.waitForTimeout(200);
    const tf = await p.locator('#img-view .iv-img').evaluate((e) => e.style.transform);
    check(tag, 'viewer: a double-tap zooms the image in', /scale\(([2-9]|1\.[1-9])/.test(tf), tf);
    await shot('image-viewer-zoomed');
    // The phone's Back button closes it and leaves the thread in place.
    await p.goBack().catch(() => {});
    await p.waitForTimeout(500);
    check(tag, 'viewer: Back closes it and stays in the thread', !(await p.locator('#img-view').count()) && await p.locator('.thread-view:visible .msg').first().isVisible());
    // Dragging a compare slider must not open the viewer.
    const cmp = p.locator('.thread-view:visible .mb-cmp-stage').first();
    await cmp.scrollIntoViewIfNeeded();
    const cb = await cmp.boundingBox();
    await drag(cb.x + cb.width * 0.75, cb.y + cb.height / 2, cb.x + cb.width * 0.25, cb.y + cb.height / 2);
    await p.waitForTimeout(300);
    check(tag, 'viewer: dragging a compare slider doesn\'t open it', !(await p.locator('#img-view').count()));
    // A tap on the compare block opens its after image; a backdrop tap closes it.
    await cmp.tap();
    await p.waitForTimeout(300);
    check(tag, 'viewer: a tap on a compare block opens its image', await p.locator('#img-view .iv-img').count() === 1);
    await p.touchscreen.tap(20, 20);
    await p.waitForTimeout(300);
    check(tag, 'viewer: a tap on the backdrop closes it', !(await p.locator('#img-view').count()));
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(300);
  });

  // A note on a decision, written in the reply box in note mode, finished with its own button.
  // The sending run keeps one note, which 'thread answers' then sends with a chosen option.
  await step('decision notes', async () => {
    await p.locator('.mrow[title*="Check: decisions and callouts"]').tap();
    await p.waitForSelector('.thread-view .msg', { timeout: 10000 });
    await p.waitForTimeout(800);
    if (await p.locator('.thread-view:visible .mb-decision.answered').count()) { check(tag, 'notes: answers already sent by an earlier run; restart daemon.sh to check them', false); return; }
    const dec = p.locator('.thread-view:visible .mb-decision:not(.multi):not(.rank):not(.yesno)').first();
    const yes = p.locator('.thread-view:visible .mb-decision.yesno').first();
    const cmp = p.locator('.thread-reply .composer:visible');
    const ta = cmp.locator('textarea');
    const prev = () => p.locator('.reply-preview:visible').textContent().catch(() => '');
    // The header is one line that scrolls away; who's in the thread unfolds from its button.
    const head = p.locator('.thread-view:visible .thread-head');
    check(tag, 'thread: the header is one line and scrolls with the messages', (await head.boundingBox()).height <= 45 + 1 && await head.evaluate((h) => getComputedStyle(h).position) !== 'sticky');
    await head.locator('.th-people').tap();
    check(tag, 'thread: the people button unfolds who is in the thread', await head.locator('.people').isVisible() && /helper|kid/.test(await head.locator('.people').textContent()));
    await head.locator('.th-people').tap();
    check(tag, 'thread: tapping it again folds them', !(await head.locator('.people').isVisible()));
    // The mail-rules verdict, from the stubbed decision model, shows on the message.
    const dthread = (await api('/api/agents/human/threads?limit=60')).find((x) => /^Check: decisions/.test(x.mails[0].subject));
    const vmark = p.locator(`.thread-view:visible .msg[data-id="${dthread.mails[0].id}"] .verdict.ok`);
    await vmark.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    check(tag, 'thread: the mail-rules check shows on the message', await vmark.count() === 1);
    check(tag, 'thread: the check names the verdict and scores', /Follows the mail rules: yes/.test((await vmark.getAttribute('title')) ?? ''));
    await vmark.tap();
    check(tag, 'thread: tapping the check shows its scores', await vmark.locator('.verdict-note').isVisible());
    await vmark.tap();
    check(tag, 'thread: tapping it again hides them', await vmark.locator('.verdict-note').count() === 0);
    await shot('thread-rest');
    await messageRoom('thread at rest');
    await layout('thread at rest');
    // S-102: a plain reply shows no preview; only a staged decision answer or note gets one.
    await ta.fill('Plain notes, no decision.');
    check(tag, 'notes: plain text alone shows no preview', !(await p.locator('.reply-preview:visible').isVisible()));
    await ta.fill('');
    await dec.locator('.mb-foot [data-own]').tap();
    await keyboard(true);
    check(tag, 'notes: Add a note raises the keyboard in note mode', await cmp.evaluate((c) => c.classList.contains('noting')) && await ta.evaluate((x) => document.activeElement === x));
    check(tag, 'notes: the reply box names the decision', /How long should SSO tokens live/.test(await cmp.locator('.cmp-target').textContent()));
    check(tag, 'notes: the reply box and its Add note button sit above the keyboard', await inViewport(cmp.locator('.cmp-box')) && await inViewport(cmp.locator('.cmp-send[aria-label="Add note"]')));
    await ta.fill('Both, per team.');
    await shot('note-mode-keyboard');
    check(tag, 'notes: the preview steps aside while a note is written', !(await p.locator('.reply-preview:visible').isVisible()));
    await messageRoom('note mode with the keyboard');
    await layout('note mode');
    await cmp.locator('.cmp-send[aria-label="Add note"]').tap();
    check(tag, 'notes: Add note puts the note in its block and leaves note mode', await dec.locator('.mb-note-text').textContent() === 'Both, per team.' && !(await cmp.evaluate((c) => c.classList.contains('noting'))));
    check(tag, 'notes: the preview carries the note', /Note: Both, per team\./.test(await prev()), await prev());
    // At 360 px the keyboard leaves little of the thread; put it away to reach the next block.
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
    // A note on a chosen option, cancelled with the cancel button, then written.
    await yes.locator('.mb-opt').first().tap();
    await yes.locator('.mb-foot [data-own]').tap();
    await ta.fill('Not this.');
    await cmp.locator('.cmp-cancel').tap();
    check(tag, 'notes: the cancel button leaves the block without a note', await yes.locator('.mb-note').count() === 0 && !(await cmp.evaluate((c) => c.classList.contains('noting'))));
    await yes.locator('.mb-foot [data-own]').tap();
    await ta.fill('Cap it at $15.');
    await cmp.locator('.cmp-send[aria-label="Add note"]').tap();
    check(tag, 'notes: a note joins the chosen option in the preview', /Chose Yes\.\s*Note: Cap it at \$15\./.test(await prev()), await prev());
    // Edit, then Remove, by touch.
    // The preview leaves the thread a short strip at 360 px; bring the note to its middle.
    const centre = (loc) => loc.evaluate((e) => e.scrollIntoView({ block: 'center' })).then(() => p.waitForTimeout(200));
    await centre(dec.locator('.mb-note'));
    await dec.locator('.mb-note button[data-own]').tap();
    check(tag, 'notes: Edit opens note mode with the note', await ta.inputValue() === 'Both, per team.', await ta.inputValue());
    await ta.fill('Neither: 4 hours.');
    await cmp.locator('.cmp-send[aria-label="Add note"]').tap();
    check(tag, 'notes: the edit replaces the note', await dec.locator('.mb-note-text').textContent() === 'Neither: 4 hours.' && /Note: Neither: 4 hours\./.test(await prev()));
    await centre(yes.locator('.mb-note'));
    await yes.locator('[data-unnote]').tap();
    check(tag, 'notes: Remove takes the note out of the block and the preview', await yes.locator('.mb-note').count() === 0 && !/Cap it at/.test(await prev()) && /Chose Yes/.test(await prev()));
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
    await dec.scrollIntoViewIfNeeded();
    await shot('note-preview');
    await layout('thread with a note');
    // Unstage the Yes; the sending run keeps the note on the first decision.
    await yes.locator('.mb-opt').first().tap();
    if (!sends) await p.locator('.reply-preview:visible .mb-own:has-text("Clear answers")').tap();
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(300);
  });

  await step('archive', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(300);
    const threads = await api('/api/agents/human/threads?limit=60');
    const t = threads.find((x) => /^Check: archive me/.test(x.mails[0]?.subject ?? ''));
    check(tag, 'archive: a thread is seeded for archiving', !!t);
    if (!t) return;
    const row = () => p.locator(`.mrow[data-thread="${t.thread_id}"]`);
    // The pinned waiting rows sit above the mail, so this thread can start below the fold: bring it into view.
    await row().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await p.waitForTimeout(200);
    const [x, y] = await center(row());
    // A cancelled gesture resets the row without archiving it.
    await touch('touchStart', x + 60, y);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', x + 60 - i * 20, y); await p.waitForTimeout(16); }
    await touch('touchCancel', x - 60, y);
    await p.waitForTimeout(400);
    check(tag, 'archive: a cancelled swipe leaves the thread in the list', await row().count() === 1);
    check(tag, 'archive: a cancelled swipe resets the row', await row().evaluate((el) => getComputedStyle(el).transform === 'none'));
    // A finger drags the row left; the row slides over the archive affordance behind it.
    await touch('touchStart', x + 60, y);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', x + 60 - i * 20, y); await p.waitForTimeout(16); }
    const tf = await row().evaluate((el) => getComputedStyle(el).transform);
    check(tag, 'archive: the row slides left over the archive affordance', tf !== 'none' && tf !== '', tf);
    await shot('archive-swipe');
    await touch('touchEnd', x - 60, y);
    await p.waitForTimeout(800);
    check(tag, 'archive: swiping a row left archives it', await row().count() === 0);
    await p.locator('[data-filter="archived"]').tap();
    await p.waitForTimeout(400);
    check(tag, 'archive: the Archived view lists it', await row().count() === 1);
    await shot('archived');
    await layout('archived list');
    // Swiping the archived row left unarchives it.
    const [x2, y2] = await center(row());
    await drag(x2 + 60, y2, x2 - 60, y2);
    await p.waitForTimeout(800);
    check(tag, 'archive: swiping again unarchives it', await row().count() === 0);
    await p.locator('[data-filter="all"]').tap();
    await p.waitForTimeout(400);
    check(tag, 'archive: it is back in the mail list', await row().count() === 1);
    // The open thread's header and its menu offer Archive too.
    await row().tap();
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
    await p.waitForTimeout(400);
    check(tag, 'archive: the open thread offers Archive in the top bar', await p.locator('.tab-actions [data-archive]').isVisible());
    check(tag, 'archive: the thread header has no Archive of its own on the phone', await p.locator('.thread-view:visible .thread-head [data-archive]').isVisible() === false);
    // The thread scrolls under the top bar; Archive stays where it is.
    const scroller = p.locator('.thread-view:visible .thread-scroll');
    const scrolls = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight);
    check(tag, 'archive: the thread is long enough to scroll', scrolls);
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await p.waitForTimeout(300);
    check(tag, 'archive: the thread scrolled', await scroller.evaluate((el) => el.scrollTop > 0));
    const bar = await p.locator('.tab-actions [data-archive]').boundingBox();
    const top = await p.locator('.tabbar').boundingBox();
    check(tag, 'archive: the top-bar Archive stays visible after scrolling', !!bar && !!top && bar.y >= top.y && bar.y + bar.height <= top.y + top.height + 1 && bar.width >= 44 && bar.height >= 44, JSON.stringify(bar));
    await shot('archive-scrolled');
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await p.waitForTimeout(300);
    await p.locator('[data-pane-menu]').tap();
    await p.waitForTimeout(300);
    const items = await p.locator('.menu [role=menuitem]').allTextContents();
    check(tag, 'archive: the thread menu offers Archive', items.some((i) => /^Archive\b/.test(i.trim())), items.slice(0, 6).join(' | '));
    await p.locator('.menu [role=menuitem]').filter({ hasText: /^Archive$/ }).first().tap();
    await p.waitForTimeout(900);
    // Restore it from the Archived view by swipe.
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(400);
    await p.locator('[data-filter="archived"]').tap();
    await p.waitForTimeout(400);
    const [x3, y3] = await center(row());
    await drag(x3 + 60, y3, x3 - 60, y3);
    await p.waitForTimeout(800);
    await p.locator('[data-filter="all"]').tap();
    await p.waitForTimeout(400);
    check(tag, 'archive: the thread is restored after menu archiving', await row().count() === 1);
  });

  // A reply archives its thread and opens the next mail below it; Archive with the thread opened
  // from below opens the one above (S-148). The threads go back to the inbox afterwards.
  await step('reply and archive advance', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(400);
    // Every thread row but a decision's: the decision row (S-352) is pinned above the mail, and leaving it out keeps the order these steps have always had.
    const ids = await p.locator('#inbox-view .mrow[data-thread]:not([data-decision]):not(.ask)').evaluateAll((rs) => rs.map((r) => r.dataset.thread));
    check(tag, 'advance: the inbox has four mails to move through', ids.length >= 4, `${ids.length}`);
    if (ids.length < 4) return;
    const open = async (tid) => {
      await p.locator('[data-nav="mail"]').tap();
      await p.waitForTimeout(300);
      await p.locator(`.mrow[data-thread="${tid}"]`).tap();
      await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
      await p.waitForTimeout(400);
    };
    const shownKey = () => p.locator('.pane .tab.active').getAttribute('data-key');
    const archivedIds = async () => (await api('/api/agents/human/threads?limit=60&archived=1')).map((x) => x.thread_id);
    // Reply from a mail opened below the one before it: the next mail is the one below.
    await open(ids[0]);
    await open(ids[1]);
    const ta = p.locator('.thread-reply textarea:visible');
    await ta.tap();
    await ta.fill('Advance check: a reply from the phone.');
    await shot('reply-before');
    await p.locator('.thread-reply .cmp-send:visible').tap();
    await p.waitForTimeout(1500);
    check(tag, 'advance: the reply archives its thread', (await archivedIds()).includes(ids[1]));
    check(tag, 'advance: the reply opens the next mail below it', (await shownKey()) === 'thread:' + ids[2], await shownKey());
    await shot('reply-after');
    // Archive with the mail opened from below (bottom up): the one above opens.
    await open(ids[3]);
    await open(ids[2]);
    await p.locator('.tab-actions [data-archive]').tap();
    await p.waitForTimeout(800);
    check(tag, 'advance: Archive from below opens the one above', (await shownKey()) === 'thread:' + ids[0], await shownKey());
    for (const tid of [ids[1], ids[2]]) await api(`/api/agents/human/threads/${tid}/unarchive`, 'POST', {});
  });

  // The Swipe view (S-1003): the inbox as a stack of cards. A short pull springs back, a pull
  // right leaves the card (no server change), left archives, up defers (Undo brings it back),
  // and a tap opens the thread, whose Archive comes back to the stack. Threads go back after.
  await step('swipe', async () => {
    // A blocker card (S-1310): the stub's CHOICE marker makes the mail check call it a blocker, so the
    // confirm is reached on every run. It is newest, so it is the card on top.
    const sent = await api('/api/mail', 'POST', { from: 'kid', to: ['human'], new_thread: true, subject: 'Check: swipe confirm blocker', body: 'TLDR: CHOICE=blocker The deploy waits on a secret only you can set.' });
    let kindSet = false, blockerTid = '';
    for (let i = 0; i < 50 && !kindSet; i++) {
      const th = (await api('/api/agents/human/threads?limit=60')).find((t) => t.mails.some((m) => m.subject === 'Check: swipe confirm blocker'));
      blockerTid = th?.thread_id ?? '';
      kindSet = !!th?.mails.find((m) => m.subject === 'Check: swipe confirm blocker')?.verdict?.kind;
      if (!kindSet) await p.waitForTimeout(200);
    }
    check(tag, 'swipe: the seeded blocker mail has its kind', kindSet, JSON.stringify(sent).slice(0, 300));
    await p.locator('[data-nav="mail"]').tap();
    // The mail list has the blocker before the stack opens: the API's thread can come before the page's live update.
    await p.waitForFunction((s) => [...document.querySelectorAll('.mrow')].some((e) => e.textContent.includes(s)), 'Check: swipe confirm blocker', { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(300);
    await p.locator('[data-swipe-toggle]').tap();
    await p.waitForSelector('.swipe-view:visible .swipe-top', { timeout: 10000 });
    await p.waitForTimeout(400);
    const topId = () => p.locator('.swipe-view:visible .swipe-top').getAttribute('data-card');
    const n = Number((await p.locator('.swipe-view:visible [data-swipe-count]').textContent()).match(/\d+/)?.[0] ?? 0);
    check(tag, 'swipe: the Swipe view stacks the inbox', n >= 3, `${n} cards`);
    // A card is a mail to you: its sender is the other party, never you.
    const from = await p.locator('.swipe-view:visible .swipe-top .mc-from').textContent();
    check(tag, 'swipe: the top card names the other party, not you', from.trim() !== 'you', from);
    await shot('swipe');
    await layout('swipe view');
    const card = p.locator('.swipe-view:visible .swipe-top');
    // The blocker card asks before it archives: the card stays, and the bar's buttons are touch targets.
    // Leave cards (nothing changes on the server) until it is on top.
    // Each leave waits for the top card to change, so a slow render can't leave the loop a card behind.
    const seen = [];
    for (let i = 0; i < 2 * n && (await topId()) !== blockerTid; i++) {
      const before = await topId();
      seen.push(before);
      await p.locator('.swipe-view:visible [data-swipe-act=leave]').tap();
      // Polls through the locator (the `:visible` pseudo-class isn't CSS). A top that never changes ends the loop with the ids seen.
      for (const deadline = Date.now() + 5000; Date.now() < deadline && (await topId()) === before;) await p.waitForTimeout(50);
    }
    {
      const topBefore = await topId();
      const [bx, by] = await center(card);
      await drag(bx, by, bx - 200, by);
      await p.waitForTimeout(700);
      const bar = p.locator('.swipe-view:visible [data-swipe-confirm]');
      check(tag, 'swipe: a pull left on a blocker asks first, the card stays', topBefore === blockerTid && await bar.count() === 1 && (await topId()) === topBefore, `${topBefore} vs ${blockerTid}; ${n} cards, seen ${seen.join(' ')}`);
      await shot('swipe-confirm');
      await layout('swipe confirm');
      const boxes = await bar.locator('button').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
      check(tag, 'swipe: the confirm buttons are at least 44 px tall', boxes.length === 2 && boxes.every((h) => h >= 44), boxes.join(' '));
      await p.locator('.swipe-view:visible [data-swipe-confirm-cancel]').tap();
      await p.waitForTimeout(300);
      check(tag, 'swipe: Cancel keeps the card', (await topId()) === topBefore && await bar.count() === 0);
      await drag(bx, by, bx - 200, by);
      await p.waitForTimeout(600);
      await p.locator('.swipe-view:visible [data-swipe-confirm-yes]').tap();
      await p.waitForTimeout(900);
      const gone = (await api('/api/agents/human/threads?limit=60&archived=1')).some((t) => t.thread_id === topBefore);
      check(tag, 'swipe: Archive in the confirm archives the blocker', gone && (await topId()) !== topBefore);
    }
    // A thread that waits on you can't be archived: leave such cards until one can.
    for (let i = 0; i < n && await p.locator('.swipe-view:visible [data-swipe-act=archive]').isDisabled(); i++) await p.locator('.swipe-view:visible [data-swipe-act=leave]').tap();
    const first = await topId();
    const [x, y] = await center(card);
    // A short pull left shows the hint and springs back.
    await touch('touchStart', x, y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', x - i * 6, y); await p.waitForTimeout(16); }
    check(tag, 'swipe: a pull left shows Archive behind the card', await p.locator('.swipe-view:visible .swipe-hint.archive.on').count() === 1);
    await shot('swipe-pull');
    await touch('touchEnd', x - 48, y);
    await p.waitForTimeout(500);
    const archivedIds = async () => (await api('/api/agents/human/threads?limit=60&archived=1')).map((t) => t.thread_id);
    check(tag, 'swipe: a short pull springs back', (await topId()) === first && !(await archivedIds()).includes(first) && await card.evaluate((el) => getComputedStyle(el).transform === 'none'), await topId());
    const deferredIds = async () => (await api('/api/agents/human/threads?limit=60&deferred=1')).map((t) => t.thread_id);
    // Right: the next card, nothing archived.
    await drag(x, y, x + 200, y);
    await p.waitForTimeout(500);
    check(tag, 'swipe: a pull right leaves the card for the next', (await topId()) !== first && !(await archivedIds()).includes(first), await topId());
    for (let i = 0; i < n && await p.locator('.swipe-view:visible [data-swipe-act=archive]').isDisabled(); i++) await p.locator('.swipe-view:visible [data-swipe-act=leave]').tap();
    // Left: archived.
    const second = await topId();
    await drag(x, y, x - 200, y);
    await p.waitForTimeout(900);
    // Some seeded cards are decisions or blockers: they ask first (checked above), so confirm.
    if (await p.locator('.swipe-view:visible [data-swipe-confirm]').count()) {
      await p.locator('.swipe-view:visible [data-swipe-confirm-yes]').tap();
      await p.waitForTimeout(900);
    }
    check(tag, 'swipe: a pull left archives the thread', (await archivedIds()).includes(second) && (await topId()) !== second);
    await api(`/api/agents/human/threads/${second}/unarchive`, 'POST', {});
    // Up: deferred; Undo moves it back.
    for (let i = 0; i < n && await p.locator('.swipe-view:visible [data-swipe-act=defer]').isDisabled(); i++) await p.locator('.swipe-view:visible [data-swipe-act=leave]').tap();
    const third = await topId();
    await drag(x, y, x, y - 220);
    await p.waitForTimeout(900);
    check(tag, 'swipe: a pull up defers the thread', (await deferredIds()).includes(third));
    await shot('swipe-undo');
    await p.locator('.swipe-view:visible [data-swipe-undo]').tap();
    await p.waitForTimeout(900);
    check(tag, 'swipe: Undo moves the deferred thread back', !(await deferredIds()).includes(third));
    await layout('swipe view after an action');
    // A tap opens the thread; its Archive comes back to the stack.
    await p.waitForTimeout(300);
    for (let i = 0; i < n && await p.locator('.swipe-view:visible [data-swipe-act=archive]').isDisabled(); i++) await p.locator('.swipe-view:visible [data-swipe-act=leave]').tap();
    const fourth = await topId();
    await card.tap();
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
    await p.waitForTimeout(400);
    check(tag, 'swipe: a tap opens the thread', (await p.locator('.pane .tab.active').getAttribute('data-key')) === 'thread:' + fourth);
    await p.locator('.tab-actions [data-archive]').tap();
    await p.waitForTimeout(900);
    check(tag, 'swipe: archiving the opened thread returns to the Swipe view', await p.locator('.swipe-view:visible').count() === 1 && (await archivedIds()).includes(fourth));
    await api(`/api/agents/human/threads/${fourth}/unarchive`, 'POST', {});
  });

  // An S-N key in a mail's body and subject is a link: a tap opens that ITSA's world; keys in
  // code and keys no ITSA has stay plain.
  await step('itsa links', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
    await p.locator('.mrow[title*="Check: S-4 review notes"]').tap();
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
    await p.waitForTimeout(800);
    const links = p.locator('.thread-view:visible a[data-open-itsa]');
    check(tag, 'itsa links: the keys in the body and the subject are links', await links.count() >= 3, `${await links.count()}`);
    check(tag, 'itsa links: no link inside code', await p.locator('.thread-view:visible :is(code, pre) a[data-open-itsa]').count() === 0);
    check(tag, 'itsa links: a key no ITSA has stays plain', /S-999/.test(await p.locator('.thread-view:visible .msg').first().innerText()) && !(await p.locator('.thread-view:visible a[data-open-itsa]:text-is("S-999")').count()));
    check(tag, 'itsa links: a link is a reachable tap target', (await links.first().boundingBox()).height >= 16);
    await shot('itsa-link');
    await layout('mail with ITSA links');
    await p.locator('.thread-view:visible .msg a[data-open-itsa]:text-is("S-4")').first().tap();
    // The ITSA view mounts empty and fills once its ITSA loads, so wait for its title, not the box.
    await p.locator('.itsa-view:visible', { hasText: 'Issues section in the sidebar' }).first().waitFor({ timeout: 10000 });
    check(tag, 'itsa links: a tap opens the ITSA', /Issues section in the sidebar/.test(await p.locator('.itsa-view:visible').first().innerText()));
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
  });

  // A mail that names an ITSA shows it as a chip under the header: glyph, key, the title cut
  // short; a tap opens the ITSA.
  await step('itsa chip', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
    await p.locator('.mrow[title*="Check: a mail about an ITSA"]').tap();
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
    await p.waitForTimeout(800);
    const chip = p.locator('.thread-view:visible .thread-head .ichip-mail');
    check(tag, 'itsa chip: the mail about an ITSA shows its chip', await chip.count() === 1);
    check(tag, 'itsa chip: it shows the key and the title', /S-\d+/.test(await chip.innerText()) && /Issues section/.test(await chip.innerText()), await chip.innerText());
    check(tag, 'itsa chip: it is a touch target', (await chip.boundingBox()).height >= 44);
    check(tag, 'itsa chip: it fits the width', (await chip.boundingBox()).x + (await chip.boundingBox()).width <= p.viewportSize().width);
    await shot('itsa-chip');
    await layout('mail with an ITSA chip');
    await chip.tap();
    await p.locator('.itsa-view:visible', { hasText: 'Issues section in the sidebar' }).first().waitFor({ timeout: 10000 });
    check(tag, 'itsa chip: a tap opens the ITSA', /Issues section in the sidebar/.test(await p.locator('.itsa-view:visible').first().innerText()));
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
  });

  // The ITSAs a mail names itself show as compact keys on its sender line (S-986), each a touch target; a tap opens the ITSA.
  // The seeded thread links two: the first message names both, the reply one, so only the first message has a chip.
  await step('compact itsa chips', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
    await p.locator('.mrow[title*="Check: compact ITSA chips"]').tap();
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
    await p.waitForTimeout(800);
    check(tag, 'compact itsa chips: the header lists both ITSAs', await p.locator('.thread-view:visible .thread-head .ichip-mail').count() === 2);
    const chips = p.locator('.thread-view:visible .msg header .msg-itsas .ichip-mail');
    check(tag, 'compact itsa chips: only the ITSA not every message links shows on a message', await chips.count() === 1, `${await chips.count()}`);
    const b = await chips.first().boundingBox();
    check(tag, 'compact itsa chips: a chip is a touch target', b && b.height >= 44 && b.width >= 24, JSON.stringify(b));
    check(tag, 'compact itsa chips: the sender line stays one line', (await p.locator('.thread-view:visible .msg header').first().boundingBox()).height < 70);
    await p.locator('.thread-view:visible .msg').first().scrollIntoViewIfNeeded();
    await shot('compact-itsa-chips');
    await layout('mail with compact ITSA chips');
    const id = await chips.first().getAttribute('data-about-itsa');
    await chips.first().tap();
    await p.waitForFunction((w) => window.stamDebug.shell.currentWorld() === w, 'w:itsa:' + id, { timeout: 10000 });
    check(tag, 'compact itsa chips: a tap opens the ITSA', true);
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
  });

  // A mail naming four ITSAs, with a model title, keeps its sender line inside the card at 360 px (S-986): two keys and "+1" inline,
  // the "to" part whole or on another line, never cut to a stub; the "+1" scrolls to the header chips.
  await step('many itsa chips', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
    await p.locator('.mrow[title*="Check: four ITSA keys"]').tap();
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
    await p.waitForTimeout(800);
    const hdr = p.locator('.thread-view:visible .msg:has(.msg-itsas) header').first();
    const m = await hdr.evaluate((h) => {
      const to = h.querySelector('.to');
      const hb = h.getBoundingClientRect();
      const tb = to?.getBoundingClientRect();
      return { sw: h.scrollWidth, cw: h.clientWidth, toText: to?.textContent ?? '', toClipped: !!to && to.scrollWidth > to.clientWidth + 1, toInside: !tb || (tb.right <= hb.right + 1 && tb.width > 0), keys: [...h.querySelectorAll('.msg-itsas .ichip-mail')].map((c) => c.textContent) };
    });
    check(tag, 'many itsa chips: the sender line fits the card', m.sw <= m.cw, JSON.stringify(m));
    check(tag, 'many itsa chips: the "to" part is whole, not clipped to a stub', !m.toClipped && m.toInside && m.toText.length >= 6, JSON.stringify(m));
    check(tag, 'many itsa chips: two keys and a +1 chip', m.keys.length === 3 && /^\+1$/.test(m.keys[2]), JSON.stringify(m.keys));
    await hdr.scrollIntoViewIfNeeded();
    await shot('many-itsa-chips');
    await layout('mail with four ITSA keys');
    await hdr.locator('[data-more-itsas]').tap();
    await p.waitForTimeout(400);
    check(tag, 'many itsa chips: the +1 brings the header chips into view', await p.locator('.thread-view:visible .th-itsas').evaluate((e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }));
    // S-1411: the header chips are one scrolling line; with 60 chips the row keeps its height and scrolls sideways.
    const row = await p.locator('.thread-view:visible .th-itsas').evaluate((e) => {
      const h0 = e.getBoundingClientRect().height;
      for (let i = 0; i < 60; i++) e.append(e.firstElementChild.cloneNode(true));
      const r = e.getBoundingClientRect();
      return { h0, h1: r.height, scrolls: e.scrollWidth > e.clientWidth, inside: r.right <= innerWidth + 1 };
    });
    await shot('many-itsa-chips-60');
    check(tag, 'many itsa chips: 60 chips stay one line that scrolls sideways', row.h1 === row.h0 && row.scrolls && row.inside);
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
  });

  // A Markdown table wider than the message scrolls sideways inside its own box (S-611); the
  // page itself never does.
  await step('wide table', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
    await p.locator('.mrow[title*="Check: a wide table"]').tap();
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
    await p.waitForTimeout(800);
    const box = p.locator('.thread-view:visible .mb-table', { has: p.locator('th', { hasText: 'Column 12' }) });
    const m = await box.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
    check(tag, 'wide table: the table scrolls sideways in its box', m.sw > m.cw && (m.ox === 'auto' || m.ox === 'scroll'), JSON.stringify(m));
    const doc = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    check(tag, 'wide table: the page does not scroll sideways', doc.sw <= doc.iw, JSON.stringify(doc));
    await shot('wide-table');
    await layout('mail with a wide table');
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
  });

  // A realistic table (S-611): seven columns of ids, 40-60 character titles, and status words. It
  // keeps its natural width and scrolls in its box, and its title cells stay readable.
  await step('merged PR table', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
    await p.locator('.mrow[title*="Check: merged PRs"]').tap();
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
    await p.waitForTimeout(800);
    const box = p.locator('.thread-view:visible .mb-table', { has: p.locator('th', { hasText: 'Branch' }) });
    const m = await box.evaluate((el) => {
      const t = el.querySelector('table');
      const title = [...t.tHead.rows[0].cells].findIndex((c) => c.textContent.trim() === 'Title');
      const cell = t.tBodies[0].rows[0].cells[title];
      return { sw: el.scrollWidth, cw: el.clientWidth, titleW: Math.round(cell.getBoundingClientRect().width) };
    });
    check(tag, 'merged PR table: it scrolls sideways in its box', m.sw > m.cw, JSON.stringify(m));
    check(tag, 'merged PR table: title cells stay readable (at least 100 px)', m.titleW >= 100, JSON.stringify(m));
    // The scroll cue (S-611): a shadow on each edge of the box, behind the cover that hides it at the end.
    const cue = await box.evaluate((el) => getComputedStyle(el).backgroundImage.split('linear-gradient').length - 1);
    check(tag, 'merged PR table: the scroll cue is on the box (four gradient layers)', cue === 4, String(cue));
    const doc = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    check(tag, 'merged PR table: the page does not scroll sideways', doc.sw <= doc.iw, JSON.stringify(doc));
    await shot('merged-prs');
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
  });

  // The same for an ITSA's body and a comment (S-611): each table scrolls in its own box.
  await step('wide table in an ITSA', async () => {
    const wide = (await api('/api/itsas')).find((x) => x.title === 'Check: a wide table in an ITSA');
    await p.locator('[data-nav="issues"]').tap();
    await p.waitForSelector('#issues-side .irow', { timeout: 10000 });
    const root = (await api('/api/itsas')).find((x) => x.title === 'Check: issue system');
    const row = p.locator(`#issues-side .irow[data-itsa="${wide.id}"]`);
    if (!(await row.isVisible())) await p.locator(`#issues-side .irow[data-itsa="${root.id}"] .chev`).tap();
    await p.waitForTimeout(300);
    await p.locator(`#issues-side .irow[data-itsa="${wide.id}"] .ititle`).tap();
    await p.waitForSelector(`.itsa-view[data-itsa="${wide.id}"]`);
    // The comment's table comes with the ITSA's thread, after the body: wait for it, not for a time.
    await p.waitForFunction((id) => document.querySelectorAll(`.itsa-view[data-itsa="${id}"] .mb-table`).length >= 3, wide.id, { timeout: 10000 }).catch(() => {});
    await p.waitForTimeout(300);
    const m = await p.locator(`.itsa-view[data-itsa="${wide.id}"] .mb-table`).evaluateAll((els) => els.map((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX })));
    check(tag, 'wide table in an ITSA: the body and comment tables scroll in their boxes', m.length >= 3 && m.every((t) => t.sw > t.cw && (t.ox === 'auto' || t.ox === 'scroll')), JSON.stringify(m));
    // The scroll cue's covers take the pane's colour here, not the sheet's (S-611).
    const surf = await p.evaluate((id) => {
      const view = document.querySelector(`.itsa-view[data-itsa="${id}"]`);
      const box = view.querySelector('.mb-table');
      return { pane: getComputedStyle(view).backgroundColor, img: getComputedStyle(box).backgroundImage };
    }, wide.id);
    check(tag, 'wide table in an ITSA: the scroll cue covers in the pane colour', surf.img.includes(surf.pane), JSON.stringify(surf));
    const doc = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    check(tag, 'wide table in an ITSA: the page does not scroll sideways', doc.sw <= doc.iw, JSON.stringify(doc));
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
  });

  await step('thread answers', async () => {
    await p.locator('.mrow[title*="Check: decisions and callouts"]').tap();
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
    await p.waitForTimeout(800);
    check(tag, 'a thread opens in main', await p.locator('.thread-view:visible').isVisible() && !(await p.locator('#inbox-view').isVisible()));
    if (await p.locator('.thread-view:visible .mb-decision.answered').count()) { check(tag, 'answers: already sent by an earlier run; restart daemon.sh to check them', false); return; }
    await p.locator('.thread-view:visible .mb-decision:not(.multi):not(.rank):not(.yesno) .mb-opt').nth(1).tap();
    await p.locator('.thread-view:visible .mb-decision.yesno .mb-opt').first().tap();
    await p.locator('.thread-view:visible .mb-decision.multi .mb-opt').nth(1).tap();
    check(tag, 'staging an answer doesn\'t raise the keyboard', !(await p.evaluate(() => document.activeElement?.tagName === 'TEXTAREA')));
    // Rank: drag the last row's grip to the top, then nudge with a button.
    const rows = p.locator('.thread-view:visible .mb-decision.rank .mb-rrow');
    // A poll's re-render can restore the pre-touch order for a frame; wait for the order the
    // step means to see instead of reading it the moment after a drag or a tap.
    const order = () => rows.evaluateAll((rs) => rs.map((r) => r.dataset.rank));
    const settle = async (ok) => {
      for (let i = 0; i < 50; i++) {
        const o = await order();
        if (ok(o)) return o;
        await p.waitForTimeout(100);
      }
      return order();
    };
    const before = await rows.evaluateAll((rs) => rs.map((r) => r.dataset.rank));
    await rows.last().scrollIntoViewIfNeeded();
    const [gx, gy] = await center(rows.last().locator('.mb-rnum'));
    const [, ty] = await center(rows.first());
    await drag(gx, gy, gx, ty - 6);
    await settle((o) => o[0] === before.at(-1));
    // The drop stages the order, and the app's next poll re-renders the thread, which can land
    // on a tap that follows at once and swallow its click. Wait for that poll's answer and a
    // frame after it, then the order the step means to see.
    await p.waitForResponse((r) => r.url().includes('/api/') && r.request().method() === 'GET', { timeout: 10000 }).catch(() => {});
    await p.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    const after = await settle((o) => o[0] === before.at(-1));
    check(tag, 'rank: dragging a row\'s number by touch reorders it', after[0] === before.at(-1), `${before} -> ${after}`);
    // The same poll re-render can swallow this tap, so wait for it and a frame after, as the drop does.
    await p.waitForResponse((r) => r.url().includes('/api/') && r.request().method() === 'GET', { timeout: 10000 }).catch(() => {});
    await p.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    // A tap the re-render swallowed is tapped again, at most three in all, and only while the order is still `after`:
    // a tap that landed late has already moved it, so it isn't applied twice.
    let taps = 0, after2 = after;
    do {
      await rows.nth(1).locator('[data-rank-move="1"]').tap();
      taps++;
      await p.waitForResponse((r) => r.url().includes('/api/') && r.request().method() === 'GET', { timeout: 10000 }).catch(() => {});
      await p.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
      after2 = await settle((o) => o[2] === after[1]);
    } while (after2[2] !== after[1] && taps < 3 && (await order()).join() === after.join());
    check(tag, 'rank: the move buttons work by touch', after2[2] === after[1], `${after} -> ${after2} in ${taps} tap${taps === 1 ? '' : 's'}`);
    const prev = await p.locator('.reply-preview:visible').textContent();
    check(tag, 'the preview shows every staged answer', /12 hours/.test(prev) && /Yes/.test(prev) && /Ranked/.test(prev) && /Types/.test(prev), prev.slice(0, 160));
    // The preview is one summary line until opened.
    const rp = p.locator('.reply-preview:visible');
    check(tag, 'the preview is one line: answers staged, Preview', /4 answers staged/.test(await rp.locator('.rp-toggle').textContent()) && !(await rp.locator('.md').isVisible()) && (await rp.boundingBox()).height <= 46);
    await shot('thread-staged');
    await messageRoom('thread with answers staged');
    await layout('thread');
    await rp.locator('.rp-toggle').tap();
    check(tag, 'tapping the preview line opens the preview', await rp.locator('.md').isVisible() && /Chose 12 hours/.test(await rp.locator('.md').textContent()));
    await shot('thread-preview-open');
    await layout('thread with the preview open');
    await rp.locator('.rp-toggle').tap();
    check(tag, 'tapping it again folds the preview', !(await rp.locator('.md').isVisible()));
    const ta = p.locator('.thread-reply textarea:visible');
    await ta.tap();
    await keyboard(true);
    await ta.fill('Context from the phone check.');
    check(tag, 'the reply box sits above the keyboard', await inViewport(p.locator('.thread-reply .cmp-box:visible')));
    check(tag, 'the reply send button is reachable', await inViewport(p.locator('.thread-reply .cmp-send:visible')));
    await shot('thread-keyboard');
    if (sends) {
      await p.locator('.thread-reply .cmp-send:visible').tap();
      await p.waitForTimeout(1500);
      const mine = await p.locator('.msg.mine').count();
      check(tag, 'the reply sends by touch', mine >= 1, `${mine} of my messages`);
      // A reply archives its thread, so it's looked up in the archived list too.
      const sentThread = [...await api('/api/agents/human/threads?limit=60'), ...await api('/api/agents/human/threads?limit=60&archived=1')].find((x) => /^Check: decisions/.test(x.mails[0].subject));
      const sent = (await api(`/api/threads/${sentThread.thread_id}`)).at(-1);
      check(tag, 'the reply carries the chosen option and the note', sent.body.includes('Chose **12 hours**.\n\nNote: Neither: 4 hours.'), sent.body);
    } else { await ta.fill(''); await p.locator('.reply-preview:visible .mb-own:has-text("Clear answers")').tap(); }
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
  });

  // The Issues tab's "N waiting on you" is a button: it opens a sheet listing the ITSAs and
  // the agents waiting on you, one row each, and a tap on a row opens it.
  await step('waiting', async () => {
    await p.locator('[data-nav="issues"]').tap();
    await p.waitForTimeout(500);
    const btn = p.locator('#issues-waiting');
    if (!(await btn.count())) { check(tag, 'waiting: the Issues header offers the count (restart daemon.sh)', false); return; }
    const n = Number((await btn.innerText()).match(/\d+/)?.[0]);
    check(tag, 'waiting: the count is a touch-sized button', (await btn.boundingBox()).height >= 28);
    await btn.tap();
    const list = p.locator('.menu.popover [data-waiting-list]');
    await list.waitFor();
    check(tag, 'waiting: the sheet lists as many rows as the count says', await list.locator('.wrow').count() === n, `${await list.locator('.wrow').count()} of ${n}`);
    check(tag, 'waiting: the sheet fits the screen', await inViewport(p.locator('.menu.popover')));
    for (const r of await list.locator('.wrow').all()) check(tag, 'waiting: a row is a touch target', (await r.boundingBox()).height >= 40);
    await shot('waiting-list');
    await layout('waiting list');
    await list.locator('.wrow').first().tap();
    await p.waitForTimeout(500);
    check(tag, 'waiting: a tap on a row closes the sheet and opens it', !(await p.locator('.menu.popover').count()) && !(await p.locator('#issues-side').isVisible()));
  });

  // Waiting on the human: the Mail tab's pinned attention list holds the ITSAs in a human
  // status with the permission requests; a tap opens the ITSA's world, whose header offers the
  // status's actions at touch size; a tap stages one and the comment box above the keyboard
  // sends it. The sending run puts the status back. The agent tree shows the owners' chips.
  await step('attention', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.waitForTimeout(400);
    check(tag, 'attention: an agent row shows the chip of the ITSA it owns', await p.locator('#tree .node .ichip').first().isVisible());
    await shot('tree-chip');
    await layout('tree with ITSA chips');
    await p.locator('[data-nav="mail"]').tap();
    await p.waitForTimeout(500);
    const att = await api('/api/itsas/attention');
    const review = att.find((x) => x.title === 'Issues section in the sidebar');
    if (!review) { check(tag, 'attention: the seeded ITSA waits on the human (restart daemon.sh)', false); return; }
    // The page lists each ITSA ask as its thread's row (an ask row with the ITSA's chip) or, with no thread, as its own
    // row under Also waiting (keyed `i:`). Permission and decision asks are rows too, but not these.
    const rows = p.locator('#inbox-view .mrow.ask:has([data-chip="itsa"]), #inbox-view .mrow[data-waiting^="i:"]');
    check(tag, 'attention: the Mail page lists the ITSAs waiting on you', await rows.count() === att.length, `${await rows.count()} of ${att.length}`);
    // The count must also have room (S-3461: at 360 px the search box once left it a width of 0).
    check(tag, 'attention: the header counts them', /to answer/.test(await p.locator('#inbox-view .inbox-count').innerText()) && await p.locator('#inbox-view .inbox-count').evaluate((e) => e.getBoundingClientRect().width >= e.scrollWidth - 1));
    check(tag, 'attention: the Mail tab badge counts them', Number(await p.locator('[data-nav="mail"] .badge').innerText()) >= att.length);
    await shot('attention');
    await layout('attention list');
    await p.locator(`#inbox-view .mrow:has([data-chip="itsa"]:text-is("${review.key}")), #inbox-view .mrow[data-waiting]:has-text("${review.title}")`).first().tap();
    await p.waitForSelector(`.itsa-view[data-itsa="${review.id}"] .itsa-ask`);
    await p.waitForTimeout(500);
    const view = p.locator(`.itsa-view[data-itsa="${review.id}"]`);
    check(tag, 'attention: tapping a row opens the ITSA and closes the list', !(await p.locator('#inbox-view').isVisible()) && await view.isVisible());
    check(tag, 'attention: Approve and Request changes show in the header', (await view.locator('.itsa-ask .btn').allInnerTexts()).join('|') === 'Approve|Request changes');
    await shot('itsa-ask');
    await layout('itsa action bar');
    await view.locator('.itsa-ask [data-act=changes]').tap();
    check(tag, 'attention: a tap stages Request changes', await view.locator('.itsa-ask [data-act=changes].staged').count() === 1);
    const reply = view.locator('.itsa-reply textarea');
    await reply.tap();
    await reply.fill('Phone check: please rename it');
    await keyboard(true);
    await reply.scrollIntoViewIfNeeded();
    check(tag, 'attention: the send button is reachable with the keyboard up', await inViewport(view.locator('.itsa-reply .cmp-send')));
    await shot('itsa-ask-staged');
    if (sends) {
      await view.locator('.itsa-reply .cmp-send').tap();
      await p.waitForTimeout(1500);
      check(tag, 'attention: sending by touch moves the ITSA to in_progress', (await api('/api/itsas/' + review.id)).status === 'in_progress');
      await api('/api/itsas/' + review.id, 'PATCH', { status: 'needs_review', by: 'kid' });
    } else { await reply.fill(''); }
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
  });

  // Approving the permission mail starts helper's turn, and a turn's UserPromptSubmit and Stop
  // hooks close a pending dialog (S-689); the dialog step below waits past that turn's Stop so
  // the dialog it posts isn't closed while the checks run.
  const turnStops = async () => (await api(`/api/agents/${helper.id}/events`)).filter((e) => e.type === 'hook:Stop').map((e) => e.id);
  let approvedFrom = null;

  await step('permission', async () => {
    await p.locator('[data-nav="mail"]').tap();
    await p.locator('.mrow[title*="Permission: Run the"]').first().tap();
    await p.waitForSelector('.thread-view:visible .perm', { timeout: 10000 });
    await p.waitForTimeout(500);
    const pending = await p.locator('.thread-view:visible .perm.pending [data-approve="1"]').count();
    if (!pending) { check(tag, 'permission: already answered by an earlier run; restart daemon.sh to check it', false); return; }
    const permKey = await p.locator('.pane .tab.active').getAttribute('data-key');
    await p.locator('.thread-view:visible .perm.pending [data-approve="1"]').tap();
    await p.locator('.thread-reply textarea:visible').fill('Approved from the phone check.');
    check(tag, 'permission: approve stages with the note in the preview', /Approve/.test(await p.locator('.reply-preview:visible').textContent()));
    await shot('permission');
    await layout('permission');
    if (sends) {
      approvedFrom = Math.max(0, ...(await turnStops()));
      await p.locator('.thread-reply .cmp-send:visible').tap();
      await p.waitForTimeout(1500);
      check(tag, 'permission: approval sends by touch', await p.locator('.perm.approved').count() >= 1);
      // Answering a permission from a mail is the user responding to it: the thread archives, and the next mail opens.
      const archived = (await api('/api/agents/human/threads?limit=60&archived=1')).map((x) => x.thread_id);
      check(tag, 'permission: the answer archives its thread', archived.includes(permKey.slice(7)));
      check(tag, 'permission: the answer opens the next mail', (await p.locator('.pane .tab.active').getAttribute('data-key')) !== permKey, await p.locator('.pane .tab.active').getAttribute('data-key'));
      await api(`/api/agents/human/threads/${permKey.slice(7)}/unarchive`, 'POST', {});
    } else { await p.locator('.thread-reply textarea:visible').fill(''); await p.locator('.reply-preview:visible .mb-own:has-text("Clear answers")').tap(); }
    await p.evaluate(() => document.activeElement?.blur());
  });

  // A harness dialog's mail reads on its own (S-519): a line on what the agent wants, the whole command wrapped, who has looked.
  await step('dialog mail', async () => {
    // Wait for the turn the approval above started to finish (S-689): while it runs, its
    // UserPromptSubmit and Stop hooks close any dialog posted, so post this one after its Stop.
    if (approvedFrom !== null) for (let i = 0; i < 200; i++) {
      if ((await turnStops()).some((id) => id > approvedFrom)) break;
      await p.waitForTimeout(100);
    }
    // As Claude Code's PermissionRequest hook reports it; an earlier step's prompt to helper closes any seeded one.
    await api(`/api/hook/claude/${helper.id}`, 'POST', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'cd /home/user/projects/app && git fetch origin && git worktree add -b feature/perm-mail-readable /home/user/.cache/app-wt/perm-mail-readable origin/main && node scripts/deploy.mjs --dry-run', description: 'Fetch main and set up a worktree for the permission mail change' } });
    // With a chief of staff live, the dialog goes to it first (S-520); it sends it on, so the user gets the dialog mail, escalated.
    let req;
    for (let i = 0; i < 50 && !req; i++) {
      req = (await api('/api/permissions?status=pending')).find((r) => r.agent_id === helper.id && r.dialog);
      if (!req) await p.waitForTimeout(100);
    }
    const chief = (await api('/api/agents')).find((a) => a.chief_of_staff);
    const sentOn = req?.audience === 'delegate' && chief;
    // Until then it is with them (S-594): the mail list shows it read-only, in a collapsed group of
    // its own that names who it is with, off the count of what waits on you.
    if (sentOn) {
      await p.locator('[data-nav="mail"]').tap();
      const group = p.locator('#inbox-view details.mail-delegated');
      await group.waitFor({ timeout: 10000 }).catch(() => {});
      check(tag, 'delegated dialog: the mail list shows it in the With group', await group.isVisible());
      if (await group.isVisible()) {
        check(tag, 'delegated dialog: the group starts collapsed', !(await group.evaluate((d) => d.open)));
        await shot('delegated-dialog-collapsed');
        await group.locator('summary').tap();
        const row = group.locator(`.mrow[data-delegated="${req.id}"]`);
        const text = await row.innerText().catch(() => '');
        check(tag, 'delegated dialog: its row says what the agent wants and who it is with', /helper wants to run: cd /.test(text) && text.includes(`with @${chief.name}`), text);
        check(tag, 'delegated dialog: the row fits the width, cut short', await row.evaluate((r) => r.scrollWidth <= r.clientWidth + 1));
        check(tag, 'delegated dialog: read-only and not waiting on you', await row.locator('button').count() === 0 && !(await row.evaluate((r) => r.classList.contains('ask'))));
        await shot('delegated-dialog');
        await layout('delegated dialog');
      }
      await api(`/api/permissions/${req.id}/answer`, 'POST', { decision: 'escalate', by: chief.id, note: 'helper needs the worktree to make the change' });
      const left = await p.waitForFunction((id) => !document.querySelector(`#inbox-view .mrow[data-delegated="${id}"]`), req.id, { timeout: 10000 }).then(() => true, () => false);
      check(tag, 'delegated dialog: sent on, it leaves the With group', left);
    }
    // Poll until the dialog mail lands (S-689): it can arrive late, so wait on state, not the clock.
    let dm;
    for (let i = 0; i < 60 && !dm; i++) {
      dm = (await api('/api/agents/human/threads?limit=60')).find((x) => x.mails.some((m) => /helper wants to run: cd /.test(m.subject ?? '')));
      if (!dm) await p.waitForTimeout(250);
    }
    check(tag, 'dialog mail: the mail is in the inbox', !!dm);
    if (!dm) return;
    // Opened by its thread id in the address, as the ITSA mail step below does.
    await p.goto('about:blank');
    await p.goto(origin + '/#token=' + token + (testHuman ? '&testHuman=' + testHuman : '') + '&thread=' + dm.thread_id);
    await p.waitForSelector('.thread-view:visible .md', { timeout: 10000 });
    await p.waitForTimeout(500);
    const body = await p.locator('.thread-view:visible .md').first().innerText();
    check(tag, 'dialog mail: says what the agent wants in a line', /wants to run a shell command/.test(body), body.slice(0, 120));
    check(tag, 'dialog mail: gives the reason and who has looked', /Fetch main and set up a worktree/.test(body) && /Who has looked/.test(body) && (!sentOn || /looked first and sent it on to you: helper needs the worktree/.test(body)), body.slice(-300));
    check(tag, 'dialog mail: no raw JSON and no agent hint', !/"tool"/.test(body) && !/stam authorize|answer_permission/.test(body));
    const code = p.locator('.thread-view:visible .md pre code').first();
    check(tag, 'dialog mail: the whole command is in the code block', /--dry-run/.test(await code.innerText()));
    check(tag, 'dialog mail: the command wraps instead of scrolling sideways', await code.evaluate((c) => c.parentElement.scrollWidth <= c.parentElement.clientWidth + 1));
    await shot('dialog-mail');
    await layout('dialog mail');
  });

  // An ITSA Approve sent from its mail (the ask a human status posts) archives the thread and opens the next mail.
  await step('itsa approve from a mail', async () => {
    const ask = (await api('/api/agents/human/threads?limit=60')).find((x) => x.mails.some((m) => m.kind === 'ask' && /Approve from the mail/.test(m.subject ?? '')));
    check(tag, 'itsa mail: the approval mail is seeded', !!ask);
    if (!ask || !sends) return;
    const tid = ask.thread_id;
    // Opened by its thread id in the address (main.tsx reads it): the approval's mail sits among
    // the attention rows, and a row tap doesn't reach it on the phone.
    // A hash-only change doesn't reload the app, which reads the thread from the address once: load it fresh.
    await p.goto('about:blank');
    await p.goto(origin + '/#token=' + token + (testHuman ? '&testHuman=' + testHuman : '') + '&thread=' + tid);
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 }).catch(async (e) => { await shot('itsa-no-thread'); console.log('DEBUG tab:', await p.locator('.pane .tab.active').count(), await p.locator('.pane .tab.active').getAttribute('data-key').catch(() => 'none'), 'ask:', await p.locator('.itsa-ask').count()); throw e; });
    await p.waitForSelector('.thread-view:visible .itsa-ask [data-act=approve]', { timeout: 10000 }).catch(async (e) => { await shot('itsa-no-approve'); console.log('DEBUG approve: ask', await p.locator('.itsa-ask').count(), 'html', (await p.locator('.thread-view:visible .thread-reply').count())); throw e; });
    await p.waitForTimeout(400);
    // The ask shows the text it asks about, folded, and fits the phone (S-2998).
    const what = p.locator('.thread-view:visible .msg details summary', { hasText: 'What you approve' });
    check(tag, 'itsa mail: the ask shows the text it asks about', await what.count() > 0);
    check(tag, 'itsa mail: the ask has no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    // The owner's comment it repeats carries CSS (seed.mjs) that would hide or cover the snapshot: it still shows, on top.
    const shown = () => p.evaluate(() => {
      const s = [...document.querySelectorAll('.thread-view .msg details summary')].find((x) => x.offsetParent && /What you approve/.test(x.textContent));
      if (!s) return 'not shown';
      if (document.querySelector('.thread-view style')) return 'a style element in the mail';
      s.scrollIntoView({ block: 'center' });
      const r = s.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(s).visibility !== 'visible') return 'hidden';
      const top = document.elementFromPoint(r.left + Math.min(24, r.width / 2), r.top + r.height / 2);
      return s.contains(top) ? 'ok' : 'covered by ' + (top?.outerHTML.slice(0, 80) ?? 'nothing');
    });
    // KaTeX loads on first use: its raised box is measured once it is typeset.
    const typeset = await p.waitForSelector('.thread-view:visible .msg .mb-math.typeset', { timeout: 10000 }).then(() => true, () => false);
    check(tag, 'itsa mail: the comment\'s raised math is typeset', typeset);
    let seen = await shown();
    check(tag, 'itsa mail: comment CSS can\'t hide or cover the snapshot', seen === 'ok', seen);
    await shot('itsa-ask-mail');
    await p.setViewportSize({ width: 1280, height: 800 });
    await p.waitForTimeout(400);
    seen = await shown();
    check(tag, 'itsa mail: comment CSS can\'t hide or cover the snapshot at 1280 px', seen === 'ok', seen);
    await shot('itsa-ask-mail-1280');
    await p.setViewportSize(size.viewport);
    await p.waitForTimeout(400);
    const before = await p.locator('.pane .tab.active').getAttribute('data-key');
    await p.locator('.thread-view:visible .itsa-ask [data-act=approve]').tap();
    await p.locator('.thread-reply .cmp-send:visible').tap();
    await p.waitForTimeout(1500);
    const archived = (await api('/api/agents/human/threads?limit=60&archived=1')).map((x) => x.thread_id);
    check(tag, 'itsa mail: Approve from the mail archives its thread', archived.includes(tid));
    check(tag, 'itsa mail: Approve opens the next mail', (await p.locator('.pane .tab.active').getAttribute('data-key')) !== before, await p.locator('.pane .tab.active').getAttribute('data-key'));
    await api(`/api/agents/human/threads/${tid}/unarchive`, 'POST', {});
  });
  // A link to a thread while the app is open opens it: the hash changes on the open page (S-172).
  await step('hash link to a thread', async () => {
    const t = (await api('/api/agents/human/threads?limit=60')).find((x) => x.mails.length);
    check(tag, 'hash: a thread is in the inbox to link to', !!t);
    if (!t) return;
    await p.evaluate((tid) => { location.hash = 'thread=' + tid; }, t.thread_id);
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 }).catch(() => {});
    await p.waitForTimeout(400);
    const key = await p.locator('.pane .tab.active').getAttribute('data-key');
    check(tag, 'hash: a link to a thread opens it while the app is open', key === 'thread:' + t.thread_id, key);
  });

  await step('assistant', async () => {
    await p.locator('[data-nav="assistant"]').tap();
    await p.waitForTimeout(500);
    check(tag, 'the assistant opens full screen', await p.locator('#top-world').isVisible() && await inViewport(p.locator('#top-world .top-input')));
    check(tag, 'the assistant tab has no name, status or close button (S-376)', !(await p.locator('#top-world .top-name').isVisible()) && !(await p.locator('#top-world #top-close').isVisible()));
    await shot('assistant');
    await layout('assistant');
    await p.locator('[data-nav="main"]').tap();
    check(tag, 'main comes back from the assistant', !(await p.locator('#top-world').count()));
  });

  // A chief of staff (helper, paused, so mail to it costs nothing): two taps from anywhere,
  // the assistant tab then its name; and a long press on the prompt input's assistant button.
  await step('chief of staff', async () => {
    await api('/api/chief-of-staff', 'POST', { agent: 'helper' });
    await p.waitForTimeout(2500);
    await p.locator('[data-nav="assistant"]').tap();
    await p.waitForTimeout(400);
    check(tag, 'cos: the assistant tab offers the assistant and helper', (await p.locator('#top-world .top-targets button').allInnerTexts()).join() === 'Assistant,helper');
    await p.locator(`#top-world .top-targets button[data-target="${helper.id}"]`).tap();
    await p.waitForTimeout(400);
    check(tag, 'cos: one tap on helper shows it', await p.locator('#top-world').getAttribute('data-target') === helper.id && /helper/.test(await p.locator('#top-world .cmp-target').innerText()));
    await shot('cos');
    await layout('chief of staff');
    await p.locator('#top-world .composer textarea').focus();
    await keyboard(true);
    check(tag, 'cos: the prompt input stays above the keyboard', await inViewport(p.locator('#top-world .top-input')) && await inViewport(p.locator('#top-world .top-targets')));
    await shot('cos-keyboard');
    if (sends) {
      // A chief of staff offers Direct and Mail; this sends as mail.
      if ((await p.locator('#top-world .cmp-mode-one').getAttribute('aria-pressed')) !== 'true') await p.locator('#top-world .cmp-mode-one').tap();
      const w = `KIWI${Date.now() % 10000}`;
      await p.locator('#top-world .composer textarea').fill(`Phone check, not real work: ${w}`);
      await p.locator('#top-world .cmp-send').tap();
      await p.waitForTimeout(1500);
      const got = (await api(`/api/agents/${helper.id}/threads?limit=50`)).flatMap((t) => t.mails).some((m) => m.from_id === 'human' && (m.body ?? '').includes(w));
      check(tag, 'cos: the message reaches helper as mail', got);
    }
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
    await p.locator('[data-nav="main"]').tap();
    await p.locator('[data-nav="assistant"]').tap();
    await p.waitForTimeout(300);
    check(tag, 'cos: the assistant tab remembers helper', await p.locator('#top-world').getAttribute('data-target') === helper.id);
    await p.locator('[data-nav="main"]').tap();
    // The prompt input, on an agent's world: a tap on the stam icon opens the recipient menu, which picks helper.
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#tree .node:has(.name:text-is("kid"))').first().tap();
    await p.waitForTimeout(800);
    const btn = p.locator('#w-bottom .cmp-asst');
    await btn.tap();
    await p.waitForTimeout(300);
    await p.locator('.menu [role=radio]:has-text("helper")').tap();
    await p.waitForTimeout(300);
    check(tag, 'cos: the stam icon\'s menu picks helper', /helper/.test(await p.locator('#w-bottom .cmp-target').innerText()) && await btn.evaluate((b) => b.classList.contains('on')));
    await shot('cos-bottom');
    await btn.tap();
    await p.waitForTimeout(300);
    await p.locator('.menu [role=radio]').first().tap();
    check(tag, 'cos: the menu\'s current agent turns it back to the pane', !(await btn.evaluate((b) => b.classList.contains('on'))));
    await p.evaluate(() => document.activeElement?.blur());
    await api('/api/chief-of-staff', 'POST', { agent: null });
    await p.waitForTimeout(2500);
  });

  // The prompt input's Direct/Mail toggle on an agent's pane: Mail sends the message as mail
  // from the human, so it lands in the mailbox with the agent's answer to come. helper is
  // paused in the check daemon only when it is started with NO_HELLO.
  await step('prompt as mail', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.locator(`#tree .node:has(.name:text-is("helper"))`).first().locator(".name").tap();
    await p.waitForTimeout(800);
    // Its world may still show a tab opened earlier (the instructions); the terminal is first.
    await p.locator('#w-main .tab').first().tap();
    await p.waitForTimeout(500);
    const bar = p.locator('#w-bottom .composer');
    // An earlier step may have left the box writing to a chief of staff, which hides the toggle:
    // the stam icon's menu turns it back to the pane.
    if (await bar.locator('.cmp-asst.on').count()) { await bar.locator('.cmp-asst').tap(); await p.locator('.menu [role=radio]').first().tap(); }
    // On the phone Direct and Mail are one button: its state says which one is on.
    const one = bar.locator('.cmp-mode-one');
    await one.waitFor({ state: 'visible', timeout: 8000 });
    check(tag, 'mail: the phone shows one mode button, not the Direct/Mail pair', !(await bar.locator('.cmp-mode').isVisible()) && (await one.boundingBox())?.width >= 44);
    if ((await one.getAttribute('aria-pressed')) === 'true') await one.tap();
    await one.and(p.locator('[aria-pressed="false"]')).waitFor({ timeout: 5000 });
    // The earlier step left its pasted image as a draft in this box; start from an empty one.
    while (await bar.locator('.cmp-file .cmp-x').count()) await bar.locator('.cmp-file .cmp-x').first().tap();
    const onMode = async () => ((await one.getAttribute('aria-pressed')) === 'true' ? 'Mail' : 'Direct');
    check(tag, 'mail: the mode button says Direct is on, and how to switch', await onMode() === 'Direct' && /Sending direct; tap to send as mail/.test(await one.getAttribute('aria-label')), await one.getAttribute('aria-label'));
    await shot('prompt-direct');
    await layout('prompt input modes');
    await one.tap();
    check(tag, 'mail: tapping the mode button turns on Mail and the send button follows', await onMode() === 'Mail' && /Sending as mail/.test(await one.getAttribute('aria-label')) && await bar.locator('.cmp-send').getAttribute('aria-label') === 'Mail');
    await shot('prompt-mail');
    if (sends) {
      const w = `MANGO${Date.now() % 10000}`;
      await bar.locator('textarea').tap();
      await keyboard(true);
      await bar.locator('textarea').fill(`Phone check, not real work: ${w}`);
      // With text typed the stam icon stays: it is the only route to the recipient and the cc (S-1434).
      const stam = bar.locator('.cmp-to');
      const sb = await stam.boundingBox();
      check(tag, 'mail: the stam icon stays with text typed, 44 px and on screen', !!sb && sb.width >= 44 && sb.height >= 44 && sb.x >= 0 && sb.x + sb.width <= 360, sb);
      const bar360 = await bar.locator('.cmp-bar > button:visible, .cmp-bar .seg:visible').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
      check(tag, 'mail: the bar with text has no button past the screen edge', bar360 <= p.viewportSize().width, bar360);
      await stam.tap();
      await p.locator('.menu .rm-search').waitFor({ timeout: 5000 });
      check(tag, 'mail: with text typed the stam menu still offers the cc search, 44 px', (await p.locator('.menu .rm-search').boundingBox())?.height >= 44);
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('.menu'));
      await bar.locator('.cmp-send').tap();
      await p.waitForTimeout(1500);
      // A new thread from the human is archived on send, so look in the archived list too.
      const lists = [...await api('/api/agents/human/threads?limit=60'), ...await api('/api/agents/human/threads?limit=60&archived=1')];
      const m = lists.flatMap((t) => t.mails).find((x) => x.from_id === 'human' && (x.body ?? '').includes(w));
      check(tag, 'mail: the prompt arrives in your mailbox as mail from you', !!m && m.subject === `Phone check, not real work: ${w}` && m.recipients.some((r) => r.id === helper.id), m?.subject);
      check(tag, 'mail: the box clears after mailing', (await bar.locator('textarea').inputValue()) === '');
      await p.evaluate(() => document.activeElement?.blur());
      await keyboard(false);
      await p.locator('[data-nav="mail"]').tap();
      // A new thread from the human is archived on send: it shows in the Awaiting view, not the inbox.
      await p.locator('[data-filter="awaiting"]').tap();
      // A row shows only its topic chip (S-1075), so the full subject is matched on the row's title.
      const row = p.locator(`#inbox-view .mrow[title*="${w}"]`).first();
      await row.waitFor({ timeout: 12000 }).catch(() => {});
      check(tag, 'mail: it shows in the awaiting list', await row.count() === 1);
      await shot('prompt-mail-sent');
      await p.locator('[data-nav="main"]').tap();
      await p.waitForTimeout(400);
    }
    // Back to Direct, so the rest of the run starts from today's behaviour. Switching the
    // mode keeps the focus in the box, so the keyboard goes down with it.
    await one.tap();
    check(tag, 'mail: Direct comes back', await onMode() === 'Direct');
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
  });

  await step('settings and usage', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#open-config').tap();
    await p.waitForSelector('.settings-view');
    await p.waitForTimeout(500);
    await shot('settings');
    await barCheck('settings');
    await layout('settings');
    // Executive assistant: the Assistant tab's default is on this section.
    await p.locator('.settings-nav .item:has-text("Executive assistant")').tap();
    await p.waitForSelector('.set-card');
    await p.getByText('Assistant tab opens on').first().scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    await shot('settings-assistant');
    await p.locator('.settings-nav .item').nth(2).tap();
    await p.waitForTimeout(300);
    await shot('settings-2');
    // Spending: the cost instructions are a full-width multi-line field on a phone.
    await p.locator('.settings-nav .item:has-text("Spending")').tap();
    await p.waitForTimeout(300);
    check(tag, 'spending shows the cost instructions field', await p.locator('.set-field textarea').isVisible());
    await shot('settings-spend');
    // Tiny models: the list, then a page with editable instructions (S-1480).
    await p.locator('.settings-nav .item:has-text("Tiny models")').tap();
    await p.waitForSelector('.tiny-item');
    check(tag, 'tiny models: list rows are touch height', await p.locator('.tiny-item').first().evaluate((e) => e.getBoundingClientRect().height >= 40));
    await shot('settings-tiny');
    await p.locator('.tiny-item:has-text("Tool summary")').tap();
    await p.waitForSelector('textarea.tiny-instr');
    await layout('settings-tiny-page');
    check(tag, 'tiny models page: instructions fit the screen', await p.locator('textarea.tiny-instr').evaluate((e) => e.getBoundingClientRect().right <= innerWidth + 1));
    await shot('settings-tiny-page');
    // Prompt caching (S-2239): the timers, the agents table and the harness facts fit the screen. The timers and the
    // harness settings passed on at launch are editable (S-2240): a choice saves to settings.json, then goes back.
    await p.locator('.settings-nav .item:has-text("Prompt caching")').tap();
    await p.waitForSelector('[data-cache-harness="opencode"]');
    await p.waitForSelector('.cache-agents, .settings-inner p.muted:has-text("No Claude Code agents")');
    await layout('settings-cache');
    const timers = await p.locator('[data-cache-timers]').evaluate((e) => [...e.querySelectorAll('input')].map((i) => i.value).join(' ') + ' ' + e.textContent);
    check(tag, 'prompt caching: the timers read the settings', /\d/.test(timers) || /Off/.test(timers), timers);
    check(tag, 'prompt caching: the agents table scrolls in its box, not the page', await p.locator('.settings-inner').evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    const ttl = p.locator('[data-harness-setting="harness.claude.promptCacheTtl"] .seg button');
    check(tag, 'prompt caching: harness choices are touch height', await ttl.first().evaluate((e) => e.getBoundingClientRect().height >= 40));
    check(tag, 'prompt caching: the next-launch note shows', await p.locator('[data-harness-next-launch]').isVisible());
    await shot('settings-cache');
    const savedTtl = async () => JSON.parse((await api('/api/config/settings')).text).harness?.claude?.promptCacheTtl ?? null;
    await ttl.filter({ hasText: '1 hour' }).tap();
    await p.waitForFunction(() => document.querySelector('[data-harness-setting="harness.claude.promptCacheTtl"] .seg button.on')?.textContent === '1 hour');
    let saved = null;
    for (let i = 0; i < 20 && saved !== '1h'; i++) { saved = await savedTtl(); if (saved !== '1h') await p.waitForTimeout(100); }
    check(tag, 'prompt caching: a harness choice saves to settings.json', saved === '1h', String(saved));
    await shot('settings-cache-set');
    await ttl.filter({ hasText: 'Default' }).tap();
    for (let i = 0; i < 20 && saved !== null; i++) { saved = await savedTtl(); if (saved !== null) await p.waitForTimeout(100); }
    check(tag, 'prompt caching: Default clears it', saved === null, String(saved));
    // Model providers (S-2115): the OpenRouter card and the add form fit, and the key buttons are touch height.
    await p.locator('.settings-nav .item:has-text("Model providers")').tap();
    await p.waitForSelector('.prov-card .prov-key');
    await layout('settings-providers');
    check(tag, 'providers: no sideways scroll', await p.locator('.settings-inner').evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    check(tag, 'providers: key buttons are touch height', await p.locator('.prov-key .btn').first().evaluate((e) => e.getBoundingClientRect().height >= 40));
    check(tag, 'providers: the add form fits the screen', await p.locator('.prov-add').evaluate((e) => e.getBoundingClientRect().right <= innerWidth + 1));
    await shot('settings-providers');
    // Sidebar: the pane layout controls fit the screen and are touch height (S-1422).
    await p.locator('.settings-nav .item:has-text("Sidebar")').tap();
    await p.waitForSelector('.sidebar-set');
    await p.waitForTimeout(300);
    check(tag, 'sidebar settings: no sideways scroll', await p.locator('.sidebar-set').evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    check(tag, 'sidebar settings: tab rows are touch height', await p.locator('.sbs-tab').first().evaluate((e) => e.getBoundingClientRect().height >= 40));
    await shot('settings-sidebar');
    // Tools: the MCP catalogue, grouped, each tool folding open to its arguments.
    await p.locator('.settings-nav .item:has-text("Tools")').tap();
    await p.waitForSelector('.tools-card');
    await p.waitForTimeout(300);
    const toolCount = (await api('/api/tools')).groups.reduce((n, g) => n + g.tools.length, 0);
    check(tag, 'tools: a row per tool', await p.locator('.tools-card details.tool').count() === toolCount, `${await p.locator('.tools-card details.tool').count()} of ${toolCount}`);
    check(tag, 'tools: send_mail is listed', await p.locator('.tool-name', { hasText: 'send_mail' }).count() === 1);
    await shot('settings-tools');
    await layout('tools list');
    const sendMail = p.locator('.tools-card details.tool').filter({ hasText: 'send_mail' }).first();
    await sendMail.locator('summary').tap();
    await p.waitForTimeout(300);
    check(tag, 'tools: a tap folds a tool open to its arguments', await sendMail.evaluate((el) => el.open) && await sendMail.locator('.tool-arg-head code').count() >= 2);
    await shot('settings-tools-args');
    // Decision steps: Add a step on a tool opens the form with it picked; the list, the form,
    // a test on recent calls, and the log, all by touch. Only the sending run saves a step.
    await sendMail.locator('.tool-step').tap();
    await p.waitForSelector('.step-form');
    await p.waitForTimeout(300);
    check(tag, 'steps: Add a step on a tool picks it', await p.locator('select[name=trigger]').inputValue() === 'tool:send_mail');
    await p.locator('textarea[name=question]').fill('Does this mail promise a date?');
    await p.locator('.step-actions .choice', { hasText: 'Allow the call only if yes' }).tap();
    await p.locator('.step-more summary').tap();
    await p.evaluate(() => document.activeElement?.blur());
    await shot('settings-steps-add');
    await layout('steps form');
    // The form's buttons scroll fully clear of the bottom navigation.
    await p.locator('.step-form .type-actions').scrollIntoViewIfNeeded();
    await p.locator('.settings-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await p.waitForTimeout(300);
    const clear = await p.evaluate(() => {
      const nav = document.querySelector('#mobile-nav')?.getBoundingClientRect();
      const btns = [...document.querySelectorAll('.step-form .type-actions .btn')].map((b) => b.getBoundingClientRect());
      return { navTop: nav ? nav.top : innerHeight, bottom: Math.max(...btns.map((b) => b.bottom)) };
    });
    check(tag, 'steps: Add step and Cancel sit above the navigation', clear.bottom <= clear.navTop, `buttons end at ${Math.round(clear.bottom)}, the navigation starts at ${Math.round(clear.navTop)}`);
    await shot('settings-steps-add-end');
    if (sends) {
      await p.locator('.step-form button[type=submit]').tap();
      await p.waitForSelector('#step-test');
      check(tag, 'steps: saving a new step opens its test', await p.locator('#step-test').isVisible());
    }
    await p.locator('.step-form .type-back').tap();
    await p.waitForSelector('.steps-card');
    await p.waitForTimeout(300);
    check(tag, 'steps: the list shows the seeded steps', await p.locator('.step-row').count() >= 3, await p.locator('.step-row').count());
    await shot('settings-steps');
    await layout('steps list');
    await p.locator('.step-row', { hasText: 'Money mail' }).locator('.step-open').tap();
    await p.waitForSelector('.step-dec');
    await p.locator('#step-test').tap();
    await p.waitForSelector('.step-ex');
    await p.locator('.step-test').scrollIntoViewIfNeeded();
    check(tag, 'steps: the test shows yes or no and the probability', /^(Yes|No)[\s\S]*\d+%$/.test((await p.locator('.step-ex').nth(1).innerText()).trim()), await p.locator('.step-ex').nth(1).innerText());
    await shot('settings-steps-test');
    await layout('steps test');
    await p.locator('.step-log').scrollIntoViewIfNeeded();
    check(tag, 'steps: the log shows its decisions', await p.locator('.step-dec').count() >= 3);
    await shot('settings-steps-log');
    await layout('steps log');
    // Instructions: grouped by agent type, one column on a phone, the list first and the
    // editor behind a back control.
    await p.locator('.settings-nav .item:has-text("Instructions")').tap();
    await p.waitForTimeout(300);
    const typeCount = Object.keys((await api('/api/registry')).types ?? {}).length;
    check(tag, 'instructions lists every agent type', await p.locator('.tpl-group').count() === 5 + typeCount, `${await p.locator('.tpl-group').count()} groups`);
    check(tag, 'the instruction list leads, the editor waits behind it', await p.locator('.tpl-list').isVisible() && !(await p.locator('.tpl-editor').isVisible()));
    await shot('settings-instructions');
    await layout('instructions list');
    // The list is long: scroll to the last item and open it, so every item is proven reachable.
    const last = p.locator('.tpl-list .item:has-text("Workspace instructions")');
    await last.scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    check(tag, 'the last instruction item is reachable by scrolling', await inViewport(last));
    await last.tap();
    await p.waitForTimeout(300);
    check(tag, 'picking an item swaps the list for the editor', !(await p.locator('.tpl-list').isVisible()) && await p.locator('.tpl-editor').isVisible());
    check(tag, 'the editor shows the picked file', (await p.locator('.tpl-editor .tpl-head').innerText()).includes('workspace-instructions.md'));
    check(tag, 'the editor has a back control', await p.locator('.tpl-back').isVisible());
    await shot('settings-instructions-item');
    await layout('instructions editor');
    await p.locator('.tpl-back').tap();
    await p.waitForTimeout(300);
    check(tag, 'the back control brings the list back', await p.locator('.tpl-list').isVisible() && !(await p.locator('.tpl-editor').isVisible()));
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#open-usage').tap();
    await p.waitForSelector('.usage .lim-card');
    await p.waitForTimeout(500);
    check(tag, 'usage: each account shows as a limits card', await p.locator('.usage .lim-card').count() >= 1);
    check(tag, 'usage: the four headline tiles show', await p.locator('.usage .tiles .tile').count() === 4);
    check(tag, 'usage: a window shows its meter', await p.locator('.usage .lim-card .lim-meter').count() >= 1);
    check(tag, 'usage: the old Today tiles and Accounts section are gone', (await p.locator('.usage .mb-metrics, .usage .account, .usage .allocations').count()) === 0);
    check(tag, 'usage: the cost instructions sit in a footer with the Settings link', await p.locator('.usage .usage-foot .btn').isVisible());
    check(tag, 'usage: Period and Measure fit the width', await p.evaluate(() => [...document.querySelectorAll('.usage-controls .seg')].every((s) => s.getBoundingClientRect().right <= innerWidth + 0.5 && s.scrollWidth <= s.clientWidth + 1)));
    check(tag, 'usage: the tabs show and the Overview one is selected', (await p.locator('.usage-tabs [role=tab]').count()) === 7 && (await p.locator('.usage-tabs [aria-selected=true]').innerText()) === 'Overview');
    check(tag, 'usage: tabs and controls meet the touch hit size', await p.evaluate(() => [...document.querySelectorAll('.usage-tabs button, .usage-controls .seg button')].every((b) => b.getBoundingClientRect().height >= 43.5)));
    await p.locator('.usage-tabs [role=tab]:has-text("Trees")').tap();
    await p.waitForSelector('.usage .tree-totals .tnode');
    check(tag, 'usage: a tree total opens with its agents', await p.locator('.usage .tree-totals .tnode').count() >= 1);
    await p.locator('.usage-tabs [role=tab]:has-text("Models")').tap();
    await p.waitForSelector('.usage .usage-models table');
    check(tag, 'usage: the models table folds its token columns under the name', await p.locator('.usage .usage-models .phone-only').first().isVisible() && !(await p.locator('.usage .usage-models td.wide').first().isVisible()));
    check(tag, 'usage: the models table does not scroll sideways', await p.evaluate(() => { const t = document.querySelector('.usage .usage-models'); return !!t && t.scrollWidth <= t.clientWidth + 1; }));
    await p.locator('.usage-tabs [role=tab]:has-text("Issues")').tap();
    await p.waitForSelector('.usage .usage-configs table');
    check(tag, 'usage: the issues fold shows cost per configuration', await p.locator('.usage .usage-configs tbody tr').count() >= 2);
    check(tag, 'usage: the most expensive issues show with their configuration', await p.locator('.usage .usage-issue-list tbody tr').count() >= 1);
    // Activity (S-1011): the summary's tiles, then one column with no sideways scroll.
    await p.locator('.usage-tabs [role=tab]:has-text("Activity")').tap();
    await p.waitForSelector('.usage .activity-tab .ax-tiles, .usage .activity-tab .ax-none');
    check(tag, 'usage: activity shows its four tiles or says it has none', await p.locator('.usage .ax-tiles .tile').count() === 4 || await p.locator('.usage .activity-tab > .ax-none').count() === 1);
    check(tag, 'usage: activity does not scroll sideways', await p.evaluate(() => [...document.querySelectorAll('.activity-tab *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 1)));
    await shot('usage-activity');
    // The Agent types control (S-1491): one toggle per type present plus All, within the width and at the touch size; a
    // selection names itself in the crumb, and the Time | Cost switch changes the page to cost.
    check(tag, 'usage: the Agent types control shows on Activity, fits the width and meets the touch hit size', await p.evaluate(() => { const f = document.querySelector('.usage-types'); return !!f && f.scrollWidth <= f.clientWidth + 1 && [...f.querySelectorAll('button')].every((b) => b.getBoundingClientRect().height >= 43.5 && b.getBoundingClientRect().right <= innerWidth + 0.5); }));
    check(tag, 'usage: the Agent types control has All and several types, each with its count', await p.evaluate(() => { const b = [...document.querySelectorAll('.usage-types button')].map((x) => x.textContent); return b[0] === 'All' && b.length >= 4 && b.slice(1).every((t) => /\s\d+$/.test(t)); }));
    // The types present depend on the fixture, so pick the first two after All by position.
    const typeButtons = p.locator('.usage-types button');
    const typeName = async (i) => (await typeButtons.nth(i).textContent()).replace(/\s\d+$/, '').trim();
    const [first, second] = [await typeName(1), await typeName(2)];
    await typeButtons.nth(1).tap();
    await p.waitForSelector('.activity-tab .ax-scope .ax-filter');
    await p.waitForSelector('.usage .activity-tab .ax-tiles');
    check(tag, 'usage: a selected type names itself in the Activity crumb', (await p.locator('.ax-scope .ax-filter').innerText()).includes(first));
    await shot('usage-activity-type');
    await typeButtons.nth(2).tap();
    await p.waitForFunction((name) => document.querySelector('.activity-tab .ax-scope .ax-filter')?.textContent.includes(name), second);
    await shot('usage-activity-types');
    await p.locator('.activity-tab button[aria-pressed]:text-is("Cost")').first().tap();
    await p.waitForSelector('.activity-tab .ax-time h3:has-text("Where the cost goes")');
    check(tag, 'usage: Cost mode shows cost by agent type and cost by model, and no hours in the tiles or under them', await p.evaluate(() => { const h = (s) => document.querySelector(s)?.textContent ?? ''; return h('.ax-types h3') === 'Cost by agent type' && h('.ax-models h3') === 'Cost by model' && !/\d\u00a0h\b/.test(document.querySelector('.ax-types')?.textContent ?? '') && !/\d\u00a0h\b/.test(document.querySelector('.ax-trees')?.textContent ?? '') && !/\d\u00a0h\b/.test(document.querySelector('.ax-tiles')?.textContent ?? ''); }));
    check(tag, 'usage: Cost mode does not scroll sideways', await p.evaluate(() => [...document.querySelectorAll('.activity-tab *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 1)));
    await shot('usage-activity-cost');
    await p.locator('.activity-tab button[aria-pressed]:text-is("Time")').first().tap();
    await p.waitForSelector('.activity-tab .ax-time h3:has-text("Where the time goes")');
    await p.locator('.usage-types button:text-is("All")').tap();
    await p.locator('.usage-tabs [role=tab]:has-text("Issues")').tap();
    await p.waitForSelector('.usage .usage-configs table');
    check(tag, 'the main button names the world', (await p.locator('[data-nav="main"]').textContent()).includes('Usage'));
    await shot('usage');
    await layout('usage');
    // The link opens Settings on the Spending section, two taps from the view.
    await p.locator('.usage-tabs [role=tab]:has-text("Overview")').tap();
    await p.locator('.usage .usage-foot .btn').tap();
    await p.waitForSelector('.settings-view .settings-inner h2');
    await p.waitForTimeout(300);
    check(tag, 'usage: the link opens Settings on Spending', (await p.locator('.settings-view .settings-inner h2').innerText()) === 'Spending');
    // Back to Usage, so the view under the checks that follow is the one this step opened.
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#open-usage').tap();
    await p.waitForSelector('.usage .lim-card');
  });

  // MCP servers (S-51): the list with its kinds and login state, and the Add preview of a
  // pasted config. Nothing is added, so this is read-only.
  await step('mcp settings', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#open-config').tap();
    await p.waitForSelector('.settings-view');
    await p.locator('.settings-nav .item:has-text("MCP servers")').tap();
    await p.waitForSelector('.mcp-row');
    check(tag, 'mcp: a row per server', await p.locator('.mcp-row').count() === 2);
    check(tag, 'mcp: a remote OAuth server offers Log in', (await p.locator('.mcp-row[data-server=github]').innerText()).includes('OAuth') && await p.locator('.mcp-row[data-server=github] button:has-text("Log in")').isVisible());
    check(tag, 'mcp: a local server shows its command', (await p.locator('.mcp-row[data-server=filesystem]').innerText()).includes('local npx'));
    check(tag, 'mcp: env values stay masked', !(await p.locator('.settings-inner').innerText()).includes('not-a-real-secret'));
    await shot('settings-mcp');
    await layout('mcp settings');
    await p.locator('.mcp-add textarea').fill('{"mcpServers": {"linear": {"type": "sse", "url": "https://mcp.linear.app/sse"}}}');
    // The textarea took the focus and raised the phone's keyboard; put it away, then click the
    // button through the DOM, since the fixed bottom bar can cover its centre at 430 px.
    await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await p.locator('.mcp-add button:has-text("Preview")').evaluate((b) => b.click());
    await p.waitForSelector('.mcp-preview');
    await p.locator('.mcp-preview').scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    check(tag, 'mcp: a pasted config previews its servers', (await p.locator('.mcp-preview').innerText()).includes('linear'));
    await shot('settings-mcp-add');
    await layout('mcp add');
    // The textarea took the focus, which raises the phone's keyboard; put it away so the
    // next step can tap the bottom navigation.
    await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  });

  // Importing the harnesses' own servers (S-52), grouped by source, nothing added.
  await step('mcp import', async () => {
    // A DOM click: the section is scrolled and the button can sit under the top strip.
    await p.locator('.mcp-tools button:has-text("Import from harnesses")').evaluate((b) => b.click());
    await p.waitForSelector('.mcp-import-row');
    check(tag, 'mcp import: the harnesses\' servers are listed by source', await p.locator('.mcp-import-row').count() === 6 && await p.locator('.mcp-import-group').count() === 4);
    check(tag, 'mcp import: an identical server is marked already added', (await p.locator('.mcp-import-row[data-import=filesystem]').innerText()).includes('already added'));
    check(tag, 'mcp import: a clash is marked differs', (await p.locator('.mcp-import-row[data-import=github]').innerText()).includes('differs'));
    check(tag, 'mcp import: a new server is preselected', await p.locator('.mcp-import-row[data-import=linear] input[type=checkbox]').isChecked());
    check(tag, 'mcp import: the SSE note comes with the linear server', (await p.locator('.mcp-import-row[data-import=linear]').innerText()).includes('streamable HTTP'));
    await p.locator('#mcp-import').scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    await shot('settings-mcp-import');
    await layout('mcp import');
    await p.locator('.mcp-import button:has-text("Cancel")').evaluate((b) => b.click());
  });

  // The public MCP registry (S-53): search results and the add form, nothing added.
  await step('mcp registry', async () => {
    await p.locator('.mcp-tools button:has-text("Browse registry")').evaluate((b) => b.click());
    await p.waitForSelector('.mcp-reg-row');
    check(tag, 'mcp registry: results are listed', await p.locator('.mcp-reg-row').count() === 5);
    check(tag, 'mcp registry: a row names its version', (await p.locator('.mcp-reg-row[data-registry="com.example/docs"]').innerText()).includes('v1.0.0'));
    check(tag, 'mcp registry: a remote row offers a one-click Add', await p.locator('.mcp-reg-row[data-registry="com.example/docs"] button:has-text("Add")').isVisible());
    await p.locator('#mcp-registry').scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    await shot('settings-mcp-registry');
    await layout('mcp registry');
    // A server that needs a token opens a form with a password field.
    await p.locator('.mcp-reg-row[data-registry="com.example/needs-token"] button:has-text("Add")').evaluate((b) => b.click());
    await p.waitForSelector('#mcp-reg-add');
    check(tag, 'mcp registry: a required field opens a form', await p.locator('#mcp-reg-add input[type=password]').isVisible());
    await p.locator('#mcp-reg-add').scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    await shot('settings-mcp-registry-add');
    await layout('mcp registry add');
    await p.locator('#mcp-reg-add button:has-text("Cancel")').evaluate((b) => b.click());
    await p.locator('.mcp-registry button:has-text("Close")').evaluate((b) => b.click());
  });

  // The Agents page (S-3346): its slot is on and the main slot reads Main, not Agents again. A phone has no tap to it
  // (its Agents slot is the tree), so it opens the page as openWorld does, through the shell.
  await step('agents page', async () => {
    await p.locator('[data-nav="main"]').tap();
    await p.waitForTimeout(300);
    await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:agents'));
    await p.waitForTimeout(600);
    check(tag, 'agents page: the tab opens the Agents page in main', await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:agents');
    const b = await barCheck('agents page');
    check(tag, 'agents page: the Agents slot is on', b.filter((x) => x.on).map((x) => x.nav).join() === 'left', JSON.stringify(b));
    check(tag, 'agents page: the main slot reads Main', b.find((x) => x.nav === 'main')?.label === 'Main', JSON.stringify(b));
    await shot('agents-page');
    await p.locator('[data-nav="main"]').tap();
    await p.waitForTimeout(300);
  });

  // The Work button opens the Work page in main, with the Main button then naming main, not Work.
  await step('work', async () => {
    await p.locator('[data-nav="work"]').tap();
    await p.waitForTimeout(600);
    check(tag, 'work: the Work button opens the Work page', await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:work');
    check(tag, 'work: the Work button is active', (await p.locator('[data-nav="work"]').getAttribute('class') ?? '').includes('on'));
    check(tag, 'work: the Main button reads Main, not Work', (await p.locator('[data-nav="main"] .nl').innerText()) === 'Main');
    check(tag, 'work: the Work button and Main are touch targets', await p.evaluate(() => [...document.querySelectorAll('#mobile-nav button')].every((b) => b.getBoundingClientRect().height >= 44)));
    await shot('work-page');
    await barCheck('work');
    await p.locator('[data-nav="main"]').tap();
    await p.waitForTimeout(300);
  });

  // The Process view (S-873): a process drawn read-only, top to bottom on the narrow pane, its
  // count badge, its failed files, a picker between processes, and a node's ITSAs in a bottom
  // sheet that opens the ITSA as the Work page does. The route is stubbed (process-fixture.mjs).
  // The Files world and the file view (S-1526): the tree opens, rows are touch targets, a file opens at its
  // line, a long line wraps on a phone by default (S-2103) and scrolls inside the code block with Wrap off, and
  // Markdown renders with a Source toggle.
  await step('files view', async () => {
    await p.evaluate(() => { location.hash = 'view=files'; });
    await p.waitForSelector('.fl .fl-machine');
    check(tag, 'files: the world opens', await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:files');
    await p.locator('.fl-machine-head').first().waitFor();
    await p.locator('.fl-row', { hasText: '/fx/projects' }).first().tap();
    await p.waitForSelector('.fl-row:has-text("long.ts")');
    check(tag, 'files: tree rows are touch targets', await p.locator('.fl-row').evaluateAll((els) => els.every((e) => e.getBoundingClientRect().height >= 44)));
    check(tag, 'files: the path box is a touch target', (await p.locator('.fl-input').boundingBox()).height >= 44);
    await shot('files');
    await p.locator('.fl-row', { hasText: 'long.ts' }).first().tap();
    await p.waitForSelector('.codeview .cm-line');
    check(tag, 'files: a file opens in the code viewer with line numbers', (await p.locator('.cm-lineNumbers .cm-gutterElement').allInnerTexts()).filter(Boolean).slice(0, 2).join() === '1,2');
    // Wrap starts on at a phone width (S-2103): the long line wraps, so the editor has no sideways overflow. The Wrap
    // toggle still turns that off, and then the line scrolls inside the code block as it always did.
    const scroller = () => p.locator('.cm-scroller').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX }));
    const m = await scroller();
    check(tag, 'files: a long line wraps by default on a phone', m.sw <= m.cw, m);
    await p.locator('.codeview-bar button', { hasText: 'Wrap' }).tap();
    await p.waitForFunction(() => { const e = document.querySelector('.cm-scroller'); return !!e && e.scrollWidth > e.clientWidth }).catch(() => {});
    const off = await scroller();
    check(tag, 'files: with Wrap off a long line scrolls inside the editor', off.sw > off.cw && off.ox !== 'visible', off);
    await p.locator('.codeview-bar button', { hasText: 'Wrap' }).tap();
    await p.waitForFunction(() => { const e = document.querySelector('.cm-scroller'); return !!e && e.scrollWidth <= e.clientWidth }).catch(() => {});
    check(tag, 'files: the code toolbar buttons are touch targets', await p.locator('.codeview-bar button').evaluateAll((els) => els.length > 0 && els.every((e) => e.getBoundingClientRect().height >= 44)));
    await p.locator('.codeview-bar button', { hasText: 'Find' }).tap();
    await p.waitForSelector('.cm-search input');
    check(tag, 'files: the search panel fields and buttons are touch targets', await p.locator('.cm-search input:not([type=checkbox]), .cm-search button').evaluateAll((els) => els.length > 0 && els.every((e) => e.getBoundingClientRect().height >= 44)));
    await p.locator('.cm-search [name=close]').tap();
    check(tag, 'files: the page has no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot('file');
    await p.locator('.fv-crumb').first().tap();
    const dbg = (e) => p.evaluate(() => ({ w: window.stamDebug.shell.currentWorld(), t: document.body.innerText.slice(0, 400), hash: location.hash })).then((d) => { throw new Error(e.message + ' | ' + JSON.stringify(d)); });
    await p.waitForSelector('.fl .fl-machine').catch(dbg);
    await p.locator('.fl-row', { hasText: 'note.md' }).first().tap();
    await p.waitForSelector('.fv-md .md').catch(dbg);
    check(tag, 'files: Markdown renders', (await p.locator('.fv-md h1').innerText()) === 'Note');
    await p.locator('.fv-toggle button', { hasText: 'Source' }).tap();
    await p.locator('.codeview .cm-line:visible').first().waitFor().catch(dbg);
    check(tag, 'files: Source shows the text', (await p.locator('.codeview .cm-line:visible').first().innerText()).startsWith('# Note'));
    // The PDF viewer (S-1528): the engine loads on the first PDF, a page draws, the sheet fits the width without a
    // shadow, and the toolbar buttons are touch targets. Zoom changes the level shown.
    await p.locator('.fv-crumb:visible').first().tap();
    await p.waitForSelector('.fl .fl-machine').catch(dbg);
    await p.locator('.fl-row', { hasText: 'sample.pdf' }).first().tap();
    await p.waitForSelector('[data-testid=pdf-page-image-0]', { timeout: 30000 }).catch(dbg);
    check(tag, 'pdf: a page drew', await p.locator('[data-testid=pdf-page-image-0]').evaluate((i) => i.complete && i.naturalWidth > 0));
    check(tag, 'pdf: the indicator names the page', (await p.locator('[data-testid=pdf-page-indicator]').innerText()) === '1 / 3');
    check(tag, 'pdf: toolbar buttons are touch targets', await p.locator('.pdf-bar button').evaluateAll((els) => els.length >= 4 && els.every((e) => e.getBoundingClientRect().height >= 44 && e.getBoundingClientRect().width >= 44)));
    const sheet = await p.locator('[data-testid=pdf-page-0]').evaluate((e) => ({ w: e.getBoundingClientRect().width, shadow: getComputedStyle(e).boxShadow, radius: getComputedStyle(e).borderRadius, vw: innerWidth }));
    check(tag, 'pdf: the sheet fits the width, square, with no shadow', sheet.w <= sheet.vw && sheet.w > sheet.vw * 0.8 && sheet.shadow === 'none' && sheet.radius === '0px', sheet);
    check(tag, 'pdf: the page has no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const before = await p.locator('[data-testid=pdf-zoom-level]').innerText();
    await p.locator('.pdf-bar button[aria-label="Zoom in"]').tap();
    await p.waitForFunction((b) => document.querySelector('[data-testid=pdf-zoom-level]').textContent !== b, before);
    check(tag, 'pdf: zoom in changes the level', (await p.locator('[data-testid=pdf-zoom-level]').innerText()) !== before);
    await shot('pdf');
    // An image over the cap (S-1915): the too-large note offers Download as a touch target.
    await p.locator('.fv-crumb:visible').first().tap();
    await p.waitForSelector('.fl .fl-machine').catch(dbg);
    await p.locator('.fl-row', { hasText: 'huge.png' }).first().tap();
    await p.waitForSelector('[data-testid=image-too-big]').catch(dbg);
    check(tag, 'files: an image over the cap offers Download as a touch target', (await p.locator('[data-testid=image-too-big] button').boundingBox()).height >= 44);
    await shot('image-too-big');
    await layout('files view');
  });

  // The PR diff view (S-1531): unified only on the narrow pane, the file list a sheet from "Files (N) ▾", prev and next
  // file buttons at the bottom, Meat chips, collapsed unchanged runs, and touch targets. The PR is a small git repo with a
  // refs/pull/7/head that daemon.sh seeds (seed-diff.sh), read through the real /api/diff routes.
  await step('diff view', async () => {
    await p.evaluate(() => { location.hash = 'diff=fixture:7'; });
    await p.waitForSelector('.dv .dv-count', { timeout: 30000 });
    check(tag, 'diff: the header names the PR', (await p.locator('.dv-title strong').innerText()) === 'PR #7');
    // S-1918: the narrow header shows the head sha only (both are in its title), and folds Wrap and the text size into one button.
    check(tag, 'diff: the narrow header shows the short head sha only, both shas in its title', /^head [0-9a-f]{7}$/.test(await p.locator('.dv-shas').innerText()) && /^head [0-9a-f]{40} · base [0-9a-f]{40}$/.test((await p.locator('.dv-shas').getAttribute('title')) ?? ''));
    const aa = await p.locator('.dv-text').boundingBox();
    check(tag, 'diff: one "Aa · Wrap" button on screen replaces the Wrap and A−/A+ buttons', (await p.locator('.dv-text').innerText()).startsWith('Aa · Wrap') && !!aa && aa.x >= 0 && aa.x + aa.width <= 360 && await p.locator('.dv-controls .codeprefs').count() === 0, JSON.stringify(aa));
    check(tag, 'diff: Meat hides the test and the lockfile ("7 of 9 files")', (await p.locator('.dv-count').innerText()) === '7 of 9 files');
    // S-1917: the fixture PR isn't watched, so the chip says "no review"; it stays one line inside the viewport.
    const rv = await p.locator('.dv-review').boundingBox();
    check(tag, 'diff: the review chip says "no review" and fits the phone width on one line', (await p.locator('.dv-review').innerText()) === 'no review' && !!rv && rv.x >= 0 && rv.x + rv.width <= p.viewportSize().width && rv.height < 48, JSON.stringify(rv));
    check(tag, 'diff: the chips count the classes, tests and lockfiles hidden', (await p.locator('.dv-chip').allInnerTexts()).join('|') === 'Tests 1 hidden|Lockfiles 1 hidden|Docs 1', (await p.locator('.dv-chip').allInnerTexts()).join('|'));
    check(tag, 'diff: no file column and no Split/Unified toggle on the phone', await p.locator('.dv-side').count() === 0 && await p.locator('.dv-mode').count() === 0);
    // The editor mounts lazily, when its row intersects, and the first merge bundle fetch is slow under load: bring the row
    // into view so it intersects, then wait on the mounted editor rather than a fixed time.
    await p.locator('[data-dv-file="src/a.ts"]').scrollIntoViewIfNeeded({ timeout: 30000 });
    await p.waitForSelector('[data-dv-file="src/a.ts"] .cm-editor .cm-content .cm-line', { timeout: 60000 }).catch(async (e) => { throw new Error(e.message + ' | ' + (await p.locator('[data-dv-file="src/a.ts"]').innerText().catch(() => 'no row'))); });
    check(tag, 'diff: unified only (no side-by-side merge view)', await p.locator('.cm-mergeView').count() === 0 && await p.locator('[data-dv-file="src/a.ts"] .cm-deletedChunk').count() > 0);
    check(tag, 'diff: the unchanged middle is collapsed', await p.locator('[data-dv-file="src/a.ts"] .cm-collapsedLines').count() >= 1);
    check(tag, 'diff: the binary shows its size and no diff', /^binary, \d+ KB$/.test(await p.locator('[data-dv-file="logo.bin"] .dv-row').innerText()));
    check(tag, 'diff: the protected file shows a row and no diff', (await p.locator('[data-dv-file=".env"] .dv-row').innerText()).includes('hidden: protected file') && await p.locator('[data-dv-file=".env"] .cm-editor').count() === 0);
    check(tag, 'diff: a rename shows old → new', (await p.locator('[data-dv-file="new-name.txt"] .dv-path').innerText()) === 'old-name.txt → new-name.txt');
    const before = await p.locator('[data-dv-file="src/a.ts"] .cm-line').count();
    await p.locator('[data-dv-file="src/a.ts"] .cm-collapsedLines').first().tap();
    await p.waitForFunction((n) => document.querySelectorAll('[data-dv-file="src/a.ts"] .cm-line').length > n, before);
    check(tag, 'diff: a tap on a collapsed run expands it', true);
    check(tag, 'diff: the page has no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot('diff');
    // Go to declaration (S-1532): a tap on an identifier in a changed line of src/a.ts (seed-diff.sh). The index builds on
    // the first lookup, so the first wait is long; every wait says what the page showed instead.
    const declSeen = () => p.evaluate(() => {
      const pick = document.querySelector('.decl-pick');
      const flash = [...document.querySelectorAll('.cm-decl-flash')].map((e) => `${e.closest('[data-dv-file]')?.dataset.dvFile}: ${e.textContent}`);
      return `picker ${pick ? `${pick.dataset.state} "${pick.textContent.slice(0, 160)}"` : 'none'}; flashed ${flash.join(', ') || 'nothing'}`;
    });
    const declWait = async (what, fn, arg, timeout = 15000) => {
      try { await p.waitForFunction(fn, arg, { timeout }); } catch { throw new Error(`diff: ${what} never showed; the page showed ${await declSeen()}`); }
    };
    const tapWord = async (lineText, word) => {
      const line = p.locator('[data-dv-file="src/a.ts"] .cm-content .cm-line', { hasText: lineText }).first();
      await line.scrollIntoViewIfNeeded();
      const box = await line.evaluate((el, w) => {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const i = n.textContent.indexOf(w);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i + 1);
          r.setEnd(n, i + 2);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
        return null;
      }, word);
      if (!box) throw new Error(`diff: no "${word}" in the line "${lineText}" of src/a.ts; it shows ${await line.innerText().catch(() => 'nothing')}`);
      await p.touchscreen.tap(box.x, box.y);
    };
    await tapWord('const line = added', 'added');
    await declWait('the jump from "added" to its declaration in src/new.ts', () => document.querySelector('[data-dv-file="src/new.ts"] .cm-decl-flash')?.textContent === 'export const added = 1', undefined, 45000);
    check(tag, 'diff: a tap on a name declared in a PR file jumps there and marks the line', await p.locator('.decl-pick').count() === 0);
    await tapWord('const line = helper(dup)', 'dup');
    await declWait('the declaration sheet listing both "dup"s', () => document.querySelectorAll('.decl-sheet .decl-row').length === 2);
    const rows = await p.locator('.decl-sheet .decl-row').evaluateAll((els) => els.map((e) => ({ t: e.querySelector('.decl-row-at').textContent, h: e.getBoundingClientRect().height })));
    check(tag, 'diff: several declarations show a bottom sheet, path:line per row', rows.map((r) => r.t).join('|') === 'src/lib.ts:4function|src/other.ts:1function', JSON.stringify(rows));
    check(tag, 'diff: declaration rows are touch targets', rows.every((r) => r.h >= 44), JSON.stringify(rows));
    check(tag, 'diff: the declaration sheet stays inside the screen', await p.locator('.decl-sheet').evaluate((e) => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5; }));
    await shot('decl-sheet');
    await p.locator('.decl-sheet .decl-close').tap();
    await declWait('the sheet closing on Close', () => !document.querySelector('.decl-pick'));
    await tapWord('const line = helper(dup)', 'helper');
    await declWait('the lines of "helper" from src/lib.ts, a file outside the PR', () => document.querySelector('.decl-sheet[data-state=one] .decl-line.cur')?.textContent.includes('export function helper(n: number) {'));
    const open = await p.locator('.decl-sheet .decl-btn', { hasText: 'Open file' }).evaluate((e) => e.getBoundingClientRect().height);
    check(tag, 'diff: one declaration outside the PR shows its lines and a 44 px Open file', open >= 44 && (await p.locator('.decl-sheet .decl-line').count()) >= 4, String(open));
    await shot('decl-one');
    // A real touch on the scrim right over src/a.ts's Viewed checkbox (its header is sticky at the top): the scrim must be
    // what the touch hits, it must close the sheet, and the tap must not fall through and toggle Viewed.
    const under = await p.evaluate(() => {
      const box = document.querySelector('[data-dv-file="src/a.ts"] .dv-viewed input')?.getBoundingClientRect();
      const top = document.querySelector('.decl-sheet')?.getBoundingClientRect().top ?? 0;
      if (!box || box.bottom > top) return { err: `the Viewed box of src/a.ts is ${box ? `at ${Math.round(box.top)}-${Math.round(box.bottom)}, the sheet starts at ${Math.round(top)}` : 'not on the page'}` };
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit?.className ?? hit?.nodeName ?? 'nothing', viewed: document.querySelector('[data-dv-file="src/a.ts"] .dv-viewed input').checked };
    });
    if (under.err) throw new Error(`diff: ${under.err}`);
    check(tag, 'diff: the scrim covers the page above the declaration sheet', under.hit === 'decl-scrim', `the touch point hits ${under.hit}`);
    await p.touchscreen.tap(under.x, under.y);
    await declWait('the sheet closing on a tap on the scrim', () => !document.querySelector('.decl-pick'));
    await p.waitForTimeout(300);
    const after = await p.evaluate(() => document.querySelector('[data-dv-file="src/a.ts"] .dv-viewed input')?.checked);
    check(tag, 'diff: a tap on the scrim closes the sheet without reaching what is under it', after === under.viewed, `Viewed of src/a.ts went from ${under.viewed} to ${after}`);
    // The files sheet.
    await p.locator('.dv-files-btn').tap();
    await p.waitForSelector('.dv-sheet .dv-li');
    check(tag, 'diff: the files sheet lists every file, hidden ones dimmed', await p.locator('.dv-sheet .dv-li').count() === 9 && await p.locator('.dv-sheet .dv-li.off').count() === 2);
    check(tag, 'diff: sheet rows are touch targets', await p.locator('.dv-sheet .dv-li').evaluateAll((els) => els.every((e) => e.getBoundingClientRect().height >= 44)));
    await shot('diff-sheet');
    await p.locator('.dv-sheet .dv-li', { hasText: 'new-name.txt' }).first().tap();
    await p.waitForSelector('.dv-sheet', { state: 'detached' });
    await p.waitForFunction(() => { const m = document.querySelector('.dv-main').getBoundingClientRect().top, f = document.querySelector('[data-dv-file="new-name.txt"]').getBoundingClientRect().top; return Math.abs(f - m) < 100; });
    check(tag, 'diff: a file in the sheet scrolls to that file and closes the sheet', true);
    // Prev and next file.
    const pager = await p.locator('.dv-pager .dv-btn').evaluateAll((els) => els.map((e) => ({ t: e.textContent, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
    check(tag, 'diff: prev and next file buttons are at the bottom, 44 px tall', pager.length === 2 && pager.every((b) => b.h >= 44 && b.w >= 44), JSON.stringify(pager));
    const top0 = await p.locator('.dv-main').evaluate((e) => e.scrollTop);
    await p.locator('.dv-pager .dv-btn', { hasText: 'prev file' }).tap();
    await p.waitForFunction((t) => document.querySelector('.dv-main').scrollTop < t, top0);
    check(tag, 'diff: prev file scrolls up', true);
    // A Meat chip shows its class; Viewed marks a file and closes its body.
    await p.locator('.dv-chip', { hasText: 'Tests' }).tap();
    await p.waitForFunction(() => document.querySelector('.dv-count').textContent === '8 of 9 files');
    check(tag, 'diff: a chip shows its class', await p.locator('[data-dv-file="test/a.test.ts"]').count() === 1);
    await p.locator('[data-dv-file="src/a.ts"] .dv-viewed').scrollIntoViewIfNeeded();
    await p.locator('[data-dv-file="src/a.ts"] .dv-viewed').tap();
    await p.waitForFunction(() => !document.querySelector('[data-dv-file="src/a.ts"] .cm-editor'));
    check(tag, 'diff: Viewed closes the file and is remembered in this browser', await p.evaluate(() => JSON.parse(localStorage.getItem('stam/diff-viewed') || '[]').some((k) => k.startsWith('fixture#7:src/a.ts@'))));
    await layout('diff view');
    await p.evaluate(() => { try { localStorage.removeItem('stam/diff-viewed'); } catch {} });
  });

  // Viewer entry points (S-1529): a file path in a mail is a link that opens the file view at its line, an attached
  // file opens the file view, and a PDF embed is a card, never an iframe. The Files API is stubbed (files-fixture.mjs).
  await step('entry links', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%fixture\n').toString('base64');
    const sent = await api('/api/mail', 'POST', { from: 'kid', to: ['human'], new_thread: true, subject: 'Check: entry links', body: 'See /fx/projects/long.ts:5 and `/fx/projects/note.md`.\n\n```embed\nattachment: report.pdf\n```', attachments: [{ name: 'report.pdf', content_b64: pdf }, { name: 'extra.bin', content_b64: pdf }] });
    const tid = sent.thread_id ?? (await api('/api/agents/human/threads?limit=60')).find((t) => t.mails.some((m) => m.subject === 'Check: entry links'))?.thread_id;
    await p.evaluate((t) => { location.hash = 'thread=' + t; }, tid);
    await p.waitForSelector('.msg.open .md a.file-link');
    check(tag, 'entry links: both paths in the body are links', await p.locator('.msg.open .md a.file-link').count() === 2);
    check(tag, 'entry links: a link does not break the text flow', await p.locator('.msg.open .md a.file-link').first().evaluate((e) => getComputedStyle(e).display === 'inline'));
    check(tag, 'entry links: a PDF embed has no iframe', await p.locator('.msg.open iframe').count() === 0 && await p.locator('.msg.open [data-att-open]').count() === 1);
    check(tag, 'entry links: the PDF card links are touch targets', await p.locator('.msg.open .mb-efile a').evaluateAll((els) => els.length === 2 && els.every((e) => e.getBoundingClientRect().height >= 44)));
    check(tag, 'entry links: the page has no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot('entry-links');
    await p.locator('.msg.open .md a.file-link').first().tap();
    await p.waitForSelector('.codeview .cm-line');
    await p.waitForSelector('.codeview .cm-selectedLine');
    check(tag, 'entry links: a tap on a path opens the file view with its line marked', (await p.locator('.codeview .cm-selectedLine').first().innerText()).startsWith('const wide '));
    // The thread's tab shows its short title (S-2311: "entry links", not the full subject), so the tab is the target.
    await p.locator(`.tab[data-key="thread:${tid}"]`).first().tap();
    await p.waitForSelector('.files a.att-file');
    check(tag, 'entry links: the attachment link and its Download button show', await p.locator('.files a.att-file').count() === 1 && await p.locator('.files .att-dl').count() === 1);
    check(tag, 'entry links: Download is a touch target', (await p.locator('.files .att-dl').first().boundingBox()).height >= 44);
    await p.locator('.files a.att-file').first().tap();
    await p.waitForFunction(() => [...document.querySelectorAll('.fv-crumb.cur')].some((e) => e.textContent === 'extra.bin'));
    check(tag, 'entry links: an attachment opens the file view', true);
    await layout('entry links');
  });

  // Diff entry points (S-1533): a GitHub PR URL in a mail for a served repo opens the diff view in the app, with "GitHub" beside it
  // for the PR page; a PR of another repo stays a plain link. daemon.sh gives the `fixture` checkout the origin github.com/fixture/repo.
  await step('diff entry points', async () => {
    const sent = await api('/api/mail', 'POST', { from: 'kid', to: ['human'], new_thread: true, subject: 'Check: diff entry', body: 'Review https://github.com/fixture/repo/pull/7 and ignore https://github.com/other/thing/pull/3.' });
    const tid = sent.thread_id ?? (await api('/api/agents/human/threads?limit=60')).find((t) => t.mails.some((m) => m.subject === 'Check: diff entry'))?.thread_id;
    await p.evaluate((t) => { location.hash = 'thread=' + t; }, tid);
    try { await p.waitForSelector('.msg.open .md a.pr-link', { timeout: 15000 }); } catch { throw new Error(`diff entry: the PR URL never became an in-app link; the mail showed ${JSON.stringify(await p.locator('.msg.open .md').first().innerHTML().catch(() => 'no open mail'))}`); }
    check(tag, 'diff entry: only the served PR is an in-app link, with GitHub beside it', await p.locator('.msg.open .md a.pr-link').count() === 1 && await p.locator('.msg.open .md a.pr-gh').count() === 1);
    check(tag, 'diff entry: the other repo\'s PR stays a plain link', await p.locator('.msg.open .md a[href$="other/thing/pull/3"]').evaluate((e) => !e.classList.contains('pr-link') && e.nextElementSibling?.classList.contains('pr-gh') !== true));
    const gh = await p.locator('.msg.open .md a.pr-gh').evaluate((e) => {
      const b = e.getBoundingClientRect();
      const at = (x, y) => { const h = document.elementFromPoint(x, y); return h === e ? 'pr-gh' : h?.className || h?.tagName; };
      const cx = b.left + b.width / 2;
      return { w: b.width, centre: at(cx, b.top + b.height / 2), rightEdge: at(b.right - 2, b.top + b.height / 2), above: at(cx, b.top - 2), below: at(cx, b.bottom + 2) };
    });
    check(tag, 'diff entry: GitHub is at least 44 px wide and the point hits it', gh.w >= 44 && gh.centre === 'pr-gh' && gh.rightEdge === 'pr-gh', `the box is ${gh.w} px wide; its centre hits ${gh.centre} and its right edge hits ${gh.rightEdge}`);
    check(tag, 'diff entry: the point just above and below GitHub does not hit it', gh.above !== 'pr-gh' && gh.below !== 'pr-gh', `the point above hits ${gh.above} and the point below ${gh.below}; its box reaches into the next line`);
    const edge = await p.locator('.msg.open .md a.pr-gh').evaluate((e) => { const b = e.getBoundingClientRect(); const h = document.elementFromPoint(b.left - 2, b.top + b.height / 2); return h === e ? 'pr-gh' : h?.className || h?.tagName; });
    check(tag, 'diff entry: the point just left of GitHub does not hit it, so the PR link end is the link\'s', edge !== 'pr-gh', `the point left of it hits ${edge}`);
    check(tag, 'diff entry: the page has no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot('diff-entry-mail');
    const at = await p.locator('.msg.open .md a.pr-link').evaluate((e) => { const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; return { hit: document.elementFromPoint(x, y) === e }; });
    if (!at.hit) throw new Error('diff entry: the PR link is covered at its centre; the point hits something else');
    await p.locator('.msg.open .md a.pr-link').tap();
    try { await p.waitForSelector('.dv .dv-count', { timeout: 30000 }); } catch { throw new Error(`diff entry: a tap on the PR URL never opened the diff view; the page showed world ${await p.evaluate(() => window.stamDebug.shell.currentWorld())}`); }
    check(tag, 'diff entry: a tap on the PR URL opens the diff view of PR #7', (await p.locator('.dv-title strong').innerText()) === 'PR #7');
    await shot('diff-entry');
    await layout('diff entry points');
  });

  await step('process view', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.waitForTimeout(300);
    await p.locator('#open-process').tap();
    await p.waitForSelector('.proc .react-flow');
    // Wait on loaded state, not time (S-1325): the drawing starts wide with lane bands and redraws as the
    // column once the pane is measured, and the badges show after the ITSA counts are fetched.
    await p.waitForFunction(() => document.querySelector('.proc-node.row .proc-lane-cap')?.textContent.trim() && !document.querySelector('.proc .proc-lane'));
    await p.waitForFunction(() => document.querySelector('.proc-node[data-node=code] .proc-badge')?.textContent.trim() === '3');
    // S-1397: a refetch with a changed body rebuilds the nodes; one without top-level width/height commits
    // visibility:hidden until React Flow measures it again. Watch every node from the refetch to the new badge.
    if (!process.env.STAM_PROCESS_REAL) {
      await p.evaluate(() => {
        window.__hiddenNodes = 0;
        const look = () => { for (const n of document.querySelectorAll('.proc .react-flow__node')) if (getComputedStyle(n).visibility === 'hidden') window.__hiddenNodes++ };
        window.__nodeWatch = new MutationObserver(look);
        window.__nodeWatch.observe(document.querySelector('.proc'), { subtree: true, childList: true, attributes: true });
      });
      const more = JSON.parse(JSON.stringify(PROCESSES));
      const c = more.processes[0].counts.code;
      c.itsas.push({ ...c.itsas[0], key: 'S-9999', id: 'fixture-s-9999' });
      c.count = c.itsas.length;
      const moreRoute = (route) => route.fulfill({ json: more });
      await p.route(`${origin}/api/processes**`, moreRoute);
      // Changing an ITSA's status changes the list the view follows, so it refetches.
      const subject = (await api('/api/itsas')).find((x) => x.title === 'Check: issue system');
      await api('/api/itsas/' + subject.id, 'PATCH', { status: subject.status === 'blocked' ? 'todo' : 'blocked' });
      await p.waitForFunction((n) => document.querySelector('.proc-node[data-node=code] .proc-badge')?.textContent.trim() === String(n), c.count);
      check(tag, 'process: a refetch with new counts never hides a node', await p.evaluate(() => { window.__nodeWatch.disconnect(); return window.__hiddenNodes }) === 0);
      await p.unroute(`${origin}/api/processes**`, moreRoute);
      await api('/api/itsas/' + subject.id, 'PATCH', { status: subject.status });
      await p.waitForFunction(() => document.querySelector('.proc-node[data-node=code] .proc-badge')?.textContent.trim() === '3');
    }
    check(tag, 'process: the pane opens as its own world', await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:process');
    check(tag, 'process: the Main button names the world', (await p.locator('[data-nav="main"] .nl').innerText()).includes('Process'));
    check(tag, 'process: it draws its nodes', await p.locator('.proc .proc-node').count() >= 6, await p.locator('.proc .proc-node').count());
    check(tag, 'process: it runs top to bottom on a narrow pane', (await p.locator('.proc').getAttribute('data-dir')) === 'TB');
    check(tag, 'process: the phone has no lane bands; each node names its lane', await p.locator('.proc .proc-lane').count() === 0 && (await p.locator('.proc-node.row .proc-lane-cap').first().innerText()).trim().length > 0);
    const xs = await p.locator('.proc-node').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
    check(tag, 'process: the nodes form one column that fits the width', new Set(xs).size === 1 && await p.locator('.proc-node').first().evaluate((e) => e.getBoundingClientRect().right <= innerWidth), xs);
    check(tag, 'process: the text is at the body size', await p.locator('.proc-node .proc-label').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize) >= 13));
    check(tag, 'process: a node that holds ITSAs shows its count badge', await p.locator('.proc-node[data-node=code] .proc-badge').innerText() === '3');
    const realProc = !!process.env.STAM_PROCESS_REAL // the fixture's old-flow.yaml and release process don't exist on the real route
    if (!realProc) check(tag, 'process: a failed file is listed', (await p.locator('.proc-errors li').innerText()).includes('old-flow.yaml'));
    // The picker lists both processes and switching redraws.
    if (!realProc) {
    check(tag, 'process: the picker shows both processes', await p.locator('.proc-pick option').count() === 2);
    await p.locator('.proc-pick').selectOption('release');
    await p.waitForSelector('.proc-node[data-node=tag]');
    check(tag, 'process: the picker switches the drawing', await p.locator('.proc-node[data-node=tag]').count() === 1 && await p.locator('.proc-node[data-node=review]').count() === 0);
    await p.locator('.proc-pick').selectOption('dev-change');
    }
    await p.waitForSelector('.proc-node[data-node=code]');
    await shot('process');
    await layout('process view');
    // Editing (S-1083): Edit opens a working copy, the bar adds a node, a node's sheet connects it
    // (a touch drag is unreliable at 360 px), a problem is listed and marks its node, Review shows
    // the YAML diff, and Discard leaves; nothing is saved.
    await p.locator('.proc [data-act=edit]').tap();
    await p.waitForSelector('.proc.editing .proc-bar');
    check(tag, 'process edit: the bar fits the screen and its buttons are touch targets', await inViewport(p.locator('.proc-bar')) && await p.locator('.proc-bar .btn').evaluateAll((els) => els.every((e) => e.getBoundingClientRect().height >= 44)));
    check(tag, 'process edit: there is no palette on a phone', await p.locator('.proc-palette').count() === 0);
    check(tag, 'process edit: Save as proposal is disabled', await p.locator('.proc-head [data-act=save-proposal]').isDisabled());
    const nodesBefore = await p.locator('.proc-node').count();
    await p.locator('.proc-bar [data-edit=add]').tap();
    await p.waitForSelector('.proc-edit[data-panel=add]');
    await p.locator('[data-kind-pick=script]').tap();
    await p.locator('.proc-edit input[aria-label=Label]').fill('Notify the channel');
    // The keyboard's Done closes the field, and the bottom bar returns: the layout settles before the tap.
    await p.evaluate(() => document.activeElement?.blur());
    await p.waitForTimeout(300);
    await p.locator('[data-act=add-node]').tap();
    await p.waitForSelector('.proc-edit[data-panel=node]');
    await p.waitForTimeout(300);
    check(tag, 'process edit: adding a node draws it and opens its sheet within the screen', await p.locator('.proc-node').count() === nodesBefore + 1 && await inViewport(p.locator('.proc-edit')) && (await p.locator('.proc-edit').getAttribute('class')).includes('narrow'));
    check(tag, 'process edit: the sheet\'s fields are touch targets', await p.locator('.proc-edit select, .proc-edit input').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).every((e) => e.getBoundingClientRect().height >= 44)));
    await p.locator('.proc-edit select[data-act=connect]').selectOption('request');
    await p.waitForSelector('.proc-issues');
    check(tag, 'process edit: an edge into a start node is listed as a problem and marks the node', /incoming edge/.test(await p.locator('.proc-issues').innerText()) && await p.locator('.proc-node[data-node=request].bad').count() === 1);
    await shot('process-edit');
    await layout('process edit sheet');
    await p.locator('.proc-edit .proc-edge .icon-btn').first().tap();
    await p.waitForTimeout(200);
    check(tag, 'process edit: deleting the edge clears the problem', await p.locator('.proc-issues').count() === 0 && await p.locator('.proc-node.bad').count() === 0);
    await p.locator('.proc-edit select[data-act=connect]').selectOption('merge');
    check(tag, 'process edit: Connect to adds an edge row', await p.locator('.proc-edit .proc-edge').count() === 1);
    await p.locator('.proc-bar [data-edit=review]').tap();
    await p.waitForSelector('.proc-diff');
    check(tag, 'process edit: Review shows the added YAML lines', /notify-the-channel/.test(await p.locator('.proc-diff').innerText()) && await p.locator('.proc-diff .d-add').count() > 0);
    check(tag, 'process edit: the diff stays inside the screen width', await p.locator('.proc-edit').evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    await shot('process-edit-review');
    await layout('process edit review');
    await p.locator('.proc-head [data-act=discard]').tap();
    await p.locator('.proc-head [data-act=discard]').tap();
    await p.waitForSelector('.proc:not(.editing)');
    check(tag, 'process edit: Discard confirms, then leaves edit mode and the drawing as it was', await p.locator('.proc-node').count() === nodesBefore && await p.locator('.proc-bar').count() === 0);
    // Save as proposal (S-1084): a change, the summary, the daemon's answer (stubbed: no branch, PR or ITSA is made), and the card that names the proposal.
    let sent = null;
    await p.route('**/api/processes/*/proposal', async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { key: 'S-1201', id: 'fixture-s-1201', pr: { number: 412, url: 'https://github.com/example/stam2/pull/412' }, branch: 'process/dev-change-x' } });
    });
    await p.locator('.proc [data-act=edit]').tap();
    await p.waitForSelector('.proc.editing .proc-bar');
    check(tag, 'process save: with nothing changed, Save as proposal is disabled', await p.locator('.proc-head [data-act=save-proposal]').isDisabled());
    await p.locator('.proc-node[data-node=code] .proc-hit').evaluate((el) => el.click());
    await p.waitForSelector('.proc-edit[data-panel=node]');
    await p.locator('.proc-edit input[aria-label=Label]').fill('Implement and test');
    await p.evaluate(() => document.activeElement?.blur());
    await p.waitForTimeout(300);
    check(tag, 'process save: a change enables the header button', !(await p.locator('.proc-head [data-act=save-proposal]').isDisabled()));
    await p.locator('.proc-head [data-act=save-proposal]').tap();
    await p.waitForSelector('.proc-diff');
    check(tag, 'process save: the review button needs a summary', await p.locator('.proc-edit [data-act=save-proposal]').isDisabled());
    await p.locator('.proc-edit textarea[aria-label=Summary]').fill('Say what the developer step does');
    await p.evaluate(() => document.activeElement?.blur());
    await p.waitForTimeout(300);
    check(tag, 'process save: the sheet, summary and button fit the screen', await inViewport(p.locator('.proc-edit')) && await p.locator('.proc-edit [data-act=save-proposal]').evaluate((e) => e.getBoundingClientRect().height >= 44));
    await shot('process-save');
    await layout('process save');
    await p.locator('.proc-edit [data-act=save-proposal]').tap();
    await p.waitForSelector('.proc-saved');
    check(tag, 'process save: the card names the proposal and links its PR', (await p.locator('.proc-saved').innerText()).includes('S-1201') && (await p.locator('.proc-saved a.btn').getAttribute('href')).endsWith('/pull/412'));
    check(tag, 'process save: the request carries the whole file and the summary', typeof sent?.yaml === 'string' && /Implement and test/.test(sent.yaml) && sent.summary === 'Say what the developer step does', JSON.stringify(sent)?.slice(0, 120));
    check(tag, 'process save: the card\'s buttons are touch targets', await p.locator('.proc-saved .btn').evaluateAll((els) => els.every((e) => e.getBoundingClientRect().height >= 44)));
    await shot('process-saved');
    await layout('process saved');
    await p.locator('.proc-saved [data-act=done]').tap();
    await p.waitForSelector('.proc:not(.editing)');
    // A touch tap on the start node opens the bottom sheet; the start holds no ITSAs.
    await p.locator('.proc-node[data-node=request] .proc-hit').tap();
    await p.waitForSelector('.proc-sheet');
    check(tag, 'process: tapping a node opens the bottom sheet within the screen', await inViewport(p.locator('.proc-sheet')) && (await p.locator('.proc-sheet').getAttribute('class')).includes('narrow'));
    check(tag, 'process: a node with no ITSAs says so', (await p.locator('.proc-sheet').innerText()).includes('no ITSAs'));
    await p.locator('.proc-sheet .proc-close').tap();
    check(tag, 'process: the sheet closes by touch', !(await p.locator('.proc-sheet').count()));
    // Open the task node by its own click (the column is scrolled, the node may sit below the fold) and list its ITSAs.
    await p.locator('.proc-node[data-node=code] .proc-hit').evaluate((el) => el.click());
    await p.waitForSelector('.proc-sheet .proc-itsa');
    const sheet = p.locator('.proc-sheet');
    if (!realProc) check(tag, 'process: the sheet lists the node\'s ITSAs with their owners', await sheet.locator('.proc-itsa').count() === 3 && /S-101/.test(await sheet.locator('.proc-itsa').first().innerText()));
    await shot('process-sheet');
    await layout('process sheet');
    check(tag, 'process: the sheet names the node\'s boundary event', (await sheet.locator('.proc-bounds').innerText()).includes('on cost → pause'));
    // S-2249: the boundary events are text, not a tooltip. The node has one event in the fixture, so a long line of three is set in
    // the open sheet as the sheet would draw it: it must wrap inside the 360 px sheet, not clip.
    await sheet.evaluate((el) => {
      const line = document.createElement('p');
      line.className = 'proc-sub proc-bounds';
      line.id = 'bounds-probe';
      line.textContent = 'on cost → pause, timeout → notify_manager, deployment_health_check_failed → rollback';
      el.append(line);
    });
    const probe = p.locator('#bounds-probe');
    check(tag, 'process: a long boundary line wraps inside the sheet, none clipped', await probe.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().right <= innerWidth && e.scrollHeight > parseFloat(getComputedStyle(e).fontSize) * 2), await probe.evaluate((e) => `scroll ${e.scrollWidth} client ${e.clientWidth} height ${e.scrollHeight}`));
    await layout('process boundary sheet');
    await probe.evaluate((e) => e.remove());
    await p.locator('.proc-node[data-node=code] .proc-hit').evaluate((el) => el.click());
    await p.waitForSelector('.proc-sheet .proc-itsa');
    await sheet.locator('.proc-itsa').first().tap();
    await p.waitForSelector('.itsa-view');
    check(tag, 'process: a row opens the ITSA as the Work page does', await p.locator('.itsa-view').isVisible());
    await p.locator('[data-nav="main"]').tap();
    await p.waitForTimeout(300);
  });

  // The Alt+A prompt (S-1461), from the pane menu: full screen, the box at the bottom by the
  // keyboard, 44 px cards (a fixture answers /api/suggest); a tap picks without dropping the
  // keyboard, and back closes it.
  await step('suggest', async () => {
    await p.route('**/api/suggest?*', (route) => route.fulfill({ json: [
      { kind: 'agent', id: helper.id, title: 'helper', snippet: 'the paused fixture agent', score: 0.9 },
      { kind: 'thread', id: 'nope', title: 'A fixture thread with a long subject that has to cut off', snippet: 'not picked here', score: 0.5 },
    ] }));
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator('.name').tap();
    await p.waitForTimeout(1200);
    await p.locator('[data-pane-menu]').tap();
    await p.locator('.menu [role=menuitem]:has-text("Write and pick where")').tap();
    await p.waitForSelector('#suggest-modal');
    await p.waitForTimeout(300);
    check(tag, 'suggest: the pane menu opens the prompt', await p.locator('#suggest-modal').isVisible());
    check(tag, 'suggest: it fills the screen', await p.locator('#suggest-modal').evaluate((e) => Math.abs(e.getBoundingClientRect().width - innerWidth) < 1.5));
    check(tag, 'suggest: the box takes the focus', await p.evaluate(() => !!document.activeElement?.matches('#suggest-modal textarea')));
    await keyboard(true);
    await p.locator('#suggest-modal textarea').pressSequentially('look at the ');
    await p.waitForSelector('#suggest-modal .sg-card');
    await p.waitForTimeout(300);
    const hs = await p.locator('#suggest-modal .sg-pick').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    check(tag, 'suggest: each card is a 44 px touch target', hs.length === 2 && hs.every((h) => h >= 43.5), hs.join(','));
    check(tag, 'suggest: the box and the best card sit above the keyboard', await inViewport(p.locator('#suggest-modal textarea')) && await inViewport(p.locator(`#suggest-modal [data-suggest="agent:${helper.id}"]`)));
    await shot('suggest');
    await layout('suggest prompt');
    // Preview (S-1910): a hold on a card opens a sheet that names it, with touch-size Close and Pick; Close
    // leaves the cards and the text, and a hold then Pick picks as a tap does.
    const [hx, hy] = await center(p.locator(`#suggest-modal [data-suggest="agent:${helper.id}"] .sg-pick`));
    await longPress(hx, hy);
    await p.waitForSelector('[data-preview]');
    check(tag, 'suggest: a hold previews the card', await p.locator(`[data-preview="agent:${helper.id}"]`).isVisible());
    const pb = await p.locator('[data-preview-pick]').boundingBox(), cb = await p.locator('[data-preview-close]').boundingBox();
    check(tag, 'suggest: the preview\'s Pick and Close are touch targets', pb.height >= 43.5 && pb.width >= 43.5 && cb.height >= 43.5 && cb.width >= 43.5, `${pb.height},${cb.height}`);
    check(tag, 'suggest: the preview is inside the screen', await p.locator('.menu.popover').evaluate((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5; }));
    await shot('suggest-preview');
    await layout('suggest preview');
    await p.locator('[data-preview-close]').tap();
    await p.waitForSelector('[data-preview]', { state: 'detached' });
    await p.waitForTimeout(300);
    check(tag, 'suggest: Close returns to the list without picking', await p.locator('#suggest-modal .sg-card').count() === 2 && await p.locator('#suggest-modal .sg-chip').count() === 0 && await p.locator('#suggest-modal').isVisible());
    check(tag, 'suggest: the typed text stays', (await p.locator('#suggest-modal textarea').inputValue()).includes('look at the'));
    await longPress(hx, hy);
    await p.waitForSelector('[data-preview]');
    await p.goBack();
    await p.waitForTimeout(500);
    check(tag, 'suggest: back closes only the preview', !(await p.locator('[data-preview]').count()) && await p.locator('#suggest-modal .sg-card').count() === 2);
    const [hx2, hy2] = await center(p.locator(`#suggest-modal [data-suggest="agent:${helper.id}"] .sg-pick`));
    await longPress(hx2, hy2);
    await p.waitForSelector('[data-preview]');
    await p.locator('[data-preview-pick]').tap();
    await p.waitForTimeout(300);
    check(tag, 'suggest: Pick in the preview picks the card, as a chip', await p.locator(`#suggest-modal .sg-chip[data-pick="agent:${helper.id}"]`).isVisible());
    await p.locator('#suggest-modal .sg-unpick').tap();
    await p.waitForSelector('#suggest-modal .sg-card');
    await p.locator(`#suggest-modal [data-suggest="agent:${helper.id}"] .sg-pick`).tap();
    await p.waitForTimeout(300);
    check(tag, 'suggest: a tap picks the card, as a chip', await p.locator(`#suggest-modal .sg-chip[data-pick="agent:${helper.id}"]`).isVisible());
    check(tag, 'suggest: the keyboard stays up (the box keeps the focus)', await p.evaluate(() => !!document.activeElement?.matches('#suggest-modal textarea')));
    check(tag, 'suggest: with the cards gone the box stays at the bottom, by the keyboard', await p.locator('#suggest-modal .composer').evaluate((e) => innerHeight - e.getBoundingClientRect().bottom < 80));
    check(tag, 'suggest: the remove button is a touch target', await p.locator('#suggest-modal .sg-unpick').evaluate((e) => e.getBoundingClientRect().height >= 43.5));
    await shot('suggest-picked');
    await layout('suggest picked');
    await p.goBack();
    await p.waitForTimeout(500);
    check(tag, 'suggest: back closes it', !(await p.locator('#suggest-modal').count()));
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
    // Go to (S-1463): the card's button is a touch target, opens the agent, closes the prompt, and
    // what was written becomes a draft in the agent's own box.
    await p.locator('[data-pane-menu]').tap();
    await p.locator('.menu [role=menuitem]:has-text("Write and pick where")').tap();
    await p.waitForSelector('#suggest-modal');
    await p.locator('#suggest-modal textarea').pressSequentially('hand this over ');
    await p.waitForSelector('#suggest-modal .sg-card');
    const go = p.locator(`#suggest-modal [data-suggest="agent:${helper.id}"] [data-go]`);
    const gb = await go.evaluate((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; });
    check(tag, 'suggest: Go to is a touch target', gb[0] >= 43.5 && gb[1] >= 43.5, gb.join('x'));
    await shot('suggest-goto');
    await go.tap();
    await p.waitForTimeout(500);
    check(tag, 'suggest: Go to closes the prompt', !(await p.locator('#suggest-modal').count()));
    check(tag, 'suggest: Go to leaves the text as a draft in the agent\'s box', (await p.locator('#w-bottom textarea').inputValue()).includes('hand this over'), await p.locator('#w-bottom textarea').inputValue());
    await p.evaluate(() => document.activeElement?.blur());
    // Touch (S-2570, the scrim contract in docs/design-system.md): under pointer: coarse the prompt has no scrim
    // (style.css hides #suggest-scrim), so a tap outside a preview lands on the prompt. That tap closes the preview
    // only and presses nothing under it: the card beneath stays unpicked.
    await p.locator('[data-pane-menu]').tap();
    await p.locator('.menu [role=menuitem]:has-text("Write and pick where")').tap();
    await p.waitForSelector('#suggest-modal');
    await p.locator('#suggest-modal textarea').pressSequentially('tap outside ');
    await p.waitForSelector('#suggest-modal .sg-card');
    const [tx, ty] = await center(p.locator(`#suggest-modal [data-suggest="agent:${helper.id}"] .sg-pick`));
    await longPress(tx, ty);
    await p.waitForSelector('[data-preview]');
    await p.locator('#suggest-modal [data-suggest="thread:nope"] .sg-pick').tap();
    await p.waitForTimeout(400);
    check(tag, 'suggest: a tap outside the preview closes only the preview', !(await p.locator('[data-preview]').count()) && await p.locator('#suggest-modal').isVisible());
    check(tag, 'suggest: that tap picks nothing under the preview', await p.locator('#suggest-modal .sg-chip').count() === 0 && await p.locator('#suggest-modal .sg-card').count() === 2);
    // Back onto a menu over the prompt (S-2020, driven with real events): Alt+A opens the prompt over the open pane
    // menu, a tap outside the menu closes the menu, and the entry it leaves is the prompt over the menu's. One back
    // press lands on that entry; the skip passes it, so the prompt does not reopen.
    await p.goBack();
    await p.waitForTimeout(500);
    await p.locator('[data-pane-menu]').tap();
    await p.waitForSelector('.menu');
    await p.keyboard.press('Alt+a');
    await p.waitForSelector('#suggest-modal');
    await p.locator('#suggest-modal .sg-head').tap();
    await p.waitForSelector('.menu', { state: 'detached' });
    await p.goBack();
    await p.waitForTimeout(500);
    check(tag, 'suggest: one back onto a menu over the prompt does not reopen the prompt', !(await p.locator('#suggest-modal').count()));
    await p.unroute('**/api/suggest?*');
  });

  // The Agents tab's search entry opens the palette full screen with the keyboard; rows are touch
  // targets that open their world.
  await step('search', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.locator('[data-tree-search]').tap();
    await p.waitForSelector('#search-palette');
    await p.waitForTimeout(300);
    check(tag, 'search: the Agents tab search entry opens the palette', await p.locator('#search-palette').isVisible());
    check(tag, 'search: the palette fills the screen', await p.locator('#search-palette').evaluate((e) => Math.abs(e.getBoundingClientRect().width - innerWidth) < 1.5));
    check(tag, 'search: the box takes the focus', await p.evaluate(() => document.activeElement?.id === 'search-all'));
    await shot('search');
    await layout('search palette');
    await p.locator('#search-all').fill('helper');
    await p.waitForSelector('#search-palette .pal-result');
    await p.waitForTimeout(300);
    check(tag, 'search: typing shows grouped results', await p.locator('#search-palette .pal-group').count() >= 1);
    await keyboard(true);
    check(tag, 'search: the box and first result sit above the keyboard', await inViewport(p.locator('#search-palette .pal-input')) && await inViewport(p.locator('#search-palette .pal-result').first()));
    await shot('search-keyboard');
    await layout('search with keyboard');
    await p.locator(`.pal-result[data-result="agent:${helper.id}"]`).tap();
    await p.waitForTimeout(900);
    check(tag, 'search: tapping a result closes the palette', !(await p.locator('#search-palette').count()));
    check(tag, 'search: it opened the agent world', await p.evaluate(() => window.stamDebug.shell.currentWorld()) === helper.id);
    await p.evaluate(() => document.activeElement?.blur());
    await keyboard(false);
    // A Settings section, two taps from anywhere.
    await p.locator('[data-nav="left"]').tap();
    await p.locator('[data-tree-search]').tap();
    await p.waitForSelector('#search-all');
    await p.locator('#search-all').fill('compaction');
    await p.waitForSelector('#search-palette .pal-result');
    await p.locator('.pal-result[data-result="setting:section:context"]').tap();
    await p.waitForSelector('.settings-view .settings-inner h2');
    await p.waitForTimeout(300);
    check(tag, 'search: a Settings result opens Settings on that section', (await p.locator('.settings-view .settings-inner h2').innerText()) === 'Context and compaction');
    await p.locator('[data-nav="main"]').tap();
    await p.waitForTimeout(300);
  });

  // The back button (and gesture): a world, the phone's tab, and an overlay each take a
  // history entry, so back closes the overlay, then returns to the world, then to the tab.
  await step('back button', async () => {
    const current = () => p.evaluate(() => window.stamDebug.shell.currentWorld());
    await p.locator('[data-nav="left"]').tap();
    await p.waitForTimeout(300);
    check(tag, 'back: the Agents tab is showing', await p.locator('#tree').isVisible());
    await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator(".name").tap();
    await p.waitForTimeout(1200);
    check(tag, 'back: an agent world is open', await current() === helper.id && !(await p.locator('#tree').isVisible()));
    await p.locator('[data-nav="left"]').tap();
    await p.locator('[data-tree-search]').tap();
    await p.waitForSelector('#search-palette');
    check(tag, 'back: the search palette is open', await p.locator('#search-palette').isVisible());
    await shot('back-overlay');
    await p.goBack().catch(() => {});
    await p.waitForTimeout(500);
    check(tag, 'back: closes the overlay first, back to the Agents tab', !(await p.locator('#search-palette').count()) && await current() === helper.id && await p.locator('#tree').isVisible());
    await p.goBack().catch(() => {});
    await p.waitForTimeout(500);
    check(tag, 'back: returns to the agent world', await current() === helper.id && !(await p.locator('#tree').isVisible()));
    await shot('back-tab');
  });

  // Installing as an app and notifications. The push service is stubbed in the page (headless
  // browsers have none): the subscription is a real P-256 key pointing at a closed port, so
  // the daemon stores it and a test reports the failure. iPhone sizes see Add to Home Screen
  // first, then, as the installed app, the same controls.
  await step('notifications', async () => {
    const man = await p.evaluate(async () => { const r = await fetch(document.querySelector('link[rel=manifest]').href); return { type: r.headers.get('content-type'), m: await r.json() }; });
    check(tag, 'the manifest installs standalone at /', man.type.includes('manifest') && man.m.display === 'standalone' && man.m.start_url === '/' && man.m.scope === '/');
    const icons = await p.evaluate(async (list) => Promise.all(list.map(async (i) => { const r = await fetch(i.src); return `${i.sizes} ${r.status} ${r.headers.get('content-type')}`; })), man.m.icons);
    check(tag, 'its icons load, 192 and 512 px with a maskable one', icons.every((x) => / 200 image\//.test(x)) && man.m.icons.some((i) => i.purpose === 'maskable'), icons.join(', '));
    const touchIcon = await p.evaluate(async () => (await fetch(document.querySelector('link[rel=apple-touch-icon]').href)).status);
    check(tag, 'iOS gets a home-screen icon', touchIcon === 200);
    if (!(await p.evaluate(() => 'serviceWorker' in navigator))) { check(tag, 'service workers (skipped: none in this engine)', true); return; }
    // WebKit-only skip: the WebKit context blocks service workers (they would bypass the check's route stubs), so none registers.
    if (!useWebkit) {
      const scope = await p.evaluate(async () => (await navigator.serviceWorker.ready).scope);
      check(tag, 'the service worker runs over the whole page', scope === origin + '/', scope);
    }
    const ios = await p.evaluate(() => /iPhone/.test(navigator.userAgent));
    if (!ios) await p.evaluate(() => {
      const e = new Event('beforeinstallprompt');
      e.prompt = async () => { window.__prompted = true; };
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
    });
    const open = async () => {
      await p.locator('[data-nav="left"]').tap();
      await p.locator('#open-config').tap();
      await p.waitForSelector('.settings-view');
      await p.locator('.settings-nav .item:has-text("Notifications")').tap();
      await p.waitForSelector('#push-devices');
      await p.waitForTimeout(400);
    };
    await open();
    await shot('notifications');
    await layout('notifications');
    if (ios) {
      check(tag, 'iPhone in Safari: Add to Home Screen comes first', (await p.locator('#install-ios').innerText()).includes('Add to Home Screen') && !(await p.locator('#push-on').count()));
      // Now as the installed app.
      await p.evaluate(() => Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }));
      await p.locator('.settings-nav .item:has-text("Mail to you")').tap();
      await p.locator('.settings-nav .item:has-text("Notifications")').tap();
      await p.waitForSelector('#push-devices');
      check(tag, 'the installed app offers no install', !(await p.locator('#install-ios').count()));
    } else {
      check(tag, 'the install prompt shows as a button', await p.locator('#install-app').isVisible());
      await p.locator('#install-app').tap();
      await p.waitForTimeout(300);
      check(tag, 'tapping it opens the browser\'s install prompt', await p.evaluate(() => window.__prompted === true) && !(await p.locator('#install-app').count()));
    }
    // WebKit-only skip: Playwright's WebKit build has no Notification or PushManager (the app reports push unsupported), so the browser's half can't be stubbed.
    if (useWebkit && !(await p.evaluate(() => 'Notification' in window))) return;
    // The browser's half, stubbed: permission granted and a subscription with real keys.
    await p.evaluate(async (tag) => {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const p256dh = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
      const auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
      let sub = null;
      Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
      Notification.requestPermission = async () => 'granted';
      const pm = (await navigator.serviceWorker.ready).pushManager;
      const proto = Object.getPrototypeOf(pm);
      proto.getSubscription = async () => sub;
      proto.subscribe = async (o) => (sub = { endpoint: `http://127.0.0.1:9/push/${tag}`, options: o, toJSON: () => ({ endpoint: `http://127.0.0.1:9/push/${tag}`, keys: { p256dh, auth } }), unsubscribe: async () => { sub = null; return true; } });
    }, tag);
    const mine = async () => (await api('/api/push')).devices.find((d) => d.endpoint_hash === createHash('sha256').update(`http://127.0.0.1:9/push/${tag}`).digest('hex'));
    // The pane reads the permission when it renders, and the stub above grants it afterwards; reopen the pane so it shows the stub.
    await p.locator('.settings-nav .item:has-text("Mail to you")').tap();
    await p.locator('.settings-nav .item:has-text("Notifications")').tap();
    await p.waitForSelector('#push-devices');
    await p.locator('#push-on').tap();
    await p.waitForSelector(`.device-row:has-text("this device")`);
    const d = await mine();
    check(tag, 'Turn on registers this device', !!d && d.kinds.join() === 'mail,permission' && d.label.includes(ios ? 'iPhone' : 'Android'), d?.label);
    await shot('notifications-on');
    await layout('notifications on');
    await p.locator(`.device-row[data-device="${d.id}"] .seg button:has-text("Mail to you")`).tap();
    await p.waitForTimeout(600);
    check(tag, 'a device can stop taking mail', (await mine())?.kinds.join() === 'permission');
    await p.locator('.notify-card button:has-text("Send a test")').tap();
    await p.waitForSelector('.notify-card .notify-msg');
    check(tag, 'a failed test says why', (await p.locator('.notify-card .notify-msg').innerText()).includes('refused'));
    await p.locator('.notify-card button:has-text("Turn off")').tap();
    await p.waitForTimeout(600);
    check(tag, 'Turn off removes this device', !(await mine()) && await p.locator('#push-on').isVisible());
    // Without serve's proof of the human (only the token), the daemon refuses and Settings says where to go.
    if (testHuman) await ctx.unroute(`${origin}/api/push**`, asHuman);
    await p.locator('.settings-nav .item:has-text("Mail to you")').tap();
    await p.locator('.settings-nav .item:has-text("Notifications")').tap();
    await p.waitForSelector('#push-denied');
    check(tag, 'with only the token, Settings points to the HTTPS address', (await p.locator('#push-denied').innerText()).includes('HTTPS address') && !(await p.locator('#push-on').count()));
    await shot('notifications-denied');
    if (testHuman) await ctx.route(`${origin}/api/push**`, asHuman);
  });

  // Agent types: the list of types, one type's form, and back, by touch; the last run also
  // adds a type, removes it, and adds an agent by type from the + menu.
  await step('agent types', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#open-config').tap();
    await p.waitForSelector('.settings-view');
    await p.locator('.settings-nav .item:has-text("Agent types")').tap();
    await p.waitForSelector('.type-cards');
    check(tag, 'types: a card per type', await p.locator('.type-cards .choice').count() === Object.keys((await api('/api/registry')).types ?? {}).length);
    await shot('types');
    await layout('agent types');
    await p.locator('.type-cards [data-type=reviewer]').tap();
    await p.waitForSelector('.type-form');
    await shot('types-form');
    await layout('agent type form');
    const save = p.locator('.type-form button[type=submit]');
    await save.scrollIntoViewIfNeeded();
    check(tag, 'types: Save is reachable by scrolling', await inViewport(save));
    await p.locator('.type-form .type-back').tap();
    await p.waitForSelector('.type-cards');
    check(tag, 'types: Back returns to the list', await p.locator('.type-form').count() === 0);
    if (!sends) return;
    await p.locator('.settings-inner button:has-text("Add a type")').tap();
    await p.locator('.type-form input[name=name]').fill('phone-type');
    // The prompt bar suggests a recipient here (S-1474) and takes the bottom of the page: bring each button to the middle first.
    const centre = (sel) => p.locator(sel).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await centre('.type-form .seg button:has-text("Codex")');
    await p.locator('.type-form .seg button:has-text("Codex")').tap();
    await centre('.type-form button[type=submit]');
    await p.locator('.type-form button[type=submit]').tap();
    await p.waitForSelector('.type-cards [data-type=phone-type]');
    check(tag, 'types: a type added by touch is saved', (await api('/api/registry')).types['phone-type']?.harness === 'codex');
    await p.locator('.type-cards [data-type=phone-type]').tap();
    await p.locator('.type-form button:has-text("Remove")').tap();
    await p.waitForSelector('.type-cards');
    check(tag, 'types: Remove deletes it', !(await api('/api/registry')).types['phone-type']);
    const n = (await api('/api/agents')).length;
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#new-agent').tap();
    await p.waitForSelector('.menu');
    await shot('types-menu');
    await p.locator('.menu [role=menuitem]').filter({ hasText: /^coordinator/ }).first().tap();
    await p.waitForTimeout(2500);
    const all = await api('/api/agents');
    check(tag, 'types: a type in the + menu adds an agent of that type', all.length === n + 1 && all.some((a) => a.type === 'coordinator'));
  });

  // Fields and cards (S-370, S-1438 PR 5): the Table tab lists the built-in and custom columns in one list,
  // moved up and down by touch, and a field's edit form on the Fields tab is a full-width sheet. Three
  // fields are seeded once (one a choice with tones); the move is put back.
  await step('workcols', async () => {
    const have = (await api('/api/itsas/fields')).map((f) => f.key);
    const seed = [
      { key: 'stage', label: 'Stage', type: 'choice', card: 'chip', description: 'Where the work is: dev while building, review once a reviewer has it.', options: [
        { value: 'dev', label: 'Dev', tone: 'accent' }, { value: 'review', label: 'Review', tone: 'warn' }, { value: 'blocked', label: 'Blocked', tone: 'bad' }, { value: 'shipped', label: 'Shipped', tone: 'ok' }] },
      { key: 'due', label: 'Due', type: 'date', width: 's', align: 'end', description: 'The day it should be done by.' },
      { key: 'design', label: 'Design doc', type: 'link', hint: 'The design doc, if there is one' },
    ];
    for (const f of seed) if (!have.includes(f.key)) await api('/api/itsas/fields', 'POST', f);
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#open-config').tap();
    await p.waitForSelector('.settings-view');
    await p.locator('.settings-nav .item:has-text("Fields and cards")').tap();
    await p.waitForSelector('.wcol-tabs');
    check(tag, 'workcols: the tabs are a segmented row, Fields first, the same tabs as the desktop', await p.locator('.wcol-tabs [role=tab]').evaluateAll((els) => els.map((e) => e.textContent).join(' ')) === 'Fields Table Issue card Agent card');
    await p.locator('.wcol-tabs [role=tab]:has-text("Table")').tap();
    await p.waitForSelector('.wcol-card');
    const ids = () => p.locator('.wcol-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-col')));
    const before = await ids();
    check(tag, 'workcols: built-in and custom columns in one list, work first', before[0] === 'work' && before.filter((x) => x.startsWith('field:')).length >= 3, before.join(' '));
    check(tag, 'workcols: the choice column shows its tones', await p.locator('.wcol-row .wcol-opts .badge.warn').count() >= 1);
    await shot('workcols');
    await layout('workcols');
    const due = before.find((x, i) => x.startsWith('field:') && i > 0 && before[i - 1].startsWith('field:'));
    const label = await p.locator(`.wcol-row[data-col="${due}"] .wcol-head b`).innerText();
    await p.locator(`[aria-label="Move ${label} up"]`).tap();
    await p.waitForFunction((d) => { const r = [...document.querySelectorAll('.wcol-row')].map((e) => e.getAttribute('data-col')); const i = r.indexOf(d); return i > 0 && r[i + 1] && r[i + 1].startsWith('field:'); }, due);
    check(tag, 'workcols: a tap on up moves the column up', true);
    await p.locator(`[aria-label="Move ${label} down"]`).tap();
    await p.waitForFunction((b) => [...document.querySelectorAll('.wcol-row')].map((e) => e.getAttribute('data-col')).join(' ') === b, before.join(' '));
    await p.locator('.wcol-tabs [role=tab]:has-text("Fields")').tap();
    await p.locator('.fld-row[aria-label="Edit Stage"]').tap();
    await p.waitForSelector('.wcol-form');
    check(tag, 'workcols: the edit form lists the options with tone swatches', await p.locator('.wcol-opt').count() === 4 && await p.locator('.wcol-tone.on').count() === 4);
    check(tag, 'workcols: the form has the kinds picker and the phone card control', await p.locator('.wcol-kinds input[type=checkbox]').count() >= 1 && await p.locator('.wcol-form .set-label b', { hasText: 'On the phone' }).count() === 1);
    await shot('workcols-edit');
    await layout('workcols-edit');
    await p.locator('.wcol-form .type-back').tap();
    await p.waitForSelector('.fld-list');
  });

  // The board on a phone (S-38): one column at a time with a strip of chips and counts; a tap
  // or a sideways swipe changes column; a long press opens the move sheet, and choosing a column
  // moves the card; a tap opens the ITSA. The card is put back to its status afterwards.
  await step('board', async () => {
    const all = await api('/api/itsas');
    const root = all.find((x) => x.title === 'Check: issue system');
    const card = all.find((x) => x.title === 'Board on the phone');
    await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:itsa:' + root.id);
    await p.locator('.itsa-view:visible [data-open-board]').tap();
    const bv = p.locator(`.board-view[data-board="${root.id}"]`);
    await bv.locator('.board-strip').waitFor();
    const chips = bv.locator('.board-strip button');
    check(tag, 'board: the strip has a chip per column, with its count', await chips.count() >= 2 && /\d/.test(await chips.first().innerText()), await chips.count());
    check(tag, 'board: one column shows at a time', await bv.locator('.bcol').count() === 1);
    const cw = p.viewportSize().width;
    const cardBox = await bv.locator('.bcard').first().boundingBox();
    check(tag, 'board: cards are full width', cardBox && cardBox.width > cw * 0.8, cardBox?.width);
    const chipBoxes = await chips.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    check(tag, 'board: column chips are touch targets at least 44 px', chipBoxes.every((h) => h >= 44), chipBoxes.join(' '));
    check(tag, 'board: no sideways page scroll', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    // Toasts from earlier actions cover the tab bar; wait for them to go before the shot.
    await p.locator('.toast').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    await shot('board-phone');
    await bv.locator('[data-col-chip="ready"]').tap();
    await p.waitForTimeout(300);
    check(tag, 'board: a chip tap shows that column', await bv.locator('.bcol').getAttribute('data-col') === 'ready');
    const bx = await bv.locator('.board-cols').boundingBox();
    await drag(bx.x + bx.width * 0.8, bx.y + 120, bx.x + bx.width * 0.2, bx.y + 120);
    await p.waitForTimeout(300);
    check(tag, 'board: a swipe left shows the next column', await bv.locator('.bcol').getAttribute('data-col') === 'active', await bv.locator('.bcol').getAttribute('data-col'));
    await drag(bx.x + bx.width * 0.2, bx.y + 120, bx.x + bx.width * 0.8, bx.y + 120);
    await p.waitForTimeout(300);
    check(tag, 'board: a swipe right shows the column before', await bv.locator('.bcol').getAttribute('data-col') === 'ready');
    await bv.locator('[data-col-chip="backlog"]').tap();
    await p.waitForTimeout(300);
    const at = await bv.locator(`.bcard[data-card="${card.id}"]`).boundingBox();
    await p.evaluate(() => { window.__ctx = []; addEventListener('contextmenu', (e) => setTimeout(() => window.__ctx.push(e.defaultPrevented), 0), true); });
    await longPress(at.x + at.width / 2, at.y + at.height / 2);
    await p.waitForTimeout(300);
    check(tag, 'board: a long press opens the move sheet', await p.locator('.menu [role^=menuitem]').first().isVisible());
    check(tag, 'board: the sheet is at the bottom of the screen', await p.locator('.menu').evaluate((m) => m.getBoundingClientRect().bottom >= window.innerHeight - 2));
    await shot('board-sheet');
    check(tag, 'board: a long press shows no native menu', (await p.evaluate(() => (window.__ctx ?? []).every(Boolean))));
    await p.locator('.menu [role^=menuitem]', { hasText: 'Ready' }).tap();
    await p.waitForTimeout(800);
    check(tag, 'board: choosing a column in the sheet moves the card', (await api('/api/itsas/' + card.id)).status !== 'backlog');
    await bv.locator('[data-col-chip="ready"]').tap();
    await p.waitForTimeout(300);
    await bv.locator(`.bcard[data-card="${card.id}"]`).tap();
    await p.waitForTimeout(400);
    check(tag, 'board: a tap on a card opens its ITSA', await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:itsa:' + card.id);
    await api('/api/itsas/' + card.id, 'PATCH', { status: card.status });
  });

  // The Work page on the phone is a glance (S-301): Needs you, then Moving, then Ready to try,
  // with none of the table's controls; the Issues page browses the rest. It shows and doesn't
  // act (S-363): no action buttons, and links under a card with their kind's icon.
  await step('work', async () => {
    await p.locator('[data-nav="issues"]').tap();
    await p.locator('#issues-work').tap();
    const wv = p.locator('.work-view:visible');
    await wv.locator('.w-glance').waitFor();
    check(tag, 'work: the Issues tab opens the Work page', await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:work');
    check(tag, 'work: a glance, with no table, column header, or table controls', await wv.locator('.w-head, .w-row, .work-bar').count() === 0);
    const secs = await wv.locator('.wg-sec').evaluateAll((els) => els.map((e) => e.dataset.sec));
    check(tag, 'work: Needs you, then Moving, then Ready to try', JSON.stringify(secs) === '["needs","moving","try"]', JSON.stringify(secs));
    const all = await api('/api/itsas');
    const by = (t) => all.find((x) => x.title === t);
    const webUi = all.find((x) => /^Web UI/.test(x.title));
    // Backlog, ready, and closed work is the Issues page's, not the glance's.
    const quiet = ['Board on the phone', 'Board on the desktop', 'Jira import', 'Storage, API, and CLI'].map(by).filter(Boolean);
    check(tag, 'work: backlog, ready, and closed work is left out', quiet.length === 4 && (await Promise.all(quiet.map((x) => wv.locator(`[data-itsa="${x.id}"]`).count()))).every((n) => n === 0));
    const blocked = by('GitHub PR sync');
    check(tag, 'work: a blocked issue shows under Moving', await wv.locator(`[data-sec="moving"] [data-itsa="${blocked.id}"]`).count() === 1);
    // The Needs-you rows: the first few, the rest one tap away, every waiting ITSA in the end.
    const needs = wv.locator('[data-sec="needs"]');
    const total = Number(await needs.locator('.wg-head .count').innerText());
    // Earlier steps answer some of the seeded asks, so there may be three or fewer by now.
    check(tag, 'work: Needs you shows the first three, and Show more when there are more', await needs.locator('.wg-need').count() === Math.min(3, total)
      && await needs.locator('.wg-more').count() === (total > 3 ? 1 : 0), total);
    await shot('work-phone');
    if (total > 3) await needs.locator('.wg-more').tap();
    const att = await api('/api/itsas/attention');
    check(tag, 'work: Show more lists every waiting ITSA', await needs.locator('.wg-need').count() === total && await needs.locator('[data-kind="itsa"]').count() === att.length, att.length);
    check(tag, 'work: needs rows carry no action buttons (S-363)', await needs.locator('button, .btn').evaluateAll((els) => els.filter((e) => !e.matches('.wg-more')).length) === 0);
    const needHit = await needs.locator('.wg-need').first().boundingBox();
    check(tag, 'work: a needs row is a 44 px target that opens it', !!needHit && needHit.height >= 43.5, JSON.stringify(needHit));
    await shot('work-needs');
    // Ready to try: the staged ITSA, its links under it in the table's column order, each with
    // its kind's icon, each a 44 px target; a branch is only named.
    const card = wv.locator(`[data-sec="try"] .wg-card[data-itsa="${webUi.id}"]`);
    // The card is the board's issue card (S-3560): a kind's links are icon anchors in its `data-cell` span, each a 44 px target.
    const links = await card.locator('.bc-links .bc-link').evaluateAll((els) => els.map((e) => ({ kind: e.closest('[data-cell]').dataset.cell, tag: e.tagName, href: e.getAttribute('href'), name: e.getAttribute('aria-label'), icon: !!e.querySelector('svg'), h: e.getBoundingClientRect().height })));
    check(tag, 'work: a card lists its links by kind, each with its icon and a name', JSON.stringify(links.map((l) => [l.kind, l.name, l.icon])) === JSON.stringify([['branch', 'stam/dash-data', true], ['github', 'PR #15', true], ['test', 'staging', true]]), JSON.stringify(links));
    check(tag, 'work: the test link opens where to test it; a branch is not a link', links.find((l) => l.kind === 'test')?.href === 'https://staging.example.com/web' && links.find((l) => l.kind === 'branch')?.tag === 'SPAN' && links.find((l) => l.kind === 'branch')?.href === null);
    check(tag, 'work: each link is at least 44 px tall', links.length > 0 && links.every((l) => l.h >= 43.5), links.map((l) => Math.round(l.h)).join(','));
    check(tag, 'work: cards carry no action buttons (S-363)', await wv.locator('.wg-card button:not(.w-agent), .wg-card .btn').count() === 0);
    const cw = p.viewportSize().width;
    const box = await card.boundingBox();
    check(tag, 'work: cards fit the screen', box && box.x >= 0 && box.x + box.width <= cw + 1, box && `${box.x}+${box.width}`);
    check(tag, 'work: a card shows a warning health', await card.locator('[data-cell=health]').count() === 1);
    await layout('work');
    // The Work composer clears the bottom bar: scrolled to the end, the last control stays above
    // the composer, and the composer above the tab bar.
    const composer = p.locator('#w-bottom');
    const cbox = await composer.boundingBox();
    const nav = await p.locator('#mobile-nav').boundingBox();
    check(tag, 'work: the composer shows on the Work page, above the bottom bar', !!cbox && !!nav && cbox.y + cbox.height <= nav.y + 1, JSON.stringify({ cbox, nav }));
    const browse = wv.locator('.wg-browse');
    const scrolled = await browse.evaluate((el) => {
      let s = el.parentElement
      while (s && !(getComputedStyle(s).overflowY === 'auto' && s.scrollHeight > s.clientHeight)) s = s.parentElement
      if (!s) return { found: false }
      s.scrollTop = s.scrollHeight
      return { found: true, top: s.scrollTop, max: s.scrollHeight - s.clientHeight, cls: s.className }
    })
    await p.waitForTimeout(300)
    const lastBox = await browse.boundingBox();
    check(tag, 'work: the last control scrolls clear of the composer', !!cbox && !!lastBox && scrolled.found && lastBox.y + lastBox.height <= cbox.y + 1, JSON.stringify({ lastBox, cbox, scrolled }));
    await shot('work-composer-phone');
    await card.locator('.bc-title').tap();
    await p.waitForTimeout(400);
    check(tag, 'work: a tap on a card opens its ITSA', await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:itsa:' + webUi.id);
    await p.locator('[data-nav="work"]').tap();
    await wv.locator('.wg-browse').tap();
    check(tag, 'work: Browse every issue opens the Issues list', await p.evaluate(() => window.stamDebug.shell.phoneShows()) === 'issues');
  });

  // The glance's Filter button (S-1514): a full-height sheet whose rows are 44 px targets; a status
  // filter turns the sections into one list of the matches with "N of M", and Clear brings them back.
  await step('work filter', async () => {
    const wv = p.locator('.work-view:visible');
    await p.locator('[data-nav="work"]').tap();
    await wv.locator('.w-glance').waitFor();
    const btn = wv.locator('.wg-filter');
    const bb = await btn.boundingBox();
    check(tag, 'work filter: the Filter button is a 44 px target', !!bb && bb.height >= 44 - 0.5, JSON.stringify(bb));
    await btn.tap();
    const sheet = p.locator('[data-fsheet]');
    await sheet.waitFor();
    const vp = p.viewportSize();
    const sb = await sheet.boundingBox();
    check(tag, 'work filter: the sheet fills the screen', !!sb && !!vp && sb.width >= vp.width - 1 && sb.height >= vp.height - 1, JSON.stringify({ sb, vp }));
    const small = await sheet.locator('.fs-row, .fs-foot .btn, .fs-close').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 43.5).length);
    check(tag, 'work filter: every row and pinned button is at least 44 px', small === 0, String(small));
    const foot = await sheet.locator('.fs-foot').boundingBox();
    check(tag, 'work filter: Clear all and Show stay pinned at the bottom', !!foot && !!vp && foot.y + foot.height >= vp.height - 1, JSON.stringify(foot));
    await sheet.locator('.fs-col[data-col="status"] .fs-row').tap();
    const opts = sheet.locator('.fs-edit [role="checkbox"]');
    const n = await opts.count();
    check(tag, 'work filter: a column row opens its filter editor', n > 1, String(n));
    await opts.first().tap();
    const show = await sheet.locator('[data-fs="show"]').innerText();
    const shown = Number(show.replace(/\D/g, ''));
    await sheet.locator('[data-fs="show"]').tap();
    await sheet.waitFor({ state: 'detached' });
    const list = wv.locator('[data-sec="matches"]');
    await list.waitFor();
    const text = (await list.locator('[data-matches]').innerText()).trim();
    const m = /^(\d+) of (\d+)$/.exec(text);
    check(tag, 'work filter: the sections give way to one list with "N of M"', !!m && Number(m[1]) === shown && Number(m[2]) >= shown && await list.locator('.wg-card').count() === shown && await wv.locator('[data-sec="moving"]').count() === 0, `${text} / ${show}`);
    check(tag, 'work filter: Needs you stays on top', await wv.locator('[data-sec="needs"]').count() === 1);
    check(tag, 'work filter: the button counts the filter', (await btn.getAttribute('data-active')) === '1');
    await shot('work-filter-phone');
    // A back press closes the sheet and stays on Work (it is a history place, like the add panel).
    await btn.tap();
    await sheet.waitFor();
    await p.goBack();
    await sheet.waitFor({ state: 'detached' });
    check(tag, 'work filter: a back press closes the sheet and stays on Work', await wv.locator('[data-sec="matches"]').count() === 1 && await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:work');
    await list.locator('.wg-clear').tap();
    await wv.locator('[data-sec="moving"]').waitFor();
    check(tag, 'work filter: Clear brings the sections back', await wv.locator('[data-sec="matches"]').count() === 0 && (await btn.getAttribute('data-active')) === '0');
  });

  // A column grouping set from the sheet's Group by (S-1781): the Glance names it in a chip that clears it.
  await step('work group chip', async () => {
    const wv = p.locator('.work-view:visible');
    await p.locator('[data-nav="work"]').tap();
    await wv.locator('.w-glance').waitFor();
    await wv.locator('.wg-filter').tap();
    const sheet = p.locator('[data-fsheet]');
    await sheet.waitFor();
    const sel = sheet.locator('select[aria-label="Group by column"]');
    const sb = await sel.boundingBox();
    check(tag, 'work group chip: the sheet\'s Group by is a 44 px control', !!sb && sb.height >= 44 - 0.5, JSON.stringify(sb));
    await sel.selectOption('status');
    await sheet.locator('[data-fs="show"]').tap();
    await sheet.waitFor({ state: 'detached' });
    const chip = wv.locator('[data-group-chip]');
    await chip.waitFor();
    const cb = await chip.boundingBox();
    check(tag, 'work group chip: the chip names the column and is a 44 px target', (await chip.innerText()).trim() === 'Grouped by Status' && !!cb && cb.height >= 44 - 0.5, JSON.stringify(cb));
    check(tag, 'work group chip: the groups replace Moving', await wv.locator('[data-sec="moving"]').count() === 0);
    await shot('work-group-chip-phone');
    await chip.tap();
    await wv.locator('[data-sec="moving"]').waitFor();
    check(tag, 'work group chip: the chip brings Moving back', await chip.count() === 0);
  });

  // The quick filter chips (S-1515): a row that scrolls sideways of 44 px toggles; a tap on one turns the
  // sections into one list with "N of M" and counts in the Filter button, and a second tap brings them back.
  await step('work quick', async () => {
    const wv = p.locator('.work-view:visible');
    await p.locator('[data-nav="work"]').tap();
    await wv.locator('.w-glance').waitFor();
    const row = wv.locator('.wg-quick');
    const chips = row.locator('.w-qchip');
    check(tag, 'work quick: six chips', await chips.count() === 6, String(await chips.count()));
    const small = await chips.evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 43.5).length);
    check(tag, 'work quick: every chip is at least 44 px tall', small === 0, String(small));
    const sc = await row.evaluate((e) => ({ scrolls: e.scrollWidth > e.clientWidth, overflowX: getComputedStyle(e).overflowX, page: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
    check(tag, 'work quick: the row scrolls sideways and the page does not', sc.scrolls && sc.overflowX === 'auto' && !sc.page, JSON.stringify(sc));
    const chip = row.locator('[data-quick="review"]');
    await chip.scrollIntoViewIfNeeded();
    await chip.tap();
    const list = wv.locator('[data-sec="matches"]');
    await list.waitFor();
    const text = (await list.locator('[data-matches]').innerText()).trim();
    const m = /^(\d+) of (\d+)$/.exec(text);
    check(tag, 'work quick: a tap turns the sections into the list with "N of M"', !!m && Number(m[1]) <= Number(m[2]) && await list.locator('.wg-card').count() === Number(m[1]) && await wv.locator('[data-sec="moving"]').count() === 0, text);
    check(tag, 'work quick: the chip is pressed and the Filter button counts it', (await chip.getAttribute('aria-pressed')) === 'true' && (await wv.locator('.wg-filter').getAttribute('data-active')) === '1');
    await shot('work-quick-phone');
    await chip.tap();
    await wv.locator('[data-sec="moving"]').waitFor();
    check(tag, 'work quick: a second tap brings the sections back', await wv.locator('[data-sec="matches"]').count() === 0 && (await chip.getAttribute('aria-pressed')) === 'false' && (await wv.locator('.wg-filter').getAttribute('data-active')) === '0');
  });

  // The saved view picker (S-1517): the glance header's first control, 44 px, with a dot when the view is edited
  // after it was saved. It opens the View menu as a sheet; Escape closes it and focus returns to the button.
  // A view is saved, left and come back to, then deleted.
  await step('work views', async () => {
    const wv = p.locator('.work-view:visible');
    await p.locator('[data-nav="work"]').tap();
    await wv.locator('.w-glance').waitFor();
    const pick = wv.locator('[data-view-picker]');
    const menu = p.locator('.menu[role="menu"]');
    const chip = wv.locator('.wg-quick [data-quick="mine"]');
    check(tag, 'work views: the picker reads "View: Default" and is at least 44 px tall', (await pick.innerText()).trim() === 'View: Default' && (await pick.evaluate((e) => e.getBoundingClientRect().height)) >= 43.5, (await pick.innerText()).trim());
    check(tag, 'work views: no sideways page scroll with the picker', await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await chip.scrollIntoViewIfNeeded();
    await chip.tap();
    await pick.locator('[data-dirty]').waitFor();
    check(tag, 'work views: an edit marks the picker with the dot', await pick.locator('[data-dirty]').count() === 1);
    await pick.tap();
    await menu.waitFor();
    const small = await menu.locator('button:not(:disabled)').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 43.5).length);
    check(tag, 'work views: the menu rows are at least 44 px tall', small === 0, String(small));
    await shot('work-views-phone');
    await p.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    check(tag, 'work views: Escape closes the menu and focus returns to the picker', await pick.evaluate((e) => e === document.activeElement));
    await pick.tap();
    await menu.getByRole('menuitem', { name: 'Save as…' }).tap();
    const form = p.locator('.w-save');
    await form.waitFor();
    await form.locator('input').fill('Phone view');
    await form.locator('button[type="submit"]').tap();
    await form.waitFor({ state: 'detached' });
    await p.waitForFunction(() => document.querySelector('[data-view-picker]')?.textContent?.trim() === 'View: Phone view');
    check(tag, 'work views: Save as makes the new view current, with no dot', await pick.locator('[data-dirty]').count() === 0 && (await chip.getAttribute('aria-pressed')) === 'true');
    await pick.tap();
    await menu.getByRole('menuitemradio', { name: 'Default' }).tap();
    await p.waitForFunction(() => document.querySelector('[data-view-picker]')?.textContent?.trim() === 'View: Default');
    check(tag, 'work views: switching to Default brings its layout (no quick filter)', (await chip.getAttribute('aria-pressed')) === 'false' && await pick.locator('[data-dirty]').count() === 0);
    await pick.tap();
    await menu.getByRole('menuitemradio', { name: 'Phone view' }).tap();
    await p.waitForFunction(() => document.querySelector('[data-view-picker]')?.textContent?.trim() === 'View: Phone view');
    check(tag, 'work views: switching back brings the saved quick filter', (await chip.getAttribute('aria-pressed')) === 'true' && await pick.locator('[data-dirty]').count() === 0);
    await pick.tap();
    await menu.getByRole('menuitem', { name: 'Delete' }).tap();
    await p.waitForFunction(() => document.querySelector('[data-view-picker]')?.textContent?.trim() === 'View: Default');
    check(tag, 'work views: Delete leaves Default', (await chip.getAttribute('aria-pressed')) === 'false');
  });

  // The stories page (S-647): drawn from fixtures alone, it fits the phone with no sideways
  // scroll, asks the daemon nothing, and its drawer opens another story.
  await step('stories', async () => {
    // Leave the app first, so its polls still in flight aren't counted; then count only requests
    // the stories page and its frames make.
    // A sentinel in the app's real storage: the stories page runs on in-memory storage and mustn't see it.
    await p.evaluate(() => { localStorage.setItem('stam/story-sentinel', '1'); sessionStorage.setItem('stam/story-sentinel', '1'); });
    // The app's own UI and layout state, which the Tree, Main world and App frame stories also seed: they must leave it as it is.
    const APP_KEYS = ['stam/ui', 'stam/layout', 'stam/shell-local', 'stam/shell3'];
    const appState = () => p.evaluate((ks) => ks.map((k) => localStorage.getItem(k)), APP_KEYS);
    // The state once the app's layout writes have landed: the same for half a second (at most 5 s).
    // A daemon under load (SEED_ACTIVITY) answers the earlier steps' layout ops late, and a late
    // answer would otherwise read as a change the stories made.
    const settled = async () => {
      let last = JSON.stringify(await appState());
      for (let i = 0; i < 10; i++) {
        await p.waitForTimeout(500);
        const now = JSON.stringify(await appState());
        if (now === last) break;
        last = now;
      }
      return JSON.parse(last);
    };
    const before = await settled();
    await p.goto('about:blank');
    const apis = [];
    const fromStories = (r) => { try { return new URL(r.frame().url()).pathname.startsWith('/stories'); } catch { return false; } };
    const onReq = (r) => { if (new URL(r.url()).pathname.startsWith('/api') && fromStories(r)) apis.push(r.url()); };
    p.on('request', onReq);
    try {
      // A resting agent's badge (S-2110): a 96 px tab gives the name its room (the badge folds to its mark), and a long wait wraps
      // inside the full badge in the details page and the system view's sheet instead of painting outside it.
      await p.goto(origin + '/stories?frame=wait-mark&state=10&theme=light');
      await p.waitForSelector('.tab .rest-badge');
      await p.waitForTimeout(400);
      const tabFit = await p.evaluate(() => {
        const tab = document.querySelector('.tab').getBoundingClientRect(), b = document.querySelector('.tab .rest-badge'), r = b.getBoundingClientRect();
        const min = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size-tab-name-min')) || 0;
        return { mode: b.dataset.mode, inside: r.left >= tab.left - 0.5 && r.right <= tab.right + 0.5, label: document.querySelector('.tab .label').clientWidth, min };
      });
      check(tag, 'stories: a resting agent in a 96 px tab folds to its mark and keeps the name its room', tabFit.mode === 'icon' && tabFit.inside && tabFit.label >= tabFit.min - 0.5, JSON.stringify(tabFit));
      const wrapped = () => document.querySelectorAll('.rest-badge.full').length > 0 && [...document.querySelectorAll('.rest-badge.full')].every((b) => {
        const r = b.getBoundingClientRect(), t = b.querySelector('span').getBoundingClientRect();
        return r.height > 20 && t.top >= r.top - 0.5 && t.bottom <= r.bottom + 0.5 && t.right <= r.right + 0.5 && r.right <= innerWidth && b.scrollWidth <= b.clientWidth + 1;
      });
      await p.goto(origin + '/stories?frame=agent-details&state=10&theme=light');
      await p.waitForSelector('.rest-badge.full');
      check(tag, 'stories: a long wait wraps inside the resting badge in the details page', await p.evaluate(wrapped));
      await p.goto(origin + '/stories?frame=system-view&state=14&theme=light');
      await p.waitForSelector('.sv-state ~ .rest-badge.full, .sv-facts .rest-badge.full', { state: 'attached', timeout: 15000 });
      check(tag, 'stories: a long wait wraps inside the resting badge in the system view\'s sheet', await p.evaluate(wrapped));
      await p.goto(origin + '/stories');
      await p.waitForSelector('.sb-doc h1');
      await p.waitForSelector('.sb-frame iframe');
      await p.waitForTimeout(800);
      // The prompt input's states send into the outbox; none of it may reach the app's.
      await p.goto(origin + '/stories#story=prompt-input');
      await p.waitForSelector('.sb-frame iframe');
      await p.waitForTimeout(1500);
      for (const id of ['agent-tree', 'main-world', 'app-frame']) {
        await p.goto(origin + '/stories#story=' + id);
        await p.waitForSelector('.sb-frame iframe');
        await p.waitForTimeout(1500);
      }
      // The mail card story's state 4 holds a 300-character unbroken option (S-1312): it wraps inside the card.
      await p.goto(origin + '/stories?frame=mail-card&state=4&theme=light');
      await p.waitForSelector('.mc-struct .mc-opts li');
      check(tag, 'stories: a long unbroken option wraps inside its card', await p.evaluate(() => {
        const t = document.querySelector('.mc-struct'), li = t.querySelector('.mc-opts li');
        return t.scrollWidth <= t.clientWidth && li.scrollWidth <= li.clientWidth;
      }));
      // The inline diff's rows wrap (S-2099): a long line takes several visual lines, nothing scrolls sideways, and a selection copies back the patch lines.
      // The same rows at a desktop width too, where a long line wraps once it passes the column.
      const phoneSize = p.viewportSize();
      for (const [width, state, name, long] of [[null, 1, 'deep indent', 'node.children.length'], [null, 2, 'long identifier', 'aVeryLongGeneratedIdentifier'], [1280, 2, 'long identifier at 1280 px', 'aVeryLongGeneratedIdentifier']]) {
        await p.setViewportSize(width ? { width, height: 900 } : phoneSize);
        await p.goto(origin + `/stories?frame=diff&state=${state}&theme=light`);
        await p.waitForSelector('.mb-diff .l.add');
        const r = await p.evaluate((needle) => {
          const d = document.querySelector('.mb-diff');
          const row = [...d.querySelectorAll('.l.add')].find((l) => l.textContent.includes(needle));
          const lh = parseFloat(getComputedStyle(row).lineHeight);
          const sel = getSelection(), range = document.createRange();
          range.selectNodeContents(d.querySelector('pre code'));
          sel.removeAllRanges(); sel.addRange(range);
          const copied = sel.toString().replace(/\n$/, '');
          const patch = [...d.querySelectorAll('pre code .l')].map((l) => l.textContent).join('\n');
          return { lines: row.getBoundingClientRect().height / lh, over: [d, ...d.querySelectorAll('pre')].some((e) => e.scrollWidth > e.clientWidth), copied, patch };
        }, long);
        check(tag, `stories: a ${name} diff row wraps onto several lines`, r.lines > 1.5, String(r.lines));
        check(tag, `stories: a ${name} diff block has no sideways overflow`, !r.over);
        check(tag, `stories: a selection of the ${name} diff copies back the patch lines`, r.copied === r.patch, JSON.stringify(r.copied).slice(0, 200));
      }
      // The bounded block (S-2100): one scroller capped at the phone's 18 lines and half the screen, the first file open, a summary that sticks.
      await p.goto(origin + '/stories?frame=diff&state=7&theme=light');
      await p.waitForSelector('.mb-dscroll');
      const huge = await p.evaluate(() => {
        const s = document.querySelector('.mb-dscroll'), f = s.querySelector('details.mb-file'), sum = f.querySelector('summary');
        s.scrollTop = 200;
        const top = sum.getBoundingClientRect().top - s.getBoundingClientRect().top;
        return { cap: s.clientHeight <= innerHeight / 2 + 1, scrolls: s.scrollHeight > s.clientHeight, pos: getComputedStyle(sum).position, top, scrollers: document.querySelectorAll('.mb-dscroll').length, label: s.getAttribute('aria-label') };
      });
      check(tag, 'stories: a huge diff is one scroller within half the screen', huge.cap && huge.scrolls && huge.scrollers === 1, JSON.stringify(huge));
      check(tag, 'stories: a file summary sticks at the top of the diff scroller', huge.pos === 'sticky' && Math.abs(huge.top) <= 1, JSON.stringify(huge));
      // A file summary paints the surface its block sits on: the ITSA comment story's pane, not the page.
      for (const theme of ['light', 'dark']) {
        await p.goto(origin + `/stories?frame=diff&state=9&theme=${theme}`);
        await p.waitForSelector('.mb-dscroll summary');
        const bg = await p.evaluate(() => ({ sum: getComputedStyle(document.querySelector('.mb-dscroll summary')).backgroundColor, pane: getComputedStyle(document.querySelector('.comment-fixture')).backgroundColor }));
        check(tag, `stories: a diff file summary in an ITSA comment matches its surface (${theme})`, bg.sum === bg.pane, JSON.stringify(bg));
      }
      await p.goto(origin + '/stories?frame=diff&state=6&theme=light');
      await p.waitForSelector('.mb-dscroll');
      const many = await p.evaluate(() => ({ open: [...document.querySelectorAll('.mb-dscroll details.mb-file')].map((d) => d.open), head: document.querySelector('.mb-dsum').textContent }));
      check(tag, 'stories: a long many-file diff opens only its first file', many.open[0] && many.open.slice(1).every((o) => !o) && /^9 files/.test(many.head), JSON.stringify(many));
      await p.setViewportSize(phoneSize);
      await p.goto(origin + '/stories');
      await p.waitForSelector('.sb-doc h1');
      await p.waitForSelector('.sb-frame iframe');
      await p.waitForTimeout(800);
      check(tag, 'stories: the page runs on in-memory storage, not the app\'s', await p.evaluate(() => localStorage.getItem('stam/story-sentinel') === null && sessionStorage.getItem('stam/story-sentinel') === null && typeof indexedDB === 'undefined'));
      check(tag, 'stories: no horizontal page scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await layout('stories');
      await shot('stories');
      await p.locator('.sb-menu').tap();
      await p.waitForTimeout(400);
      const item = p.locator('.sb-nav .sb-item', { hasText: 'Context menu' });
      check(tag, 'stories: the menu button opens the drawer of stories', await item.isVisible());
      await item.tap();
      await p.waitForTimeout(400);
      check(tag, 'stories: a story in the drawer opens it', (await p.locator('.sb-doc h1').innerText()) === 'Context menu' && !(await item.isVisible()));
      check(tag, 'stories: the page makes no /api request', !apis.length, apis.join(', '));
    } finally {
      p.off('request', onReq);
    }
    // Back to the app, on whatever view the daemon's layout last showed (Issues, after Work).
    await p.goto(origin + '/#token=' + token);
    await p.waitForSelector('#mobile-nav');
    // The app's own storage is as the stories found it: the sentinel stays, and no story row reached the outbox.
    const real = await p.evaluate(async () => {
      const keep = localStorage.getItem('stam/story-sentinel') === '1' && sessionStorage.getItem('stam/story-sentinel') === '1';
      localStorage.removeItem('stam/story-sentinel'); sessionStorage.removeItem('stam/story-sentinel');
      const rows = await new Promise((ok) => { const q = indexedDB.open('stam-outbox'); q.onerror = () => ok([]); q.onsuccess = () => { const db = q.result; if (!db.objectStoreNames.contains('rows')) return ok([]); const r = db.transaction('rows').objectStore('rows').getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ok([]); }; });
      return { keep, stories: rows.filter((r) => String(r.key).startsWith('story:')).length };
    });
    check(tag, 'stories: the app\'s storage is untouched', real.keep && real.stories === 0, JSON.stringify(real));
    const after = await settled();
    check(tag, 'stories: the Tree, Main world and App frame stories leave stam/ui and the layout as they were', APP_KEYS.every((_, i) => after[i] === before[i]), APP_KEYS.filter((_, i) => after[i] !== before[i]).map((k) => `${k}: ${before[APP_KEYS.indexOf(k)]?.slice(0, 400)} => ${after[APP_KEYS.indexOf(k)]?.slice(0, 400)}`).join(', '));
  });

  // Rapid-fire mode (S-1004): the conversation as mail cards. A send starts a new thread; a tapped
  // card is picked, and sends follow up in its thread until its ✕ unpicks it. Only the sending run mails.
  await step('rapid-fire', async () => {
    await p.locator('[data-nav="left"]').tap();
    await p.locator(`#tree .node:has(.name:text-is("helper"))`).first().locator('.name').tap();
    await p.waitForTimeout(1500);
    const toConv = p.locator('#w-main .pane.focused .view-switch[data-to="conversation"]');
    if (await toConv.isVisible()) { await toConv.tap(); await p.waitForTimeout(800); }
    const toggle = p.locator('#w-main .pane.focused .rapid-switch');
    await toggle.tap();
    // The cards come from the agent's own pages (S-4580): count them once those have loaded.
    await p.waitForSelector('.rf[data-loaded]:visible', { timeout: 10000 });
    check(tag, 'rapid-fire: the ⚡ toggle shows the conversation as cards', await toggle.getAttribute('aria-pressed') === 'true');
    const target = p.locator('#w-bottom .rf-target');
    check(tag, 'rapid-fire: the prompt input starts a new thread', await target.getAttribute('data-rf') === 'new', await target.innerText());
    const cards = p.locator('.rf:visible .rf-list > li');
    const box = p.locator('#w-bottom .composer textarea');
    const send = async (text) => { await box.tap(); await box.fill(text); await p.locator('#w-bottom .cmp-send').tap(); await box.evaluate((el) => el.blur()); };
    const grows = async (n) => { await p.waitForFunction((n) => document.querySelectorAll('.rf .rf-list > li').length > n, n, { timeout: 10000 }); };
    let n = await cards.count();
    if (sends) {
      await send('Rapid idea: cache the model list');
      await grows(n);
      n = await cards.count();
      check(tag, 'rapid-fire: a send adds a card at the bottom', /cache the model list/.test(await cards.last().innerText()));
    }
    await shot('rapid');
    await layout('rapid-fire');
    if (!n) throw new Error('no card to pick');
    const last = cards.last().locator('.mail-card');
    const tid = await last.getAttribute('data-card');
    await last.tap();
    check(tag, 'rapid-fire: a tap picks the card', await last.getAttribute('aria-pressed') === 'true');
    check(tag, 'rapid-fire: the prompt input says it follows up in that thread, in its words', await target.getAttribute('data-rf') === 'reply' && /cache the model list/.test(await target.innerText()), await target.innerText());
    check(tag, 'rapid-fire: the picked card is fully in sight', await inViewport(last));
    check(tag, 'rapid-fire: the picked card offers Open', await cards.last().locator('[data-open-thread]').isVisible());
    await shot('rapid-picked');
    await layout('rapid-fire, a card picked');
    if (sends) {
      const before = (await api(`/api/threads/${tid}`)).length;
      await send('And on the phone too');
      await p.waitForTimeout(1500);
      const after = (await api(`/api/threads/${tid}`)).length;
      check(tag, 'rapid-fire: a send with a card picked follows up in its thread', after === before + 1, `${before} → ${after}`);
      check(tag, 'rapid-fire: the follow-up adds no card, and the card stays picked', await cards.count() === n && await last.getAttribute('aria-pressed') === 'true');
    }
    await p.locator('#w-bottom .rf-unpick').tap();
    check(tag, 'rapid-fire: the ✕ unpicks the card', !(await p.locator('.rf:visible .mail-card.sel').count()) && await target.getAttribute('data-rf') === 'new');
    if (sends) {
      await send('Rapid idea: a second one');
      await grows(n);
      check(tag, 'rapid-fire: after unpicking, a send starts a new thread again', await cards.count() === n + 1);
    }
    await shot('rapid-unpicked');
    await toggle.tap();
    await p.waitForTimeout(500);
    check(tag, 'rapid-fire: the toggle again shows the conversation', !(await p.locator('.rf:visible').count()));
  });

  if (sends) await step('add agent', async () => {
    const n = (await api('/api/agents')).length;
    await p.locator('[data-nav="left"]').tap();
    await p.locator('#new-agent').tap();
    await p.locator('.menu [role=menuitem]:has-text("With the defaults")').tap();
    await p.waitForTimeout(2500);
    check(tag, '+ then With the defaults adds an agent', (await api('/api/agents')).length === n + 1);
  });

  await ctx.close();
}
await browser.close();
if (!only) for (const k of KNOWN_OVERLAPS) if (!knownSeen.has(k)) console.log(`stale: no overlap matches known entry "${k}" (S-2249); drop it`);
writeFileSync(`${out}/results-${engine}.json`, JSON.stringify(results, null, 1));
console.log(`${engine}: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
