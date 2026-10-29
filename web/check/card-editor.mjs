// The issue card editor's drag and keys on a throwaway daemon (S-3314, S-1438 PR 6b): Settings › Fields and cards › Issue
// card at 1440, light and dark. A keyboard run (lift, step, drop, reload, the live region, Escape cancel writes nothing),
// then a pointer run (slot to slot, slot to Available, a refused drop into a full slot). It reads the saved layout from
// the settings the daemon holds, and takes the shots of a drag, a lifted chip, a refusal and the result.
//   node web/check/card-editor.mjs BASE_URL OUT_DIR [--only=light,dark]
// BASE_URL carries the token and the test human key (daemon.sh prints one). It writes to the daemon, so it needs a
// throwaway daemon. Exits 1 when a check fails.
// --phone runs the phone editor instead (S-1438 PR 7): at 360 and 430 px, by touch, light and dark (--only), with a tap
// that moves a row across slots, a ⋯ sheet with a disabled reason, the Add sheet, a long-press drag shot mid-drag, a
// cancelled press that writes nothing, and a reload that shows what was saved. The desktop run is skipped then.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';
import { settled } from './settled.mjs';

const [base, out, ...flags] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node card-editor.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const only = flags.find((f) => f.startsWith('--only='))?.slice(7).split(',') ?? ['light', 'dark'];
const phone = flags.includes('--phone');
// --agent runs the agent card editor (S-3435) instead of the issue card's checks: desktop (a)-(c) with the system view, and the
// phone at 360 and 430 px (d)-(f). Its own block is at the foot of this file.
const agent = flags.includes('--agent');

const { chromium, devices } = findPlaywright();
const u = new URL(base);
const hash = new URLSearchParams(u.hash.slice(1));
const token = hash.get('token') ?? '';
const testHuman = hash.get('testHuman') ?? '';
const origin = u.origin;
const human = { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'x-stam-test-human': testHuman, 'content-type': 'application/json' };
const api = (path) => fetch(origin + path, { headers: human }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }));

let failed = 0;
const check = (name, ok, detail = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`;
  console.log(line);
  if (!ok) failed++;
};

// The issue layout the daemon holds, from the settings it saved (a record the page writes after a short delay).
const saved = async () => {
  const s = await api('/api/config/settings');
  // The settings file as text: cardLayouts is one of its keys.
  let file = {};
  try { file = JSON.parse(s.body?.text ?? '{}') } catch { file = {} }
  const all = file.cardLayouts ?? {};
  return all.issue ?? null;
};
// Waits until the saved layout passes `ok`, polling; returns the last one read.
const settledWhere = async (ok) => {
  let last = null;
  for (let i = 0; i < 40; i++) {
    last = await saved();
    if (last && ok(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
};
const slotsOf = (l) => (l?.slots ?? {});

const browser = await chromium.launch(chromiumLaunchOptions());
const pageFor = async (scheme) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  await ctx.addInitScript((s) => { try { localStorage.setItem('stam/theme', s) } catch {} }, scheme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  // The throwaway daemon takes a page's settings write as the test human only with this header, as the check's own calls do.
  await p.route('**/api/config/settings', (route) => route.continue({ headers: { ...route.request().headers(), 'x-stam-test-human': testHuman } }));
  p.on('pageerror', (e) => check(`no page errors (${scheme})`, false, e.message));
  await p.goto(`${origin}/#token=${token}&testHuman=${testHuman}&cfg=fields/issue`);
  await p.waitForSelector('.ice-row[data-slot="META"]', { timeout: 20000 });
  return { ctx, p };
};
// The center of a chip, and of a Available item, for the mouse.
const center = (p, sel) => p.locator(sel).first().boundingBox().then((b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));
// A pointer drag from one chip to a point: down, a few steps, up. The drop is the release.
// The target is measured after the drag starts, since a refusal line or a lift can move the rows under the pointer.
async function drag(p, from, to, steps = 10) {
  const a = await center(p, from)
  await p.mouse.move(a.x, a.y)
  await p.mouse.down()
  await p.mouse.move(a.x + 12, a.y + 12, { steps: 2 })
  const b = typeof to === 'string' ? await center(p, to) : to
  await p.mouse.move(b.x, b.y, { steps })
  return { a, b }
}
const said = (p) => p.locator('.ice-said').textContent()
const layoutSlots = async (p) => (await saved()) ?? null
// The FOOT row of a card, item by item: the box, the text's width, the row's gap, and whether the item is cut. Run in the page.
const footShape = (id) => {
  const row = document.querySelector(`.sv-card[data-card="${id}"] .sv-r4`)
  const gap = row ? parseFloat(getComputedStyle(row).columnGap) || 0 : 0
  const rowW = row?.getBoundingClientRect().width ?? 0
  return [...(row?.children ?? [])].map((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return { text: (el.textContent ?? '').trim(), box: el.getBoundingClientRect().width, textW: range.getBoundingClientRect().width, gap, rowW,
      clipped: el.scrollWidth > el.clientWidth + 0.5, ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' }
  })
}
// The short item (the one whose text is narrower) keeps its box at its text plus the gap, and is not cut.
const shortKeeps = (rows) => {
  if (rows.length !== 2) return false
  const short = rows[0].textW <= rows[1].textW ? rows[0] : rows[1]
  return short.box <= short.textW + short.gap + 1 && !short.clipped
}

for (const scheme of phone || agent ? [] : only) {
  const { ctx, p } = await pageFor(scheme);
  // Start from the default card, so every step below is from a known layout.
  await p.locator('.ice-foot .btn').click();
  await settledWhere((l) => JSON.stringify(slotsOf(l).META) === JSON.stringify(['status', 'rollup', 'links', 'owner']));

  // Keyboard: Tab in, lift Owner (META, last), step down into Badges, drop. One write, and the live region says so.
  const owner = p.locator('[data-item="owner"]').first();
  await owner.focus();
  await p.keyboard.press('Space');
  check(`lift is announced (${scheme})`, (await said(p)).startsWith('Owner lifted, Meta, position 4'), await said(p));
  const before = await saved();
  await p.keyboard.press('ArrowDown');
  check(`a step is announced as "Owner, Badges, position 1" (${scheme})`, (await said(p)) === 'Owner, Badges, position 1', await said(p));
  check(`a step writes nothing (${scheme})`, JSON.stringify(await saved()) === JSON.stringify(before));
  check(`a key-lifted chip draws no gap (${scheme})`, (await p.locator('.ice-gap').count()) === 0);
  check(`a key-lifted chip is raised (${scheme})`, ((await owner.getAttribute('class')) ?? '').includes('raised'));
  // The lifted look, read from the DOM while the chip is lifted and moved: its shadow, its outline and its focus.
  const look = await p.evaluate(() => { const el = document.querySelector('[data-item="owner"]'); const cs = getComputedStyle(el); return { boxShadow: cs.boxShadow, outline: `${cs.outlineStyle} ${cs.outlineWidth}`, opacity: cs.opacity, focused: document.activeElement === el } });
  console.log(`lifted look (${scheme}): ${JSON.stringify(look)}`);
  check(`the lifted chip has focus and a raised shadow (${scheme})`, look.focused && look.boxShadow !== 'none' && look.opacity === '1', JSON.stringify(look));
  await p.screenshot({ path: `${out}/${scheme}-keyboard-lifted.png` });
  await p.keyboard.press('Space');
  check(`the drop is announced (${scheme})`, (await said(p)) === 'Owner moved to Badges, position 1', await said(p));
  const dropped = await settledWhere((l) => slotsOf(l).BADGES?.[0] === 'owner');
  check(`the drop saves owner at the start of Badges (${scheme})`, slotsOf(dropped).BADGES?.[0] === 'owner', JSON.stringify(slotsOf(dropped)));

  // Reload: the layout is kept.
  console.log('saved after drop:', JSON.stringify(slotsOf(await saved())));
  await p.reload();
  await p.waitForSelector('.ice-row[data-slot="META"]', { timeout: 20000 });
  await p.waitForTimeout(1500);
  console.log('after reload BADGES:', await p.locator('[data-slot="BADGES"]').textContent().catch(() => 'none'));
  check(`reload keeps the layout (${scheme})`, (await p.locator('.ice-row[data-slot="BADGES"] [data-item="owner"]').count()) === 1);

  // Escape cancel: a lift then Escape writes nothing, and the chip is back where it was.
  let writes = 0;
  const onReq = (r) => { if (r.url().includes('/api/config/settings') && r.method() !== 'GET') writes++ };
  p.on('request', onReq);
  await p.locator('[data-item="rollup"]').first().focus();
  await p.keyboard.press('Space');
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(1200);
  p.off('request', onReq);
  check(`Escape cancel writes nothing (${scheme})`, writes === 0, `${writes} writes`);
  check(`Escape cancel says the chip is back (${scheme})`, (await said(p)).startsWith('Roll-up back in Meta'), await said(p));

  // Pointer, slot to Available: hide Owner by dragging it off the card.
  await drag(p, '[data-item="owner"]', '[data-drop="AVAILABLE"]');
  await p.mouse.up();
  const hidden = await settledWhere((l) => !Object.values(slotsOf(l)).flat().includes('owner'));
  check(`slot to Available hides it (${scheme})`, !Object.values(slotsOf(hidden)).flat().includes('owner'));

  // Pointer, Available to slot: Updated into Foot, which has room.
  await drag(p, '.ice-avail[data-item="updated"]', '[data-slot="FOOT"]');
  await p.mouse.up();
  const footed = await settledWhere((l) => (slotsOf(l).FOOT ?? []).includes('updated'));
  check(`Available to slot adds it (${scheme})`, (slotsOf(footed).FOOT ?? []).includes('updated'), JSON.stringify(slotsOf(footed)));

  // Pointer, a refused drop: Top is full (three), so a drop into it keeps the layout and says why. Meta's top must not
  // move while the refusal shows: the reason hangs over the rows, it takes no room.
  const beforeRefuse = JSON.stringify(slotsOf(await saved()));
  const metaBefore = (await p.locator('[data-slot="META"]').boundingBox()).y;
  const { b: refuseAt } = await drag(p, '.ice-avail[data-item="owner"]', '[data-slot="TOP"]', 4);
  const refusing = await p.locator('[data-slot="TOP"] .ice-refusal').textContent().catch(() => null);
  const metaDuring = (await p.locator('[data-slot="META"]').boundingBox()).y;
  console.log(`refusal (${scheme}): Meta top before ${metaBefore.toFixed(1)}, during ${metaDuring.toFixed(1)}`);
  check(`a refusal moves no row (${scheme})`, Math.abs(metaBefore - metaDuring) < 0.5, `${metaBefore} vs ${metaDuring}`);
  await p.screenshot({ path: `${out}/${scheme}-refused.png` });
  await p.mouse.up();
  await p.waitForTimeout(1200);
  check(`a refused drop shows its reason in the slot (${scheme})`, refusing === 'Top is full: it holds at most 3', String(refusing));
  check(`a refused drop keeps the saved layout (${scheme})`, JSON.stringify(slotsOf(await saved())) === beforeRefuse);

  // Pointer, slot to slot: Status from Meta into Foot, which takes it at the drop. The ghost keeps the grab offset, so
  // the pointer's point stays under it; the selection is empty while the drag lasts and after it.
  const pick = await p.locator('[data-item="status"]').first().boundingBox();
  const { a: grabAt, b: footAt } = await drag(p, '[data-item="status"]', '[data-slot="FOOT"]');
  await p.screenshot({ path: `${out}/${scheme}-mid-drag.png` });
  const selectedMid = await p.evaluate(() => window.getSelection()?.toString() ?? '');
  const gap = await p.locator('.ice-gap').first().boundingBox().catch(() => null);
  const chip = await p.locator('[data-item="status"]').first().boundingBox();
  const ghost = await p.locator('.ice-ghost').boundingBox().catch(() => null);
  console.log(`mid-drag (${scheme}): pointer ${footAt.x.toFixed(1)},${footAt.y.toFixed(1)}; ghost ${ghost ? [ghost.x, ghost.y, ghost.width, ghost.height].map((v) => v.toFixed(1)).join(',') : 'none'}; grab offset ${(grabAt.x - pick.x).toFixed(1)},${(grabAt.y - pick.y).toFixed(1)}`)
  check(`the pointer stays under the ghost (${scheme})`, !!ghost && footAt.x >= ghost.x && footAt.x <= ghost.x + ghost.width && footAt.y >= ghost.y && footAt.y <= ghost.y + ghost.height, JSON.stringify({ footAt, ghost }));
  await p.mouse.up();
  const moved = await settledWhere((l) => (slotsOf(l).FOOT ?? []).includes('status'));
  const selectedAfter = await p.evaluate(() => window.getSelection()?.toString() ?? '');
  check(`slot to slot moves it (${scheme})`, (slotsOf(moved).FOOT ?? []).includes('status'), JSON.stringify(slotsOf(moved)));
  check(`the ghost tracks the pointer (${scheme})`, !!ghost, 'no ghost while dragging');
  check(`the drop gap draws (${scheme})`, !!gap, 'no gap while dragging');
  check(`a drag selects no page text (${scheme})`, selectedMid === '' && selectedAfter === '', JSON.stringify({ selectedMid, selectedAfter }));
  if (gap && chip) console.log(`DOM ${scheme}: chip ${chip.width.toFixed(1)}x${chip.height.toFixed(1)}, gap ${gap.width.toFixed(1)}x${gap.height.toFixed(1)}`);
  if (scheme === 'light') await p.screenshot({ path: `${out}/light-after-moves.png` });
  if (scheme === 'dark') await p.screenshot({ path: `${out}/dark-after-moves.png` });

  await ctx.close();
}
// Narrow width: 900 px, the editor alone. A status drag mid-flight (rows must not scroll sideways), then a Links refusal
// with its reason, whose right edge must stay inside the editor.
if (!phone && !agent) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  await p.route('**/api/config/settings', (route) => route.continue({ headers: { ...route.request().headers(), 'x-stam-test-human': testHuman } }));
  // A Links refusal cannot be reached by a drag (Links is not offered while a kind is placed), so the layout is written with
  // Links and a kind both placed; a drag of the kind out of its slot is then refused for the clash, as the model says.
  const fixture = { slots: { TOP: ['parent', 'kind', 'health'], META: ['status', 'rollup', 'links', 'owner'], BADGES: ['github'], FOOT: ['updated'] }, titleLines: 3, chosen: true };
  await fetch(origin + '/api/config/settings', { method: 'PATCH', headers: human, body: JSON.stringify({ patch: { cardLayouts: { issue: fixture } } }) });
  await p.goto(`${origin}/#token=${token}&testHuman=${testHuman}&cfg=fields/issue`);
  await p.waitForSelector('.ice-row[data-slot="META"]', { timeout: 20000 });
  await p.waitForTimeout(800);
  // Mid-drag: the status is held over Foot.
  await drag(p, '[data-item="status"]', '[data-slot="FOOT"]');
  const shape = await p.evaluate(() => ({ docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, rows: [...document.querySelectorAll('.ice-row')].map((r) => { const c = r.querySelector('.ice-chips'); return { slot: r.getAttribute('data-slot'), h: Math.round(r.getBoundingClientRect().height), sideways: c ? c.scrollWidth - c.clientWidth : 0 }; }) }));
  console.log(`narrow 900 mid-drag: ${JSON.stringify(shape)}`);
  await p.screenshot({ path: `${out}/narrow-900-mid-drag.png` });
  await p.mouse.up();
  await p.waitForTimeout(800);
  check('at 900 px the page does not scroll sideways, and no row scrolls', shape.docOverflow <= 0 && shape.rows.every((r) => r.sideways <= 0), JSON.stringify(shape));
  // The Links refusal: a kind dragged out of Badges while Links is placed. Its reason hangs under Foot.
  await drag(p, '[data-item="github"]', '[data-slot="FOOT"]');
  const reason = await p.locator('[data-slot="FOOT"] .ice-refusal').boundingBox().catch(() => null);
  const editor = await p.locator('.ice').boundingBox();
  const row = await p.locator('[data-slot="FOOT"]').boundingBox();
  const refusalText = await p.locator('[data-slot="FOOT"] .ice-refusal').textContent().catch(() => null);
  console.log(`links refusal 900: text "${refusalText}"; reason right ${reason ? (reason.x + reason.width).toFixed(1) : 'none'}, editor right ${(editor.x + editor.width).toFixed(1)}, foot row top ${row.y.toFixed(1)}`);
  check('the Links reason shows in Foot at 900 px', refusalText === "Links and a link kind can't both be on the card", String(refusalText));
  check('the Links reason stays inside the editor at 900 px', !!reason && reason.x + reason.width <= editor.x + editor.width + 0.5, JSON.stringify({ reason, editor }));
  await p.screenshot({ path: `${out}/narrow-900-refused-links.png` });
  await p.mouse.up();
  await ctx.close();
}
// Split view: Settings › Fields and cards beside the Work board. The card read is the one of the ITSA the editor previews
// (its select), and every card on the board is read too: a Settings move must reach each card of the layout without a reload.
if (!phone && !agent) {
  const post = (path, method, body) => fetch(origin + path, { method, headers: human, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }));
  await post('/api/itsas', 'POST', { title: 'Check: card editor split', kind: 'issue', by: 'human' });
  const { ctx, p } = await pageFor('light');
  await p.locator('.ice-foot .btn').click();
  await p.waitForTimeout(800);
  await p.evaluate(() => window.stamDebug.shell.open(window.stamDebug.shell.currentWorld(), 'work', { split: 'right' })).catch((e) => check('the Work board opens beside Settings', false, e.message));
  await p.waitForSelector('.bcard', { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(1000);
  const previewId = await p.locator('.ice-pick select').inputValue();
  const previewTitle = await p.locator('.ice-pick select option:checked').textContent();
  const footsOf = () => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.bcard')].map((c) => [c.getAttribute('data-card'), (c.querySelector('.bc-foot')?.textContent ?? '').trim()])));
  const pcard = (id) => p.locator(`.bcard[data-card="${id}"]`).first();
  const up = await pcard(previewId).waitFor({ timeout: 8000 }).then(() => true, () => false);
  check('the board shows the card of the ITSA the editor previews', up, `preview ${previewId} (${previewTitle})`);
  if (up) {
    const beforeAll = await footsOf();
    const before = beforeAll[previewId] ?? '';
    console.log(`preview card ${previewId} foot before: "${before}"; cards on the board: ${Object.keys(beforeAll).length}`);
    await p.locator('.ice-avail[data-item="updated"]').first().focus();
    await p.keyboard.press('Space');
    await p.keyboard.press('ArrowUp');
    await p.keyboard.press('Space');
    await p.waitForTimeout(800);
    const afterAll = await footsOf();
    const after = afterAll[previewId] ?? '';
    console.log(`preview card ${previewId} foot after: "${after}"`);
    const changed = Object.keys(afterAll).filter((id) => afterAll[id] !== beforeAll[id]);
    const stale = Object.keys(afterAll).filter((id) => afterAll[id] === beforeAll[id] && !afterAll[id].includes('now'));
    console.log(`cards whose foot changed: ${changed.length} of ${Object.keys(afterAll).length}; cards without the Updated text: ${stale.length}`);
    await p.screenshot({ path: `${out}/light-split-view.png` });
    check('a Settings move reaches the previewed board card without a reload', after !== before && after.includes('now'), `before "${before}", after "${after}"`);
    check('a Settings move reaches every card on the board', changed.length === Object.keys(afterAll).length && Object.keys(afterAll).length > 0, `${changed.length} of ${Object.keys(afterAll).length} changed`);
  }
  await ctx.close();
}

// The phone editor (S-1438 PR 7), by touch at 360 and 430 px. Each run starts from the default card, and the layout the
// page shows is read from its DOM, so the reload check compares what was drawn with what was saved.
const SLOT_SECTIONS = ['Top', 'Meta', 'Badges', 'Foot']
const drawnSlots = (p) => p.evaluate((names) => Object.fromEntries(names.map((n) => [n, [...(document.querySelector(`section[aria-label="${n}"]`)?.querySelectorAll('[data-item]') ?? [])].map((e) => e.dataset.item)])), SLOT_SECTIONS)
// The editor opens from the link `cfg=fields/issue`, as the desktop run does; a reload keeps the hash.
const editorUrl = () => `${origin}/#token=${token}&testHuman=${testHuman}&cfg=fields/issue`;
// Whether the element at the centre of the locator is that element, or one inside it: a control something else paints over cannot be tapped.
const hitsItself = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && (top === el || el.contains(top)); });
// Whether the whole box of the locator lies inside the window.
const inView = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
const sheetItemDisabled = (p, text) => p.locator('.ipe-sheet-item', { hasText: text }).first().isDisabled();

if (phone && !agent) for (const width of [360, 430]) for (const scheme of only) {
  const tag = `${width}-${scheme}`;
  const device = width === 360 ? devices['Pixel 7'] : devices['iPhone 15'];
  const ctx = await browser.newContext({ ...device, viewport: { width, height: width === 360 ? 740 : 860 }, colorScheme: scheme });
  await ctx.addInitScript((s) => { try { localStorage.setItem('stam/theme', s) } catch {} }, scheme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  await p.route('**/api/config/settings', (route) => route.continue({ headers: { ...route.request().headers(), 'x-stam-test-human': testHuman } }));
  p.on('pageerror', (e) => check(`no page errors (${tag})`, false, e.message));
  await p.goto(editorUrl());
  await p.waitForSelector('.ipe-row', { timeout: 20000 });
  const shot = (step) => p.screenshot({ path: `${out}/${tag}-${step}.png` });
  const noSideways = (step) => p.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth).then((ok) => check(`${step} (${tag}): no sideways scroll`, ok));
  await p.locator('.ipe-foot .btn').tap();
  await settledWhere((l) => JSON.stringify(slotsOf(l).META) === JSON.stringify(['status', 'rollup', 'links', 'owner']));
  await p.waitForTimeout(300);

  // (a) A tap: ↓ on Owner, the last item in Meta, lands it first in Badges, and the preview draws it.
  const previewBefore = await p.locator('.ipe-preview-card').innerHTML();
  await p.locator('[data-item="owner"] [data-act="down"]').tap();
  const a = await settledWhere((l) => slotsOf(l).BADGES?.[0] === 'owner');
  check(`(a) ↓ on Owner in Meta lands it first in Badges (${tag})`, slotsOf(a).BADGES?.[0] === 'owner' && !(slotsOf(a).META ?? []).includes('owner'), JSON.stringify(slotsOf(a)));
  await p.waitForTimeout(400);
  check(`(a) the preview draws the move (${tag})`, (await p.locator('.ipe-preview-card').innerHTML()) !== previewBefore);
  // The preview, scrolled to the top of the page, so Owner's place in the card's badges row is in the shot.
  await p.evaluate(() => document.querySelector('.ipe-preview')?.scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(200);
  await shot('a-preview-owner-in-badges');
  await noSideways('(a)');

  // (b) Fill Top to its cap of three with ↑, then the ⋯ of Status: Move to Top is disabled, and says why.
  for (const item of ['rollup', 'links']) {
    for (let i = 0; i < 3 && (await drawnSlots(p)).Top.length < 3 && (await drawnSlots(p)).Meta.includes(item); i++) {
      await p.locator(`[data-item="${item}"] [data-act="up"]`).tap();
      await p.waitForTimeout(400);
    }
  }
  const topCount = (await drawnSlots(p)).Top.length;
  check(`(b) Top is full, at three (${tag})`, topCount === 3, `Top holds ${topCount}`);
  await p.locator('[data-item="status"] [data-act="menu"]').tap();
  await p.waitForSelector('.ipe-sheet');
  check(`(b) the ⋯ sheet has faded in before its hit test and shot (${tag})`, await settled(p, '.ipe-sheet'));
  const sheetItems = p.locator('.ipe-sheet-item');
  let allHit = (await sheetItems.count()) > 0;
  for (let i = 0; i < (await sheetItems.count()); i++) {
    await sheetItems.nth(i).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    allHit = allHit && (await hitsItself(sheetItems.nth(i)));
  }
  check(`(b) every ⋯ sheet item is the top element at its centre (${tag})`, allHit);
  check(`(b) Move to Top is disabled in the ⋯ sheet, with its reason (${tag})`, (await sheetItemDisabled(p, 'Move to Top')) && (await p.locator('.ipe-sheet-item', { hasText: 'Move to Top' }).first().textContent()).includes('Top is full'));
  await shot('b-options-sheet');
  await noSideways('(b)');
  await p.keyboard.press('Escape');

  // (c) The Add sheet lists the hidden items, each with its slot.
  await p.locator('.ipe-add').tap();
  await p.waitForSelector('.ipe-add-row');
  check(`(c) the Add sheet has faded in before its shot (${tag})`, await settled(p, '.ipe-sheet'));
  check(`(c) the Add sheet lists the hidden items (${tag})`, (await p.locator('.ipe-add-row').count()) > 0);
  const addControls = p.locator('.ipe-add-row button, .ipe-add-row select');
  let addHit = (await addControls.count()) > 0;
  const covered = [];
  for (let i = 0; i < (await addControls.count()); i++) {
    // The sheet scrolls: a control below its fold is brought into view inside the sheet before the hit test.
    await addControls.nth(i).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    if (!(await hitsItself(addControls.nth(i)))) covered.push(await addControls.nth(i).evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return `${el.tagName}.${el.className} under ${top?.tagName}.${top?.className} at ${Math.round(r.top)}`; }));
    addHit = addHit && covered.length === 0;
  }
  const addBox = await p.locator('.ipe-add-row').first().evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, h: r.height }; });
  // One line per item: its name, slot and Add share a top edge, and the row is one touch target tall with no reason shown.
  const oneLine = await p.locator('.ipe-add-row').first().evaluate((row) => { const tops = [...row.querySelectorAll('select, button')].map((el) => Math.round(el.getBoundingClientRect().top)); return { same: tops.every((t) => t === tops[0]), tall: row.getBoundingClientRect().height <= 60, controls: tops.length }; });
  check(`(c) each Add row is one line: name, slot and Add share a top edge (${tag})`, oneLine.same && oneLine.controls === 2 && oneLine.tall, JSON.stringify(oneLine));
  const vw = await p.evaluate(() => innerWidth);
  check(`(c) every Add row's control is the top element at its centre, in view (${tag})`, addHit && addBox.r <= vw && addBox.h >= 44, `hit ${addHit}, row ${JSON.stringify(addBox)} in ${vw}, covered: ${covered.join(' | ')}`);
  await shot('c-add-sheet');
  await noSideways('(c)');
  await p.keyboard.press('Escape');

  // (d) A long press on Status's handle lifts it; the drop between rows in Badges writes once. The shot is taken mid-drag.
  if ((await p.locator('.menu').count()) > 0) { await p.keyboard.press('Escape'); await p.waitForTimeout(300); }
  await p.locator('[data-item="status"] .ipe-handle').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(200);
  const handle = await p.locator('[data-item="status"] .ipe-handle').boundingBox();
  await p.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(700);
  check(`(d) the hold lifts Status (${tag})`, (await p.locator('.ipe-row.dragging').count()) === 1);
  // The middle of Owner's row in Badges: the section's own middle can sit under the composer at the foot of the screen.
  await p.locator('section[aria-label="Badges"] [data-item="owner"]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(200);
  const over = await p.locator('section[aria-label="Badges"] [data-item="owner"]').boundingBox();
  await p.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 12 });
  await p.waitForTimeout(200);
  check(`(d) the drop gap shows in Badges mid-drag (${tag})`, (await p.locator('section[aria-label="Badges"] .ipe-gap').count()) === 1);
  const ghostBox = (await p.locator('.ipe-ghost').count()) ? await p.locator('.ipe-ghost').first().boundingBox() : null;
  check(`(d) the lifted row is drawn under the finger, inside the viewport (${tag})`, (await p.locator('.ipe-ghost').count()) === 1 && (await inView(p.locator('.ipe-ghost'))), `count ${await p.locator('.ipe-ghost').count()}, box ${JSON.stringify(ghostBox)}, window ${await p.evaluate(() => `${innerWidth}x${innerHeight}`)}`);
  await shot('d-mid-drag');
  await p.mouse.up();
  const d = await settledWhere((l) => (slotsOf(l).BADGES ?? []).includes('status'));
  check(`(d) the release writes Status into Badges (${tag})`, (slotsOf(d).BADGES ?? []).includes('status') && !(slotsOf(d).META ?? []).includes('status'), JSON.stringify(slotsOf(d)));
  await noSideways('(d)');

  // (d2) A long press cancelled with Escape writes nothing, even released over a slot.
  const kept = JSON.stringify(await saved());
  await p.locator('[data-item="owner"] .ipe-handle').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(200);
  const owner = await p.locator('[data-item="owner"] .ipe-handle').boundingBox();
  await p.mouse.move(owner.x + owner.width / 2, owner.y + owner.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(700);
  await p.keyboard.press('Escape');
  await p.mouse.up();
  await p.waitForTimeout(800);
  check(`(d2) a cancelled long press writes nothing (${tag})`, JSON.stringify(await saved()) === kept);

  // (f) Edge scroll: a row low in the list, lifted and held just under the sticky preview's bottom edge, scrolls the list up.
  // The preview covers the window's top, so that edge is the preview's bottom, not the window's.
  const listScroller = `(() => { let n = document.querySelector('.ipe')?.parentElement; while (n && !['auto', 'scroll'].includes(getComputedStyle(n).overflowY)) n = n.parentElement; return n ?? document.scrollingElement; })()`;
  await p.evaluate(`${listScroller}.scrollTop = ${listScroller}.scrollHeight`);
  await p.waitForTimeout(300);
  const scrolledTo = await p.evaluate(`${listScroller}.scrollTop`);
  const lowHandle = await p.locator('.ipe [data-item] .ipe-handle').last().boundingBox();
  const previewBox = await p.locator('.ipe-preview').boundingBox();
  await p.mouse.move(lowHandle.x + lowHandle.width / 2, lowHandle.y + lowHandle.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(700);
  await p.mouse.move(lowHandle.x + lowHandle.width / 2, previewBox.y + previewBox.height - 8, { steps: 8 });
  await p.waitForTimeout(800);
  const held = await p.evaluate(`${listScroller}.scrollTop`);
  await p.mouse.up();
  await p.waitForTimeout(300);
  check(`(f) a lifted row held under the preview's bottom edge scrolls the list up (${tag})`, scrolledTo > 0 && held < scrolledTo, `scrollTop ${scrolledTo} -> ${held}`);
  await noSideways('(f)');

  // (e) After a reload, the layout drawn is the one saved.
  await p.reload();
  await p.waitForSelector('.ipe-row', { timeout: 20000 });
  const after = await settledWhere((l) => (slotsOf(l).BADGES ?? []).includes('status'));
  const drawn = await drawnSlots(p);
  check(`(e) after a reload the layout drawn equals the saved one (${tag})`, SLOT_SECTIONS.every((n) => JSON.stringify(drawn[n]) === JSON.stringify(slotsOf(after)[n.toUpperCase()] ?? [])), JSON.stringify(drawn));
  await shot('e-reloaded');
  await noSideways('(e)');
  await ctx.close();
}

// The agent card editor (S-3435, --agent). A fresh daemon: the defaults are written first, so each step starts from a known layout.
if (agent) {
  const agentUrl = (hashRest = 'cfg=fields/agent') => `${origin}/#token=${token}&testHuman=${testHuman}&${hashRest}`;
  const savedAgent = async () => {
    const s = await api('/api/config/settings');
    let file = {};
    try { file = JSON.parse(s.body?.text ?? '{}') } catch { file = {} }
    return file.cardLayouts?.agent ?? null;
  };
  // Waits until the saved agent layout passes `ok`; returns the last one read.
  const settleAgent = async (ok) => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      last = await savedAgent();
      if (last && ok(last)) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    return last;
  };
  const DEFAULT_BADGES = ['health', 'review', 'tests'];
  const newPage = async (scheme, width, device, hashRest) => {
    const ctx = await browser.newContext({ ...(device ?? {}), viewport: { width, height: width === 1440 ? 900 : width === 360 ? 740 : 860 }, colorScheme: scheme });
    await ctx.addInitScript((s) => { try { localStorage.setItem('stam/theme', s) } catch {} }, scheme);
    const p = await ctx.newPage();
    p.setDefaultTimeout(8000);
    await p.route('**/api/config/settings', (route) => route.continue({ headers: { ...route.request().headers(), 'x-stam-test-human': testHuman } }));
    p.on('pageerror', (e) => check(`no page errors (agent ${width} ${scheme})`, false, e.message));
    await p.goto(agentUrl(hashRest));
    return { ctx, p };
  };
  const noSideways = (p, step) => p.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth).then((ok) => check(`(f) ${step}: no sideways scroll`, ok));
  // The system view's cards: id and rect, as the view places them (the stage's own coordinates are the rect's).
  const cardRects = (p) => p.evaluate(() => [...document.querySelectorAll('.sv-card[data-card]')].map((e) => { const b = e.getBoundingClientRect(); return { id: e.dataset.card, x: b.x, y: b.y, w: b.width, h: b.height } }));
  const overlaps = (rs) => rs.flatMap((a, i) => rs.slice(i + 1).filter((b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5).map((b) => `${a.id}/${b.id}`));
  // The agent the checks use is `kid`, which owns open ITSAs. Each of its open ITSAs goes at risk and gets a branch with a review and
  // a test run, so its card draws Health, Review and Tests (the defaults): the badge order is one the move (b) can change.
  const sendJson = (method, path, body, headers = human) => fetch(origin + path, { method, headers, body: JSON.stringify(body) });
  const agents = await api('/api/agents');
  const kidId = (Array.isArray(agents.body) ? agents.body : agents.body?.agents ?? []).find((a) => a.name === 'kid')?.id ?? null;
  // An agent's own writes (a post, a link) take its own token, which the URL carries in agents= (daemon.sh); the shared token can't act as it.
  const agentTokens = JSON.parse(hash.get('agents') ?? '{}');
  const kidAuth = { ...human, authorization: 'Bearer ' + (agentTokens[kidId] ?? '') };
  const CLOSED = ['done', 'canceled', 'duplicate', 'wont_do'];
  const kidOpen = async () => ((await api('/api/itsas')).body ?? []).filter((x) => x.owner === kidId && !CLOSED.includes(x.status));
  for (const it of await kidOpen()) {
    await sendJson('POST', `/api/itsas/${it.id}/post`, { by: 'kid', kind: 'update', health: 'at_risk', body: 'Check: at risk, so the agent card draws its Health badge' }, kidAuth);
    if (!(it.links ?? []).some((l) => l.system === 'branch')) await sendJson('POST', `/api/itsas/${it.id}/links`, { system: 'branch', external_id: `stam/check-${it.key}`, url: `https://github.com/example/stam2/tree/stam/check-${it.key}`, repo: 'stam2', by: 'kid' }, kidAuth);
  }
  for (const it of await kidOpen()) {
    const br = (it.links ?? []).find((l) => l.system === 'branch') ?? ((await api('/api/itsas')).body ?? []).find((x) => x.id === it.id)?.links?.find((l) => l.system === 'branch');
    if (br) await sendJson('PATCH', `/api/itsas/${it.id}/links/${br.n}`, { review: { verdict: 'approve', summary: 'Checked.' }, tests: { passed: 13, failed: 1, skipped: 0, command: 'npx vitest run' } });
  }
  check('the check agent kid is on the daemon and owns an open ITSA', !!kidId && (await kidOpen()).length > 0, `kid ${kidId}`);

  // Desktop: (a) the editor with its preview, (b) a keyboard move seen in the system view, (c) ISSUE off in the Tree.
  for (const scheme of only) {
    const tag = `desk-${scheme}`;
    const { ctx, p } = await newPage(scheme, 1440, null, 'cfg=fields/agent');
    await p.waitForSelector('.ice-row[data-slot="BADGES"]', { timeout: 20000 });
    await p.locator('.ice-foot .btn').click();
    await settleAgent((l) => JSON.stringify(l.slots?.BADGES) === JSON.stringify(DEFAULT_BADGES) && JSON.stringify(l.slots?.ISSUE) === JSON.stringify(['issue']));

    const sys = await newPage(scheme, 1440, null, 'view=system&mode=tree');
    await sys.p.waitForSelector('.sv-card[data-card]', { timeout: 20000 });
    const sysBadgesNow = () => sys.p.evaluate(() => [...document.querySelectorAll('.sv-card[data-card] .sv-r3')].map((r) => r.textContent).join('|'));
    const sysBefore = await sysBadgesNow();
    // The default FOOT is the activity line alone, the long one on a busy agent: when it is cut, it ends in an ellipsis.
    const activityLine = await sys.p.evaluate((id) => {
      const el = document.querySelector(`.sv-card[data-card="${id}"] .sv-r4 > *`);
      return el ? { text: el.textContent.trim(), clipped: el.scrollWidth > el.clientWidth + 0.5, ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' } : null;
    }, kidId);
    check(`(h) the default FOOT line ends in an ellipsis when it is cut (${tag})`, !!activityLine && (!activityLine.clipped || activityLine.ellipsis), JSON.stringify(activityLine));
    const rectsOn = await cardRects(sys.p);
    const heightOn = rectsOn.map((r) => r.h);
    const kidOn = rectsOn.find((r) => r.id === kidId);
    check(`(a) the preview is the real agent card (${tag})`, (await p.locator('.ice-preview-card .sv-card').count()) === 1);
    // 96 px is the base (--sv-card-h). With ISSUE on and the default layouts, the nested issue card adds one row: agentCardHeight(96, 16, 1, 1, 1) = 96.
    check(`(a) the default card is 96 px in the system view (${tag})`, heightOn.length > 0 && heightOn.every((h) => Math.abs(h - 96) < 1), JSON.stringify(heightOn.slice(0, 4)));
    // The preview is kid's card, drawn with the same layout: its box is the system view's card, and the page styles it (system.css).
    const previewBox = await p.locator('.ice-preview-card .sv-card').boundingBox();
    check(`(a) the preview's card box is the system view's card box, 96 px (${tag})`, !!kidOn && !!previewBox && Math.abs(previewBox.height - 96) < 1 && Math.abs(kidOn.h - previewBox.height) < 1, `preview ${previewBox?.height} / kid ${kidOn?.h}`);
    await p.screenshot({ path: `${out}/${tag}-a-editor.png` });

    // (b) Health moves from the front of Badges to after Review: Space lifts, the arrow steps, Space drops.
    const chip = p.locator('[data-slot="BADGES"] [data-item="health"]').first();
    await chip.focus();
    await p.keyboard.press('Space');
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('Space');
    const moved = await settleAgent((l) => JSON.stringify(l.slots?.BADGES) === JSON.stringify(['review', 'health', 'tests']));
    check(`(b) a keyboard move saves Health after Review (${tag})`, JSON.stringify(moved?.slots?.BADGES) === JSON.stringify(['review', 'health', 'tests']), JSON.stringify(moved?.slots?.BADGES));
    // The system view polls the layout (CARD_LAYOUT_POLL_MS), so the move shows there a few seconds on. kid's card draws its
    // Health badge (at risk, above), so the move reorders text the view shows.
    await sys.p.waitForTimeout(7000);
    const sysAfter = await sysBadgesNow();
    check(`(b) the system view shows the move (${tag})`, sysBefore !== '' && sysAfter !== sysBefore, `before ${sysBefore.slice(0, 120)} / after ${sysAfter.slice(0, 120)}`);
    await sys.p.screenshot({ path: `${out}/${tag}-b-system.png` });
    await p.keyboard.press('Escape');

    // (c) kid's card with its issue (ISSUE on): 96 px, shot; then ISSUE off: 80 px, no overlap, shot.
    check(`(c) kid's card is 96 px with its issue on (${tag})`, !!kidOn && Math.abs(kidOn.h - 96) < 1, `kid ${kidOn?.h}`);
    await sys.p.screenshot({ path: `${out}/${tag}-c-issue-on.png` });
    await p.locator('[data-slot="ISSUE"] input[role=switch]').click();
    await settleAgent((l) => (l.slots?.ISSUE ?? []).length === 0);
    await sys.p.reload();
    await sys.p.waitForSelector('.sv-card[data-card]', { timeout: 20000 });
    await sys.p.waitForTimeout(1500);
    const off = await cardRects(sys.p);
    const kidOff = off.find((r) => r.id === kidId);
    check(`(c) ISSUE off: kid's card drops to 80 px (${tag})`, !!kidOff && Math.abs(kidOff.h - 80) < 1, `kid ${kidOff?.h}`);
    check(`(c) ISSUE off: every card is shorter than 96 px (${tag})`, off.length > 0 && off.every((r) => r.h < 96 - 1), JSON.stringify(off.slice(0, 4).map((r) => r.h)));
    check(`(c) ISSUE off: no two card rects overlap (${tag})`, overlaps(off).length === 0, overlaps(off).join(' '));
    await sys.p.screenshot({ path: `${out}/${tag}-c-issue-off.png` });
    await p.locator('[data-slot="ISSUE"] input[role=switch]').click();
    await settleAgent((l) => (l.slots?.ISSUE ?? []).length === 1);
    await p.reload();
    await p.waitForSelector('.ice-row[data-slot="BADGES"]', { timeout: 20000 });
    // (g) Empty BADGES: every badge hidden. The preview and kid's system card are the same card, 80 px with ISSUE on; then Reset restores BADGES.
    for (const name of ['Health', 'Review', 'Tests']) {
      await p.locator(`[aria-label="Options for ${name}"]`).click();
      await p.getByRole('menuitem', { name: 'Hide' }).click();
    }
    await settleAgent((l) => (l.slots?.BADGES ?? []).length === 0);
    await sys.p.reload();
    await sys.p.waitForSelector('.sv-card[data-card]', { timeout: 20000 });
    await sys.p.waitForTimeout(1500);
    const emptyPreview = (await p.locator('.ice-preview-card .sv-card').boundingBox())?.height ?? 0;
    const emptySys = (await cardRects(sys.p)).find((r) => r.id === kidId)?.h ?? 0;
    check(`(g) empty BADGES: the preview card is 80 px and the system view's kid card matches it (${tag})`, Math.abs(emptyPreview - 80) < 1 && Math.abs(emptySys - emptyPreview) < 1, `preview ${emptyPreview} / system ${emptySys}`);
    await p.screenshot({ path: `${out}/${tag}-g-empty-badges-preview.png` });
    await p.locator('.ice-foot .btn').click();
    await settleAgent((l) => JSON.stringify(l.slots?.BADGES) === JSON.stringify(DEFAULT_BADGES));
    // (h) Two items in FOOT: Tests moves to FOOT (its text reads), so kid's card shows Activity then Tests. The first item may clip,
    // and then it ends in an ellipsis; the second is readable, in view, and its box does not touch the first.
    await p.locator('[aria-label="Options for Tests"]').click();
    await p.getByRole('menuitem', { name: 'Move to Foot' }).click();
    await settleAgent((l) => (l.slots?.FOOT ?? []).length === 2);
    await sys.p.reload();
    await sys.p.waitForSelector('.sv-card[data-card]', { timeout: 20000 });
    await sys.p.getByRole('button', { name: 'Fit' }).click();
    await sys.p.waitForTimeout(1500);
    const foot = await sys.p.evaluate((id) => {
      const card = document.querySelector(`.sv-card[data-card="${id}"]`);
      const items = card ? [...card.querySelectorAll('.sv-r4 > *')] : [];
      const kids = items.map((k) => k.getBoundingClientRect());
      const rowRight = card?.querySelector('.sv-r4')?.getBoundingClientRect().right ?? 0;
      const first = items[0];
      return {
        n: items.length, touching: kids.slice(1).filter((b, i) => b.left < kids[i].right + 1).length,
        clipped: kids.filter((b) => b.right > rowRight + 0.5).length,
        lastText: (items.at(-1)?.textContent ?? '').trim(),
        firstClipped: !!first && first.scrollWidth > first.clientWidth + 0.5,
        firstEllipsis: !!first && getComputedStyle(first).textOverflow === 'ellipsis',
        lastClipped: !!items.at(-1) && items.at(-1).scrollWidth > items.at(-1).clientWidth + 0.5,
      };
    }, kidId);
    check(`(h) two FOOT items in kid's card, both shown, the second readable, and the first ellipsised when cut (${tag})`,
      foot.n >= 2 && foot.touching === 0 && foot.clipped === 0 && foot.lastText.length > 0 && !foot.lastClipped && (!foot.firstClipped || foot.firstEllipsis), JSON.stringify(foot));
    const shape = await sys.p.evaluate(footShape, kidId)
    check(`(h) the short FOOT item keeps its box at its text plus the gap, Activity then Tests (${tag})`, shortKeeps(shape), JSON.stringify(shape))
    await sys.p.screenshot({ path: `${out}/${tag}-h-two-foot.png` });
    // (h) reversed: Activity moves after Tests (keys: Space, ArrowRight, Space). Tests stays whole, Activity ends in "…", and the row stays in the card.
    await p.locator('.ice-row[data-slot="FOOT"] [data-item="activity"]').focus();
    await p.keyboard.press('Space');
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('Space');
    const reversed = await settleAgent((l) => JSON.stringify(l.slots?.FOOT) === JSON.stringify(['tests', 'activity']));
    check(`(h) FOOT is Tests then Activity once Activity is moved (${tag})`, JSON.stringify(reversed?.slots?.FOOT) === JSON.stringify(['tests', 'activity']), JSON.stringify(reversed?.slots?.FOOT));
    await sys.p.reload();
    await sys.p.waitForSelector('.sv-card[data-card]', { timeout: 20000 });
    await sys.p.getByRole('button', { name: 'Fit' }).click();
    await sys.p.waitForTimeout(1500);
    const rev = await sys.p.evaluate((id) => {
      const card = document.querySelector(`.sv-card[data-card="${id}"]`);
      const row = card?.querySelector('.sv-r4');
      const items = row ? [...row.children] : [];
      const cr = card?.getBoundingClientRect();
      const rr = row?.getBoundingClientRect();
      const [tests, activity] = items;
      return {
        n: items.length,
        testsText: (tests?.textContent ?? '').trim(), testsClipped: !!tests && tests.scrollWidth > tests.clientWidth + 0.5,
        activityClipped: !!activity && activity.scrollWidth > activity.clientWidth + 0.5,
        activityEllipsis: !!activity && getComputedStyle(activity).textOverflow === 'ellipsis',
        rowInCard: !!cr && !!rr && rr.left >= cr.left - 0.5 && rr.right <= cr.right + 0.5,
      };
    }, kidId);
    check(`(h) reversed: Tests is whole, Activity ends in "…" when cut, the row is in the card (${tag})`,
      rev.n === 2 && rev.testsText.length > 0 && !rev.testsClipped && (!rev.activityClipped || rev.activityEllipsis) && rev.rowInCard, JSON.stringify(rev));
    await sys.p.screenshot({ path: `${out}/${tag}-h-two-foot-reversed.png` });
    const revShape = await sys.p.evaluate(footShape, kidId)
    check(`(h) the short FOOT item keeps its box at its text plus the gap, Tests then Activity (${tag})`, shortKeeps(revShape), JSON.stringify(revShape))
    // (h) both long: the two texts are made longer than the row on this measurement page only. Each ends in "…" and gets at least 40% of the row.
    await sys.p.evaluate((id) => {
      const items = [...(document.querySelector(`.sv-card[data-card="${id}"] .sv-r4`)?.children ?? [])]
      items.forEach((el, i) => { el.textContent = i ? 'Tests: 1 failed of 14 and more words after it so that it cannot fit the row' : 'waiting for your reply on a long activity line that runs well past the row' })
    }, kidId)
    const both = await sys.p.evaluate(footShape, kidId)
    check(`(h) both FOOT items long: each ends in "…" and gets at least 40% of the row (${tag})`,
      both.length === 2 && both.every((r) => r.clipped && r.ellipsis && r.box >= 0.4 * r.rowW), JSON.stringify(both))
    await p.locator('.ice-foot .btn').click();
    await settleAgent((l) => JSON.stringify(l.slots?.FOOT) === JSON.stringify(['activity']));
    // (e) After a reload, the editor draws the saved layout.
    const after = await settleAgent((l) => (l.slots?.ISSUE ?? []).length === 1);
    const drawnBadges = await p.evaluate(() => [...document.querySelectorAll('.ice-row[data-slot="BADGES"] [data-item]')].map((e) => e.dataset.item));
    check(`(e) reload keeps the badge order (${tag})`, JSON.stringify(drawnBadges) === JSON.stringify(after?.slots?.BADGES), JSON.stringify(drawnBadges));
    await noSideways(p, `desk ${scheme}`);
    await ctx.close();
    await sys.ctx.close();
  }

  // Phone: (d) the tab list and the ⋯ sheet, each item the topmost element at its centre; (e) reload; (f) no sideways scroll.
  for (const width of [360, 430]) for (const scheme of only) {
    const tag = `${width}-${scheme}`;
    const device = width === 360 ? devices['Pixel 7'] : devices['iPhone 15'];
    const { ctx, p } = await newPage(scheme, width, device, 'cfg=fields/agent');
    await p.waitForSelector('.ipe-row', { timeout: 20000 });
    const tabs = await p.locator('.wcol-tabs [role=tab]').evaluateAll((els) => els.map((e) => e.textContent).join(' | '));
    check(`(d) the tab list has the Agent card tab (${tag})`, tabs.endsWith('Agent card'), tabs);
    await p.locator('.ipe-foot .btn').tap();
    await settleAgent((l) => JSON.stringify(l.slots?.BADGES) === JSON.stringify(DEFAULT_BADGES));
    await p.locator('[data-item="health"] [data-act=menu]').tap();
    await p.waitForSelector('.ipe-sheet', { timeout: 8000 });
    // Let the sheet finish its entrance (the fade and the slide), and drop the tap's focus, before the hit test and the shot.
    check(`(d) the agent ⋯ sheet has faded in before its hit test (${tag})`, await settled(p, '.ipe-sheet'));
    await p.evaluate(() => document.activeElement?.blur());
    await p.mouse.move(0, 0);
    await p.waitForTimeout(300);
    const topmost = await p.evaluate(() => [...document.querySelectorAll('.ipe-sheet-item')].map((el) => {
      const b = el.getBoundingClientRect();
      const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { text: el.textContent.trim().slice(0, 24), ok: !!top && (top === el || el.contains(top)) };
    }));
    check(`(d) every sheet item is the topmost element at its centre (${tag})`, topmost.length > 0 && topmost.every((t) => t.ok), JSON.stringify(topmost.filter((t) => !t.ok)));
    // The sheet is opaque (no row behind shows through), and it ends above the bottom bar (its Assistant button).
    const sheetLook = await p.evaluate(() => {
      // The sheet's surface is the popover (.menu.popover) around the list (.ipe-sheet), which has no background of its own.
      const sheet = document.querySelector('.menu.popover');
      const bg = getComputedStyle(sheet).backgroundColor;
      const bar = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Assistant');
      // The bar's centre: the topmost element there is the sheet or its scrim, not the bar's button.
      const r = bar ? bar.getBoundingClientRect() : null;
      const top = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      const last = [...document.querySelectorAll('.menu.popover .ipe-sheet-item')].pop();
      const lb = last ? last.getBoundingClientRect() : null;
      return {
        bg, opaque: !/rgba\(|transparent/.test(bg) || /rgba\([^)]*,\s*1\)/.test(bg),
        barTopmost: !!top && !!bar && !(top === bar || bar.contains(top)) && !!top.closest('.menu.popover, [class*="scrim"]'),
        lastIn: !!lb && lb.top >= 0 && lb.bottom <= innerHeight,
      };
    });
    check(`(d) the sheet is opaque (${tag})`, sheetLook.opaque, sheetLook.bg);
    check(`(d) the bottom bar's centre is the sheet or its scrim, not the bar (${tag})`, sheetLook.barTopmost);
    check(`(d) the sheet's last item is fully in the viewport (${tag})`, sheetLook.lastIn);
    await p.screenshot({ path: `${out}/${tag}-d-sheet.png` });
    await p.evaluate(() => document.querySelector('.menu.popover .ipe-sheet-item:last-child')?.click());
    await p.waitForTimeout(400);
    await noSideways(p, `phone ${tag}`);
    await p.screenshot({ path: `${out}/${tag}-f-agent.png` });
    // (e) The reload draws the layout saved after a Hide.
    const saved = await settleAgent((l) => JSON.stringify(l.slots?.BADGES) === JSON.stringify(['review', 'tests']));
    check(`(d) Hide from the sheet removes Health from Badges (${tag})`, JSON.stringify(saved?.slots?.BADGES) === JSON.stringify(['review', 'tests']), JSON.stringify(saved?.slots?.BADGES));
    await p.reload();
    await p.waitForSelector('.ipe-row', { timeout: 20000 });
    const drawn = await p.evaluate(() => [...document.querySelectorAll('section[aria-label="Badges"] [data-item]')].map((e) => e.dataset.item));
    check(`(e) reload draws the saved badges (${tag})`, JSON.stringify(drawn) === JSON.stringify(saved?.slots?.BADGES ?? []), JSON.stringify(drawn));
    if (width === 360) {
      // (h) Two FOOT items at 360 px: Health moves to FOOT from its ⋯ sheet, and the system view's kid card shows the two apart.
      await p.locator('.ipe-foot .btn').tap();
      await settleAgent((l) => JSON.stringify(l.slots?.BADGES) === JSON.stringify(DEFAULT_BADGES));
      await p.locator('[data-item="tests"] [data-act=menu]').tap();
      await p.locator('.menu.popover .ipe-sheet-item', { hasText: 'Move to Foot' }).tap();
      await settleAgent((l) => (l.slots?.FOOT ?? []).length === 2);
      const sys360 = await newPage(scheme, 360, device, 'view=system&mode=tree');
      await sys360.p.waitForSelector('.sv-card[data-card]', { timeout: 20000 });
      // Pan the stage left by a drag on its empty space, so kid's card sits clear of the zoom buttons at the right.
      await sys360.p.mouse.move(340, 330);
      await sys360.p.mouse.down();
      await sys360.p.mouse.move(240, 330, { steps: 12 });
      await sys360.p.mouse.move(140, 330, { steps: 12 });
      await sys360.p.mouse.up();
      await sys360.p.waitForTimeout(1200);
      const foot360 = await sys360.p.evaluate((id) => {
        const card = document.querySelector(`.sv-card[data-card="${id}"]`);
        const items = card ? [...card.querySelectorAll('.sv-r4 > *')] : [];
        const kids = items.map((k) => k.getBoundingClientRect());
        const rowRight = card?.querySelector('.sv-r4')?.getBoundingClientRect().right ?? 0;
        const first = items[0];
        return {
          n: items.length, touching: kids.slice(1).filter((b, i) => b.left < kids[i].right + 1).length,
          clipped: kids.filter((b) => b.right > rowRight + 0.5).length,
          lastText: (items.at(-1)?.textContent ?? '').trim(),
          firstClipped: !!first && first.scrollWidth > first.clientWidth + 0.5,
          firstEllipsis: !!first && getComputedStyle(first).textOverflow === 'ellipsis',
          lastClipped: !!items.at(-1) && items.at(-1).scrollWidth > items.at(-1).clientWidth + 0.5,
          inView: !!card && card.getBoundingClientRect().right <= innerWidth && card.getBoundingClientRect().bottom <= innerHeight,
        };
      }, kidId);
      check(`(h) two FOOT items in kid's card at 360 px, the second readable, the first ellipsised when cut, the card in view (${tag})`,
        foot360.n >= 2 && foot360.touching === 0 && foot360.clipped === 0 && foot360.lastText.length > 0 && !foot360.lastClipped && (!foot360.firstClipped || foot360.firstEllipsis) && foot360.inView, JSON.stringify(foot360));
      const shape360 = await sys360.p.evaluate(footShape, kidId)
      check(`(h) at 360 px the short FOOT item keeps its box at its text plus the gap, Activity then Tests (${tag})`, shortKeeps(shape360), JSON.stringify(shape360))
      await sys360.p.screenshot({ path: `${out}/${tag}-h-two-foot.png` });
      await sys360.ctx.close();
      // (h) reversed at 360 px: Tests moves up before Activity (its ↑), so FOOT is Tests then Activity.
      await p.locator('section[aria-label="Foot"] [data-item="tests"] [data-act=up]').tap();
      await settleAgent((l) => JSON.stringify(l.slots?.FOOT) === JSON.stringify(['tests', 'activity']));
      const rev360Page = await newPage(scheme, 360, device, 'view=system&mode=tree');
      await rev360Page.p.waitForSelector('.sv-card[data-card]', { timeout: 20000 });
      await rev360Page.p.mouse.move(340, 330);
      await rev360Page.p.mouse.down();
      await rev360Page.p.mouse.move(240, 330, { steps: 12 });
      await rev360Page.p.mouse.move(140, 330, { steps: 12 });
      await rev360Page.p.mouse.up();
      await rev360Page.p.waitForTimeout(1200);
      const rev360 = await rev360Page.p.evaluate((id) => {
        const card = document.querySelector(`.sv-card[data-card="${id}"]`);
        const row = card?.querySelector('.sv-r4');
        const items = row ? [...row.children] : [];
        const cr = card?.getBoundingClientRect();
        const rr = row?.getBoundingClientRect();
        const [tests, activity] = items;
        return {
          n: items.length,
          testsText: (tests?.textContent ?? '').trim(), testsClipped: !!tests && tests.scrollWidth > tests.clientWidth + 0.5,
          activityClipped: !!activity && activity.scrollWidth > activity.clientWidth + 0.5,
          activityEllipsis: !!activity && getComputedStyle(activity).textOverflow === 'ellipsis',
          rowInCard: !!cr && !!rr && rr.left >= cr.left - 0.5 && rr.right <= cr.right + 0.5,
          inView: !!cr && cr.left >= 0 && cr.right <= innerWidth && cr.bottom <= innerHeight,
        };
      }, kidId);
      check(`(h) reversed at 360 px: Tests is whole, Activity ends in "…" when cut, the row is in the card, the card in view (${tag})`,
        rev360.n === 2 && rev360.testsText.length > 0 && !rev360.testsClipped && (!rev360.activityClipped || rev360.activityEllipsis) && rev360.rowInCard && rev360.inView, JSON.stringify(rev360));
      const revShape360 = await rev360Page.p.evaluate(footShape, kidId)
      check(`(h) at 360 px the short FOOT item keeps its box at its text plus the gap, Tests then Activity (${tag})`, shortKeeps(revShape360), JSON.stringify(revShape360))
      await rev360Page.p.screenshot({ path: `${out}/${tag}-h-two-foot-reversed.png` });
      await rev360Page.ctx.close();
      await p.locator('.ipe-foot .btn').tap();
      await settleAgent((l) => JSON.stringify(l.slots?.FOOT) === JSON.stringify(['activity']));
    }
    await ctx.close();
  }
}
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all card-editor checks passed');
process.exit(failed ? 1 : 0);
