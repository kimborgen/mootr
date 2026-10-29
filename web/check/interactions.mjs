// Browser checks of the web UI's drag and send interactions, with real mouse drags (HTML5
// drag and drop through Playwright) and the keyboard:
//   node web/check/interactions.mjs BASE_URL OUT_DIR [tabs] [rank] [spawn] [types] [tools] [steps] [archive] [cos] [mail] [search] [suggest] [itsa] [board] [work] [legend] [itsalinks] [itsachip] [term] [machines] [system] [rules] [back] [attention] [assistant] [layout] [requirements] [permissions]
// BASE_URL carries the token (web/check/daemon.sh prints one); the checks write (mail, an
// assistant), so it must be a throwaway daemon. With no flow named, tabs, rank, and spawn
// run; spawn adds agents with no prompt, so it costs nothing; cos and mail post to a paused agent, free; assistant runs on the fake
// Claude Code (daemon.sh), so it costs nothing. Screenshots land in OUT_DIR/<flow>-<step>.png. Exits 1 if a check fails.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { findPlaywright } from './find-playwright.mjs';

const [base, out, ...flows] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node interactions.mjs BASE_URL OUT_DIR [tabs] [rank] [spawn] [types] [tools] [steps] [archive] [cos] [mail] [search] [itsa] [board] [work] [legend] [term] [machines] [rules] [back] [attention] [assistant] [layout] [permissions]'); process.exit(2); }
if (!flows.length) flows.push('tabs', 'rank', 'spawn', 'types', 'tools', 'steps', 'archive', 'cos', 'mail', 'maillink', 'search', 'suggest', 'itsa', 'board', 'work', 'legend', 'itsalinks', 'itsachip', 'itsamail', 'itsabeside', 'term', 'machines', 'system', 'rules', 'back', 'attention', 'layout', 'retros');
mkdirSync(out, { recursive: true });

const { chromium } = findPlaywright();

const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
// The test key stands in for tailscale serve, the only proof of the human for config writes (S-230).
// A write that names helper or kid (by or from) goes with that agent's own token (daemon.sh's agents=, S-545).
const agentTokens = JSON.parse(new URLSearchParams(u.hash.slice(1)).get('agents') || '{}');
const ownToken = (body) => { try { const b = JSON.parse(body); return agentTokens[b.by ?? b.from]; } catch { return undefined; } };
const api = (path, init) => fetch(origin + path, { ...init, headers: { authorization: 'Bearer ' + (ownToken(init?.body) || token), 'x-stam-human': '1', 'content-type': 'application/json', ...(testHuman ? { 'x-stam-test-human': testHuman } : {}) } }).then((r) => r.json());

let failures = 0;
const check = (ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};
const same = (got, want, what) => check(JSON.stringify(got) === JSON.stringify(want), what, got);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Records the requests a page makes from now on; the result counts one "METHOD /path" (S-151).
function watch(p) {
  const seen = [];
  p.on('request', (r) => seen.push(r.method() + ' ' + new URL(r.url()).pathname));
  return (what) => seen.filter((x) => x === what).length;
}

const browser = await chromium.launch(chromiumLaunchOptions());
const agents = await api('/api/agents');
const helper = agents.find((a) => a.name === 'helper');
if (!helper) { console.error('no agent named helper: use a daemon from web/check/daemon.sh'); process.exit(2); }

// The daemon keeps one layout for every page; each flow starts from the default one.
async function resetLayout() {
  const l = await api('/api/layout');
  const ops = [...Object.keys(l.agentWorlds).map((world) => ({ op: 'dropWorld', world })), { op: 'current', world: null }];
  await api('/api/layout/ops', { method: 'POST', body: JSON.stringify({ ops }) });
  // The sidebar's pane layout is a setting; a flow that switched a tab leaves the defaults for the next.
  await api('/api/config/settings', { method: 'PATCH', body: JSON.stringify({ patch: { sidebarPanes: { main: null } } }) });
}
// Shows a sidebar pane's tab on a desktop page (S-1421); a phone page and a tab already showing are left alone.
// A tab with a page also opens that page (S-1428); these checks are about the sidebar, so main goes back to the world it showed.
async function sideTab(p, id) {
  const tab = p.locator(`#side-panes [role=tab][data-tab="${id}"]`);
  if (!(await tab.count()) || (await tab.getAttribute('aria-selected')) === 'true') return;
  const was = await p.evaluate(() => window.stamDebug.shell.currentWorld());
  await tab.click();
  await p.locator(`#pane-body-${id}`).waitFor({ state: 'visible' });
  if ((await p.evaluate(() => window.stamDebug.shell.currentWorld())) !== was) await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), was);
}
const layoutCurrent = async () => (await api('/api/layout')).current;

// `allow` matches console errors a flow causes on purpose. `keep` leaves the layout as the
// pages before left it.
// True while a check makes the daemon refuse a request on purpose: its 500 is expected in the console.
let refusing = false
// The POST /api/mail refusals the flow makes on purpose. Each one counts before its response is sent,
// so the console error that reports it is matched by count, whenever the browser reports it.
// Its location isn't checked: the message can land with another URL or none (S-307).
const refusedMail = { sent: 0, seen: 0 };
const refusedMailError = (m) => {
  if (m.type() !== 'error' || !/status of (500|409)/.test(m.text()) || refusedMail.seen >= refusedMail.sent) return false;
  refusedMail.seen++;
  return true;
};
// Waits, on the count and not the clock, until the console has reported every refusal sent so far;
// a step stops expecting those errors (`refusing = false`) only after this (S-307).
const refusalsLogged = async (ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (refusedMail.seen >= refusedMail.sent) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return refusedMail.seen >= refusedMail.sent;
};

async function page(size = { width: 1500, height: 900 }, allow = null, theme = 'light', keep = false) {
  if (!keep) await resetLayout();
  const ctx = await browser.newContext({ viewport: size, colorScheme: theme });
  // The prompt input asks whether voice is configured; the check's daemon has no key, and this
  // route is the human's (no test header here), so the answer is stubbed: no mic button, no 403.
  await ctx.route('**/api/voice', (r) => (r.request().url().endsWith('/api/voice') ? r.fulfill({ contentType: 'application/json', body: '{"configured":false}' }) : r.fallback()));
  // The page's saves of settings, instructions, templates and types are the human's: the test key goes with them.
  // An approval of a suggested input is the human's too (S-429), so it goes with the test key.
  if (testHuman) await ctx.route(/\/api\/(config|templates|types)\/|\/api\/permission-modes\/apply$|\/api\/permissions\/[^/]+\/answer$|\/api\/requirements\/asks\/[\w-]+\/drop$/, (r) => (r.request().method() === 'GET' ? r.fallback() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } })));
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); } catch {} }, theme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => check(false, 'no page error', e.message));
  // Chromium logs a permissions-policy notice about compute-pressure that isn't ours.
  p.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure/.test(m.text()) && !refusedMailError(m) && !(refusing && /status of 500/.test(m.text())) && !allow?.test(m.text())) check(false, 'no console error', m.text()); });
  p.on('dialog', (d) => d.dismiss());
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  await p.waitForTimeout(1500);
  return p;
}
const shot = (p, name) => p.screenshot({ path: `${out}/${name}.png` });

// A real mouse drag: press on FROM, move in steps to TO ({x, y}), pause so the drop preview
// shows, release. `mid` runs while the button is down.
async function drag(p, from, to, mid) {
  const b = await (typeof from.boundingBox === 'function' ? from.boundingBox() : from);
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x + 6, y + 6, { steps: 3 });
  await p.mouse.move(to.x, to.y, { steps: 12 });
  await p.waitForTimeout(250);
  if (mid) await mid();
  await p.mouse.up();
  await p.waitForTimeout(500);
}

// --- Tabs ---------------------------------------------------------------------------------
async function tabs() {
  console.log('# tabs');
  const p = await page();
  const node = p.locator('#tree .node:has(.name:text-is("helper"))').first();
  // The tree shows one short model code per row, all in one fixed-width slot, with the full
  // model name still in the row tooltip.
  const codes = await p.locator('#tree .node .chip').allTextContents();
  check(codes.length >= 2 && codes.every((t) => /^[A-Z]/.test(t.trim())), 'the tree shows a short model code on every row', codes.join(' '));
  const codeWidths = await p.locator('#tree .node .chip').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  check(new Set(codeWidths).size === 1, 'every model code takes the same width', codeWidths.join(', '));
  check(/claude-haiku-5-5/.test(await node.getAttribute('title') ?? ''), 'the full model name is still in the row tooltip');
  await shot(p, 'tree-1-model-codes');
  await node.click();
  for (const l of ['Details', 'Inbox']) { await node.click({ button: 'right' }); await p.getByRole('menuitem', { name: l }).first().click(); await p.waitForTimeout(400); }
  const id = helper.id;
  const A = `agent:${id}`, D = `details:${id}`, M = `mail:${id}`;
  // The layout: one entry per pane in document order, "left,top WxH: tab, tab*" (* active).
  const layout = () => p.locator('.pane').evaluateAll((ps) => ps.map((x) => ({ id: x.dataset.id, r: x.getBoundingClientRect(), tabs: [...x.querySelectorAll('.tab')].map((t) => t.dataset.key + (t.classList.contains('active') ? '*' : '')), focused: x.classList.contains('focused') })));
  const keys = async () => (await layout()).map((l) => l.tabs.map((t) => t.replace('*', '')));
  const tab = (k) => p.locator(`.tab[data-key="${k}"]`);
  const pane = async (i) => (await layout())[i].r;
  const to = (r, fx, fy) => ({ x: r.x + r.width * fx, y: r.y + r.height * fy });

  same(await keys(), [[A, D, M]], 'one pane holds the agent, details, and inbox tabs');
  await shot(p, 'tabs-1-one-pane');

  // Reorder inside the pane: the inbox tab to the front, then back to the end.
  let r = await pane(0);
  const tb = await tab(A).boundingBox();
  await drag(p, tab(M), { x: tb.x + 8, y: tb.y + tb.height / 2 });
  same(await keys(), [[M, A, D]], 'dragging a tab onto the left half of the first tab puts it first');
  const db = await tab(D).boundingBox();
  await drag(p, tab(M), { x: db.x + db.width - 4, y: db.y + db.height / 2 });
  same(await keys(), [[A, D, M]], 'dragging it onto the right half of the last tab puts it last');
  await drag(p, tab(D), { x: r.x + r.width - 30, y: tb.y + tb.height / 2 });
  same(await keys(), [[A, M, D]], 'dropping on the empty tab strip puts the tab last');
  // Dropping a tab on its own place keeps it there.
  const mb = await tab(M).boundingBox();
  await drag(p, tab(M), { x: mb.x + 6, y: mb.y + mb.height / 2 });
  same(await keys(), [[A, M, D]], 'dropping a tab on its own left half leaves the order alone');
  await drag(p, tab(M), { x: mb.x + mb.width - 6, y: mb.y + mb.height / 2 });
  same(await keys(), [[A, M, D]], 'dropping a tab on its own right half leaves the order alone');
  await drag(p, tab(D), { x: mb.x + 6, y: mb.y + mb.height / 2 });
  same(await keys(), [[A, D, M]], 'details dragged before the inbox');
  await drag(p, tab(M), to(r, 0.5, 0.5));
  same(await keys(), [[A, D, M]], 'dropping a tab on its own pane body leaves the order alone');

  // To each split edge: a new pane on that side, the dragged tab alone in it.
  for (const [side, fx, fy, axis] of [['right', 0.97, 0.5, 'x'], ['left', 0.03, 0.5, 'x'], ['down', 0.5, 0.97, 'y'], ['up', 0.5, 'below the tab strip', 'y']]) {
    r = await pane(0);
    let sawPreview = false;
    // The top edge starts under the tab strip, which is a drop zone of its own.
    const target = fy === 'below the tab strip' ? { x: r.x + r.width * fx, y: await p.locator('.pane .tabbar').first().boundingBox().then((b) => b.y + b.height + 12) } : to(r, fx, fy);
    await drag(p, tab(M), target, async () => { sawPreview = (await p.locator('.drop-preview').count()) > 0; if (side === 'right') await shot(p, 'tabs-2-edge-preview'); });
    const ls = await layout();
    check(sawPreview, `a drop preview shows over the ${side} edge`);
    check(ls.length === 2, `dropping on the ${side} edge splits the pane`, ls.map((l) => l.tabs));
    if (ls.length === 2) {
      const [a, b] = ls;
      const mine = ls.find((l) => l.tabs.join() === M + '*');
      check(!!mine, `the dragged tab sits alone in the new ${side} pane`, ls.map((l) => l.tabs));
      if (mine) {
        const other = ls.find((l) => l !== mine);
        const before = axis === 'x' ? mine.r.x < other.r.x : mine.r.y < other.r.y;
        check(before === (side === 'left' || side === 'up'), `the new pane is on the ${side}`, { new: mine.r, other: other.r });
      }
      check(ls.find((l) => l.tabs.length === 2)?.tabs.map((t) => t.replace('*', '')).join() === A + ',' + D, 'the other pane keeps the other two tabs in order', ls.map((l) => l.tabs));
    }
    if (side === 'right') await shot(p, 'tabs-3-split-right');
    // Back: drop the tab on the strip of the pane that kept the others; the empty pane closes.
    const rest = (await layout()).find((l) => l.tabs.length === 2);
    const strip = await p.locator(`.pane[data-id="${rest.id}"] .tabbar`).boundingBox();
    await drag(p, tab(M), { x: strip.x + strip.width - 20, y: strip.y + strip.height / 2 });
    same(await keys(), [[A, D, M]], `dragging the ${side} pane's tab back to the other pane's strip merges them`);
  }

  // A tab to another pane's body (not an edge): a new tab at its end; a source pane left empty closes.
  r = await pane(0);
  await drag(p, tab(M), to(r, 0.97, 0.5));
  r = await pane(0);
  const ls0 = await layout();
  const keep = ls0.find((l) => l.tabs.length === 2);
  await drag(p, tab(D), to(ls0.find((l) => l.tabs.length === 1).r, 0.5, 0.5));
  same((await keys()).map((x) => x.slice().sort()), [[A], [D, M].sort()], 'dropping a tab on another pane\'s body moves it there');
  const after = await layout();
  check(after.find((l) => l.tabs.some((t) => t.startsWith(D)))?.tabs.at(-1).startsWith(D) && after.find((l) => l.tabs.some((t) => t.startsWith(D))).tabs.at(-1).endsWith('*'), 'the moved tab is last and active there', after.map((l) => l.tabs));
  await shot(p, 'tabs-4-moved-between-panes');
  // Focus follows a click inside a pane's content.
  const first = (await layout())[0];
  await p.mouse.click(first.r.x + 60, first.r.y + first.r.height / 2);
  const f1 = (await layout()).map((l) => l.focused);
  const second = (await layout())[1];
  await p.mouse.click(second.r.x + second.r.width / 2, second.r.y + second.r.height / 2);
  const f2 = (await layout()).map((l) => l.focused);
  check(f1[0] && !f1[1] && !f2[0] && f2[1], 'clicking in a pane\'s content focuses that pane', { f1, f2 });
  // Closing the last tab of a pane closes the pane.
  while ((await layout()).length > 1) {
    const l = (await layout()).at(-1);
    await p.locator(`.pane[data-id="${l.id}"] .tab .close`).first().click();
    await p.waitForTimeout(200);
  }
  check((await layout()).length === 1, 'closing a pane\'s tabs closes the pane');

  // An agent dragged in from the tree: to an edge it splits; to the strip it adds a tab.
  const kid = agents.find((a) => a.name === 'kid');
  const kidNode = p.locator('#tree .node:has(.name:text-is("kid"))').first();
  r = await pane(0);
  await drag(p, kidNode, to(r, 0.97, 0.5));
  let ls = await layout();
  check(ls.length === 2 && ls.some((l) => l.tabs.join() === `agent:${kid.id}*`), 'dragging an agent from the tree to the right edge opens it in a new pane', ls.map((l) => l.tabs));
  await shot(p, 'tabs-5-agent-from-tree');
  // The layout persists across a reload.
  await p.reload();
  await p.waitForSelector('#tree .node');
  await p.waitForTimeout(1500);
  same((await layout()).map((l) => l.tabs.length), ls.map((l) => l.tabs.length), 'the layout survives a reload');
  await p.context().close();
}

// --- Rank ---------------------------------------------------------------------------------
async function rank() {
  console.log('# rank');
  // The flow seeds its own one-message thread with a ranking, as the rules flow does (S-104,
  // S-127). Other flows reply into the shared "Check: decisions" thread, and once it holds more
  // than three messages its first one folds and renders no decision block.
  const F = '```';
  const t = await api('/api/mail', { method: 'POST', body: JSON.stringify({ from: agents.find((a) => a.name === 'kid').id, to: ['human'], new_thread: true, subject: `Check: rank ${Date.now() % 100000}`, body: `TLDR: Order the work for me.\n\n${F}rank\nOrder the work\n- Auth: first\n- Billing\n- Search (recommended)\n${F}` }) });
  const p = await page();
  await p.locator(`[data-thread="${t.thread_id}"]`).first().click();
  await p.waitForSelector('.mb-decision.rank');
  await p.waitForTimeout(800);
  // Scoped to the visible thread view, so a hidden copy (an archived thread's) can't match.
  const block = p.locator('.thread-view:visible .mb-decision.rank').first();
  await block.evaluate((b) => b.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(300);
  const order = () => block.locator('.mb-rrow').evaluateAll((rs) => rs.map((r) => r.dataset.rank));
  // A drag or an arrow stages the order, and a poll's re-render can restore the previous one
  // for a frame; wait for the order the step means to see instead of reading it on a timer.
  const sameOrder = async (want, what) => {
    for (let i = 0; i < 50; i++) {
      const got = await order();
      if (got.join() === want.join()) return check(true, what);
      await p.waitForTimeout(100);
    }
    check(false, what, await order());
  };
  const row = (label) => block.locator(`.mb-rrow[data-rank="${label}"] .mb-opt-text`);
  const rowBox = (label) => block.locator(`.mb-rrow[data-rank="${label}"]`).boundingBox();
  const preview = () => p.locator('.thread-view:visible .reply-preview:not([hidden]) .md').first().innerText().then((x) => x.replace(/\s+/g, ' ').trim()).catch(() => '');
  const sendBtn = p.locator('#w-bottom .cmp-send');
  same(await order(), ['Auth', 'Billing', 'Search'], 'the rows start in the order the agent suggested');
  check(await sendBtn.isDisabled(), 'nothing is staged, so Send is off');
  // S-102: a plain reply needs no preview; only a staged decision answer or note gets one.
  const replyText = p.locator('#w-bottom textarea');
  await replyText.fill('Notes with no decision attached.');
  await p.waitForTimeout(150);
  check(await p.locator('.reply-preview:not([hidden])').count() === 0, 'plain text alone shows no preview');
  await replyText.fill('');
  await shot(p, 'rank-1-start');

  // Drag the last row above the first: rows move while dragging; the drop stages the order.
  const first = await rowBox('Auth');
  await drag(p, row('Search'), { x: first.x + 100, y: first.y + 4 }, async () => { same(await order(), ['Search', 'Auth', 'Billing'], 'the row moves while it is dragged'); await shot(p, 'rank-2-dragging'); });
  await sameOrder(['Search', 'Auth', 'Billing'], 'dropping the last row on the first puts it first');
  check(/Ranked: 1\. Search, 2\. Auth, 3\. Billing\./.test(await preview()), 'the preview shows the staged ranking', await preview());
  check(await sendBtn.isEnabled(), 'Send is on once an order is staged');
  check(await block.evaluate((b) => b.classList.contains('staging')), 'the block shows it has a staged answer');
  check(await block.locator('[data-rank-keep]').evaluate((b) => b.classList.contains('staged')), 'Keep this order shows as staged');
  await shot(p, 'rank-3-staged-by-drag');

  // A drop on the lower half of a row puts the dragged row after it.
  const mid = await rowBox('Auth');
  await drag(p, row('Search'), { x: mid.x + 100, y: mid.y + mid.height - 4 });
  await sameOrder(['Auth', 'Search', 'Billing'], 'dropping on the lower half of a row puts the dragged row after it');
  check(/Ranked: 1\. Auth, 2\. Search, 3\. Billing\./.test(await preview()), 'the preview follows', await preview());

  // The arrow buttons.
  // The arrows show on hover.
  const move = async (label, dir) => { await block.locator(`.mb-rrow[data-rank="${label}"]`).hover(); await block.locator(`.mb-rrow[data-rank="${label}"] [data-rank-move="${dir}"]`).click(); };
  await move('Auth', 1);
  await sameOrder(['Search', 'Auth', 'Billing'], 'Move down on the first row swaps it with the second');
  await move('Billing', -1);
  await sameOrder(['Search', 'Billing', 'Auth'], 'Move up on the last row swaps it with the one before');
  check(/Ranked: 1\. Search, 2\. Billing, 3\. Auth\./.test(await preview()), 'the preview follows the arrows', await preview());
  check(await block.locator('.mb-rrow').first().locator('[data-rank-move="-1"]').isHidden() && await block.locator('.mb-rrow').last().locator('[data-rank-move="1"]').isHidden(), 'the first row has no Move up and the last no Move down');
  await shot(p, 'rank-4-staged-by-arrows');

  // Send: the reply quotes the question and carries the order; the block is answered.
  const had = (await api('/api/threads/' + t.thread_id)).length;
  await p.locator('#w-bottom textarea').fill('Search first, it blocks the rest.');
  check(/Search first/.test(await preview()), 'typed context joins the preview', await preview());
  await sendBtn.click();
  // The reply archives the thread and opens the next mail (the app's own archive-and-advance, after
  // the POST resolves). Wait until the app has left the thread and the API lists it as archived,
  // then reopen it (it waits in Awaiting) to check its block.
  let mails;
  for (let i = 0; i < 80; i++) {
    const left = await p.evaluate(() => window.stamDebug.shell.currentWorld()) !== 't:' + t.thread_id;
    const gone = !(await api('/api/agents/human/threads?limit=60')).some((x) => x.thread_id === t.thread_id);
    mails = await api('/api/threads/' + t.thread_id);
    if (left && gone && mails.length === had + 1) break;
    await sleep(250);
  }
  await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 't:' + t.thread_id);
  await p.waitForSelector('.thread-view:visible .mb-decision.rank.answered');
  const reply = mails.at(-1);
  check(mails.length === had + 1 && reply.from_id === 'human', 'one reply from you joins the thread', mails.map((m) => m.from_id));
  check(reply.body.includes('Ranked: 1. **Search**, 2. **Billing**, 3. **Auth**.') && reply.body.includes('Order the work') && reply.body.includes('Search first'), 'the reply holds the question, the order, and the context', reply.body);
  check(reply.recipients.some((r) => r.id === agents.find((a) => a.name === 'kid').id), 'it goes to the agent that asked', reply.recipients);
  same(await order(), ['Search', 'Billing', 'Auth'], 'the answered block keeps the order');
  check((await block.locator('.mb-status').innerText()).includes('You ranked: Search, Billing, Auth.'), 'the status line says what you ranked', await block.locator('.mb-status').innerText());
  check(await block.locator('.mb-rrow').evaluateAll((rs) => rs.every((r) => !r.draggable)), 'answered rows no longer drag');
  check(await sendBtn.isDisabled() && !(await preview()), 'the preview clears and Send is off after sending');
  await shot(p, 'rank-5-sent');
  await p.reload();
  await p.waitForSelector('.thread-view:visible .mb-decision.rank.answered');
  same(await order(), ['Search', 'Billing', 'Auth'], 'after a reload the answered block shows your order');
  await p.context().close();
}

// --- Notes on decisions ------------------------------------------------------------------
// A note per decision block, written in the thread's prompt input in note mode: alone, with
// a chosen option, edited, removed, cancelled with Escape, and sent with the reply.
async function notes() {
  console.log('# notes');
  for (const theme of ['dark', 'light']) {
    const p = await page(undefined, null, theme);
    const threads = await api('/api/agents/human/threads?limit=60');
    const t = threads.find((x) => /^Check: decisions/.test(x.mails[0].subject));
    await p.locator(`[data-thread="${t.thread_id}"]`).first().click();
    await p.waitForSelector('.mb-decision.yesno');
    await p.waitForTimeout(800);
    // Scoped to the visible thread view, so a hidden copy (an archived thread's) can't match.
    const dec = p.locator('.thread-view:visible .mb-decision:not(.multi):not(.rank):not(.yesno)').first();
    const yes = p.locator('.thread-view:visible .mb-decision.yesno').first();
    const pick = p.locator('.thread-view:visible .mb-decision.multi').first();
    const cmp = p.locator('#w-bottom .composer');
    const ta = cmp.locator('textarea');
    const preview = () => p.locator('.reply-preview:not([hidden]) .md').first().innerText().then((x) => x.replace(/\s+/g, ' ').trim()).catch(() => '');
    const noting = () => cmp.evaluate((c) => c.classList.contains('noting'));
    const noteOf = (b) => b.locator('.mb-note-text').innerText().catch(() => '');
    const had = (await api('/api/threads/' + t.thread_id)).length;
    if (theme === 'dark') {
      // The dark run only takes the screenshots; the light run checks and sends.
      await ta.fill('Draft reply.');
      await dec.locator('.mb-foot [data-own]').click();
      await ta.fill('Both 1 hour and 12 hours, per team.');
      await dec.scrollIntoViewIfNeeded();
      await shot(p, 'notes-1-note-mode-dark');
      await ta.press('Enter');
      await yes.locator('.mb-opt').first().click();
      await p.waitForTimeout(200);
      await shot(p, 'notes-2-preview-dark');
      await p.context().close();
      continue;
    }

    // A note alone: Add a note puts the prompt input in note mode for that block.
    await ta.fill('Draft reply.');
    await dec.locator('.mb-foot [data-own]').click();
    check(await noting(), 'Add a note puts the prompt input in note mode');
    check(await ta.evaluate((x) => document.activeElement === x), 'note mode focuses the prompt input');
    check(await ta.inputValue() === '', 'note mode starts empty, the reply draft set aside', await ta.inputValue());
    check(/Note on How long should SSO tokens live\?/.test((await cmp.locator('.cmp-target').innerText()).replace(/\s+/g, ' ')), 'the prompt input names the decision it writes to', await cmp.locator('.cmp-target').innerText());
    check(await cmp.locator('.cmp-send').getAttribute('aria-label') === 'Add note', 'the submit button means Add note');
    check(await dec.evaluate((b) => b.classList.contains('noting')), 'the block shows it is being written to');
    await ta.fill('Both 1 hour and 12 hours, per team.');
    await dec.scrollIntoViewIfNeeded();
    await shot(p, 'notes-1-note-mode');
    await ta.press('Enter');
    check(!(await noting()), 'Enter finishes the note and leaves note mode');
    check(await ta.inputValue() === 'Draft reply.', 'the reply draft comes back', await ta.inputValue());
    check(await noteOf(dec) === 'Both 1 hour and 12 hours, per team.', 'the note shows in its block', await noteOf(dec));
    check(/How long should SSO tokens live\? Note: Both 1 hour and 12 hours, per team\./.test(await preview()), 'the preview quotes the question and the note', await preview());
    check((await api('/api/threads/' + t.thread_id)).length === had, 'nothing is sent');

    // A note with a chosen option.
    await yes.locator('.mb-opt').first().click();
    await yes.locator('.mb-foot [data-own]').click();
    await ta.fill('Cap it at $15.');
    await cmp.locator('.cmp-send').click();
    check(/Chose Yes\. Note: Cap it at \$15\./.test(await preview()), 'a note joins the chosen option', await preview());
    check(await noteOf(yes) === 'Cap it at $15.', 'the second block shows its own note', await noteOf(yes));

    // Escape cancels and leaves the block alone.
    await pick.locator('.mb-foot [data-own]').click();
    await ta.fill('Not this one.');
    await p.keyboard.press('Escape');
    check(!(await noting()) && await pick.locator('.mb-note').count() === 0, 'Escape cancels the note');
    check(await ta.inputValue() === 'Draft reply.', 'after Escape the reply draft is back', await ta.inputValue());

    // Edit starts from the note; the edit replaces it.
    await dec.locator('.mb-note [data-own]').last().click();
    check(await noting() && await ta.inputValue() === 'Both 1 hour and 12 hours, per team.', 'Edit opens note mode with the note', await ta.inputValue());
    await ta.fill('Neither: use 4 hours.');
    await ta.press('Enter');
    check(await noteOf(dec) === 'Neither: use 4 hours.', 'the edited note shows in the block', await noteOf(dec));
    check(/Note: Neither: use 4 hours\./.test(await preview()) && !/Both 1 hour/.test(await preview()), 'the preview follows the edit', await preview());

    // Remove takes the note off and keeps the chosen option.
    await yes.locator('[data-unnote]').click();
    check(await yes.locator('.mb-note').count() === 0, 'Remove takes the note out of the block');
    check(/Chose Yes\./.test(await preview()) && !/Cap it at/.test(await preview()), 'the preview keeps the option without the note', await preview());
    await shot(p, 'notes-2-preview');

    // Send: one reply with each answer and the draft.
    await cmp.locator('.cmp-send').click();
    // The reply archives the thread and opens the next mail (the app's own archive-and-advance, after
    // the POST resolves). Wait until the app has left the thread and the API lists it as archived,
    // then reopen it (it waits in Awaiting) to check its blocks.
    let reply;
    for (let i = 0; i < 80; i++) {
      const left = await p.evaluate(() => window.stamDebug.shell.currentWorld()) !== 't:' + t.thread_id;
      const gone = !(await api('/api/agents/human/threads?limit=60')).some((x) => x.thread_id === t.thread_id);
      reply = (await api('/api/threads/' + t.thread_id)).at(-1);
      if (left && gone && reply?.from_id === 'human') break;
      await sleep(250);
    }
    await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 't:' + t.thread_id);
    await p.waitForSelector('.thread-view:visible .mb-decision.yesno.answered');
    check(reply.from_id === 'human' && reply.body.includes('> How long should SSO tokens live?\n\nNote: Neither: use 4 hours.'), 'the reply quotes the question and carries the note', reply.body);
    check(reply.body.includes('Chose **Yes**.') && !reply.body.includes('Cap it at') && reply.body.includes('Draft reply.'), 'the reply carries the option and the draft, not the removed note', reply.body);
    await p.waitForSelector('.thread-view:visible .mb-decision:not(.multi):not(.rank):not(.yesno).answered');
    check(/You answered with a note\./.test(await dec.locator('.mb-status').innerText()), 'the block says you answered with a note', await dec.locator('.mb-status').innerText());
    check(await dec.locator('.mb-note').count() === 0, 'the sent note leaves the block');
    await shot(p, 'notes-3-sent');
    await p.context().close();
  }
}

// --- Adding an agent ---------------------------------------------------------------------
// The + button's quick menu and the panel with every choice, by keyboard and mouse. The
// agents it adds get no prompt, so they cost nothing; they're stopped at the end.
async function spawnFlow() {
  console.log('# spawn');
  // The taken-name check gets a 409 on purpose.
  const p = await page(undefined, /status of 409/);
  const all = () => api('/api/agents');
  const newest = async (before) => (await all()).find((a) => !before.some((b) => b.id === a.id));
  const made = [];
  const stopLater = (a) => made.push(a);
  const added = async (before, what) => {
    for (let i = 0; i < 40; i++) { const a = await newest(before); if (a) return a; await sleep(250); }
    check(false, what + ': an agent was added');
    return null;
  };
  const items = () => p.locator('.menu [role^=menuitem]').allInnerTexts();
  const focused = () => p.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  const plus = p.locator('#new-agent');

  // The quick menu: the defaults first and focused, then the other presets, then harnesses.
  await plus.click();
  await p.waitForSelector('.menu');
  const first = await items();
  check(/With the defaults/.test(first[0]) && /sonnet 5\.5 · medium/.test(first[0]), 'the first row adds with the defaults and shows their model and effort', first[0]);
  check(/With the defaults/.test(await focused()), 'the defaults row has the focus, so + then Enter adds one', await focused());
  check(['deep', 'fast', 'second-opinion'].every((x) => first.some((t) => t.startsWith(x))) && !first.some((t) => t.startsWith('standard')), 'each other preset has a row, the default one only once', first);
  check(['Claude Code…', 'Codex…', 'OpenCode…', 'More options…'].every((x) => first.some((t) => t.includes(x))), 'each harness and More options have rows', first);
  check(await p.locator('.menu [role^=menuitem] .hico').count() >= 7, 'rows show the harness mark');
  await shot(p, 'spawn-1-menu');
  await plus.click();
  check(await p.locator('.menu').count() === 0, 'a second click on + closes the menu');
  await plus.click();
  await p.keyboard.press('Escape');
  check(await p.locator('.menu').count() === 0 && await p.evaluate(() => document.activeElement?.id) === 'new-agent', 'Escape closes it and gives the focus back to +');

  // One click: + then Enter adds an agent with the defaults.
  let before = await all();
  await plus.click();
  await p.keyboard.press('Enter');
  let a = await added(before, 'Enter on the defaults');
  if (a) {
    same([a.harness, a.model, a.effort, a.permission_mode], ['claude', 'claude-sonnet-5-5', 'medium', 'auto'], 'Enter on the first row adds an agent with the default preset');
    await p.waitForTimeout(800);
    check(await p.locator(`#tree .node.sel[data-id="${a.id}"]`).count() === 1, 'the new agent is selected in the tree');
    stopLater(a);
  }

  // A harness's models, then that model's efforts, by keyboard.
  before = await all();
  await plus.click();
  await p.locator('.menu [role=menuitem]:has-text("Claude Code…")').click();
  const models = await items();
  same(models.map((t) => t.trim()), ['Harness default…', 'opus 5.5…', 'sonnet 5.5…', 'haiku 5.5…', 'fable 5.1…', 'More options…'], 'Claude Code lists only its models');
  await shot(p, 'spawn-2-models');
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown');
  check(/haiku/.test(await focused()), 'arrows move through the models', await focused());
  await p.keyboard.press('Enter');
  const efforts = await items();
  same(efforts.map((t) => t.trim()), ['Default effort', 'low', 'medium', 'high', 'xhigh', 'max', 'More options…'], 'haiku lists Claude Code\'s efforts');
  await shot(p, 'spawn-3-efforts');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter');
  a = await added(before, 'the effort menu');
  if (a) { same([a.harness, a.model, a.effort], ['claude', 'claude-haiku-5-5', 'low'], 'picking haiku then low adds that agent'); stopLater(a); }

  // OpenCode has no efforts: its models add at once, and its menu shows only its models.
  await plus.click();
  await p.locator('.menu [role=menuitem]:has-text("OpenCode…")').click();
  const oc = await items();
  check(oc.some((t) => /deepseek/.test(t)) && !oc.some((t) => /opus|haiku|sol/.test(t)) && !oc.some((t) => /…$/.test(t.trim()) && !/More options/.test(t)), 'OpenCode lists its models, with no effort step', oc);
  await p.keyboard.press('Escape');

  // The panel: every choice picked from options, by keyboard.
  await plus.click();
  await p.locator('.menu [role=menuitem]:has-text("More options…")').click();
  await p.waitForSelector('.spawn-panel');
  check(await p.locator('.spawn-panel').count() === 1 && await p.locator('.menu').count() === 0, 'More options opens the panel');
  check(await p.evaluate(() => document.activeElement?.dataset.pick) === 'Type', 'the panel focuses its first row, the type');
  const value = (k) => p.locator(`.spawn-panel [data-pick="${k}"] .sp-value`).innerText();
  await p.keyboard.press('ArrowDown');
  same([await value('Type'), await value('Harness'), await value('Model'), await value('Effort'), await value('Permissions')], ['None', 'Claude Code', 'sonnet 5.5', 'medium', 'Settings: Auto'], 'it starts from the defaults, with no type');
  await shot(p, 'spawn-4-panel');
  // Harness: Enter opens its options with the current one checked; pick OpenCode.
  await p.keyboard.press('Enter');
  check((await p.locator('.menu [aria-checked=true]').innerText()).includes('Claude Code'), 'the option menu checks the current harness');
  check(/Claude Code/.test(await focused()), 'and focuses it');
  await shot(p, 'spawn-5-option');
  await p.locator('.menu [role=menuitemradio]:has-text("OpenCode")').click();
  same([await value('Harness'), await value('Model'), await value('Effort')], ['OpenCode', 'Harness default', 'Not offered'], 'switching to OpenCode drops the Claude model and effort');
  check(await p.locator('.spawn-panel [data-pick="Effort"]').isDisabled(), 'Effort is disabled for a harness without efforts');
  check(await p.evaluate(() => document.activeElement?.dataset.pick) === 'Harness', 'the focus comes back to the row after a pick');
  // Back to Claude Code, haiku, low; the helper's folder; helper as parent; bypass.
  const pick = async (row, option) => { await p.locator(`.spawn-panel [data-pick="${row}"]`).click(); await p.locator('.menu [role=menuitemradio]').filter({ hasText: option }).first().click(); };
  await pick('Harness', 'Claude Code');
  await pick('Model', 'haiku 5.5');
  await pick('Effort', 'low');
  await p.locator('.spawn-panel [data-pick="Folder"]').click();
  const fold = await items();
  check(fold.some((t) => t.includes('/work.')), 'Folder offers the running agents\' folders', fold);
  await p.locator('.menu [role=menuitemradio]').filter({ hasText: '/work.' }).first().click();
  await pick('Parent', 'helper');
  await pick('Permissions', 'Bypass');
  same([await value('Model'), await value('Effort'), await value('Parent'), await value('Permissions')], ['haiku 5.5', 'low', 'helper', 'Bypass'], 'the rows show what was picked');
  // A taken name: the error shows in the panel, which stays open.
  await p.locator('.spawn-panel .sp-field input').first().fill('helper');
  before = await all();
  await p.keyboard.press('Control+Enter');
  await p.waitForSelector('.spawn-panel .sp-error');
  check(/taken/.test(await p.locator('.spawn-panel .sp-error').innerText()), 'a taken name shows its error in the panel', await p.locator('.spawn-panel .sp-error').innerText());
  await shot(p, 'spawn-6-error');
  const n = Date.now() % 10000;
  await p.locator('.spawn-panel .sp-field input').first().fill(`Spawn Check ${n}`);
  check(await p.locator('.spawn-panel .sp-field input').first().inputValue() === `spawn-check-${n}`, 'the name keeps to lowercase letters, digits, and dashes');
  check(await p.locator('.spawn-panel .sp-error').count() === 0, 'editing clears the error');
  await p.keyboard.press('Control+Enter');
  a = await added(before, 'the panel');
  if (a) {
    same([a.name, a.harness, a.model, a.effort, a.parent_id, a.permission_mode, a.cwd === helper.cwd], [`spawn-check-${n}`, 'claude', 'claude-haiku-5-5', 'low', helper.id, 'bypass', true], 'Ctrl+Enter adds the agent with every choice');
    await p.waitForTimeout(400);
    check(await p.locator('.spawn-panel').count() === 0, 'the panel closes after adding');
    stopLater(a);
  }

  // The panel closes with Escape and returns the focus to +.
  await plus.click();
  await p.locator('.menu [role=menuitem]:has-text("More options…")').click();
  await p.waitForSelector('.spawn-panel');
  await p.keyboard.press('Escape');
  check(await p.locator('.spawn-panel').count() === 0 && await p.evaluate(() => document.activeElement?.id) === 'new-agent', 'Escape closes the panel and gives the focus back to +');

  // A tree row's + opens the same menu for a child.
  await p.locator(`#tree .node[data-id="${helper.id}"]`).hover();
  await p.locator(`#tree [data-add="${helper.id}"]`).click();
  check(/Add a child of helper/.test(await p.locator('.menu .label').first().innerText()), 'a row\'s + opens the menu for a child of that agent');
  await p.keyboard.press('Escape');
  await p.context().close();
  for (const a of made) await api(`/api/agents/${a.id}/kill`, { method: 'POST' });
}

// --- Archiving -------------------------------------------------------------------------
// An S-N key in a mail's body and subject is a link that opens that ITSA; keys in code and
// keys no ITSA has stay plain. Uses the seeded "Check: S-4 review notes" thread.
async function itsaLinks() {
  console.log('# itsalinks');
  for (const theme of ['light', 'dark']) {
    const p = await page(undefined, null, theme);
    const row = p.locator('.mrow[title*="Check: S-4 review notes"]').first();
    await row.waitFor();
    await row.click();
    await p.waitForSelector('.thread-view .msg a[data-open-itsa]');
    const links = p.locator('.thread-view a[data-open-itsa]');
    check(await links.count() >= 3, `${theme}: the keys in the body and the subject are links`, await links.count());
    check(await p.locator('.thread-view :is(code, pre) a[data-open-itsa]').count() === 0, `${theme}: no link inside code`);
    check(!(await p.locator('.thread-view a[data-open-itsa]:text-is("S-999")').count()), `${theme}: a key no ITSA has stays plain`);
    await shot(p, `itsa-link-${theme}`);
    await p.locator('.thread-view .msg a[data-open-itsa]:text-is("S-4")').first().click();
    await p.waitForSelector('.itsa-view');
    check(/Issues section in the sidebar/.test(await p.locator('.itsa-view').first().innerText()), `${theme}: a click opens the ITSA`);
  }
}

// A mail that names an ITSA (`send_mail` `itsa`, S-91) shows it as a chip in the thread header:
// the status glyph, the key, and the title; a click opens the ITSA. Uses the seeded
// "Check: a mail about an ITSA" thread; mail in an ITSA's own thread carries the chip too.
async function itsaChip() {
  console.log('# itsachip');
  const review = (await api('/api/itsas')).find((x) => x.title === 'Issues section in the sidebar');
  for (const theme of ['light', 'dark']) {
    const p = await page(undefined, null, theme);
    const row = p.locator('.mrow[title*="Check: a mail about an ITSA"]').first();
    await row.waitFor();
    await row.click();
    // On a desktop the thread's tab carries the chip (S-1471 §2a): the key and glyph, with the title in its tooltip.
    const chip = p.locator('.tab.active [data-itsa]:not([data-itsa="folded"])');
    await chip.waitFor();
    check(await chip.count() === 1, `${theme}: one chip for the ITSA the mail is about`);
    const tip = await chip.getAttribute('title');
    check(/S-\d+/.test(await chip.innerText()) && /Issues section in the sidebar/.test(tip), `${theme}: the chip shows the key, and its tooltip the title`, { text: await chip.innerText(), tip });
    check(await chip.locator('.sglyph').count() === 1, `${theme}: the chip shows its status glyph`);
    const plain = p.locator('.mrow[title*="Check: archive me"]').first();
    await plain.click();
    await p.waitForSelector('.thread-head h2:has-text("archive me")');
    check(await p.locator('.tab.active [data-itsa]:not([data-itsa="folded"]):visible').count() === 0, `${theme}: a mail about no ITSA has no chip`);
    await row.click();
    await chip.waitFor();
    await shot(p, `itsa-chip-${theme}`);
    await chip.click();
    await p.waitForSelector(`.itsa-view[data-itsa="${review.id}"]`);
    check(true, `${theme}: a click opens the ITSA`);
  }
}

// The row button, the thread header button, the `e` key, and the Archived list, on the
// seeded "Check: archive me" thread. A pending permission request can't be archived.
// Agent types: the + menu lists them after the defaults and adds one by name; the panel's
// Type row brings a type's harness, model, and effort; Settings › Agent types adds, edits,
// and removes one; Instructions groups each type's instructions. Agents get no prompt: free.
// The ITSA view's Mail section (S-92): the threads about the ITSA, without its own thread;
// a tap opens the thread. The seeded mail about "Issues section in the sidebar" is the row.
async function itsaMail() {
  console.log('# itsamail');
  const review = (await api('/api/itsas')).find((x) => x.title === 'Issues section in the sidebar');
  for (const theme of ['light', 'dark']) {
    const p = await page({ width: 1500, height: 900 }, null, theme);
    await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:itsa:' + review.id);
    await p.locator(`.itsa-view[data-itsa="${review.id}"]`).waitFor();
    const sec = p.locator('.itsa-sec[aria-label="Mail"]');
    await sec.waitFor();
    const row = sec.locator('.imail').first();
    await row.waitFor();
    check(await sec.locator('.itsa-sec-head .count').innerText() === '2', `${theme}: the count shows two threads`);
    same(await sec.locator('.imail-subj').allInnerTexts(), ['Check: a second mail about that ITSA', 'Check: a mail about an ITSA'], `${theme}: one row per thread, newest first, the ITSA's own thread left out`);
    check((await sec.innerText()).includes('Mail') && await row.locator('.imail-people').innerText() !== '', `${theme}: the row shows participants`);
    await shot(p, `itsa-mail-${theme}`);
    // The Linked mail section (S-986): the threads linked to the ITSA, newest first; a row opens its thread.
    const lsec = p.locator('.itsa-sec[aria-label="Linked mail"]');
    await lsec.scrollIntoViewIfNeeded();
    await lsec.locator('.imail').first().waitFor();
    same(await lsec.locator('.imail-subj').allInnerTexts(), ['Check: four ITSA keys', 'Check: compact ITSA chips', 'Check: two ITSA keys in text'], `${theme}: Linked mail lists only threads the Mail section doesn't`);
    await shot(p, `itsa-linked-mail-${theme}`);
    await row.click();
    await p.waitForSelector('.thread-head h2:has-text("a second mail about that ITSA")');
    check(true, `${theme}: a tap opens the thread`);
    await p.context().close();
    // The same section on a phone, at 360 px: the rows are touch targets, and the name fits.
    const ph = await page({ width: 360, height: 800 }, null, theme);
    await ph.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:itsa:' + review.id);
    const psec = ph.locator('.itsa-sec[aria-label="Mail"]');
    await psec.waitFor();
    await psec.scrollIntoViewIfNeeded();
    const box = await ph.locator('.imail').first().boundingBox();
    check(box && box.height >= 44, `${theme}: a 360 px row is a 44 px touch target`, box);
    check(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${theme}: no horizontal scroll at 360 px`);
    await shot(ph, `itsa-mail-360-${theme}`);
    const lph = ph.locator('.itsa-sec[aria-label="Linked mail"]');
    await lph.scrollIntoViewIfNeeded();
    await lph.locator('.imail').first().waitFor();
    const lbox = await lph.locator('.imail').first().boundingBox();
    check(lbox && lbox.height >= 44, `${theme}: a 360 px Linked mail row is a 44 px touch target`, lbox);
    await shot(ph, `itsa-linked-mail-360-${theme}`);
    await ph.context().close();
  }
}

// An issue named in a mail opens beside the thread on the desktop (the thread's right split,
// reused when there is one), and as a pushed view on the phone, where Back returns to the thread
// (S-93). Entry points: the ITSA chip on the thread's tab, the ITSA chip in the thread header, and
// the S-N key in a body (S-1872: the tab chip opens beside too, as the other two do).
async function itsaBeside() {
  console.log('# itsabeside');
  const review = (await api('/api/itsas')).find((x) => x.title === 'Issues section in the sidebar');
  const rows = await api('/api/itsas/' + review.id + '/threads');
  const tid = rows.find((r) => r.subject.includes('a mail about an ITSA')).thread_id;
  const tidSecond = rows.find((r) => r.subject.includes('a second mail about that ITSA')).thread_id;
  for (const theme of ['light', 'dark']) {
    // The tab chip: one page, fresh, so the split is the one the chip makes.
    const p = await page({ width: 1500, height: 900 }, null, theme);
    await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 't:' + tid);
    const tabChip = p.locator('.tab.active [data-itsa]:not([data-itsa="folded"])').first();
    await tabChip.waitFor();
    await tabChip.click();
    await p.locator(`.pane:has(.itsa-view[data-itsa="${review.id}"])`).waitFor();
    const tabPanes = await p.locator('.pane').count();
    const tabThread = await p.locator('.pane:has(.thread-head)').first().boundingBox();
    const tabIssue = await p.locator('.pane:has(.itsa-view)').first().boundingBox();
    check(tabPanes === 2, `${theme}: the tab chip opens its ITSA in a split beside the thread`, tabPanes);
    check(tabThread && tabIssue && tabIssue.x > tabThread.x + tabThread.width / 2, `${theme}: the tab chip's issue is in the right split`, [tabThread, tabIssue]);
    await p.context().close();
    // A key in the body opens it beside the thread (openFromMail), so the split is checked from that key.
    const q = await page({ width: 1500, height: 900 }, null, theme);
    await q.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 't:' + tidSecond);
    await q.locator('.msg .itsalink').first().waitFor();
    await q.locator('.msg .itsalink').first().click();
    await q.locator(`.pane:has(.itsa-view[data-itsa="${review.id}"])`).waitFor();
    const panes = await q.locator('.pane').count();
    const thread = await q.locator('.pane:has(.thread-head)').first().boundingBox();
    const issue = await q.locator('.pane:has(.itsa-view)').first().boundingBox();
    check(panes === 2, `${theme}: the issue opens in a split beside the thread`, panes);
    check(thread && issue && issue.x > thread.x + thread.width / 2, `${theme}: the issue is in the right split`, [thread, issue]);
    await shot(q, `beside-desktop-${theme}`);
    // A key in the body: that ITSA is already in the split, so it's focused there, not split again.
    await q.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 't:' + tidSecond);
    await q.locator('.msg .itsalink').first().waitFor();
    await q.locator('.msg .itsalink').first().click();
    await q.waitForTimeout(300);
    check(await q.locator('.pane').count() === 2, `${theme}: a body key reuses the split, no third pane`, await q.locator('.pane').count());
    check(await q.locator(`.pane:has(.itsa-view[data-itsa="${review.id}"])`).count() === 1, `${theme}: the key opens the ITSA in the split`);
    await q.context().close();
  }
  // Phone: a pushed view, and Back returns to the thread.
  for (const theme of ['light', 'dark']) {
    const ph = await page({ width: 360, height: 800 }, null, theme);
    await ph.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 't:' + tid);
    await ph.locator('.thread-head .ichip-mail').first().waitFor();
    await ph.locator('.thread-head .ichip-mail').first().click();
    await ph.locator(`.itsa-view[data-itsa="${review.id}"]`).waitFor();
    const cur = () => ph.evaluate(() => window.stamDebug.shell.currentWorld());
    check(await cur() === 'w:itsa:' + review.id, `${theme} phone: the chip opens the issue as its own pushed view`, await cur());
    await shot(ph, `beside-360-${theme}`);
    await ph.goBack();
    await ph.locator('.thread-head').first().waitFor();
    check(await cur() === 't:' + tid, `${theme} phone: Back returns to the thread`, await cur());
    await ph.context().close();
  }
}

// --- Settings › Permission modes (S-2071) -------------------------------------------------
// Each harness offers only its modes; bypass asks first and shows a warning; an agent that follows
// the settings is listed as stale after the change, and Apply switches it and says so.
async function permissionsFlow() {
  console.log('# permissions');
  const p = await page();
  const before = await api('/api/permission-modes');
  const made = await api('/api/agents', { method: 'POST', body: JSON.stringify({ harness: 'claude', model: 'claude-haiku-5-5', name: 'perm-ui-check' }) });
  await p.locator('#open-config').first().click();
  await p.waitForSelector('.settings-view');
  await p.locator('.settings-nav .item:has-text("Permission modes")').click();
  await p.waitForSelector('[data-harness=claude]');
  const opts = (sel) => p.locator(`${sel} option`).evaluateAll((os) => os.map((o) => o.value));
  same(await opts('[data-harness=claude]'), ['default', 'auto', 'bypass'], 'Claude Code offers Ask, Auto, and Bypass');
  same(await opts('[data-harness=codex]'), ['auto', 'bypass'], 'Codex does not offer Ask');
  same(await opts('[data-harness=opencode]'), ['auto', 'bypass'], 'OpenCode does not offer Ask');
  check((await opts('[data-type=developer]'))[0] === 'inherit', 'a type can follow its harness');
  await shot(p, 'permissions-1-settings');

  // Declining the bypass warning changes nothing.
  await p.locator('[data-harness=claude]').selectOption('bypass');
  await sleep(500);
  same((await api('/api/permission-modes')).settings.harness.claude, before.settings.harness.claude, 'declining the bypass warning saves nothing');
  check(await p.locator('[data-harness=claude]').inputValue() === before.settings.harness.claude, 'and the select snaps back');

  // Accepting saves it, warns, and lists the agent that follows the settings.
  p.removeAllListeners('dialog');
  p.on('dialog', (d) => d.accept());
  await p.locator('[data-harness=claude]').selectOption('bypass');
  await p.waitForSelector('[data-bypass-warning]');
  same((await api('/api/permission-modes')).settings.harness.claude, 'bypass', 'accepting saves bypass for Claude Code');
  await p.waitForSelector(`[data-agent=${made.name}]`);
  check(/Auto → Bypass/.test(await p.locator(`[data-agent=${made.name}]`).innerText()), 'the agent is listed with its current and wanted mode');
  await shot(p, 'permissions-2-stale');
  await p.locator('.perm-stale .btn.primary').click();
  await p.waitForSelector('[data-apply-result]');
  check(/Switched \d+ agent/.test(await p.locator('[data-apply-result]').innerText()) && (await p.locator('[data-apply-result]').innerText()).includes(made.name), 'Apply lists the agents it switched');
  await shot(p, 'permissions-3-applied');
  for (let i = 0; i < 40 && (await api(`/api/agents/${made.id}`)).permission_mode !== 'bypass'; i++) await sleep(250);
  same((await api(`/api/agents/${made.id}`)).permission_mode, 'bypass', 'the agent runs bypass');

  // Back to what it was.
  await p.locator('[data-harness=claude]').selectOption(before.settings.harness.claude);
  await p.waitForFunction(() => !document.querySelector('[data-bypass-warning]'));
  await api(`/api/agents/${made.id}/kill`, { method: 'POST' });
  await p.context().close();

  // The phone: the section and the stale list fit 360 px with no sideways scroll.
  const ph = await page({ width: 360, height: 780 });
  await ph.evaluate(() => localStorage.setItem('stam/settings-section', 'permissions'));
  await ph.locator('#open-config, [aria-label=Settings]').first().click();
  await ph.waitForSelector('[data-harness=claude]');
  check(await ph.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'the section has no sideways scroll at 360 px');
  await shot(ph, 'permissions-4-phone');
  await ph.context().close();
}

async function typesFlow() {
  console.log('# types');
  const p = await page(undefined, /status of 409/);
  const all = () => api('/api/agents');
  // The agent of the clicked type that wasn't there before: another agent (a retro-steward the digest spawns) doesn't count.
  const added = async (before, type) => {
    for (let i = 0; i < 40; i++) { const a = (await all()).find((x) => x.type === type && !before.some((b) => b.id === x.id)); if (a) return a; await sleep(250); }
    return null;
  };
  const items = () => p.locator('.menu [role^=menuitem]').allInnerTexts();
  const plus = p.locator('#new-agent');
  const reg = await api('/api/registry');
  const types = Object.keys(reg.types ?? {});
  same(types, ['developer', 'reviewer', 'reviewer-opus', 'review-ring', 'manager', 'coordinator', 'retro-steward', 'cos', 'advisor'], 'the shipped types');

  await plus.click();
  await p.waitForSelector('.menu');
  const rows = (await items()).map((t) => t.trim());
  const at = (x) => rows.findIndex((t) => t.startsWith(x));
  check(/With the defaults/.test(rows[0]), 'the defaults row stays first', rows[0]);
  check(types.every((t) => at(t) > 0) && types.every((t) => at(t) < at('deep')), 'each type has a row, before the presets', rows);
  check(await p.locator('.menu .label.eyebrow').filter({ hasText: 'Agent types' }).count() >= 1, 'the types have their section');
  check(/opus 5\.5 · medium/.test(rows[at('manager')]), 'a type row shows its model and effort', rows[at('manager')]);
  await shot(p, 'types-1-menu');
  let before = await all();
  await p.locator('.menu [role=menuitem]').filter({ hasText: /^manager/ }).first().click();
  let a = await added(before, 'manager');
  check(a && a.type === 'manager' && a.model === 'claude-opus-5-5' && a.effort === 'medium', 'clicking a type adds an agent of that type', a && [a.type, a.model, a.effort]);
  const manager = a;

  // The panel: a type fills the harness, model, and effort, which stay changeable.
  await plus.click();
  await p.locator('.menu [role=menuitem]:has-text("More options…")').click();
  await p.waitForSelector('.spawn-panel');
  const value = (k) => p.locator(`.spawn-panel [data-pick="${k}"] .sp-value`).innerText();
  await p.locator('.spawn-panel [data-pick="Type"]').click();
  await p.locator('.menu [role=menuitemradio]').filter({ hasText: 'reviewer' }).first().click();
  same([await value('Type'), await value('Harness'), await value('Model'), await value('Effort')], ['reviewer', 'Codex', 'gpt-6.1-sol', 'low'], 'picking a type fills harness, model, and effort');
  await shot(p, 'types-2-panel');
  await p.locator('.spawn-panel [data-pick="Type"]').click();
  await p.locator('.menu [role=menuitemradio]').filter({ hasText: 'advisor' }).first().click();
  await p.locator('.spawn-panel .sp-field input').first().fill('types-advisor');
  before = await all();
  await p.keyboard.press('Control+Enter');
  a = await added(before, 'advisor');
  check(a && a.type === 'advisor' && a.model === 'claude-fable-5-1' && a.role === 'advisor', 'the panel adds an agent of the picked type', a && [a.type, a.model, a.role]);

  // Settings › Agent types.
  await p.locator('#open-config').first().click();
  await p.waitForSelector('.settings-view');
  await p.locator('.settings-nav .item:has-text("Agent types")').click();
  await p.waitForSelector('.type-cards');
  check(await p.locator('.type-cards .choice').count() === types.length, 'a card per type');
  const managers = (await api('/api/agents')).filter((a) => a.type === 'manager' && (a.lifecycle === 'active' || a.lifecycle === 'paused')).length;
  check(new RegExp(`${managers} running`).test(await p.locator('.type-cards [data-type=manager]').innerText()), 'a card counts the agents running as that type');
  check(await p.locator('.type-cards [data-type=reviewer] .chip').first().innerText() === 'Reviewer', 'a reviewer type is tagged Reviewer');
  check(/falls back to reviewer-opus/.test(await p.locator('.type-cards [data-type=reviewer]').innerText()), 'a reviewer type shows its fallback');
  check(/Ring · \d+ members/.test(await p.locator('.type-cards [data-type=review-ring]').innerText()), 'a ring type shows its members');
  await shot(p, 'types-3-settings');
  await p.locator('.type-cards [data-type=developer]').click();
  await p.waitForSelector('.type-form');
  check(/Claude/.test(await p.locator('.type-form .seg button.on').first().innerText()), 'the form shows the type\'s harness');
  check((await p.locator('.type-form textarea[name=brief]').inputValue()).includes('{{task}}'), 'the form shows the brief');
  await shot(p, 'types-4-form');
  await p.locator('.type-form .type-back').click();
  await p.locator('.settings-inner button:has-text("Add a type")').click();
  await p.locator('.type-form input[name=name]').fill('UI Tester');
  await p.locator('.type-form input[name=description]').fill('Checks the UI.');
  await p.locator('.type-form select[name=model]').selectOption('claude-haiku-5-5');
  await p.locator('.type-form .seg button:has-text("low")').click();
  await p.locator('.type-form .seg button:has-text("Its tree")').click();
  await p.locator('.type-form textarea[name=brief]').fill('Check: {{task}}');
  await p.locator('.type-form button[type=submit]').click();
  await p.waitForSelector('.type-cards [data-type=ui-tester]');
  const saved = (await api('/api/registry')).types['ui-tester'];
  same([saved?.harness, saved?.model, saved?.effort, saved?.visibility?.reach, saved?.brief], ['claude', 'claude-haiku-5-5', 'low', 'tree', 'Check: {{task}}'], 'Add type saves it to the registry');
  await shot(p, 'types-5-added');

  // Reviewer types (S-412): grouped first, the default marked, a ring edited, errors inline.
  await p.waitForSelector('.type-cards');
  check(await p.locator('.type-cards').count() === 2 && await p.locator('.type-cards[data-group=reviewers] [data-type=reviewer]').count() === 1, 'reviewer types are listed in a group of their own, first');
  check(/Default/.test(await p.locator('.type-cards [data-type=reviewer]').innerText()), 'the default reviewer carries a Default chip');
  await shot(p, 'types-5b-reviewers');
  await p.locator('.type-cards [data-type=reviewer]').click();
  await p.waitForSelector('.type-form .review-card');
  await shot(p, 'types-5c-reviewer-form');
  p.removeAllListeners('dialog');
  p.on('dialog', (d) => d.accept());
  await p.locator('.type-form button:has-text("Remove")').click();
  await p.waitForSelector('.type-form .sp-error');
  check(/default reviewer/.test(await p.locator('.type-form .sp-error').innerText()), 'removing the default reviewer shows the server\'s message', await p.locator('.type-form .sp-error').innerText());
  await p.locator('.type-form .type-back').click();
  await p.locator('.type-cards [data-type=review-ring]').click();
  await p.waitForSelector('.type-form .ring-member');
  check(await p.locator('.type-form select[name=model]').count() === 0, 'a ring type shows no harness, model, or effort');
  await shot(p, 'types-5d-ring-form');
  const ringBefore = (await api('/api/registry')).types['review-ring'].review;
  await p.locator('.type-form [aria-label="Move member 2 up"]').click();
  await p.locator('.type-form select[name=fallback]').selectOption('reviewer-opus');
  await p.locator('.type-form button[type=submit]').click();
  await p.waitForSelector('.type-cards');
  const ringAfter = (await api('/api/registry')).types['review-ring'];
  same(ringAfter.review.ring.members, [...ringBefore.ring.members].reverse(), 'a ring\'s members are reordered and saved');
  same([ringAfter.review.fallback, ringAfter.harness], ['reviewer-opus', ''], 'the fallback is saved and the ring keeps no harness');
  await p.locator('.type-cards [data-type=reviewer-opus]').click();
  await p.locator('.type-form .review-card .set-row.default-row button:has-text("Yes")').click();
  await p.locator('.type-form button[type=submit]').click();
  await p.waitForSelector('.type-cards');
  check((await api('/api/registry')).defaultReviewer === 'reviewer-opus', 'switching Default reviewer on makes the type the default');
  await p.locator('.type-cards [data-type=reviewer]').click();
  await p.locator('.type-form .review-card .set-row.default-row button:has-text("Yes")').click();
  await p.locator('.type-form button[type=submit]').click();
  await p.waitForSelector('.type-cards');
  check((await api('/api/registry')).defaultReviewer === 'reviewer', 'and back');

  // Its instructions: a group of its own under Instructions, reached from the form.
  await p.locator('.type-cards [data-type=ui-tester]').click();
  await p.locator('.type-form .type-instr').getByRole('button', { name: 'Edit instructions' }).click();
  await p.waitForSelector('.tpl-editor');
  check((await p.locator('.tpl-editor .tpl-head').innerText()).includes('type-ui-tester.md'), 'the form links to the type\'s instructions');
  const groups = await p.locator('.tpl-group > span:first-child').allInnerTexts();
  check(['Type: manager', 'Type: ui-tester'].every((g) => groups.includes(g)), 'Instructions has a group per type', groups);
  await p.locator('.tpl-list .item:has-text("manager")').click();
  check((await p.locator('.tpl-editor .tpl-head').innerText()).includes(manager?.name ?? '?'), 'a type\'s group names its agents');
  await shot(p, 'types-6-instructions');

  // Removing: the user type is gone.
  await p.locator('.settings-nav .item:has-text("Agent types")').click();
  await p.locator('.type-cards [data-type=ui-tester]').click();
  p.removeAllListeners('dialog');
  p.on('dialog', (d) => d.accept());
  await p.locator('.type-form button:has-text("Remove")').click();
  await p.waitForSelector('.type-cards');
  check(!(await api('/api/registry')).types['ui-tester'] && await p.locator('.type-cards [data-type=ui-tester]').count() === 0, 'Remove deletes the type');
  await p.context().close();
}

async function archive() {
  console.log('# archive');
  const p = await page();
  const threads = await api('/api/agents/human/threads?limit=60');
  const t = threads.find((x) => /^Check: archive me/.test(x.mails[0]?.subject ?? ''));
  check(!!t, 'a thread is seeded for archiving', threads.map((x) => x.mails[0]?.subject));
  if (!t) return p.context().close();
  const tid = t.thread_id;
  const row = () => p.locator(`.mrow[data-thread="${tid}"]`);
  const current = () => p.evaluate(() => window.stamDebug.shell.currentWorld());
  const inList = async () => (await api('/api/agents/human/threads?limit=60')).some((x) => x.thread_id === tid);
  // Opening an unread thread fetches it once and marks its mail read once (S-151), on a page of its own.
  const q = await page();
  const reqs = watch(q);
  await q.locator(`.mrow[data-thread="${tid}"]`).click();
  await q.waitForSelector('.thread-view:visible .msg');
  await sleep(3000);
  const fetches = reqs(`GET /api/threads/${tid}`), reads = reqs('POST /api/agents/human/read');
  check(fetches <= 1, 'opening a thread fetches it once', fetches);
  check(reads <= 1, 'opening a thread marks its mail read once', reads);
  await q.context().close();

  // The row's archive button shows on hover (replacing the timestamp) and hides the thread
  // without deleting its mail; it is in the tab order, so focus shows it too.
  check(await row().count() === 1, 'the thread is in the mail list');
  const op = () => row().locator('.hover-actions').evaluate((el) => getComputedStyle(el).opacity);
  const timeShown = () => row().locator('.t').evaluate((el) => getComputedStyle(el).visibility !== 'hidden');
  check(await op() === '0' && await timeShown(), 'the archive button is hidden at rest, with the timestamp shown');
  await row().hover();
  check(await op() === '1', 'hover shows one icon-only archive button');
  check(!(await timeShown()), 'hover replaces the timestamp with the button');
  check(await row().locator('[data-arch]').getAttribute('aria-label') === 'Archive', 'the button is labelled Archive', await row().locator('[data-arch]').getAttribute('aria-label'));
  await shot(p, 'archive-1-row-hover');
  await p.mouse.move(2, 2);
  await row().locator('[data-arch]').focus();
  check(await op() === '1' && !(await timeShown()), 'focus (Tab) reveals the button in place of the timestamp');
  // The row leaves the list before the daemon answers (S-152): the archive POST waits on a gate
  // here, so the check sees the list without the thread while the daemon still has it.
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  await p.route(`**/api/agents/human/threads/${tid}/archive`, async (r) => { await gate; await r.fallback(); });
  await row().locator('[data-arch]').click();
  check(await row().count() === 0, 'the row leaves the list at once, before the daemon answers');
  check(await inList(), 'the daemon still holds the thread in the inbox while the archive waits');
  release();
  for (let i = 0; i < 50 && await inList(); i++) await sleep(100);
  await p.unroute(`**/api/agents/human/threads/${tid}/archive`);
  check(await row().count() === 0 && !(await inList()), 'the row stays out once the daemon archives it');
  check((await api('/api/threads/' + tid)).length === t.mails.length, 'archiving keeps every message');

  // The Archived entry lists it; the row button there unarchives it.
  await p.locator('.mail-toggle').nth(1).click();
  await p.waitForTimeout(500);
  check(await row().count() === 1, 'the Archived list shows the archived thread');
  await shot(p, 'archive-2-archived');
  await row().hover();
  await row().locator('[data-arch]').click();
  await p.waitForTimeout(700);
  check(await row().count() === 0, 'the row button unarchives it from the Archived list');
  await p.locator('.mail-toggle').nth(1).click();
  await p.waitForTimeout(500);
  check(await row().count() === 1, 'the thread is back in the mail list');

  // The tab bar's Archive archives the open thread and opens the next one, or nothing, as the header button did.
  const all = await api('/api/agents/human/threads?limit=60');
  const pending = (x) => x.mails.some((m) => m.permission?.status === 'pending');
  const ordered = [...all.filter(pending), ...all.filter((x) => !pending(x))];
  const next = ordered[ordered.findIndex((x) => x.thread_id === tid) + 1];
  await row().click();
  await p.waitForSelector('.thread-view:visible .msg');
  check(await p.locator('.tab-actions.desk [data-archive]').isVisible(), 'the open thread has an Archive icon in the tab bar');
  await p.locator('.tab-actions.desk [data-archive]').click();
  await p.waitForTimeout(800);
  check(await current() === (next ? 't:' + next.thread_id : null), 'the tab bar\'s Archive opens the next thread, or nothing when it was the last', await current());
  check(!(await inList()), 'the archived thread left the list');

  // From the Archived list, `e` unarchives the open thread without leaving it.
  await p.locator('.mail-toggle').nth(1).click();
  await p.waitForTimeout(500);
  await row().click();
  await p.waitForSelector('.thread-view:visible .msg');
  check(/^Unarchive/.test(await p.locator('.tab-actions.desk [data-archive]').getAttribute('aria-label')), 'an archived thread offers Unarchive');
  await p.keyboard.press('e');
  await p.waitForTimeout(700);
  check(await current() === 't:' + tid && await inList(), '`e` unarchives the open thread without leaving it');

  // From the inbox, `e` archives the open thread and opens the next one.
  await p.locator('.mail-toggle').nth(1).click();
  await p.waitForTimeout(500);
  await row().click();
  await p.waitForSelector('.thread-view:visible .msg');
  await p.keyboard.press('e');
  await p.waitForTimeout(800);
  check(!(await inList()), '`e` archives the open thread');
  check(await current() !== 't:' + tid, '`e` opens the next thread');

  // Restore it: open it from the Archived list and `e` again.
  await p.locator('.mail-toggle').nth(1).click();
  await p.waitForTimeout(500);
  await row().click();
  await p.waitForSelector('.thread-view:visible .msg');
  await p.keyboard.press('e');
  await p.waitForTimeout(700);
  check(await current() === 't:' + tid && await inList(), '`e` again unarchives it (thread restored)');
  await p.locator('.mail-toggle').nth(1).click();
  await p.waitForTimeout(500);

  // The tab bar's Defer defers the open thread and opens the next one, as the header did; the deferred thread is then undone from the API.
  await row().click();
  await p.waitForSelector('.thread-view:visible .msg');
  await p.locator('.tab-actions.desk [data-defer]').click();
  await p.waitForTimeout(800);
  check((await api('/api/agents/human/threads?limit=60&deferred=1')).some((x) => x.thread_id === tid), 'the tab bar\'s Defer defers the open thread');
  check(await current() !== 't:' + tid, 'the tab bar\'s Defer opens the next thread', await current());
  await api(`/api/agents/human/threads/${tid}/undefer`, { method: 'POST' });
  await p.waitForTimeout(500);

  // A pending permission request can't be archived: no enabled button, and the API refuses.
  const perm = (await api('/api/agents/human/threads?limit=60')).find((x) => x.mails.some((m) => m.permission?.status === 'pending'));
  check(!!perm, 'a permission request thread is seeded');
  if (perm) {
    const refused = await api('/api/agents/human/threads/' + perm.thread_id + '/archive', { method: 'POST', body: '{}' });
    check(/permission/i.test(refused.error ?? ''), "the archive API refuses a pending permission thread", refused);
    await p.locator(`.mrow[data-thread="${perm.thread_id}"]`).hover();
    check(await p.locator(`.mrow[data-thread="${perm.thread_id}"] [data-arch]`).isDisabled(), "the pending thread's archive button is disabled");
  }
  await p.context().close();
}

// --- Assistant ----------------------------------------------------------------------------
// Needs the fake Claude Code for the assistant (daemon.sh's fake.json answers the word asked for).
async function assistant() {
  console.log('# assistant');
  const p = await page();
  const word = (n) => `MANGO${n}${Date.now() % 1000}`;
  const ask = (w) => `UI check, not real work. Reply with exactly the word ${w} and nothing else. Don't use any tools, send no mail, start no agents.`;
  const find = async () => (await api('/api/agents')).find((a) => a.kind === 'assistant');
  const waitFor = async (what, fn, ms = 120000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { check(false, what); return null; } await sleep(1000); }
  };
  check(!(await find()), 'there is no assistant before the first message');
  await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator(".name").click();
  await p.waitForTimeout(1500);

  // 1. The prompt input's assistant button.
  const bottom = p.locator('#w-bottom .composer');
  const btn = bottom.locator('.cmp-asst');
  check(!(await btn.evaluate((b) => b.classList.contains('on'))), 'the stam icon starts off');
  await btn.click();
  await p.locator('.menu [role=radio]:has-text("Assistant")').click();
  check(await btn.evaluate((b) => b.classList.contains('on')) && await bottom.evaluate((c) => c.classList.contains('to-assistant')), 'picking the assistant in the stam icon\'s menu switches the prompt input to it');
  check(/Assistant/.test(await bottom.locator('.cmp-target').innerText()), 'the target label names the assistant', await bottom.locator('.cmp-target').innerText());
  const w1 = word(1);
  await bottom.locator('textarea').fill(ask(w1));
  await shot(p, 'assistant-1-bottom-typed');
  await bottom.locator('textarea').press('Enter');
  await p.waitForFunction(() => /assistant/i.test(document.querySelector('#w-bottom .cmp-hint')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  check(/Your assistant is starting with your message/.test(await bottom.locator('.cmp-hint').innerText()), 'the hint says the assistant is starting', await bottom.locator('.cmp-hint').innerText());
  check((await bottom.locator('textarea').inputValue()) === '', 'the box clears after sending');
  const a = await waitFor('the assistant agent appears', find, 30000);
  if (!a) return p.context().close();
  check(a.harness === 'claude' && /haiku/.test(a.model ?? ''), 'it runs on Haiku (settings.assistant)', [a.harness, a.model]);
  check(a.name === 'assistant', 'it is named assistant', a.name);
  await shot(p, 'assistant-2-sent');
  check(await p.locator('#tree .node:has(.name:text-is("assistant")) .asst-tag').count() === 1, 'the tree marks it with the assistant tag');

  // Its terminal, in the Alt+C overlay: the message arrives and the answer shows.
  await p.keyboard.press('Alt+c');
  await p.waitForSelector('#top-world');
  // With a chief of staff the overlay's switch names who is written to, and its selected button is
  // the one marked on; with none, the header names it.
  const overlay = p.locator('#top-world');
  const named = await overlay.locator('.top-targets button.on').count() ? await overlay.locator('.top-targets button.on').innerText() : await overlay.locator('.top-name').innerText();
  check(await overlay.getAttribute('data-target') === 'assistant' && /assistant/i.test(named), 'Alt+C opens the assistant overlay naming it', named);
  const screen = () => p.locator('#top-world .xterm-rows').innerText().catch(() => '');
  const seen = (w) => waitFor(`the terminal shows ${w}`, async () => (await screen()).includes(w) || null);
  check(!!(await seen(w1)), 'the message reached the assistant (it shows in its terminal)');
  await waitFor('the assistant answers', async () => ((await screen()).match(new RegExp(w1, 'g')) ?? []).length >= 2 || null);
  const t1 = await screen();
  check((t1.match(new RegExp(w1, 'g')) ?? []).length >= 2, 'its answer shows in the overlay\'s terminal', t1.slice(-400));
  await shot(p, 'assistant-3-overlay-answer');
  check(/looking at/.test(t1) || /stam: your user sent this/.test(t1), 'the message carries what you were looking at', t1.slice(-400));

  // 2. The overlay's own prompt input, once the assistant is idle.
  await waitFor('the assistant is idle', async () => (await find())?.activity === 'idle' || null, 60000);
  const top = p.locator('#top-world .composer');
  check(await top.locator('textarea').evaluate((t) => document.activeElement === t), 'the overlay focuses its prompt input');
  const w2 = word(2);
  await top.locator('textarea').fill(ask(w2));
  await top.locator('textarea').press('Enter');
  await p.waitForTimeout(1500);
  check(/Sent to your assistant/.test(await top.locator('.cmp-hint').innerText()), 'the hint says it was sent', await top.locator('.cmp-hint').innerText());
  check(!!(await seen(w2)), 'the second message reached the assistant');
  await waitFor('the assistant answers again', async () => ((await screen()).match(new RegExp(w2, 'g')) ?? []).length >= 2 || null);
  check(((await screen()).match(new RegExp(w2, 'g')) ?? []).length >= 2, 'its second answer shows');
  await shot(p, 'assistant-4-overlay-second');
  check((await api('/api/agents')).filter((x) => x.kind === 'assistant').length === 1, 'both messages went to the one assistant');

  // Closing: Escape from the prompt input; Alt+C opens it again.
  await top.locator('textarea').focus();
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  check(await p.locator('#top-world').count() === 0, 'Escape closes the overlay');
  await p.keyboard.press('Alt+c');
  check(await p.locator('#top-world').count() === 1, 'Alt+C opens it again');
  await p.context().close();
}

// --- Chief of staff -----------------------------------------------------------------------
// helper (paused, so mail to it costs nothing) is made chief of staff for the flow. The top
// world switches between the assistant and it, remembers the choice, and Alt+C cycles; the
// prompt input's assistant button reaches it by right-click. Messages to it arrive as mail.
async function cos() {
  console.log('# cos');
  const inbox = async (w) => (await api(`/api/agents/${helper.id}/threads?limit=50`)).flatMap((t) => t.mails).find((m) => m.from_id === 'human' && m.recipients.some((r) => r.id === helper.id) && (m.body ?? '').includes(w));
  const arrived = async (w) => { for (let i = 0; i < 20; i++) { const m = await inbox(w); if (m) return m; await sleep(500); } return null; };
  const target = (p) => p.locator('#top-world').getAttribute('data-target');
  {
    // The seed names its own chief of staff; this flow starts with none.
    await api('/api/chief-of-staff', { method: 'POST', body: JSON.stringify({ agent: null }) });
    const p = await page();
    await p.keyboard.press('Alt+c');
    check(await p.locator('#top-world').count() === 1, 'with no chief of staff Alt+C opens the assistant');
    check(await p.locator('#top-world .top-targets').count() === 0, 'with no chief of staff the overlay has no switch');
    await p.keyboard.press('Alt+c');
    check(await p.locator('#top-world').count() === 0, 'with no chief of staff a second Alt+C closes it');
    await p.context().close();
  }
  same((await api('/api/chief-of-staff', { method: 'POST', body: JSON.stringify({ agent: 'helper' }) })).chiefOfStaff, 'helper', 'helper is made chief of staff');
  check((await api('/api/agents')).find((a) => a.id === helper.id)?.chief_of_staff === true, 'the agent list marks the chief of staff');
  // Settings › Chief of staff: the status card names helper with a Stop, the cos type's harness,
  // model and effort are editable, and Edit instructions opens the chief of staff's instructions.
  for (const [name, size] of [['desktop', undefined], ['phone', { width: 360, height: 780 }]]) {
    const p = await page(size);
    await p.evaluate(() => localStorage.setItem('stam/settings-section', 'chief'));
    await p.locator('#open-config, [aria-label=Settings]').first().click();
    await p.waitForSelector('.status-card[data-cos]');
    same(await p.locator('.status-card[data-cos]').getAttribute('data-cos'), 'helper', `${name}: the Settings status card names the chief of staff`);
    check(await p.locator('#cos-stop').count() === 1 && await p.locator('#cos-start').count() === 0, `${name}: a running chief of staff offers Stop, not Start`);
    check(await p.locator('.settings-inner .seg button:has-text("Claude Code")').count() >= 1, `${name}: the cos type's harness is editable`);
    check(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name}: the section has no sideways scroll`);
    await shot(p, `cos-settings-${name}`);
    await p.locator('#cos-instructions').click();
    await p.waitForSelector('.tpl-list .item.sel', { state: 'attached' });
    check(/Chief of staff/.test(await p.locator('.tpl-list .item.sel').textContent()), `${name}: Edit instructions opens the chief of staff's instructions`);
    await p.context().close();
  }
  for (const theme of ['light', 'dark']) {
    const p = await page(undefined, null, theme);
    await p.keyboard.press('Alt+c');
    await p.waitForSelector('#top-world');
    same(await p.locator('#top-world .top-targets button').allInnerTexts(), ['Assistant', 'helper'], `${theme}: the overlay switches between the assistant and helper`);
    same(await target(p), 'assistant', `${theme}: it opens on the assistant first`);
    await p.keyboard.press('Alt+c');
    same(await target(p), helper.id, `${theme}: Alt+C moves it to helper`);
    check(/helper/.test(await p.locator('#top-world .cmp-target').innerText()), `${theme}: the prompt input names helper`);
    await p.waitForTimeout(1000);
    await shot(p, `cos-overlay-${theme}`);
    if (theme === 'dark') { await p.context().close(); break; }
    // A chief of staff offers Direct (typed into its agent) and Mail; this checks Mail.
    same(await p.locator('#top-world .cmp-mode button').allInnerTexts(), ['Direct', 'Mail'], `${theme}: the overlay offers Direct and Mail to helper`);
    await p.locator('#top-world .cmp-mode button:has-text("Mail")').click();
    const w = `PAPAYA${Date.now() % 10000}`;
    await p.locator('#top-world .composer textarea').fill(`UI check, not real work: ${w}`);
    await p.locator('#top-world .composer textarea').press('Enter');
    await p.waitForFunction(() => /Mailed/.test(document.querySelector('#top-world .cmp-hint')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => {});
    check(/Mailed helper/.test(await p.locator('#top-world .cmp-hint').innerText()), 'the hint says it was mailed', await p.locator('#top-world .cmp-hint').innerText());
    const m = await arrived(w);
    check(!!m && /^UI check/.test(m.subject), 'the message reached helper as mail from the human', m);
    // Remembered: a reload opens on helper; Alt+C goes round to the assistant; a click back.
    await p.reload();
    await p.waitForSelector('#tree .node', { timeout: 20000 });
    await p.keyboard.press('Alt+c');
    same(await target(p), helper.id, 'after a reload the overlay opens on helper again');
    await p.keyboard.press('Alt+c');
    same(await target(p), 'assistant', 'Alt+C goes round to the assistant');
    await p.locator('#top-world .top-targets button[data-target="' + helper.id + '"]').click();
    same(await target(p), helper.id, 'clicking helper switches back');
    await p.keyboard.press('Escape');
    // The prompt input: the stam icon's menu picks the assistant or helper. The overlay's close
    // steps back in the history; wait for that, or the pop closes the menu it just opened.
    await p.waitForTimeout(1500);
    await p.locator('#tree .node:has(.name:text-is("kid"))').first().locator('.name').click();
    await p.waitForTimeout(1500);
    const bottom = p.locator('#w-bottom .composer');
    const btn = bottom.locator('.cmp-asst');
    // An earlier step may have left a menu open; closing it steps back in the history, and that pop
    // would close the menu the click opens next. Let it settle first.
    await p.mouse.click(900, 300);
    await p.waitForFunction(() => !document.querySelector('.menu'));
    await p.waitForTimeout(800);
    await btn.click();
    await p.locator('.menu [role=radio]:has-text("Assistant")').click();
    check(/Assistant/.test(await bottom.locator('.cmp-target').innerText()), 'the menu\'s Assistant writes to the assistant');
    await btn.click();
    await p.locator('.menu [role=radio]:has-text("helper")').click();
    check(await btn.evaluate((b) => b.classList.contains('on')) && /helper/.test(await bottom.locator('.cmp-target').innerText()), 'the menu\'s helper writes to helper', await bottom.locator('.cmp-target').innerText());
    await shot(p, 'cos-bottom-picked');
    const w2 = `GUAVA${Date.now() % 10000}`;
    await bottom.locator('textarea').fill(`UI check, not real work: ${w2}`);
    await bottom.locator('textarea').press('Enter');
    check(!!(await arrived(w2)), 'the prompt input reached helper as mail');
    await btn.click();
    await p.locator('.menu [role=radio]').first().click();
    check(!/helper/.test(await bottom.locator('.cmp-target').innerText()), 'the menu\'s current agent turns it back to the focused pane');
    await p.context().close();
  }
  await api('/api/chief-of-staff', { method: 'POST', body: JSON.stringify({ agent: null }) });
}

// --- Mail from the prompt input -----------------------------------------------------------
// The prompt input's Direct/Mail toggle: Mail sends the message to the agent as mail from
// the human, so it lands in the human's mailbox with the agent's answer to come. helper is
// paused in the check daemon (NO_HELLO), so the mail costs nothing.
// A mail link names one mail (S-415): from another thread it opens the thread, with the mail
// opened, scrolled below the header and highlighted; from the thread on screen it scrolls there.
// The target sits in a folded run of a long thread, so it has to be expanded to show.
async function mailLink() {
  console.log('# maillink');
  const kid = agents.find((a) => a.name === 'kid');
  const n = Date.now() % 100000;
  const post = (body, extra) => api('/api/mail', { method: 'POST', body: JSON.stringify({ from: kid.id, to: ['human'], body, ...extra }) });
  // Six mails in one thread, all read, so the thread opens with its middle folded.
  const ids = [];
  let prev = null, tid = null;
  for (let i = 1; i <= 6; i++) {
    const m = await post(`Link check ${n}, mail ${i}.`, prev ? { reply_to: prev.id } : { new_thread: true, subject: `Check: mail link ${n}` });
    ids.push(m.id);
    tid = m.thread_id;
    prev = m;
  }
  await api('/api/agents/human/read', { method: 'POST', body: JSON.stringify({ ids }) });
  const target = ids[1];
  // The referring mail is in a thread of its own, and links to the target by its id and as a link.
  const ref = await post(`The answer is in ${target}, and [that mail](#${target}) says it too.`, { new_thread: true, subject: `Check: mail link from ${n}` });
  const p = await page();
  await p.locator(`.mail-side [data-thread="${ref.thread_id}"]`).first().click();
  const link = p.locator(`.thread-view:visible a.threadlink[data-thread-link="${target}"]`).first();
  await link.waitFor();
  await p.waitForFunction((id) => !!document.querySelector(`.thread-view a.threadlink[data-thread-link="${id}"][data-tid]`), target, { timeout: 10000 });
  const before = await p.evaluate(() => window.stamDebug.shell.currentWorld());
  await link.click();
  await p.waitForSelector(`.thread-view:visible .msg.open[data-id="${target}"].flash`, { timeout: 10000 });
  check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 't:' + tid, 'a link to a mail in another thread opens that thread', before);
  const seen = await p.evaluate((id) => {
    const card = document.querySelector(`.thread-view .msg[data-id="${id}"]`);
    const head = card.closest('.thread-view').querySelector('.thread-head');
    const c = card.getBoundingClientRect(), h = head.getBoundingClientRect();
    return { below: c.top >= h.bottom - 1, inView: c.bottom > h.bottom && c.top < innerHeight };
  }, target);
  check(seen.below && seen.inView, 'the target mail is in view, under the sticky header', seen);
  await shot(p, 'maillink-1-other-thread');
  // A mail in the thread on screen links to a folded mail of that thread: it scrolls there without a reload.
  // A long mail last, so the thread on a phone is taller than its screen and can scroll.
  const same = await post(`Also see [mail two](#${ids[1]}) in this thread.\n\n${'Padding for the scroll check.\n\n'.repeat(20)}`, { reply_to: prev.id });
  await p.waitForSelector(`.thread-view:visible .msg[data-id="${same.id}"]`);
  const world = await p.evaluate(() => window.stamDebug.shell.currentWorld());
  await p.locator(`.thread-view:visible .msg[data-id="${same.id}"] a.threadlink[data-thread-link="${ids[1]}"]`).first().click();
  await p.waitForSelector(`.thread-view:visible .msg.open[data-id="${ids[1]}"].flash`, { timeout: 10000 });
  check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === world, 'a link to a mail in the thread on screen stays in that thread');
  await shot(p, 'maillink-2-same-thread');
  // A thread opens at its latest message (S-1500). The thread above ends in a long mail, so it overflows the box
  // on a phone and in a short desktop pane; a fresh page opens it, and the last row must be in view with its
  // top under the sticky header (this one's last mail is taller than the box, so it starts at its own top).
  for (const [label, size] of [['desktop', { width: 1280, height: 420 }], ['phone', { width: 360, height: 740 }]]) {
    const o = await page(size);
    await o.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), world);
    await o.waitForSelector('.thread-view:visible .msg');
    await o.waitForTimeout(400);
    const at = await o.evaluate(() => {
      const view = [...document.querySelectorAll('.thread-view')].find((v) => v.offsetParent !== null);
      const box = view.querySelector('.thread-scroll'), head = box.querySelector('.thread-head');
      const last = [...box.querySelectorAll('.msgs > *')].at(-1);
      const lr = last.getBoundingClientRect(), br = box.getBoundingClientRect();
      const hb = getComputedStyle(head).position === 'sticky' ? head.getBoundingClientRect().bottom : br.top;
      return { scrollTop: Math.round(box.scrollTop), max: box.scrollHeight - box.clientHeight, headBottom: Math.round(hb), lastTop: Math.round(lr.top), lastBottom: Math.round(lr.bottom), boxBottom: Math.round(br.bottom) };
    });
    check(at.max > 0 && at.scrollTop > 0 && at.lastTop >= at.headBottom - 1 && at.lastTop < at.boxBottom - 20, `a thread opens at its latest message (${label})`, at);
    await o.context().close();
  }
  await p.context().close(); // the ITSA case below opens its own page; the browser's connections are limited
  // An ITSA's body names the mail too: its link opens the thread at that mail, as a mail's does.
  const issue = await api('/api/itsas', { method: 'POST', body: JSON.stringify({ title: `Check: mail link ${n}`, body: `The answer is in ${target}, and [that mail](#${target}) says it too.` }) });
  const q = await page();
  await q.evaluate((id) => window.stamDebug.shell.showAgentWorld('w:itsa:' + id), issue.id);
  await q.waitForSelector('.itsa-view');
  await q.waitForFunction((id) => !!document.querySelector(`.itsa-view a.threadlink[data-thread-link="${id}"][data-tid]`), target, { timeout: 10000 });
  await q.locator(`.itsa-view a.threadlink[data-thread-link="${target}"]`).first().click();
  await q.waitForSelector(`.thread-view:visible .msg.open[data-id="${target}"].flash`, { timeout: 10000 });
  check(await q.evaluate(() => window.stamDebug.shell.currentWorld()) === 't:' + tid, 'a mail link in an ITSA body opens the thread at its mail');
  // The phone's width: the header scrolls away, so the target lands at the top of the box.
  const phone = await page({ width: 360, height: 740 });
  await phone.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 't:' + ref.thread_id);
  await phone.waitForSelector('.thread-view:visible .msg');
  await phone.waitForFunction((id) => !!document.querySelector(`.thread-view a.threadlink[data-thread-link="${id}"][data-tid]`), target, { timeout: 10000 });
  await phone.locator(`.thread-view:visible a.threadlink[data-thread-link="${target}"]`).first().click();
  await phone.waitForSelector(`.thread-view:visible .msg.open[data-id="${target}"].flash`, { timeout: 10000 });
  const top = await phone.evaluate((id) => {
    const card = document.querySelector(`.thread-view .msg[data-id="${id}"]`);
    const box = card.closest('.thread-scroll');
    return { gap: Math.round(card.getBoundingClientRect().top - box.getBoundingClientRect().top), scrollTop: box.scrollTop, max: box.scrollHeight - box.clientHeight };
  }, target);
  check(top.max > 0 && top.gap < 20, 'on the phone, the target mail is scrolled to the top of the box', top);
  await shot(phone, 'maillink-3-phone-360');
  // Each page is its own browser context: close them here, so the flows after this one start with less open.
  for (const x of [q, phone]) await x.context().close();
}

async function mailFlow() {
  console.log('# mail');
  const p = await page();
  const current = () => p.evaluate(() => window.stamDebug.shell.currentWorld());
  await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator(".name").click();
  await p.waitForTimeout(800);
  const bottom = p.locator('#w-bottom .composer');
  const seg = bottom.locator('.cmp-mode');
  same(await seg.locator('button').allInnerTexts(), ['Direct', 'Mail'], 'the prompt input offers Direct and Mail beside send');
  // The box starts in settings.promptDefaultMode, Mail unless changed (S-523).
  check(await seg.locator('button.on').innerText() === 'Mail', 'Mail is the default');
  await seg.locator('button:has-text("Direct")').click();
  check(await seg.locator('button.on').innerText() === 'Direct', 'Direct switches the toggle');
  await shot(p, 'mail-1-direct');
  await seg.locator('button:has-text("Mail")').click();
  check(await seg.locator('button.on').innerText() === 'Mail' && await bottom.locator('.cmp-send').getAttribute('aria-label') === 'Mail', 'Mail switches the toggle and the send button');
  check((await bottom.locator('.cmp-hint').innerText()) === '', 'the bar shows no hint text');
  // The cc section of the stam icon's menu (S-1313, S-1434): ticks for cos, intake and the assistant, a search for any agent; it is gone in Direct.
  check(await bottom.locator('.cmp-cc').count() === 0, 'the cc controls take no room in the box');
  const stam = bottom.locator('.cmp-to');
  await stam.click();
  check(await p.locator('.menu .rm-search').count() === 1, 'Mail mode shows the cc section in the stam menu');
  await p.keyboard.press('Escape');
  // The check daemon starts with no assistant, so the last chip needs one: start it, and archive it after the shot.
  const asst = await api('/api/assistant/start', { method: 'POST', body: '{}' });
  const asstId = asst.agent?.id ?? asst.id;
  await stam.click();
  await p.locator('.menu .rm-cc:has(b:text-is("asst")), .menu .rm-cc:has(b:text-is("assistant"))').first().waitFor({ timeout: 15000 });
  // A row shows only for an agent that exists (RecipientMenu.tsx): the CoS is the first live chief of staff, Intake the first live assistant of one. The fixture may have neither, so the expected chips follow the agents listed now.
  const listed = await api('/api/agents');
  const isLive = (a) => a.lifecycle === 'active' || a.lifecycle === 'paused';
  const byAge = (x, y) => x.created_at.localeCompare(y.created_at);
  const chiefs = listed.filter((a) => a.chief_of_staff && isLive(a)).sort(byAge);
  const intakes = listed.filter((a) => isLive(a) && /\bassistant\b/i.test(a.role ?? '') && (a.parents ?? []).some((p) => chiefs.some((c) => c.id === p))).sort(byAge);
  const expected = [chiefs[0] && chiefs[0].id !== helper.id && chiefs[0].name, intakes[0] && intakes[0].id !== helper.id && intakes[0].name, listed.find((a) => a.kind === 'assistant' && a.lifecycle !== 'archived')?.name].filter(Boolean);
  same(await p.locator('.menu .rm-cc b').allInnerTexts(), expected, 'the cc section offers the quick-pick agents that exist: ' + expected.join(', '));
  // The search lists live agents without a chip, whatever the fixture holds: add one of its own, and archive it after.
  const pickCwd = (await api('/api/agents')).find((a) => a.name === 'helper')?.cwd;
  const pick = await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'ccpick', harness: 'claude', model: 'claude-haiku-5-5', cwd: pickCwd, role: 'cc search target' }) });
  check(!!pick.id, 'the check starts an agent for the cc search', pick);
  await p.locator('.menu .rm-search').fill('ccpick');
  await p.locator('.menu .rm-cc:has-text("ccpick")').waitFor({ timeout: 15000 });
  await p.locator('.menu .rm-cc:has-text("ccpick")').first().click();
  check(await p.locator('.menu .rm-cc[aria-checked=true]:has-text("ccpick")').count() === 1, 'a searched agent shows ticked in the cc section');
  check(await stam.locator('.cmp-to-n').innerText() === '+1', 'the stam icon counts the cc');
  await shot(p, 'mail-cc-menu');
  await p.setViewportSize({ width: 360, height: 740 });
  await shot(p, 'mail-cc-360');
  const ccBox = await p.locator('.menu .rm-row, .menu .rm-search').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  check(ccBox.length > 0 && ccBox.every((h) => h >= 44), 'on a phone the menu rows are at least 44 px tall', ccBox);
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.keyboard.press('Escape');
  if (pick.id) await api(`/api/agents/${pick.id}/archive`, { method: 'POST', body: '{}' });
  if (asstId) await api(`/api/agents/${asstId}/archive`, { method: 'POST', body: '{}' });
  await seg.locator('button:has-text("Direct")').click();
  await stam.click();
  check(await p.locator('.menu .rm-search').count() === 0, 'Direct shows no cc section');
  await p.keyboard.press('Escape');
  await seg.locator('button:has-text("Mail")').click();
  const w = `MANGO${Date.now() % 10000}`;
  await bottom.locator('textarea').fill(`UI check, not real work: ${w}`);
  await shot(p, 'mail-2-mail');
  await bottom.locator('textarea').press('Enter');
  await p.waitForFunction(() => /Mailed/.test(document.querySelector('#w-bottom .cmp-hint')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => {});
  check(/Mailed helper/.test(await bottom.locator('.cmp-hint').innerText()), 'the hint says it was mailed', await bottom.locator('.cmp-hint').innerText());
  // A new thread from the human is archived on send, so it isn't in the inbox: it shows in the
  // Awaiting view, with the awaiting clock, until someone answers.
  await p.locator('.mail-toggle').nth(0).click();
  const row = p.locator(`.mail-side .mrow[title*="${w}"]`).first();
  await row.waitFor({ timeout: 10000 }).catch(() => {});
  check(await row.count() === 1 && await row.evaluate((el) => el.classList.contains('awaiting')), 'the prompt shows as awaiting a reply in your mailbox');
  await shot(p, 'mail-3-mailbox');
  // Mail titles (S-297): the check daemon's stub titles each mail from its subject, and the row
  // shows the title as a chip before the subject; the inbox rows carry theirs too.
  const chip = row.locator('.mtitle');
  await chip.waitFor({ timeout: 10000 }).catch(() => {});
  check(await chip.count() === 1 && await chip.innerText() === 'UI check, not', 'the row shows the mail title before its subject', await chip.count() ? await chip.innerText() : 'none');
  await p.locator('.mail-toggle').nth(0).click();
  check(await p.locator('.mail-side .mrow .mtitle').count() > 0, 'inbox rows show their mail titles');
  await shot(p, 'mail-titles');
  await p.locator('.mail-toggle').nth(0).click();
  const t = [...await api('/api/agents/human/threads?limit=60'), ...await api('/api/agents/human/threads?limit=60&archived=1')].find((x) => x.mails.some((m) => m.from_id === 'human' && (m.body ?? '').includes(w)));
  check(!!t && t.mails[0].subject === `UI check, not real work: ${w}`, 'the first line became the thread subject', t?.mails[0]?.subject);
  // The thread: your own prompt is there, and its reply box carries no toggle, being mail already.
  await row.click();
  await p.waitForSelector('.thread-view .msg');
  check(await p.locator('#w-bottom .cmp-mode').count() === 0, 'the reply box has no Direct/Mail toggle');
  check(await p.locator('.thread-view .msg.mine').count() >= 1, 'your own prompt shows in the thread');
  check(await p.locator('.thread-view .msg.mine header .mtitle').first().innerText().catch(() => '') === 'UI check, not', 'the message header shows its title');
  await shot(p, 'mail-4-thread');
  // A reply shows at once as pending (S-152); a refused one (4xx) takes it out of the thread and
  // stays in the prompt input's strip as failed, until a click puts it back in the box (S-373).
  const ta = p.locator('#w-bottom textarea');
  const strip = p.locator('#w-bottom .ob-row.failed');
  const refusedText = `REFUSED${Date.now() % 10000}`;
  refusing = true;
  await p.route('**/api/mail', (r) => { if (r.request().method() !== 'POST') return r.fallback(); refusedMail.sent++; return r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"refused for the check"}' }); });
  await ta.fill(refusedText);
  await ta.press('Enter');
  await strip.waitFor();
  check(await p.locator('.thread-view:visible .msg.pending').count() === 0, 'a refused reply leaves the thread');
  check(await ta.inputValue() === '', 'a refused reply leaves the box empty, its text in the strip');
  check((await strip.getAttribute('title')).startsWith('Failed: refused for the check'), 'the strip says why it failed', await strip.getAttribute('title'));
  check(await current() === 't:' + t.thread_id, 'a refused reply leaves the human in the same thread', await current());
  await strip.click();
  check(await ta.inputValue() === refusedText, 'a click on the failed row puts the draft back in the box', await ta.inputValue());
  check(await refusalsLogged(), "the refused reply's 409 is logged in the console");
  await p.unroute('**/api/mail');
  refusing = false;
  await ta.fill('');

  // The human opens another thread while a reply is pending, and the daemon then refuses it: the
  // failed row stays with its own thread's box, not the one open now.
  const gapText = `GAP${Date.now() % 10000}`;
  let refuse = () => {};
  const refused = new Promise((r) => { refuse = r; });
  refusing = true;
  await p.route('**/api/mail', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    // Counted when the POST arrives, before the gate: the check waits on seen reaching it.
    refusedMail.sent++;
    await refused;
    await r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"refused for the check"}' });
  });
  await ta.fill(gapText);
  await ta.press('Enter');
  await p.waitForSelector('.thread-view:visible .msg.pending');
  // The Awaiting view lists only the new thread, so the other thread comes from the inbox.
  const awaitingOn = async (on) => { if ((await p.locator('.mail-toggle').nth(0).getAttribute('aria-pressed')) !== String(on)) await p.locator('.mail-toggle').nth(0).click(); };
  await awaitingOn(false);
  const other = p.locator(`.mrow[data-thread]:not([data-thread="${t.thread_id}"])`).first();
  const otherTid = await other.getAttribute('data-thread');
  await other.click();
  await p.waitForFunction((x) => window.stamDebug.shell.currentWorld() === 't:' + x, otherTid);
  check(await current() === 't:' + otherTid, 'the human opens another thread while the reply waits');
  refuse();
  check(await refusalsLogged(), "the refusal's 409 is logged in the console");
  check(await current() === 't:' + otherTid, 'the refusal leaves the other thread open');
  check(await p.locator('#w-bottom .ob-row').count() === 0, "the failed row stays out of the other thread's strip");
  await p.unroute('**/api/mail');
  refusing = false;
  await awaitingOn(true);
  await p.locator(`.mrow[data-thread="${t.thread_id}"]`).first().click();
  await p.waitForFunction((x) => window.stamDebug.shell.currentWorld() === 't:' + x, t.thread_id);
  // A failed row reads "text: error" (S-518).
  check((await p.locator('#w-bottom .ob-row.failed .ob-text').innerText()) === `${gapText}: refused for the check`, 'the failed row waits in its own thread');
  check(await p.locator('.thread-view:visible .msg.pending').count() === 0, 'a refused reply leaves no pending message behind in its thread');
  await p.locator('#w-bottom .ob-row.failed').click();
  check((await ta.inputValue()).includes(gapText), 'the refused draft comes back from its row');
  await ta.fill('');

  // Sends and waits for the daemon's answer (S-152): the pending reply shows, then leaves.
  const reply = `REPLY${Date.now() % 10000}`;
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  await p.route('**/api/mail', async (r) => { if (r.request().method() !== 'POST') return r.fallback(); await gate; await r.fallback(); });
  await ta.fill(reply);
  await ta.press('Enter');
  await p.waitForSelector('.thread-view:visible .msg.pending');
  check(await ta.inputValue() === '', 'the reply leaves the box at once');
  check((await p.locator('.thread-view:visible .msg.pending').innerText()).includes(reply), 'the reply shows at once, as pending');
  await shot(p, 'mail-5-reply-pending-desktop');
  await p.setViewportSize({ width: 360, height: 760 });
  await shot(p, 'mail-6-reply-pending-360');
  await p.setViewportSize({ width: 1500, height: 900 });
  release();
  await p.waitForSelector('.thread-view:visible .msg.pending', { state: 'detached', timeout: 10000 }).catch(() => {});
  await p.unroute('**/api/mail');
  check((await api('/api/threads/' + t.thread_id)).some((m) => (m.body ?? '').includes(reply)), 'the reply reaches the daemon once it answers');

  // Not kept per browser (S-523): after a pick of Direct, a reload opens on the setting's Mail again.
  await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator(".name").click();
  await p.locator('#w-bottom .cmp-mode button:has-text("Direct")').click();
  check(await p.locator('#w-bottom .cmp-mode button.on').innerText() === 'Direct', 'the human picks Direct before the reload');
  await p.reload();
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator(".name").click();
  await p.waitForTimeout(600);
  check(await p.locator('#w-bottom .cmp-mode button.on').innerText() === 'Mail', 'a reload opens on the setting, not the last pick');
  await p.context().close();
}

// --- Search -------------------------------------------------------------------------------
// The palette: Ctrl/Cmd+K opens it, results are grouped and keyboard-navigable, and Enter
// or a tap opens the agent's world, the thread, the issue, or the Settings section. The
// ITSA it opens is created here (the daemon seeds agents and mail, not issues).
async function search() {
  console.log('# search');
  const title = `Search check ${Date.now() % 10000}`;
  const itsa = await api('/api/itsas', { method: 'POST', body: JSON.stringify({ title }) });
  // Earlier flows reply into it, and a reply archives its thread (S-148): look in both lists.
  const tid = [...(await api('/api/agents/human/threads?limit=60')), ...(await api('/api/agents/human/threads?limit=60&archived=1'))].find((x) => /^Check: decisions/.test(x.mails[0].subject)).thread_id;
  const p = await page();
  const current = () => p.evaluate(() => window.stamDebug.shell.currentWorld());
  const sel = () => p.locator('#search-palette .pal-result.sel').getAttribute('data-result');
  // The box takes the focus a frame after the palette renders, and the palette's own Escape
  // handling rides on it; wait for the focus so a key can't race it.
  const open = async (key = 'Control+k') => {
    await p.keyboard.press(key);
    await p.waitForSelector('#search-palette');
    await p.waitForFunction(() => document.activeElement?.id === 'search-all');
  };
  const type = (s) => p.locator('#search-all').fill(s);

  await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator(".name").click();
  await p.waitForTimeout(800);

  // Ctrl+K opens it with the box focused; Escape and a second Ctrl+K close it.
  await open();
  check(await p.locator('#search-scrim').count() === 1 && await p.locator('#search-palette').count() === 1, 'Ctrl+K opens the palette over a scrim');
  check(await p.evaluate(() => document.activeElement?.id) === 'search-all', 'the search box takes the focus');
  await type('helper');
  await p.waitForSelector('#search-palette .pal-result');
  check(/Agents/.test(await p.locator('#search-palette .pal-group').first().innerText()), 'results are grouped by kind, agents first', await p.locator('#search-palette .pal-group').first().innerText());
  check(await p.locator(`.pal-result[data-result="agent:${helper.id}"]`).count() === 1, 'the helper agent is a result');
  await shot(p, 'search-1-agent');
  const first = await sel();
  await p.keyboard.press('ArrowDown');
  check(await sel() !== first, 'ArrowDown moves the highlight', await sel());
  await p.keyboard.press('ArrowUp');
  check(await sel() === first, 'ArrowUp brings it back', await sel());
  await p.keyboard.press('Enter');
  await p.waitForSelector('#search-palette', { state: 'detached' });
  check(await current() === helper.id, "Enter opens the highlighted agent's world", await current());
  await open('Meta+k');
  check(await p.locator('#search-palette').count() === 1, 'Cmd+K opens it too');
  await p.keyboard.press('Escape');
  await p.waitForSelector('#search-palette', { state: 'detached' });
  check(await p.locator('#search-palette').count() === 0, 'Escape closes the palette');

  // A word from a mail subject finds the thread; a tap opens it.
  await open();
  await type('callouts');
  await p.waitForSelector('#search-palette .pal-result');
  check(await p.locator(`.pal-result[data-result="thread:${tid}"]`).count() === 1, 'a thread is found by its mail text');
  check(/Mail/.test((await p.locator('#search-palette .pal-group').allInnerTexts()).join(' ')), 'the mail group header shows');
  await shot(p, 'search-2-mail');
  await p.locator(`.pal-result[data-result="thread:${tid}"]`).click();
  await p.waitForTimeout(700);
  check(await current() === 't:' + tid, 'a tap on the row opens the thread', await current());

  // An issue by its title; Enter opens its world.
  await open();
  await type(title);
  await p.waitForSelector('#search-palette .pal-result');
  check(await p.locator(`.pal-result[data-result="itsa:${itsa.id}"]`).count() === 1, 'the issue is found by its title', await p.locator('#search-palette .pal-result').allInnerTexts());
  check(/Issues/.test((await p.locator('#search-palette .pal-group').allInnerTexts()).join(' ')), 'the issues group header shows');
  // The title also matches mail, which ranks above Issues: Enter opens the highlighted row, so
  // the highlight moves down to the issue first.
  for (let i = 0; i < 20 && !(await p.locator(`#search-palette .pal-result.sel[data-result="itsa:${itsa.id}"]`).count()); i++) await p.keyboard.press('ArrowDown');
  check(await p.locator(`#search-palette .pal-result.sel[data-result="itsa:${itsa.id}"]`).count() === 1, 'the issue row is highlighted');
  await shot(p, 'search-3-issue');
  await p.keyboard.press('Enter');
  await p.waitForSelector(`.itsa-view[data-itsa="${itsa.id}"] h2`);
  check((await p.locator(`.itsa-view[data-itsa="${itsa.id}"] h2`).innerText()).includes(title), "it opens the issue's world", await p.locator(`.itsa-view[data-itsa="${itsa.id}"] h2`).innerText());
  check(await current() === 'w:itsa:' + itsa.id, 'the issue world is the current one', await current());

  // A Settings section opens there, and a second one switches with Settings already open.
  await open();
  await type('compaction');
  await p.waitForSelector('#search-palette .pal-result');
  check(await p.locator('.pal-result[data-result="setting:section:context"]').count() === 1, 'a Settings section is found');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.settings-view .settings-inner h2');
  check((await p.locator('.settings-view .settings-inner h2').innerText()) === 'Context and compaction', 'it opens Settings on that section', await p.locator('.settings-view .settings-inner h2').innerText());
  await open();
  await type('machines');
  await p.waitForSelector('.pal-result[data-result="setting:section:machines"]');
  // Mail mentioning machines can rank above the section: move the highlight down to it first.
  for (let i = 0; i < 20 && !(await p.locator('#search-palette .pal-result.sel[data-result="setting:section:machines"]').count()); i++) await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelector('.settings-view .settings-inner h2')?.textContent === 'Machines');
  check((await p.locator('.settings-view .settings-inner h2').innerText()) === 'Machines', 'a second section switches with Settings already open', await p.locator('.settings-view .settings-inner h2').innerText());
  await shot(p, 'search-4-settings');

  // No match says so; the dark theme gets its own shot.
  await open();
  await type('zzzznomatch');
  await p.waitForSelector('#search-palette .pal-hint');
  check(/No matches/.test(await p.locator('#search-palette .pal-hint').innerText()), 'a query with no match says so', await p.locator('#search-palette .pal-hint').innerText());
  await shot(p, 'search-5-empty');
  await p.context().close();

  const dark = await page(undefined, null, 'dark');
  await dark.keyboard.press('Control+k');
  await dark.waitForSelector('#search-palette');
  await dark.locator('#search-all').fill('helper');
  await dark.waitForSelector('#search-palette .pal-result');
  await shot(dark, 'search-6-dark');
  await dark.context().close();
}

// --- Back and forward ----------------------------------------------------------------------
// An agent's world and Settings each take a history entry, and the search palette one on top;
// the browser's back closes the palette first, then returns to the previous world, and forward
// goes the other way.
async function back() {
  console.log('# back');
  const p = await page();
  const current = () => p.evaluate(() => window.stamDebug.shell.currentWorld());
  await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator(".name").click();
  await p.waitForTimeout(600);
  check(await current() === helper.id, 'an agent world is open', await current());
  await p.locator('#open-config').click();
  await p.waitForSelector('.settings-view');
  check(await current() === 'w:config', 'Settings is a world of its own', await current());
  await p.keyboard.press('Control+k');
  await p.waitForSelector('#search-palette');
  await p.goBack();
  await p.waitForSelector('#search-palette', { state: 'detached' });
  check(await current() === 'w:config', 'back closes the palette and keeps the world', await current());
  await p.goBack();
  await p.waitForTimeout(500);
  check(await current() === helper.id, 'back returns to the previous world', await current());
  await shot(p, 'back-1');
  await p.goForward();
  await p.waitForTimeout(500);
  check(await current() === 'w:config', 'forward returns to the world ahead', await current());
  // Moving between Settings sections is a place of its own.
  await p.locator('.settings-nav .item:has-text("Context and compaction")').click();
  await p.waitForTimeout(400);
  await p.locator('.settings-nav .item:has-text("Machines")').click();
  await p.waitForTimeout(400);
  const sec = () => p.locator('.settings-view .settings-inner h2').innerText();
  check(await sec() === 'Machines', 'a Settings section opens', await sec());
  await p.goBack();
  await p.waitForTimeout(500);
  check(await sec() === 'Context and compaction', 'back steps between Settings sections', await sec());
  await shot(p, 'back-2-settings');
  // The sidebar's History tab lists the things shown, newest first, with the one showing marked
  // (S-1456). A section change updated Settings' entry in place; a row jumps there and the list stays.
  await sideTab(p, 'history');
  const rows = () => p.locator('#history-side [data-history]').evaluateAll((els) => els.map((e) => e.getAttribute('data-history')));
  const before = await rows();
  check(before.length >= 2 && before[0] === 'w:config' && before[1] === helper.id, 'History lists the worlds shown, newest first', before.join(','));
  check(before.filter((k) => k === 'w:config').length === 1, 'a Settings section change updates the entry in place', before.join(','));
  check(await p.locator('#history-side [data-history].sel').getAttribute('data-history') === 'w:config', 'the world showing is marked');
  await shot(p, 'back-3-history');
  await p.locator(`#history-side [data-history="${helper.id}"]`).click();
  await p.waitForTimeout(500);
  check(await current() === helper.id, 'a History row jumps to that world', await current());
  check((await rows()).join(',') === before.join(','), 'the list stays after a jump', (await rows()).join(','));
  check(await p.locator('#history-side [data-history].sel').getAttribute('data-history') === helper.id, 'the marker moved to the row');
  await p.context().close();
}

// --- ITSAs ---------------------------------------------------------------------------------
// The Issues section and an ITSA's world, on the ITSAs seed.mjs creates: rows expand into
// children, a row opens the world, the header changes status and owner (checked against
// the API), a new child appears in the list and the sidebar, a child opens its own world,
// the breadcrumb leads back, a change made elsewhere shows without a reload, and the
// section folds and resizes.
async function itsa() {
  console.log('# itsa');
  const p = await page();
  const all = await api('/api/itsas');
  const root = all.find((x) => x.title === 'Check: issue system');
  if (!root) { check(false, 'the seeded ITSAs exist (seed.mjs)'); return p.context().close(); }
  const web = all.find((x) => x.parent_id === root.id && /^Web UI/.test(x.title));
  await sideTab(p, 'issues');
  const row = (id) => p.locator(`#issues-side .irow[data-itsa="${id}"]`);
  const view = () => p.locator(`.itsa-view[data-itsa]:visible`);
  check(await row(root.id).isVisible(), 'the Issues section lists the root ITSA');
  check(await row(web.id).count() === 0, 'children wait folded at first');
  check(/waiting on you/.test(await p.locator('#issues-side .section').innerText()), 'the header counts what waits on the human');
  check(await row(root.id).locator('.badge.warn').isVisible(), 'a folded root shows that something inside waits on the human');
  await row(root.id).locator('.chev').click();
  check(await row(web.id).isVisible(), 'its chevron shows the children');
  check(await row(root.id).locator('.rollup').isVisible(), 'a parent row has a roll-up bar');

  await row(root.id).click();
  await p.waitForSelector('.itsa-view[data-itsa] .itsa-head');
  check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:itsa:' + root.id, 'a row opens the ITSA world w:itsa:ID');
  check(await row(root.id).evaluate((el) => el.classList.contains('sel')), 'the open ITSA is selected in the sidebar');
  const head = await view().locator('.itsa-head').innerText();
  check(head.includes(root.key) && head.includes('Check: issue system') && /in progress/.test(head) && head.includes('helper') && head.includes('initiative'), 'the header shows key, title, status, owner, and kind', head);
  check(await view().locator('[data-prop="owner"] .glyph .ring').count() === 1, "the owner shows with its harness mark and state ring");
  check(await view().locator('.itsa-body .mb-checklist, .itsa-body .mb-callout, .itsa-body [class*="mb-"]').count() > 0, 'the body renders with mail components');
  check(await view().locator('.ikid').count() >= 4, 'the children list has the seeded children', await view().locator('.ikid').count());
  check(await view().locator('.itsa-links a').count() === 2, 'the links show');
  check(/helper/.test(await view().locator('[aria-label="Participants"]').innerText()), 'the participants show');
  check(await view().locator('[data-itsa-thread="events"] li').count() >= 1, 'without a thread, the activity shows');
  await shot(p, 'itsa-1-world');
  // An open ITSA is fetched when it opens, and not again while nothing changes (S-151: it refetched 10+ a second).
  const reqs = watch(p);
  await sleep(3000);
  const fetches = reqs(`GET /api/itsas/${root.id}`);
  check(fetches <= 1, 'an open ITSA is not refetched over 3 seconds', fetches);

  // Status from the header: a menu by category; the pick is saved as the human.
  await view().locator('[data-prop="status"]').click();
  check(await p.locator('.menu [role=menuitemradio][aria-checked=true]').innerText().then((t) => /in progress/.test(t)), 'the status menu ticks the current status');
  await shot(p, 'itsa-2-status-menu');
  await p.locator('.menu [role=menuitemradio]').filter({ hasText: /^blocked/ }).click();
  await p.waitForTimeout(600);
  let got = await api('/api/itsas/' + root.id);
  same(got.status, 'blocked', 'picking a status saves it');
  check(got.events.some((e) => e.type === 'status' && e.actor === 'human'), 'the change is recorded as the human');
  check(/blocked/.test(await view().locator('[data-prop="status"]').innerText()), 'the header shows the new status');
  check(/set the status to blocked/.test(await view().locator('[data-itsa-thread]').innerText()), 'the activity shows the change');

  // Owner from the header: you, nobody, or an agent.
  await view().locator('[data-prop="owner"]').click();
  await p.locator('.menu [role=menuitemradio]').filter({ hasText: /^kid/ }).click();
  await p.waitForTimeout(600);
  got = await api('/api/itsas/' + root.id);
  check(got.owner === agents.find((a) => a.name === 'kid')?.id, 'picking an owner saves it', got.owner);
  await view().locator('[data-prop="owner"]').click();
  await p.locator('.menu [role=menuitemradio]').filter({ hasText: /^You/ }).click();
  await p.waitForTimeout(600);
  same((await api('/api/itsas/' + root.id)).owner, 'human', 'the human can own it');

  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(200); } return false; };
  const kidAgent = agents.find((a) => a.name === 'kid');
  // S-153: a change shows before the daemon answers. The status PATCH is held here, so the header
  // shows the pending state while the daemon still has the old status; then it lands.
  let letGo;
  const held = new Promise((r) => { letGo = r; });
  await p.route('**/api/itsas/*', async (r) => { if (r.request().method() !== 'PATCH') return r.fallback(); await held; await r.fallback(); });
  await view().locator('[data-prop="status"]').click();
  await p.locator('.menu [role=menuitemradio]').filter({ hasText: /^in progress/ }).click();
  await p.waitForTimeout(400);
  check(/in progress/.test(await view().locator('[data-prop="status"]').innerText()), 'a status change shows at once, before the daemon answers');
  check(await view().locator('.itsa-props.pending').count() === 1, 'the header marks the change as pending');
  same((await api('/api/itsas/' + root.id)).status, 'blocked', 'the daemon still has the old status while the change is held');
  await shot(p, 'itsa-3-pending-status');
  // The same held change at the phone's width (S-153: the phone gets the same pending state).
  await p.setViewportSize({ width: 360, height: 800 });
  await p.waitForTimeout(400);
  await shot(p, 'itsa-3-pending-status-360');
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.waitForTimeout(300);
  letGo();
  check(await until(async () => (await api('/api/itsas/' + root.id)).status === 'in_progress'), 'the held status change lands');
  await p.waitForTimeout(600);
  check(await view().locator('.itsa-props.pending').count() === 0, 'the pending mark goes once the daemon agrees');
  await p.unroute('**/api/itsas/*');

  // A refused owner change shows at once, then rolls back with a toast that says why.
  let letRefuse;
  const refuseGate = new Promise((r) => { letRefuse = r; });
  refusing = true;
  await p.route('**/api/itsas/*', async (r) => { if (r.request().method() !== 'PATCH') return r.fallback(); await refuseGate; await r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refused for the check"}' }); });
  await view().locator('[data-prop="owner"]').click();
  await p.locator('.menu [role=menuitemradio]').filter({ hasText: /^kid/ }).click();
  check(await until(async () => /kid/.test(await view().locator('[data-prop="owner"]').innerText())), 'the owner change shows at once');
  check(await view().locator('.itsa-props.pending').count() === 1, 'and is marked pending while the daemon has not refused it');
  letRefuse();
  check(await until(async () => /refused for the check/.test(await p.locator('#toasts').innerText())), 'a refused owner change says why');
  check(await until(async () => !/kid/.test(await view().locator('[data-prop="owner"]').innerText())), 'and the owner rolls back');
  same((await api('/api/itsas/' + root.id)).owner, 'human', 'the daemon kept the old owner');
  refusing = false;
  await p.unroute('**/api/itsas/*');

  // A refused create keeps the typed title in the form, and says why once.
  refusing = true;
  await p.route('**/api/itsas', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refused for the check"}' }) : r.fallback()));
  await view().locator('[data-new-child]').click();
  await p.keyboard.type('Check: a refused child');
  await p.keyboard.press('Enter');
  check(await until(async () => /refused for the check/.test(await p.locator('#toasts').innerText())), 'a refused create says why');
  check(await p.locator('.new-itsa input').inputValue() === 'Check: a refused child', 'and keeps the typed title in the form');
  await p.locator('.new-itsa input').fill('');
  await p.keyboard.press('Escape');
  refusing = false;
  await p.unroute('**/api/itsas');

  // An agent's pause shows in the tree at once, as pausing, until the agent is paused.
  let letPause;
  const heldPause = new Promise((r) => { letPause = r; });
  await p.route(`**/api/agents/${kidAgent.id}/pause`, async (r) => { await heldPause; await r.fallback(); });
  await sideTab(p, 'agents');
  await p.locator(`#tree .node[data-id="${kidAgent.id}"]`).hover();
  await p.locator(`#tree .node[data-id="${kidAgent.id}"] [data-more]`).click();
  await p.locator('.menu [role=menuitem]').filter({ hasText: /^Pause$/ }).click();
  check(await until(async () => (await p.locator(`#tree .node[data-id="${kidAgent.id}"] .role[data-pending]`).innerText().catch(() => '')).startsWith('pausing')), 'a pause shows in the tree at once, as pausing');
  same((await api('/api/agents/' + kidAgent.id)).lifecycle, 'active', 'the agent is still running while the pause is held');
  await shot(p, 'agent-pending-pause');
  // The same held pause at the phone's width: the tree's own row, with its pending label.
  await p.setViewportSize({ width: 360, height: 800 });
  await p.waitForTimeout(400);
  await p.locator('[data-nav="left"]').click();
  await p.waitForTimeout(400);
  await shot(p, 'agent-pending-pause-360');
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.waitForTimeout(300);
  letPause();
  check(await until(async () => (await api('/api/agents/' + kidAgent.id)).lifecycle === 'paused'), 'the held pause lands');
  check(await until(async () => (await p.locator(`#tree .node[data-id="${kidAgent.id}"] .role[data-pending]`).count()) === 0), 'the pending mark goes once the agent agrees');
  await p.unroute(`**/api/agents/${kidAgent.id}/pause`);
  await api('/api/agents/' + kidAgent.id + '/unpause', { method: 'POST' });

  // New child: a title, Enter, and it shows in the list and the sidebar.
  await view().locator('[data-new-child]').click();
  await p.keyboard.type('Check: a new child');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(800);
  const kid = (await api('/api/itsas?parent=' + root.id)).find((x) => x.title === 'Check: a new child');
  check(!!kid, 'New child creates a child ITSA');
  check(await view().locator(`.ikid[data-itsa="${kid?.id}"]`).isVisible(), 'the new child shows in the list');
  await sideTab(p, 'issues');
  check(await row(kid?.id).isVisible(), 'and in the sidebar');

  // A change made elsewhere (an agent) shows without a reload.
  await api('/api/itsas/' + root.id, { method: 'PATCH', body: JSON.stringify({ status: 'in_review', by: 'helper' }) });
  await p.waitForTimeout(5500);
  check(/in review/.test(await view().locator('[data-prop="status"]').innerText()), 'a change from an agent shows within the poll');

  // A comment from the human starts the thread; an agent's update shows its health in the
  // header and pins as the latest update. helper is paused, so the mail costs nothing.
  const reply = p.locator('#w-bottom textarea');
  await reply.fill('Check: a comment from the human');
  await reply.press('Enter');
  await p.waitForTimeout(1200);
  got = await api('/api/itsas/' + root.id);
  check(!!got.thread_id, 'a comment starts the ITSA thread', got.thread_id);
  await p.waitForSelector('.itsa-view:visible [data-itsa-thread="thread"]', { timeout: 10000 }).catch(() => {});
  check(/a comment from the human/.test(await view().locator('[data-itsa-thread]').innerText()), 'the thread shows the comment');
  await api(`/api/itsas/${root.id}/post`, { method: 'POST', body: JSON.stringify({ by: 'helper', kind: 'update', health: 'at_risk', body: 'Check: an update, at risk' }) });
  await p.waitForTimeout(9000);
  check(/At risk/.test(await view().locator('.itsa-head').innerText()), "the header shows the latest update's health");
  check(/an update, at risk/.test(await view().locator('.itsa-update').innerText().catch(() => '')), 'the latest update is pinned above the children');
  check(/in_review/.test(await view().locator('[data-itsa-thread="thread"]').innerText()), "the thread shows status changes as event lines");
  await shot(p, 'itsa-2b-thread');

  // A child opens its own world; its breadcrumb leads back.
  await view().locator(`.ikid[data-itsa="${web.id}"]`).click();
  await p.waitForSelector(`.itsa-view[data-itsa="${web.id}"]`);
  check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:itsa:' + web.id, 'a child opens its own world');
  check((await p.locator(`.itsa-view[data-itsa="${web.id}"] .crumbs`).innerText()).includes(root.key), 'the child shows its parent in a breadcrumb');
  await shot(p, 'itsa-3-child');
  await p.locator(`.itsa-view[data-itsa="${web.id}"] .crumb-link`).first().click();
  check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:itsa:' + root.id, 'the breadcrumb opens the parent');

  // The issues share a pane with the agents: a tab strip switches between them, by click and by arrow
  // keys, and the list has no fold or resize separator of its own there.
  await sideTab(p, 'issues');
  check(await p.locator('#sep-issues').count() === 0, 'the issues list has no resize separator inside a pane');
  check(await p.locator('#issues-side .fold').isDisabled(), 'and its header does not fold');
  check(await p.locator('#side-panes [role=tab][aria-selected=true]').first().getAttribute('data-tab') === 'issues', 'the Issues tab is the showing tab');
  await p.locator('#pane-tab-issues').focus();
  await p.keyboard.press('ArrowLeft');
  check(await until(async () => await p.locator('#pane-body-agents').isVisible() && !(await p.locator('#issues-side').isVisible())), 'ArrowLeft shows the Agents tab and hides the issues');
  check(await p.evaluate(() => document.activeElement?.id) === 'pane-tab-agents', 'and moves focus to it');
  await p.keyboard.press('ArrowRight');
  check(await until(async () => await p.locator('#issues-side .issues-list').isVisible()), 'ArrowRight shows the Issues tab again');
  await shot(p, 'itsa-4-sidebar');
  // Leave the seed as it was for later runs.
  await api('/api/itsas/' + root.id, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress', owner: 'helper' }) });
  await p.context().close();
}

// --- ITSA board ----------------------------------------------------------------------------
// The board on the ITSAs seed.mjs creates: an ITSA's world opens with its view and its board;
// category columns; cards with kind, status chip, owner, link, and the waits-on-you mark; real
// mouse drags between columns (the category's first status) and within one (rank, kept after
// a reload); status columns and a drag to an exact status; a refused move rolls back; the
// keyboard moves a card and opens "Move to…"; the whole subtree names parents; the closed
// column folds; a change made elsewhere shows without a reload; a click opens the world; and
// the board of every root opens from the Issues header. Seeded statuses are put back.
// The Work page: the sidebar opens it, groups follow the issue tree and fold (remembered
// after a reload), Show and the filter narrow it, and a row opens its ITSA, an agent its world.
async function work() {
  console.log('# work');
  const p = await page();
  await p.setViewportSize({ width: 1700, height: 900 });
  const all = await api('/api/itsas');
  const root = all.find((x) => x.title === 'Check: issue system');
  if (!root) { check(false, 'the seeded ITSAs exist (seed.mjs)'); return p.context().close(); }
  const webUi = all.find((x) => /^Web UI/.test(x.title)), review = all.find((x) => x.title === 'Issues section in the sidebar');
  const jira = all.find((x) => x.title === 'Jira import');
  const approve = all.find((x) => x.title === 'Approve from the mail');
  const w = () => p.locator('.work-view:visible');
  const row = (id) => w().locator(`.w-row[data-itsa="${id}"]`);
  const group = (id) => w().locator(`.w-group[data-group="${id}"]`);
  await sideTab(p, 'issues');
  await p.locator('#issues-work').click();
  await w().locator('.w-row').first().waitFor();
  same(await p.evaluate(() => window.stamDebug.shell.currentWorld()), 'w:work', 'the sidebar opens the Work world');
  same(await w().locator('.w-head [role=columnheader]').allInnerTexts(), ['Work', 'Status', 'Agents', 'Branch', 'GitHub', 'Test env', 'Linear', 'Other links', 'Time', 'Cost', 'Window', 'Health', 'Review', 'Tests', 'Updated'],
    'the columns come from the registry, in order: a column per kind of link, and no action column (S-363)');
  const cell = (id, col) => row(id).locator(`.wc-${col}`).innerText().then((t) => t.trim()).catch(() => '');
  same([await cell(webUi.id, 'branch'), await cell(webUi.id, 'github'), await cell(webUi.id, 'test'), await cell(webUi.id, 'linear')], ['stam/dash-data', 'PR #15', 'staging', ''],
    'Links: each kind in its own column, a test link by its id');
  same(await row(webUi.id).locator('.wc-branch svg, .wc-github svg, .wc-test svg').count(), 3, 'Links: each link carries its kind\'s icon');
  check(await row(webUi.id).locator('.wc-github a[target="_blank"][rel*="noopener"]').count() === 1 && await row(webUi.id).locator('.wc-branch a').count() === 0, 'Links: a link opens in a new tab; a branch is only named');
  same(await cell(webUi.id, 'health'), 'At risk', 'Health: the owner update\'s health reads in words');
  same(await cell(webUi.id, 'review'), 'approved', 'Review: the branch link\'s verdict');
  same(await cell(webUi.id, 'tests'), '1 failed of 14', 'Tests: failing tests show with their counts');
  same(await cell(jira.id, 'health'), '', 'Health: a row with no health shows nothing');
  check(await group(root.id).locator('.w-ghead').innerText().then((t) => t.includes(root.key) && t.includes(root.title)), "the issue tree's root heads a group");
  const depth = async (id) => row(id).locator('.w-cell.wc-work').evaluate((el) => getComputedStyle(el).getPropertyValue('--depth').trim());
  same([await depth(webUi.id), await depth(review.id)], ['0', '1'], 'children indent below their parent');
  check(await row(webUi.id).locator('.w-summary').innerText() !== '', 'a row shows its one-line summary');
  check(await row(webUi.id).locator('.w-agent').count() >= 2, 'the Agents cell names the owner and the agent participants', await row(webUi.id).locator('.w-agent').count());
  check(await row(jira.id).count() === 0, 'Open hides closed work');
  // The page fits its pane (measured, so a sidebar counts): a table whose columns drop as the pane
  // narrows, and the phone's glance below 900 px (S-301). Neither holds a button that acts (S-363).
  const pane = async (width) => {
    await p.setViewportSize({ width, height: 900 })
    await p.waitForTimeout(200)
    return w().evaluate((el) => {
      const t = el.querySelector('.w-table')
      return { pane: el.clientWidth, card: el.hasAttribute('data-glance'), overflow: t ? t.scrollWidth - t.clientWidth : 0 }
    })
  }
  // The only buttons in the rows open an agent; the glance's two below its sections show more and go to Issues; the Filter button and the quick-filter chips only set the view.
  const actions = () => p.evaluate(() => [...document.querySelectorAll('.work-view .w-table button')]
    .filter((b) => b.offsetParent !== null && !b.matches('.w-agent, .w-time-cell, .w-gtoggle, .w-rowtoggle, .w-hmenu, .wg-ghead, .wg-more, .wg-browse, .wg-filter, .wg-view, .w-qchip')).map((b) => b.className || b.textContent))
  const wide = await pane(1500)
  check(!wide.card && wide.overflow <= 0, 'work: at 1,500 px the table fits its pane', JSON.stringify(wide))
  same(await actions(), [], 'work: the table has no action buttons (S-363)')
  // Row folds (S-1437): a chevron on rows with subrows folds them, shows the hidden count, and never opens the row;
  // Collapse all and Expand all work on every row; the table fits its pane at 1,024 and 1,280 px with every column.
  const toggles = w().locator('.w-row button.w-rowtoggle')
  check(await toggles.count() > 0, 'work: rows with subrows have a fold chevron')
  const before = await w().locator('.w-row[data-itsa]').count()
  await toggles.first().click()
  check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:work', 'work: the chevron doesn\'t open the row')
  check(await w().locator('.w-row[data-itsa]').count() < before && await w().locator('.w-row [data-hidden]').count() === 1 && await toggles.first().getAttribute('aria-expanded') === 'false', 'work: folding hides the subrows and shows their count')
  await w().locator('[data-fold-all=expand]').click()
  same(await w().locator('.w-row[data-itsa]').count(), before, 'work: Expand all brings every row back')
  await w().locator('[data-fold-all=collapse]').click()
  check(await w().locator('.w-row [data-hidden]').count() > 0 && await w().locator('.w-row[data-itsa]').count() < before, 'work: Collapse all folds every row with subrows')
  await w().locator('[data-fold-all=expand]').click()
  // The keyboard: Enter folds a focused chevron and Space unfolds it, as real keys in the browser.
  await toggles.first().focus()
  await p.keyboard.press('Enter')
  check(await toggles.first().getAttribute('aria-expanded') === 'false' && await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:work', 'work: Enter on the chevron folds the row and doesn\'t open it')
  await toggles.first().focus()
  await p.keyboard.press('Space')
  check(await toggles.first().getAttribute('aria-expanded') === 'true', 'work: Space on the chevron unfolds it')
  // A 1,024 px window leaves a pane under 900 px beside the sidebar (the glance, with no table), so the table is
  // measured at the narrowest windows that show it: 1,210 px (a pane of about 910) and 1,280 px.
  for (const width of [1210, 1280]) {
    const m = await pane(width)
    check(!m.card && m.overflow <= 0, `work: at ${width} px the table is shown and has no sideways scroll`, JSON.stringify(m))
    await p.screenshot({ path: `${out}/work-fold-${width}.png` })
  }
  await pane(1500)
  // The Quick row (S-1515): six toggles; Blocked narrows the count to "N of M", a second press restores it.
  check(await w().locator('.w-quick .w-qchip').count() === 6, 'work: the Quick row has six toggles')
  await w().locator('.w-qchip[data-quick="blocked"]').click()
  check(await w().locator('.w-qchip[data-quick="blocked"]').getAttribute('aria-pressed') === 'true' && /^\d+ of \d+$/.test(await w().locator('.work-bar .count').innerText()), 'work: a quick toggle on shows "N of M"')
  await w().locator('.w-qchip[data-quick="blocked"]').click()
  check(await w().locator('.w-qchip[aria-pressed="true"]').count() === 0 && /^\d+$/.test(await w().locator('.work-bar .count').innerText()), 'work: pressing it again restores the count')
  // The search box (S-1519) reads every column: a branch name finds the row, not only its key, title or summary.
  const searchBox = w().locator('.w-filter input')
  same(await searchBox.getAttribute('aria-label'), 'Search all columns', 'work: the search box says it searches all columns')
  await searchBox.fill('STAM/DASH-DATA')
  await row(webUi.id).waitFor()
  check(!webUi.title.toLowerCase().includes('dash-data') && await row(approve.id).count() === 0, 'work: a branch name finds the row, case aside, and leaves unrelated rows out')
  await searchBox.fill('no column has this text')
  check(await w().locator('.work-empty').innerText().then((t) => t.includes('in any column')), 'work: no match says no column has the text')
  await searchBox.fill('')
  await row(webUi.id).waitFor()
  // The view tabs (S-1517): Default first; an edit puts the dot on the current tab, Save as keeps the view as a
  // tab, one click on Default or the new tab switches, Revert drops the edit, and Delete removes the tab.
  const tab = (id) => w().locator(`.w-tabs [role=tab][data-view="${id}"]`)
  check(await w().locator('.w-tabs [role=tab]').first().innerText() === 'Default' && await tab('').getAttribute('aria-selected') === 'true', 'work: the tab strip starts with Default, selected')
  await w().locator('.w-qchip[data-quick="blocked"]').click()
  check(await w().locator('.w-tabs .w-tdot').count() === 1 && await tab('').locator('.w-tdot').count() === 1, 'work: an edit puts the dot on the current tab')
  await w().locator('.w-tools .btn', { hasText: 'View' }).click()
  await p.locator('.menu [role=menuitem]', { hasText: 'Save as…' }).click()
  await p.locator('.w-save input').fill('UI check view')
  await p.locator('.w-save button[type=submit]').click()
  await w().locator('.w-tabs [role=tab]', { hasText: 'UI check view' }).waitFor()
  const mine = w().locator('.w-tabs [role=tab]', { hasText: 'UI check view' })
  check(await mine.getAttribute('aria-selected') === 'true' && await w().locator('.w-tabs .w-tdot').count() === 0, 'work: Save as adds the view as the current tab, with no dot')
  await tab('').click()
  check(await w().locator('.w-qchip[aria-pressed="true"]').count() === 0 && await w().locator('.w-tabs .w-tdot').count() === 0, 'work: one click on Default brings the default layout, with no dot')
  await mine.click()
  check(await w().locator('.w-qchip[data-quick="blocked"]').getAttribute('aria-pressed') === 'true', 'work: one click on the tab brings its quick filter back')
  await w().locator('.w-qchip[data-quick="mine"]').click()
  check(await mine.locator('.w-tdot').count() === 1, 'work: a further edit marks the saved tab')
  await w().locator('.w-tools .btn', { hasText: 'View' }).click()
  await p.locator('.menu [role=menuitem]', { hasText: 'Revert' }).click()
  check(await w().locator('.w-tabs .w-tdot').count() === 0 && await w().locator('.w-qchip[data-quick="mine"]').getAttribute('aria-pressed') === 'false', 'work: Revert drops the edit and the dot')
  await w().locator('.w-tools .btn', { hasText: 'View' }).click()
  await p.locator('.menu [role=menuitem]', { hasText: 'Delete' }).click()
  await mine.waitFor({ state: 'detached' })
  check(await tab('').getAttribute('aria-selected') === 'true' && await w().locator('.w-qchip[aria-pressed="true"]').count() === 0, 'work: Delete removes the tab and leaves Default')
  await shot(p, 'work-view-tabs')
  check(await w().locator('.w-head [role=columnheader].wc-window').count() === 0 && await w().locator('.w-head [role=columnheader].wc-tests').count() === 1,
    'work: Window drops first as the pane narrows; Tests stays at this width', JSON.stringify(wide))
  await shot(p, 'work-desktop-1500');
  const narrow = await pane(1100)
  check(narrow.card, 'work: at 1,100 px the pane is narrower than the table, so the glance shows', JSON.stringify(narrow))
  same(await actions(), [], 'work: the glance has no action buttons (S-363)')
  await shot(p, 'work-desktop-1100');
  const narrower = await pane(1000)
  check(narrower.card, 'work: at 1,000 px the glance is in use', JSON.stringify(narrower))
  await shot(p, 'work-desktop-1000');
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.waitForTimeout(150);

  // The pinned Needs-you group: everything waiting on the human, oldest first, above the issue
  // trees and impossible to fold away. A row opens where the human answers it. kid's human wait
  // folds into the rows of the ITSAs it owns waiting on you (S-311), so intake, which owns none,
  // waits on you here to have a row of its own; the wait is cleared after the check.
  const intake = agents.find((a) => a.name === 'intake');
  const intakeWait = intake && await api(`/api/agents/${intake.id}/waits`, { method: 'POST', body: JSON.stringify({ kind: 'human', detail: 'your call on the rollout', source: 'declared' }) });
  const att = await api('/api/itsas/attention');
  const needs = w().locator('.w-needs');
  await needs.locator('[data-kind="wait"]').first().waitFor({ timeout: 10000 }).catch(() => {});
  check(await needs.count() === 1, 'the Work page pins one Needs-you group');
  const groupOrder = await w().locator('.w-group').evaluateAll((els) => els.map((e) => e.dataset.group));
  check(groupOrder[0] === 'needs', 'the Needs-you group sits above the issue trees', groupOrder.slice(0, 4).join(','));
  check(await needs.locator('.w-needs-mark').count() === 1, 'the group carries a warning mark');
  check(await needs.locator('.w-gtoggle').count() === 0, 'the group has no fold control, so it cannot be collapsed away');
  const needRows = await needs.locator('.w-need').count();
  check(await needs.locator('[data-needs-count]').innerText() === String(needRows), 'the group counts its rows', needRows);
  same(await needs.locator('[data-kind="itsa"]').evaluateAll((els) => els.map((e) => e.dataset.need)), att.map((a) => 'i:' + a.id), 'every ITSA waiting on you has a row, oldest first');
  check(await needs.locator('[data-kind="perm"]').count() >= 1 && await needs.locator('[data-kind="wait"]').count() >= 1, 'a pending request and an agent\'s human wait each have a row');
  same(await needs.locator('button:not(.w-agent)').count(), 0, 'a needs row offers no action buttons (S-363)');
  if (intakeWait?.id) await api(`/api/agents/${intake.id}/waits/done`, { method: 'POST', body: JSON.stringify({ id: intakeWait.id }) });
  check(await row(review.id).evaluate((el) => el.classList.contains('attention')), 'an ITSA in the group is marked in its tree row too');
  // One grid: a needs row's Status sits under the header's, at the same x as a tree row's.
  const headerStatus = await w().locator('.w-head .wc-status').boundingBox();
  const needStatus = await w().locator('.w-need .wc-status').first().boundingBox();
  const treeStatus = await row(webUi.id).locator('.wc-status').boundingBox();
  check(!!headerStatus && !!needStatus && !!treeStatus && Math.abs(needStatus.x - headerStatus.x) < 1 && Math.abs(needStatus.x - treeStatus.x) < 1,
    'a needs row lines up with the tree columns under the one header', `${needStatus?.x} / ${treeStatus?.x} / ${headerStatus?.x}`);
  await shot(p, 'work-needs');
  // A needs row opens its ITSA, where its actions are.
  await needs.locator(`[data-need="i:${approve.id}"] .wc-work`).click();
  await p.waitForTimeout(300);
  same(await p.evaluate(() => window.stamDebug.shell.currentWorld()), 'w:itsa:' + approve.id, 'a needs row opens its ITSA');
  await sideTab(p, 'issues');
  await p.locator('#issues-work').click();
  await w().locator('.w-row').first().waitFor();

  // Sort and filter from the header (S-1513): flat, so the rows are one list.
  await w().locator('[data-mode="flat"]').click();
  await w().locator('.w-row').first().waitFor();
  const statusCol = () => w().locator('.w-row:not(.w-need) .wc-status').evaluateAll((els) => els.map((e) => e.innerText.trim().toLowerCase()));
  const unsorted = await statusCol();
  const sortHead = w().locator('.w-head [data-col=status]');
  const settled = async (dir) => { for (let i = 0; i < 40 && await sortHead.getAttribute('aria-sort') !== dir; i++) await p.waitForTimeout(100); };
  await sortHead.click({ position: { x: 10, y: 10 } });
  await settled('ascending');
  same(await sortHead.getAttribute('aria-sort'), 'ascending', 'sort: a header click sorts ascending');
  const asc = await statusCol();
  await sortHead.click({ position: { x: 10, y: 10 } });
  await settled('descending');
  same(await statusCol(), asc.slice().reverse(), 'sort: a second click reverses the order');
  await shot(p, 'work-sorted');
  await sortHead.click({ position: { x: 10, y: 10 } });
  for (let i = 0; i < 40 && await sortHead.getAttribute('aria-sort'); i++) await p.waitForTimeout(100);
  same(await statusCol(), unsorted, 'sort: a third click puts the rows back');
  const reviewWord = review.status.replace(/_/g, ' ');
  await w().locator('.w-head [data-col=status]').hover();
  await w().locator('.w-head [data-col=status] .w-hmenu').click();
  await p.locator('.menu.popover').waitFor();
  await p.locator('.menu.popover .fm-bulk button', { hasText: 'None' }).click();
  await p.locator('.menu.popover .rm-row', { hasText: reviewWord }).click();
  await shot(p, 'work-header-menu');
  check((await statusCol()).length > 0 && (await statusCol()).every((s) => s.includes(reviewWord)), 'filter: only the ticked status stays', (await statusCol()).join(','));
  same(await w().locator('.w-ftoken').innerText().then((t) => t.toLowerCase()), `status: ${reviewWord}`, 'filter: the active-filter row has a token for it');
  check(/ of \d+$/.test(await w().locator('.work-bar > .count').innerText()), 'filter: the count reads N of M');
  await shot(p, 'work-filtered');
  await w().locator('.w-fclear').click();
  check(await w().locator('.w-filters').count() === 0, 'filter: Clear all removes the row');
  same((await statusCol()).length, unsorted.length, 'filter: every row is back after Clear all');
  // Filter from a cell (S-1518): a right-click on a status cell offers that value's filters, and the row stays closed.
  const cellRow = () => w().locator('.w-row:not(.w-need)').first();
  const cellStatus = (await statusCol())[0];
  const cellItem = (label) => p.locator('.menu [role=menuitem]', { hasText: label }).first();
  await cellRow().locator('.wc-status').click({ button: 'right' });
  await cellItem('Filter to this value').waitFor();
  same(await p.locator('.menu [role=menuitem] .ml').allInnerTexts(), ['Filter to this value', 'Exclude this value', 'Sort by this column, ascending', 'Sort by this column, descending'], 'cell: the status cell offers its value filters and a sort');
  await shot(p, 'work-cell-menu');
  await cellItem('Filter to this value').click();
  await w().locator('.w-ftoken').waitFor();
  check((await statusCol()).length > 0 && (await statusCol()).every((s) => s === cellStatus), 'cell: Filter to this value keeps only rows with it', (await statusCol()).join(','));
  same(await p.evaluate(() => window.stamDebug.shell.currentWorld()), 'w:work', 'cell: the right-click did not open the row');
  await w().locator('.w-fclear').click();
  await cellRow().locator('.wc-status').click({ button: 'right' });
  await cellItem('Exclude this value').click();
  check((await statusCol()).length > 0 && (await statusCol()).every((s) => s !== cellStatus), 'cell: Exclude this value hides the rows with it', (await statusCol()).join(','));
  await w().locator('.w-fclear').click();
  same((await statusCol()).length, unsorted.length, 'cell: every row is back after Clear all');
  await w().locator('[data-mode="issues"]').click();
  await w().locator('.w-row').first().waitFor();

  await shot(p, 'work-desktop');
  await w().locator('[data-show="all"]').click();
  check(await row(jira.id).count() === 1, 'All shows closed work too');
  await w().locator('[data-show="open"]').click();
  await w().locator('.w-filter input').fill('ISSUES SECTION');
  await p.waitForTimeout(100);
  same(await w().locator('.w-group:not(.w-needs) .w-row').evaluateAll((els) => els.map((e) => e.dataset.itsa + (e.classList.contains('context') ? '~' : ''))), [webUi.id + '~', review.id], 'the filter keeps matches and, as context, the path to them');
  await w().locator('.w-filter input').fill('');
  await group(root.id).locator('.w-gtoggle').click();
  check(await group(root.id).locator('.w-row').count() === 0, 'a group folds');
  await p.reload();
  await w().locator('.w-ghead').first().waitFor();
  check(await group(root.id).locator('.w-row').count() === 0 && await group(root.id).locator('.w-gtoggle').getAttribute('aria-expanded') === 'false', 'the fold is remembered after a reload');
  await group(root.id).locator('.w-gtoggle').click();
  await group(root.id).locator('.w-gkey').click();
  await p.waitForTimeout(300);
  same(await p.evaluate(() => window.stamDebug.shell.currentWorld()), 'w:itsa:' + root.id, "a group's key opens its root");
  await sideTab(p, 'issues');
  await p.locator('#issues-work').click();
  await w().locator('.w-row').first().waitFor();
  await row(webUi.id).locator('.w-agent').first().click();
  await p.waitForTimeout(300);
  check(!(await p.evaluate(() => window.stamDebug.shell.currentWorld())).startsWith('w:'), "an agent in a row opens the agent's world", await p.evaluate(() => window.stamDebug.shell.currentWorld()));
  await sideTab(p, 'issues');
  await p.locator('#issues-work').click();
  // Click the title cell: the centre of a row can land on an agent button, which opens the agent.
  await row(review.id).locator('.w-cell.wc-work').click();
  await p.waitForTimeout(300);
  same(await p.evaluate(() => window.stamDebug.shell.currentWorld()), 'w:itsa:' + review.id, 'a row opens its ITSA');
  await sideTab(p, 'issues');
  await p.locator('#issues-work').click();
  await w().locator('.w-row').first().waitFor();

  // The Work page's composer writes to the chief of staff. The chief of staff is whoever the
  // agent list marks; with none, helper is made one for these checks and set back to none at the end.
  const chiefOf = async () => (await api('/api/agents')).find((a) => a.chief_of_staff === true);
  const chiefBefore = await chiefOf();
  if (!chiefBefore) await api('/api/chief-of-staff', { method: 'POST', body: JSON.stringify({ agent: 'helper' }) });
  const chief = await chiefOf();
  check(!!chief, 'a chief of staff is set for the Work checks', chief?.name);
  // With no chief of staff, the Work composer says so and stays disabled.
  await api('/api/chief-of-staff', { method: 'POST', body: JSON.stringify({ agent: null }) });
  await p.waitForTimeout(800);
  await sideTab(p, 'issues');
  await p.locator('#issues-work').click();
  await w().locator('.w-row').first().waitFor();
  await p.waitForTimeout(1500);
  // Nothing to write to (S-1474): the bar suggests a recipient and names what the main world showed.
  check(await p.locator('#w-bottom .composer').count() === 1 && (await p.locator('#w-bottom textarea').getAttribute('placeholder')).includes('Work · no chief of staff'), 'with no chief of staff the Work bar suggests a recipient and names the page', await p.locator('#w-bottom textarea').getAttribute('placeholder'));
  await api('/api/chief-of-staff', { method: 'POST', body: JSON.stringify({ agent: chief.id }) });
  await sideTab(p, 'issues');
  await p.locator('#issues-work').click();
  await w().locator('.w-row').first().waitFor();
  // The bottom composer on the Work page: it names the chief of staff and mails it.
  const box = p.locator('#w-bottom textarea');
  await box.waitFor();
  // The store refreshes on a poll, so the placeholder can lag the chief change by a moment.
  await p.waitForFunction((want) => document.querySelector('#w-bottom textarea')?.getAttribute('placeholder') === want, `Mail ${chief.name}`, { timeout: 8000 }).catch(() => {});
  same(await box.getAttribute('placeholder'), `Mail ${chief.name}`, 'the Work page composer is placed for the chief of staff');
  await box.fill('Work composer check');
  await box.press('Enter');
  // The composer's hint reads the send's result: the mail went to the chief of staff.
  await p.locator('#w-bottom', { hasText: `Mailed ${chief.name}` }).waitFor({ timeout: 5000 }).catch(() => {});
  check((await box.inputValue()) === '' && (await p.locator('#w-bottom').innerText()).includes(`Mailed ${chief.name}`), 'the Work page composer mails the chief of staff', await p.locator('#w-bottom').innerText());
  if (!chiefBefore) await api('/api/chief-of-staff', { method: 'POST', body: JSON.stringify({ agent: null }) });
  await shot(p, 'work-composer-cos');

  // Columns: the Columns menu hides and shows, headers drag and take the arrow keys to reorder,
  // an edge drags to resize (a double-click resets it), and a saved view comes back exactly.
  const heads = () => w().locator('.w-head [role=columnheader]').evaluateAll((els) => els.map((e) => e.dataset.col))
  const headBox = (col) => w().locator(`.w-head [data-col=${col}]`).boundingBox()
  const toolbar = (n) => w().locator('.w-tools button').nth(n)
  // A Columns or View menu item, by its exact label.
  const item = (label) => p.locator('.menu button').filter({ has: p.getByText(label, { exact: true }) })
  const pick = (label) => item(label).click()
  // The table's columns at the default layout, as they fit this pane.
  const initial = await heads()
  const dragHeader = async (col, toX) => {
    const b = await headBox(col)
    const y = b.y + b.height / 2
    await p.mouse.move(b.x + b.width / 2, y)
    await p.mouse.down()
    await p.mouse.move(b.x + b.width / 2 + 12, y, { steps: 3 })
    await p.mouse.move(toX, y, { steps: 12 })
    await p.mouse.up()
    await p.waitForTimeout(100)
  }
  await toolbar(1).click();
  await item('Work').waitFor()
  check(await item('Work').isDisabled() && await item('Branch').isEnabled() && await item('Actions').count() === 0, 'Columns: work is on and locked; each link column can be hidden; there is no Actions column')
  await p.waitForTimeout(300)
  await shot(p, 'work-columns-menu');
  // The search narrows the list by label, says so when nothing matches, and Space toggles the focused column.
  const colSearch = p.locator('.menu input[aria-label="Search columns"]')
  check(await colSearch.evaluate((e) => e === document.activeElement), 'Columns: the search has the focus on open')
  await colSearch.fill('cos')
  check(await p.locator('.menu [role=menuitemcheckbox]').count() === 1 && await item('Cost').count() === 1, 'Columns: typing narrows the list by label')
  await colSearch.fill('zzzz')
  check(await p.locator('.menu .rm-none').count() === 1 && await p.locator('.menu [role=menuitemcheckbox]').count() === 0, 'Columns: no match says so')
  await colSearch.fill('cos')
  await p.keyboard.press('ArrowDown')
  await p.keyboard.press('Space')
  check(!(await heads()).includes('cost'), 'Columns: Arrow Down then Space unticks the focused column', JSON.stringify(await heads()))
  await toolbar(1).click();
  await pick('Cost')
  check((await heads()).includes('cost'), 'Columns: the search is gone on reopen and Cost ticks back on')
  await toolbar(1).click();
  check(await colSearch.inputValue() === '', 'Columns: the reopened search is empty')
  await p.keyboard.press('Escape')
  await toolbar(1).click();
  await pick('Cost')
  check(!(await heads()).includes('cost'), 'Columns: unticking Cost hides its column', JSON.stringify(await heads()))
  await toolbar(1).click();
  await pick('Cost')
  check((await heads()).includes('cost'), 'Columns: ticking Cost shows it again, back in its place')
  await dragHeader('status', (await headBox('branch')).x + (await headBox('branch')).width / 2 + 6)
  const moved = await heads()
  check(moved.indexOf('status') > moved.indexOf('branch') && moved.indexOf('status') < moved.indexOf('health'), 'a header dragged past Branch lands after it', JSON.stringify(moved))
  check(moved[0] === 'work', 'work stays first after a drag')
  await w().locator('.w-head [data-col=status]').focus()
  await p.keyboard.press('Alt+ArrowLeft')
  await p.waitForTimeout(100)
  // A column hidden at this width (Time, below 1400 px) takes the first press.
  if ((await heads()).indexOf('status') === moved.indexOf('status')) { await p.keyboard.press('Alt+ArrowLeft'); await p.waitForTimeout(100) }
  check((await heads()).indexOf('status') === moved.indexOf('status') - 1, 'Alt+Left moves the focused header one place left', JSON.stringify(await heads()))
  await shot(p, 'work-columns-reordered');
  const widthOf = async (col) => (await headBox(col)).width
  const w0 = await widthOf('branch')
  const grip = await w().locator('.w-head [data-col=branch] .w-resize').boundingBox()
  await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await p.mouse.down()
  await p.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 8 })
  await p.mouse.up()
  await p.waitForTimeout(100)
  check(await widthOf('branch') > w0 + 40, 'dragging the edge widens the column', `${w0} -> ${await widthOf('branch')}`)
  await shot(p, 'work-columns-resized');
  await w().locator('.w-head [data-col=branch] .w-resize').dblclick()
  await p.waitForTimeout(100)
  check(Math.abs(await widthOf('branch') - w0) <= 2, 'a double-click on the edge resets the width to the registry one', `${w0} vs ${await widthOf('branch')}`)
  // Save the current layout as a view, go to Default, and come back to the view.
  const laid = await heads()
  await toolbar(0).click();
  await p.locator('.menu button', { hasText: 'Save as' }).click()
  await p.locator('.w-save input').fill('Lean')
  await p.locator('.w-save button[type=submit]').click()
  await p.waitForTimeout(100)
  await toolbar(0).click();
  await pick('Default')
  same(await heads(), initial, 'View: Default shows the registry columns in the registry order')
  await toolbar(0).click();
  await pick('Lean')
  same(await heads(), laid, 'View: switching back to the saved view restores its columns and order')
  // The views are in settings (S-293), not in this browser: Lean is in the saved settings.
  const workViews = async () => JSON.parse((await api('/api/config/settings')).text).workViews ?? {};
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(200); } return false; };
  check(await until(async () => Object.values(await workViews()).some((v) => v.name === 'Lean')), 'View: the saved view is in settings');
  check(!(await p.evaluate(() => localStorage.getItem('stam/work-views'))), 'View: the views are not kept in this browser');
  await p.reload();
  await w().locator('.w-head [role=columnheader]').first().waitFor();
  // The views load from settings after the page shows, so wait for the saved columns to come back.
  check(await until(async () => JSON.stringify(await heads()) === JSON.stringify(laid)), 'View: the current view is kept across a reload');

  // Group: Issues (the default), Agents, and Flat. Each lists every open ITSA once; the Needs-you
  // group stays first in every mode; Flat is newest update first; a reload keeps the choice.
  const rowIds = () => w().locator('.w-group:not(.w-needs) .w-row:not(.context)').evaluateAll((els) => els.map((e) => e.dataset.itsa))
  const openNow = (await api('/api/itsas')).filter((x) => !['done', 'canceled', 'duplicate', 'wont_do'].includes(x.status))
  const stamp = new Map(openNow.map((x) => [x.id, Date.parse(x.updated_at)]))
  const firstGroup = () => w().locator('.w-group').first().getAttribute('data-group')
  check(await firstGroup() === 'needs', 'Group: the Needs-you group is first in Issues');
  await w().locator('[data-mode="flat"]').click();
  const flat = await rowIds()
  same(flat.slice().sort(), openNow.map((x) => x.id).sort(), 'Flat: every open ITSA once, and no context rows');
  check(flat.every((id, i) => i === 0 || stamp.get(flat[i - 1]) >= stamp.get(id)), 'Flat: newest update first', flat);
  check(await firstGroup() === 'needs' && await w().locator('.w-gtoggle').count() === 0, 'Group: Flat has no group headers, and the Needs-you group still leads');
  await w().locator('[data-mode="agents"]').click();
  const byAgent = await rowIds()
  // Once per agent tree, under its owner or a participant there (S-2735): no ITSA twice in one group, and every open ITSA shows.
  const groupIds = await w().locator('.w-group:not(.w-needs)').evaluateAll((gs) => gs.map((g) => [...g.querySelectorAll('.w-row:not(.context)')].map((e) => e.dataset.itsa)))
  check(groupIds.every((ids) => new Set(ids).size === ids.length), 'Agents: no ITSA twice in one group', groupIds);
  same([...new Set(byAgent)].sort(), openNow.map((x) => x.id).sort(), 'Agents: every open ITSA under an agent tree or Unowned');
  const agentNames = (await api('/api/agents')).map((a) => a.name)
  const heads2 = await w().locator('.w-group:not(.w-needs) .w-gname').allInnerTexts()
  check(heads2.length > 0 && heads2.every((h) => agentNames.includes(h) || h === 'Unowned'), 'Agents: each group is headed by a root agent\'s name, or Unowned', heads2);
  check(await firstGroup() === 'needs', 'Group: the Needs-you group is first in Agents');
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.waitForTimeout(200);
  await shot(p, 'work-agents-desktop-1500');
  // The grouping is saved to settings before the reload, so the reload reads it back.
  check(await until(async () => (await workViews()).work?.group === 'agents'), 'Group: the grouping is saved in settings');
  await p.reload();
  await w().locator('[data-mode="agents"]').waitFor();
  check(await until(async () => await w().locator('[data-mode="agents"]').getAttribute('aria-checked') === 'true'), 'Group: a reload keeps Agents');
  await w().locator('[data-mode="issues"]').click();
  check(await group(root.id).count() === 1, 'Group: switching back to Issues brings the issue groups back');

  // Group by a column (S-1520): By column… lists the groupable columns; Status heads each group with
  // its label and count in category order, every open ITSA is in one group, a fold hides a group's rows,
  // and a reload keeps the choice.
  await w().locator('[data-group-col-btn]').click();
  await p.locator('.menu [role=menuitemradio]', { hasText: /^Status$/ }).click();
  check(await until(async () => await w().locator('[data-group-col-btn]').innerText() === 'By Status'), 'Group by column: the button names the column');
  const sGroups = await w().locator('.w-group:not(.w-needs)[data-group-col="status"]').evaluateAll((els) => els.map((e) => e.dataset.groupValue));
  check(sGroups.length > 0, 'Group by column: Status makes a group for each status in use', sGroups);
  const sHeads = await w().locator('.w-group[data-group-col="status"] .w-gtoggle').evaluateAll((els) => els.map((e) => ({ n: Number(e.querySelector('.count').textContent), label: e.querySelector('.w-gname').textContent })));
  const sRows = await w().locator('.w-group[data-group-col="status"]').evaluateAll((els) => els.map((e) => e.querySelectorAll('.w-row').length));
  check(sHeads.every((h, i) => h.n === sRows[i] && h.label), 'Group by column: each head has its label and the count of its rows', sHeads);
  same((await rowIds()).slice().sort(), openNow.map((x) => x.id).sort(), 'Group by column: every open ITSA is in one status group');
  const cats = ['backlog', 'ready', 'active', 'review', 'closed'];
  const catOf = Object.fromEntries(((await api('/api/itsas/statuses')).statuses ?? []).map((s) => [s.name, s.category]));
  const ranks = sGroups.map((v) => cats.indexOf(catOf[v]));
  check(Object.keys(catOf).length === 0 || ranks.every((r, i) => i === 0 || ranks[i - 1] <= r), 'Group by column: Status groups follow the category order', ranks);
  check(await firstGroup() === 'needs', 'Group by column: the Needs-you group still leads');
  await w().locator('.w-group[data-group-col="status"] .w-gtoggle').first().click();
  check(await w().locator('.w-group[data-group-col="status"]').first().locator('.w-row').count() === 0, 'Group by column: a fold hides the group\'s rows');
  await w().locator('.w-group[data-group-col="status"] .w-gtoggle').first().click();
  check(await until(async () => (await workViews()).work?.group === 'column' && (await workViews()).work?.groupBy === 'status'), 'Group by column: the grouping is saved in settings');
  await p.reload();
  await w().locator('[data-group-col-btn]').waitFor();
  check(await until(async () => await w().locator('[data-group-col-btn]').innerText() === 'By Status'), 'Group by column: a reload keeps it');
  await w().locator('[data-mode="issues"]').click();
  check(await group(root.id).count() === 1, 'Group by column: Issues brings the issue groups back');

  // ITSA fields are columns (S-369): a choice with tones, a link and a number, set on two ITSAs. A
  // field shows by default, a value draws by its type, an empty one draws nothing, and a field the
  // user hid stays hidden through a reload. The phone's card shows the non-empty ones.
  const mk = (body) => api('/api/itsas/fields', { method: 'POST', body: JSON.stringify(body) });
  const fPrio = await mk({ key: 'prio', label: 'Priority', type: 'choice', options: [{ value: 'hi', label: 'High', tone: 'bad' }, { value: 'ok', label: 'Fine', tone: 'ok' }], width: 's', card: 'chip' });
  const fDoc = await mk({ key: 'doc', label: 'Spec', type: 'link', width: 'm', card: 'meta' });
  const fPts = await mk({ key: 'pts', label: 'Points', type: 'number', width: 's', align: 'end', card: 'meta', hint: 'Story points' });
  const setFields = (it, fields) => api('/api/itsas/' + it.id, { method: 'PATCH', body: JSON.stringify({ fields }) });
  await setFields(webUi, { prio: 'hi', doc: 'https://www.example.com/spec', pts: 5 });
  await setFields(review, { prio: 'ok' });
  // A wide window: the fields drop out as the pane narrows, after the built-ins.
  await p.setViewportSize({ width: 2200, height: 900 });
  await p.reload();
  await w().locator('.w-row').first().waitFor();
  // The fields load after the rows do.
  await until(async () => (await w().locator('.w-head [role=columnheader]').allInnerTexts()).includes('Points'));
  const fcols = await w().locator('.w-head [role=columnheader]').allInnerTexts();
  same(fcols.slice(-3), ['Priority', 'Spec', 'Points'], 'Fields: a column per field, after the built-ins, by position');
  same(await w().locator('.w-head .wc-field\\:' + fPts.id).getAttribute('title'), 'Story points', 'Fields: the header\'s tooltip is the field\'s hint');
  same(await row(webUi.id).locator('.wc-field\\:' + fPrio.id + ' .badge.err').innerText(), 'High', 'Fields: a choice is its option\'s label in a badge with the tone');
  same(await row(review.id).locator('.wc-field\\:' + fPrio.id + ' .badge.ok').innerText(), 'Fine', 'Fields: another option, another tone');
  const doc = row(webUi.id).locator('.wc-field\\:' + fDoc.id + ' a');
  check(await doc.getAttribute('target') === '_blank' && (await doc.innerText()).trim() === 'example.com', 'Fields: a link opens in a new tab, labelled by its host');
  check(await row(webUi.id).locator('.wc-field\\:' + fPts.id).evaluate((el) => el.classList.contains('end')) && await row(webUi.id).locator('.wc-field\\:' + fPts.id).innerText() === '5', 'Fields: a number is end-aligned');
  same(await row(review.id).locator('.wc-field\\:' + fDoc.id).innerText(), '', 'Fields: an empty value draws nothing');
  await row(webUi.id).scrollIntoViewIfNeeded();
  await shot(p, 'work-fields-desktop-1500');
  // Hide Points; a reload keeps it hidden, and the seen list is saved with the layout.
  await w().locator('.w-tools button', { hasText: 'Columns' }).click();
  await p.locator('.menu [role=menuitemcheckbox]', { hasText: 'Points' }).click();
  check(await until(async () => (await workViews()).work?.seen?.length === 3 && !(await workViews()).work.cols.includes('field:' + fPts.id)), 'Fields: hiding one is saved, with the fields the layout has seen');
  await p.reload();
  await w().locator('.w-row').first().waitFor();
  await until(async () => (await w().locator('.w-head [role=columnheader]').allInnerTexts()).includes('Spec'));
  same((await w().locator('.w-head [role=columnheader]').allInnerTexts()).slice(-2), ['Priority', 'Spec'], 'Fields: a hidden field stays hidden after a reload');
  // A field added later shows at once; Settings' layout event reloads an open page.
  const fNew = await mk({ key: 'owner', label: 'Team', type: 'text', width: 'm', card: 'meta' });
  await p.evaluate(() => window.dispatchEvent(new Event('stam:work-layout')));
  check(await until(async () => (await w().locator('.w-head [role=columnheader]').allInnerTexts()).includes('Team')), 'Fields: a new field shows by default, with the hidden one still hidden');
  await api('/api/itsas/fields/' + fNew.id, { method: 'DELETE', body: JSON.stringify({ by: 'human' }) });
  await p.evaluate(() => window.dispatchEvent(new Event('stam:work-layout')));
  check(await until(async () => !(await w().locator('.w-head [role=columnheader]').allInnerTexts()).includes('Team')), 'Fields: a removed field drops out of the page');
  await w().locator('.w-tools button', { hasText: 'Columns' }).click();
  await p.locator('.menu [role=menuitemcheckbox]', { hasText: 'Points' }).click();
  // The glance and the phone's card (S-3560): the issue layout's IssueCard. Where a field sits follows the stored layout, or the
  // seed (`card: 'meta'` into META, a chip into BADGES), so only the choice's slot is fixed here; each value is in a data-cell span.
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(300);
  const card = (it) => w().locator(`.wg-card[data-itsa="${it.id}"]`).first();
  await card(webUi).waitFor();
  const fcell = (it, f) => card(it).locator(`[data-cell="field:${f.id}"]`);
  same(await card(webUi).locator(`.bc-badges [data-cell="field:${fPrio.id}"] .badge`).innerText(), 'High', 'Fields: a choice field is a chip on the card');
  check(await fcell(webUi, fDoc).count() === 1 && await fcell(webUi, fPts).count() === 1, 'Fields: the other fields with a value are on the card too');
  check(await fcell(review, fPrio).count() === 1, 'Fields: the card with a value draws it');
  check(await fcell(review, fDoc).count() === 0 && await fcell(review, fPts).count() === 0, 'Fields: a card shows no empty field');
  await card(webUi).scrollIntoViewIfNeeded();
  await shot(p, 'work-fields-card-390');
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.context().close();
  const d = await page(undefined, null, 'dark');
  await sideTab(d, 'issues');
  await d.locator('#issues-work').click();
  await d.locator('.work-view:visible .w-row').first().waitFor();
  await shot(d, 'work-desktop-dark');
  await d.setViewportSize({ width: 2200, height: 900 });
  await d.waitForTimeout(300);
  await shot(d, 'work-fields-desktop-dark');
  await d.setViewportSize({ width: 390, height: 844 });
  await d.waitForTimeout(300);
  await shot(d, 'work-fields-card-390-dark');
  await d.context().close();
  for (const f of [fPrio, fDoc, fPts]) await api('/api/itsas/fields/' + f.id, { method: 'DELETE', body: JSON.stringify({ by: 'human' }) });
}

async function board() {
  console.log('# board');
  const p = await page(undefined, /status of 500|Failed to load resource/);
  const all = await api('/api/itsas');
  const root = all.find((x) => x.title === 'Check: issue system');
  if (!root) { check(false, 'the seeded ITSAs exist (seed.mjs)'); return p.context().close(); }
  const { statuses } = await api('/api/itsas/statuses');
  const first = (c) => statuses.find((s) => s.category === c).name;
  const kids = all.filter((x) => x.parent_id === root.id);
  const byTitle = (t) => all.find((x) => x.title === t);
  const desk = byTitle('Board on the desktop'), phone = byTitle('Board on the phone'), owners = byTitle('Owners: spawn with an ITSA');
  const human = byTitle('Human attention: one list'), webUi = all.find((x) => /^Web UI/.test(x.title));
  const before = Object.fromEntries(all.map((x) => [x.id, x.status]));
  const b = () => p.locator('.board-view:visible');
  const card = (id) => b().locator(`.bcard[data-card="${id}"]`);
  const col = (id) => b().locator(`.bcol[data-col="${id}"]`);
  const colOf = async (id) => card(id).evaluate((el) => el.closest('.bcol').dataset.col);
  const order = async (c) => col(c).locator('.bcard').evaluateAll((els) => els.map((e) => e.dataset.card));
  const status = async (id) => (await api('/api/itsas/' + id)).status;
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(200); } return false; };
  // A point inside column C, above the card at INDEX (or below the last).
  const spot = async (c, index) => {
    const cards = col(c).locator('.bcard');
    const n = await cards.count();
    if (index < n) { const r = await cards.nth(index).boundingBox(); return { x: r.x + r.width / 2, y: r.y + 4 }; }
    const r = await col(c).locator('.bcol-cards').boundingBox();
    return { x: r.x + r.width / 2, y: n ? (await cards.nth(n - 1).boundingBox()).y + (await cards.nth(n - 1).boundingBox()).height + 8 : r.y + 20 };
  };

  await sideTab(p, 'issues');
  await p.locator(`#issues-side .irow[data-itsa="${root.id}"]`).click();
  await p.waitForSelector('.itsa-view[data-itsa] .itsa-head');
  const tabs = await p.locator('.tab').evaluateAll((els) => els.map((e) => e.textContent));
  check(tabs.some((t) => /board/.test(t)), "an ITSA's world opens with a board tab beside the view", tabs);
  await p.locator('.tab', { hasText: 'board' }).click();
  await b().waitFor();
  same(await b().locator('.bcol').evaluateAll((els) => els.map((e) => e.dataset.col)), ['backlog', 'ready', 'active', 'review', 'closed'], 'one column per category by default');
  same(await b().locator('.bcard').count(), kids.length, 'the board shows the direct children');
  check(await card(human.id).locator('.badge.warn').isVisible(), 'a card that waits on the human is marked');
  check(await card(owners.id).locator('.bc-links a').count() === 1, 'a card shows its link icons');
  check(await card(owners.id).locator('.glyph').count() > 0, "a card shows its owner's mark");
  check(await card(desk.id).locator('.chip.kind').innerText() === 'issue', 'a card shows its kind');
  check(/todo/.test(await card(desk.id).locator('.bc-status').innerText()), 'a card shows its status chip in category mode');
  check(await card(webUi.id).locator('.rollup').count() === 1, "a card shows its children's roll-up");
  await shot(p, 'board-1-categories');

  // Drag a card from Ready to Active: it takes Active's first status.
  await drag(p, card(desk.id), await spot('active', 0), async () => {
    check(await col('active').evaluate((el) => el.classList.contains('drop')), 'the column under the pointer takes the drop fill');
    check(await b().locator('.bdrop-line').count() === 1, 'a line marks where the card lands');
    check(await p.locator('.bcard.ghost').count() === 1, 'a ghost follows the pointer');
    await shot(p, 'board-2-dragging');
  });
  same(await colOf(desk.id), 'active', 'the card shows in the column it was dropped on');
  check(await until(async () => (await status(desk.id)) === first('active')), `the drop sets the category's first status (${first('active')})`, await status(desk.id));
  same((await order('active'))[0], desk.id, 'the card lands where it was dropped');

  // Drag within Active: to the bottom, then check the order survives a reload.
  const n = (await order('active')).length;
  await drag(p, card(desk.id), await spot('active', n));
  await until(async () => (await order('active')).at(-1) === desk.id);
  same((await order('active')).at(-1), desk.id, 'dragging within a column reorders it');
  check(await until(async () => (await api('/api/itsas/' + desk.id)).rank != null), 'the order is stored as rank');
  same(await status(desk.id), first('active'), 'reordering keeps the status');
  const kept = await order('active');
  await p.reload();
  await p.waitForSelector('.board-view:visible .bcard', { timeout: 20000 });
  same(await order('active'), kept, 'the order survives a reload');

  // A refused move rolls back.
  await p.route('**/api/itsas/*', (r) => (r.request().method() === 'PATCH' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refused for the check"}' }) : r.fallback()));
  await drag(p, card(phone.id), await spot('review', 0));
  check(await until(async () => (await colOf(phone.id)) === 'backlog'), 'a refused move puts the card back', await colOf(phone.id));
  check(/refused for the check/.test(await p.locator('#toasts').innerText()), 'and says why');
  same(await status(phone.id), 'backlog', 'the daemon kept the old status');
  await p.unroute('**/api/itsas/*');

  // The keyboard: Shift+Right moves to the next column, M opens "Move to…".
  await card(phone.id).focus();
  await p.keyboard.press('Shift+ArrowRight');
  check(await until(async () => (await status(phone.id)) === first('ready')), 'Shift+Right moves the card to the next column', await status(phone.id));
  check(await card(phone.id).evaluate((el) => el === document.activeElement), 'the moved card keeps the focus');
  await p.keyboard.press('m');
  await p.waitForSelector('.menu');
  check(/Move to/.test(await p.locator('.menu').innerText()), 'M opens the Move to menu');
  await shot(p, 'board-3-move-menu');
  await p.locator('.menu [role^=menuitem]', { hasText: 'Review' }).click();
  check(await until(async () => (await status(phone.id)) === first('review')), 'Move to sets the status', await status(phone.id));
  await card(phone.id).focus();
  await p.keyboard.press('ArrowLeft');
  check(await p.evaluate(() => document.activeElement?.closest('.bcol')?.dataset.col) === 'active', 'Left moves the focus to the previous column');

  // S-628: one rule for a context action. A right click opens the card's actions as a popover at the
  // pointer and cancels the browser's menu; the context-menu key and Shift+F10 open them at the card.
  await p.evaluate(() => { window.__ctx = []; addEventListener('contextmenu', (e) => setTimeout(() => window.__ctx.push(e.defaultPrevented), 0), true); });
  const cb = await card(phone.id).boundingBox();
  await card(phone.id).click({ button: 'right', position: { x: 30, y: 10 } });
  await p.waitForSelector('.menu');
  const mb = await p.locator('.menu').boundingBox();
  check(Math.abs(mb.x - (cb.x + 30)) < 40 && Math.abs(mb.y - (cb.y + 10)) < 40, 'a right click opens the card menu as a popover at the pointer', JSON.stringify({ mb, cb }));
  check(/Move to/.test(await p.locator('.menu').innerText()), 'the popover holds the same actions as the phone sheet');
  await p.waitForTimeout(100);
  check((await p.evaluate(() => window.__ctx)).length > 0 && (await p.evaluate(() => window.__ctx)).every(Boolean), "a right click cancels the browser's own menu", JSON.stringify(await p.evaluate(() => window.__ctx)));
  await p.keyboard.press('Escape');
  await p.waitForSelector('.menu', { state: 'detached' });
  await card(phone.id).focus();
  await p.keyboard.press('Shift+F10');
  await p.waitForSelector('.menu');
  check(/Move to/.test(await p.locator('.menu').innerText()), 'Shift+F10 opens the card menu');
  await p.keyboard.press('Escape');
  await p.waitForSelector('.menu', { state: 'detached' });
  // A held mouse button is not a long press: only touch holds.
  const mid = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 };
  await p.mouse.move(mid.x, mid.y); await p.mouse.down(); await p.waitForTimeout(700);
  const heldMenu = await p.locator('.menu').count();
  await p.mouse.move(2, 2); await p.mouse.up(); // released off the card, so it isn't a click that opens it
  check(!heldMenu, 'holding the mouse button opens no menu');

  // One column per status, and a drag to an exact status.
  await b().locator('[data-mode-btn="status"]').click();
  same(await b().locator('.bcol').count(), statuses.length, 'one column per status');
  // The view is kept in settings (S-293), so it is read back after a reload, not from this browser.
  const savedView = async () => JSON.parse((await api('/api/config/settings')).text).boardViews?.[root.id];
  check(await until(async () => (await savedView())?.mode === 'status'), 'the board view is saved in settings');
  await p.reload();
  await b().waitFor();
  check(await until(async () => (await b().locator('.bcol').count()) === statuses.length), 'the saved view comes back after a reload');
  check(await card(desk.id).locator('.bc-status').count() === 0, 'a card in its own status column drops the chip');
  // Scroll the lanes so the card's column is first; blocked is then in view too.
  await b().locator('.board-cols').evaluate((el, id) => { el.scrollLeft = el.querySelector(`.bcard[data-card="${id}"]`).closest('.bcol').offsetLeft - el.offsetLeft - 20; }, desk.id);
  await drag(p, card(desk.id), await spot('blocked', 0));
  check(await until(async () => (await status(desk.id)) === 'blocked'), 'a drop on a status column sets that status', await status(desk.id));
  await b().locator('.board-cols').evaluate((el) => { el.scrollLeft = 0; });
  await shot(p, 'board-4-statuses');
  await b().locator('[data-mode-btn="category"]').click();

  // The whole subtree, flattened: a grandchild names its parent.
  await b().locator('[data-scope-btn="subtree"]').click();
  const grand = all.find((x) => x.parent_id === webUi.id);
  check(await card(grand.id).isVisible(), 'the whole subtree shows grandchildren');
  check((await card(grand.id).locator('.bc-parent').innerText()).includes(webUi.key), "a flattened card shows its parent's key");
  await b().locator('[data-scope-btn="children"]').click();

  // The closed column folds and unfolds.
  await col('closed').locator('.bcol-head .icon-btn').click();
  check(await col('closed').evaluate((el) => el.classList.contains('folded')), 'the closed column folds');
  await col('closed').locator('.bcol-unfold').click();
  check(await col('closed').locator('.bcard').count() > 0, 'and unfolds');

  // A change made elsewhere shows without a reload.
  await api('/api/itsas/' + owners.id, { method: 'PATCH', body: JSON.stringify({ status: 'done', by: 'helper' }) });
  check(await until(async () => (await colOf(owners.id).catch(() => '')) === 'closed', 10000), 'a change made elsewhere moves the card live');

  // A click opens the card's world.
  await card(desk.id).locator('.bc-title').click();
  check(await until(async () => (await p.evaluate(() => window.stamDebug.shell.currentWorld())) === 'w:itsa:' + desk.id), "a click opens the card's world");

  // Every root, from the Issues header.
  await sideTab(p, 'issues');
  await p.locator('#issues-board').click();
  check(await until(async () => (await p.evaluate(() => window.stamDebug.shell.currentWorld())) === 'w:board:all'), 'the Issues header opens the board of every root');
  check(await card(root.id).isVisible(), 'it shows the roots');

  // Put the seed back.
  for (const [id, st] of Object.entries(before)) if ((await status(id)) !== st) await api('/api/itsas/' + id, { method: 'PATCH', body: JSON.stringify({ status: st, rank: null }) });
  await p.context().close();
}

// --- Machines -----------------------------------------------------------------------------
// The sidebar's CPU, RAM, and swap meters: one line per computer, three labelled meters
// whose fill follows the reading, a popover on approach with the numbers and each core, and
// a fold that keeps only the header.
async function machinesFlow() {
  console.log('# machines');
  for (const theme of ['light', 'dark']) {
    const p = await page(undefined, null, theme);
    await sideTab(p, 'machines');
    const rows = p.locator('#machines-side .machine-row');
    check(await rows.count() >= 1, `${theme}: the sidebar lists at least this machine`);
    const row = rows.first();
    check(await row.isVisible(), `${theme}: the Machines section shows`);
    check(await row.locator('.mmeter').count() === 3, `${theme}: a machine line has three meters`);
    same(await row.locator('.mmeter .ml').allTextContents(), ['C', 'R', 'S'], `${theme}: the meters are labelled CPU, RAM, swap`);
    const m0 = (await api('/api/machines'))[0];
    const width = await row.locator('.mmeter[data-kind=cpu] .mtrack i').evaluate((el) => parseFloat(el.style.width));
    // The daemon's reading is seeded (daemon.sh's STAM_PROC_DIR), so the fill matches it exactly.
    check(Math.abs(width - Math.min(100, Math.max(0, m0.cpu.pct))) < 0.5, `${theme}: the CPU fill follows the reading`, `${width} vs ${m0.cpu.pct}`);
    // Hover opens the popover: percentages, raw GB, load average, and every core.
    const rb = await row.boundingBox();
    await p.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    const pop = p.locator('.machines-pop');
    await pop.waitFor();
    const text = await pop.innerText();
    check(/%/.test(text) && /GB/.test(text) && /core 0/.test(text) && /Load/.test(text), `${theme}: the popover shows percentages, GB, load, and per-core`, text.replace(/\n/g, ' | '));
    check(await pop.locator('.mp-cores li').count() === m0.cpu.count, `${theme}: one row per core`, `${await pop.locator('.mp-cores li').count()} vs ${m0.cpu.count}`);
    await shot(p, `machines-popover-${theme}`);
    // Leaving closes it.
    await p.mouse.move(900, 700);
    await p.waitForTimeout(400);
    check(!(await pop.count()), `${theme}: leaving closes the popover`);
    // In its pane the section has no fold: the tab says which list shows.
    check(await p.locator('#machines-side .fold').isDisabled(), `${theme}: the header does not fold inside a pane`);
    await p.context().close();
  }
}

// --- System view (S-458) ------------------------------------------------------------------
// The w:system world on the daemon's own agents: opened from the sidebar's footer and from
// #view=system, a card per live agent under the human, a click opens the side panel, and its
// links go to the agent's world and the ITSA's (#itsa=KEY opens an ITSA's world too).
async function systemFlow() {
  console.log('# system');
  const p = await page();
  await p.locator('#open-system').click();
  await p.waitForSelector('.sv-card[data-card]');
  check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:system', 'the footer button opens w:system');
  const agents = (await api('/api/agents')).filter((a) => a.lifecycle === 'active' || a.lifecycle === 'paused');
  await p.waitForTimeout(500);
  check(await p.locator('.sv-card[data-card]').count() === agents.length + 1, 'a card per live agent, plus the human', `${await p.locator('.sv-card[data-card]').count()} vs ${agents.length + 1}`);
  check(await p.locator('.sv-card[data-card="human"]').count() === 1, 'the human is on top');
  const helper = agents.find((a) => a.name === 'helper') ?? agents[0];
  // Mail off the daemon's own stream (S-459): a sheet flies to the recipient's card, or under
  // reduced motion the card is marked; either way it reaches the card.
  const sender = agents.find((a) => a.id !== helper.id);
  if (sender) {
    const seen = p.waitForFunction((id) => !!document.querySelector('.sv-fly') || !!document.querySelector(`.sv-card[data-card="${id}"].hit`), helper.id, { polling: 'raf', timeout: 10000 });
    await api('/api/mail', { method: 'POST', body: JSON.stringify({ from: sender.id, to: [helper.id], subject: 'Check: a flight', body: 'A sheet flies.', new_thread: true }) });
    check(!!(await seen.catch(() => null)), 'mail from the stream flies to its card');
  }
  await p.locator(`.sv-card[data-card="${helper.id}"]`).click();
  await p.waitForSelector('.sv-panel');
  check((await p.locator('.sv-panel h3').innerText()) === helper.name, 'a click opens the panel for that agent');
  await shot(p, 'system-panel');
  await p.locator('.sv-links .btn', { hasText: 'Open its world' }).click();
  await p.waitForFunction((id) => window.stamDebug.shell.currentWorld() === id, helper.id);
  check(true, 'Open its world goes to the agent');
  await p.evaluate(() => { location.hash = 'view=system' });
  await p.waitForFunction(() => window.stamDebug.shell.currentWorld() === 'w:system');
  check(true, '#view=system opens the system view');
  const it = (await api('/api/itsas'))[0];
  if (it) {
    await p.evaluate((k) => { location.hash = 'itsa=' + k }, it.key);
    await p.waitForFunction((id) => window.stamDebug.shell.currentWorld() === 'w:itsa:' + id, it.id);
    check(true, '#itsa=KEY opens the ITSA world');
  }
  await p.context().close();
}

// The tree's state marks and the ? legend, in both themes.
async function legend() {
  for (const theme of ['light', 'dark']) {
    const p = await page(undefined, null, theme);
    const g = p.locator('#tree .node:has(.name:text-is("helper")) .glyph').first();
    const ring = await g.locator('.ring').evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
    check(ring >= 2, `${theme}: the state ring is at least 2 px`, ring);
    const tip = await p.locator('#tree .node:has(.name:text-is("helper"))').first().getAttribute('title');
    check(/^helper · \S+.*\n[A-Z][a-z ]+: /.test(tip ?? ''), `${theme}: the row tooltip names the state and says what it means`, tip);
    await shot(p, `legend-tree-${theme}`);
    const q = p.locator('#tree [data-legend-open]');
    check(await q.isVisible(), `${theme}: the Agents header has a ? button`);
    await q.click();
    const pop = p.locator('.menu.popover[role=dialog]');
    check(await pop.isVisible(), `${theme}: the ? opens the legend`);
    same(await pop.locator('[data-legend]').evaluateAll((els) => els.map((e) => e.dataset.legend)), ['working', 'starting', 'waiting', 'idle', 'blocked', 'errored', 'paused', 'resting', 'shut_down'], `${theme}: the legend lists every state`);
    // Colour is never the only signal: the states that share a hue differ in shape.
    const shapes = await pop.locator('[data-legend] .glyph').evaluateAll((els) => els.map((e) => [e.dataset.state, getComputedStyle(e.querySelector('.ring')).borderTopStyle, getComputedStyle(e.querySelector('.ring')).borderTopWidth,
      e.querySelector('.pip') ? (e.querySelector('.pip svg')?.innerHTML ?? (getComputedStyle(e.querySelector('.pip')).boxShadow.includes('inset') ? 'hollow' : 'dot')) : 'none'].join(' ')));
    check(new Set(shapes).size === shapes.length && new Set(shapes.map((x) => x.split(' ').slice(1).join(' '))).size === shapes.length, `${theme}: each state has its own ring and pip shape`, shapes);
    const b = await pop.boundingBox();
    check(!!b && b.y >= 0 && b.y + b.height <= 900 && b.x + b.width <= 1500, `${theme}: the legend fits the window`, b);
    await shot(p, `legend-${theme}`);
    await p.keyboard.press('Escape');
    check(!(await pop.count()), `${theme}: Escape closes the legend`);
    check(await q.evaluate((el) => el === document.activeElement), `${theme}: and the focus goes back to the ?`);
    await q.click();
    await p.mouse.click(900, 500);
    check(!(await pop.count()), `${theme}: a click outside closes it`);
    await p.context().close();
  }
}

// --- Terminal size ------------------------------------------------------------------------
// A plain terminal (free) keeps its tmux size while the prompt input under it grows, with
// its newest lines in view, and claims a dragged window's size once, not per step.
async function term() {
  console.log('# term');
  const sh = await api('/api/shells', { method: 'POST', body: '{}' });
  for (const [size, tag] of [[{ width: 1500, height: 900 }, 'desktop'], [{ width: 360, height: 760 }, 'phone']]) {
    const p = await page(size);
    let claims = 0;
    p.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload === 'string' && f.payload[0] === '\x00') claims++; }));
    await p.evaluate((k) => window.stamDebug.shell.open('main', k), `shell:${sh.machine}:${sh.id}`);
    const view = p.locator('#w-main .term-view').first();
    await view.waitFor();
    await p.waitForTimeout(1500);
    await view.click();
    await p.keyboard.type('clear; seq 1 300\n');
    // A phone swaps the prompt input for the key row while the terminal has the keyboard.
    await p.evaluate(() => document.activeElement?.blur());
    await p.waitForTimeout(1500);
    // The screen's last line that has text, and whether it lies inside the pane.
    const bottom = () => view.evaluate((v) => {
      const rows = [...v.querySelectorAll('.xterm-rows > div')].filter((r) => r.textContent.trim());
      const last = rows[rows.length - 1], pr = v.getBoundingClientRect(), r = last?.getBoundingClientRect();
      return { text: last?.textContent.trim(), inside: !!r && r.top >= pr.top && r.bottom <= pr.bottom + 1 };
    });
    const term = () => p.evaluate(() => { const s = [...window.stamDebug.sessions].find((x) => x.el.isConnected && x.el.offsetWidth); return s && [s.term.cols, s.term.rows]; });
    const at = await term();
    await shot(p, `term-${tag}-1-rest`);
    if (tag === 'desktop') {
      const pal = await p.evaluate(() => { const s = [...window.stamDebug.sessions].find((x) => x.el.isConnected && x.el.offsetWidth), cs = getComputedStyle(document.documentElement); return ['red', 'brightBlue'].map((n, i) => [s.term.options.theme[n], cs.getPropertyValue(`--ansi-${[1, 12][i]}`).trim()]); });
      check(pal.every(([a, b]) => a && a === b), 'the terminal draws ANSI colours from the design tokens', pal);
    }
    claims = 0;
    const ta = p.locator('#w-bottom .composer textarea');
    await ta.click();
    for (let i = 0; i < 8; i++) { await ta.type(`line ${i} of a prompt`); await ta.press('Shift+Enter'); await p.waitForTimeout(150); }
    await p.waitForTimeout(800);
    same(claims, 0, `${tag}: a prompt input growing by 8 lines doesn't resize the terminal`);
    same(await term(), at, `${tag}: the terminal keeps its rows and columns while the prompt input grows`);
    const b = await bottom();
    check(b.inside, `${tag}: the newest line stays in view above the grown prompt input`, b);
    await shot(p, `term-${tag}-2-composing`);
    await ta.fill('');
    await p.waitForTimeout(800);
    same(claims, 0, `${tag}: clearing the prompt input doesn't resize the terminal either`);
    check(await view.locator('.term-inner').evaluate((e) => e.style.marginTop === ''), `${tag}: the terminal is back in place`);
    if (tag === 'desktop') {
      claims = 0;
      for (let i = 1; i <= 20; i++) { await p.setViewportSize({ width: 1500 - i * 10, height: 900 - i * 5 }); await p.waitForTimeout(16); }
      await p.waitForTimeout(800);
      check(claims >= 1 && claims <= 3, 'desktop: a 20-step window drag resizes the terminal once it settles, not per step', claims);
    }
    await p.context().close();
  }
  // Two viewers: a phone opens the terminal a desktop shows and takes its size. The desktop
  // keeps out of it while the screen redraws and the program asks the terminal questions
  // (xterm answers those itself), until someone clicks or types in it.
  // keep: the second viewer's page() must not reset the layout, which would unmount the first
  // viewer's terminal and let its reopening claim the size back.
  const viewer = async (size, keep = false) => {
    const p = await page(size, null, 'light', keep);
    const v = { p, claims: 0, size: null };
    p.on('websocket', (ws) => {
      ws.on('framesent', (f) => { if (typeof f.payload === 'string' && f.payload[0] === '\x00') v.claims++; });
      ws.on('framereceived', (f) => { if (typeof f.payload === 'string' && f.payload[0] === '\x00') v.size = JSON.parse(f.payload.slice(1)).size; });
    });
    await p.evaluate((k) => window.stamDebug.shell.open('main', k), `shell:${sh.machine}:${sh.id}`);
    await p.locator('#w-main .term-view').first().waitFor();
    await p.waitForTimeout(2000);
    return v;
  };
  const desk = await viewer({ width: 1500, height: 900 });
  const phone = await viewer({ width: 360, height: 760 }, true);
  // The phone's size as its terminal holds it. A kept layout (keep) opens the shell before the
  // frame listener above is attached, so the frames can't show it; the terminal's shared size can.
  const sharedSize = (v) => v.p.evaluate(() => [...window.stamDebug.sessions].find((x) => x.el.isConnected && x.el.offsetWidth)?.shared ?? null);
  for (let i = 0; i < 40 && !(await sharedSize(phone)); i++) await sleep(200);
  check(!!(await sharedSize(phone)), 'the phone gets the window size after it opens', await sharedSize(phone));
  const theirs = await sharedSize(phone);
  desk.claims = 0;
  await api(`/api/shells/${sh.id}/input`, { method: 'POST', body: JSON.stringify({ machine: sh.machine, text: "clear; for i in 1 2 3 4; do seq 1 80; printf '\\033[c\\033[>c'; sleep 0.4; done" }) });
  await desk.p.waitForTimeout(3500);
  same(desk.claims, 0, 'a desktop showing the terminal doesn\'t take the size back from a phone that opened it');
  same(await sharedSize(desk), theirs, 'both viewers keep the phone\'s size');
  await shot(desk.p, 'term-desktop-3-phone-has-size');
  await desk.p.locator('#w-main .term-view').first().click();
  await desk.p.waitForTimeout(800);
  check(desk.claims >= 1 && JSON.stringify(phone.size) !== JSON.stringify(theirs), 'a click on the desktop takes the size', { claims: desk.claims, size: phone.size });
  await desk.p.context().close();
  await phone.p.context().close();
  await api(`/api/shells/${sh.id}/kill`, { method: 'POST', body: JSON.stringify({ machine: sh.machine }) });
}

// --- Mail rules ----------------------------------------------------------------------------
// The decision model's verdict on a mail to the human, in the message header: a check for
// yes, a warning mark for no, and the scores on hover or tap. The flow seeds its own two
// threads and waits for their verdicts through the API, so it depends on no earlier flow:
// the app folds an old thread's first message once other flows have replied into it, and a
// folded message carries no mark. The daemon checks mail against a stub decisions endpoint
// (web/check/daemon.sh), so this is free.
async function rules() {
  console.log('# rules');
  const p = await page();
  const tag = `rules ${Date.now() % 100000}`;
  // One fresh thread that follows the rules and one that does not (the stub answers `no`
  // for a body carrying MAILCHECK:NO). The verdict is set after delivery, off the send
  // path, so wait for it on the mail the daemon hands back, not on a timer or a list.
  const seed = async (subject, body) => {
    // From kid: helper runs haiku, which may not mail the human (see rank()).
    const m = await api('/api/mail', { method: 'POST', body: JSON.stringify({ from: agents.find((a) => a.name === 'kid').id, to: ['human'], subject, body, new_thread: true }) });
    const end = Date.now() + 30000;
    for (;;) {
      const ms = await api('/api/threads/' + m.thread_id).catch(() => []);
      const mail = Array.isArray(ms) ? ms.find((x) => x.id === m.id) : undefined;
      if (mail?.verdict || Date.now() > end) return mail ?? m;
      await sleep(500);
    }
  };
  const yes = await seed(`Check: ${tag}`, 'TLDR: A short note that follows the rules.\n\nNothing to answer here.');
  const no = await seed(`Check: ${tag} no`, 'TLDR: Seed data for the mail-rules mark.\n\nMAILCHECK:NO Hello there! I hope this message finds you well. I just wanted to reach out and give you a long, rambling preamble before eventually, maybe, getting to a point. Apologies for the length.');
  check(yes?.verdict?.follows === true && no?.verdict?.follows === false, 'the flow\'s own two mails carry a yes and a no verdict', [yes?.verdict, no?.verdict]);
  if (!yes?.verdict || !no?.verdict) return p.context().close();
  // The mark renders with the message; wait for it by id rather than by timing.
  const mark = async (t, cls) => {
    const sel = `.thread-view:visible .msg[data-id="${t.id}"] .verdict.${cls}`;
    await p.waitForSelector(sel, { timeout: 20000 }).catch(() => {});
    return p.locator(sel);
  };
  // Open through the app's own shell, so the check never depends on a row click.
  const openThread = async (tid) => {
    await p.evaluate((id) => window.stamDebug.shell.showAgentWorld('t:' + id), tid);
    await p.waitForSelector('.thread-view:visible .msg', { timeout: 20000 });
  };

  await openThread(yes.thread_id);
  const ok = await mark(yes, 'ok');
  check(await ok.count() === 1, 'a mail that follows the rules shows a check mark');
  const okTitle = (await ok.getAttribute('title', { timeout: 1000 }).catch(() => '')) ?? '';
  check(/Follows the mail rules: yes · concise 0\.9 · fluff 0\.1 · value 0\.8/.test(okTitle), 'the mark names the verdict and the scores', okTitle);
  await shot(p, 'rules-1-yes');
  if (await ok.count() === 1) {
    await ok.click();
    check(await ok.locator('.verdict-note').isVisible(), 'tapping the mark shows its scores');
    await ok.click();
    check(await ok.locator('.verdict-note').count() === 0, 'tapping it again hides them');
  }

  await openThread(no.thread_id);
  const warn = await mark(no, 'warn');
  check(await warn.count() === 1, 'a mail that does not follow the rules shows a warning mark');
  const warnTitle = (await warn.getAttribute('title', { timeout: 1000 }).catch(() => '')) ?? '';
  check(/^Follows the mail rules: no ·/.test(warnTitle), 'the warning names the verdict', warnTitle);
  await shot(p, 'rules-2-no');
  await p.context().close();
}

// Settings › Tools: the MCP catalogue, grouped, each tool folding open to its arguments.
// Read-only, so free.
// --- Model pickers (S-379) -------------------------------------------------------------------
// A Settings model field (Mail titles here) opens a searchable list of models. OpenRouter is never
// reached: the flow routes /api/models to a fixture, then checks that the list sorts cheapest
// first or by name, filters as typed, keeps the current value listed, and saves a typed id that
// the list doesn't have. Shots: the list open on desktop, and as the sheet at 360 px in both themes.
async function modelPicker() {
  console.log('# modelpicker');
  const fixture = { models: [
    { id: 'google/gemma-3-4b-it', name: 'Google: Gemma 3 4B', in: 0.02, out: 0.04 },
    { id: 'openai/gpt-x', name: 'OpenAI: GPT X', in: 2.5, out: 10 },
    { id: 'google/gemma-3-27b-it', name: 'Google: Gemma 3 27B', in: 0.1, out: 0.2 },
    { id: 'unpriced/model', name: 'Unpriced model', in: null, out: null },
  ] };
  const ids = (p) => p.locator('.model-list .model-opt .model-id').allInnerTexts();
  const saved = async (p, act) => {
    const saving = p.waitForResponse((r) => r.url().endsWith('/api/config/settings') && r.request().method() !== 'GET');
    await act();
    await saving;
    return JSON.parse((await api('/api/config/settings')).text).mail?.titles?.model;
  };
  // Desktop: sorting, filtering, a typed id, and the value kept listed.
  let p = await page({ width: 1500, height: 900 });
  await p.route(/\/api\/models\?kind=openrouter/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) }));
  await p.locator('#open-config').first().click();
  await p.waitForSelector('.settings-view');
  await p.locator('.settings-nav .item:has-text("Mail to you")').click();
  const input = p.locator('input[aria-label="Mail titles model"]');
  await input.click();
  // The list shows the current value at once; wait for the catalogue to arrive behind it.
  await p.waitForSelector('.model-list .model-opt .model-id:text-is("unpriced/model")');
  const listed = await ids(p);
  check(fixture.models.every((m) => listed.includes(m.id)), 'the list opens with every model, and the current value', listed);
  check((await p.locator('.model-list .model-opt').first().innerText()).includes('$0.02 in · $0.04 out'), 'the cheapest model comes first, with its price');
  await shot(p, 'modelpicker-1-desktop');
  await p.locator('.model-head button', { hasText: 'Name' }).click();
  check((await ids(p))[0] === 'google/gemma-3-27b-it', 'Name sorts by name', await ids(p));
  await input.fill('gemma');
  check((await ids(p)).length === 2, 'typing filters by id or name', await ids(p));
  await input.fill('');
  // Enter picks the highlighted model and saves it.
  let value = await saved(p, async () => { await input.press('ArrowDown'); await input.press('Enter'); });
  check(value === 'google/gemma-3-27b-it', 'Enter saves the highlighted model', value);
  // A typed id the list doesn't have is kept as it is.
  value = await saved(p, async () => { await input.click(); await input.fill('my-lab/custom-model'); await input.press('Enter'); });
  check(value === 'my-lab/custom-model', 'a typed id is saved as it is', value);
  await input.click();
  check(await p.locator('.model-list .model-opt[aria-selected="true"]').count() === 1, 'the current value stays listed, selected', await ids(p));
  check((await p.locator('.model-list .model-opt[aria-selected="true"]').innerText()).includes('current'), 'the current value is marked');
  await p.keyboard.press('Escape');
  check(await p.locator('.model-list').count() === 0, 'Escape closes the list');
  // Leaving the field puts back the saved value: a query typed and then clicked away saves nothing.
  const kept = await input.inputValue();
  const before = JSON.parse((await api('/api/config/settings')).text).mail?.titles?.model;
  await p.locator('body').click({ position: { x: 1200, y: 60 } });
  await input.click();
  check(await input.evaluate((el) => el.selectionStart === 0 && el.selectionEnd === el.value.length), 'focusing the field selects its text, so a query replaces it');
  await input.fill('gemma');
  await p.locator('body').click({ position: { x: 1200, y: 60 } });
  check(await p.locator('.model-list').count() === 0 && await input.inputValue() === kept, 'leaving the field with a query puts back the saved value', await input.inputValue());
  check(JSON.parse((await api('/api/config/settings')).text).mail?.titles?.model === before, 'leaving the field with a query saves nothing');
  await p.context().close();
  // Phone, at 360 by 400 (the keyboard leaves that much): the sheet opens with its search field in view and focused,
  // and typing there filters the list.
  for (const theme of ['light', 'dark']) {
    p = await page({ width: 360, height: 400 }, null, theme);
    // A long catalogue, as OpenRouter's is: the list scrolls, and the search and sort row must stay at its top.
    const long = { models: [...fixture.models, ...Array.from({ length: 40 }, (_, i) => ({ id: `google/gemma-variant-${i}`, name: `Google: Gemma variant ${i}`, in: 0.01 + i, out: 0.02 + i }))] };
    await p.route(/\/api\/models\?kind=openrouter/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(long) }));
    await p.locator('#open-config').first().click();
    await p.waitForSelector('.settings-view');
    await p.locator('.settings-nav .item:has-text("Mail to you")').click();
    await p.locator('input[aria-label="Mail titles model"]').click();
    await p.waitForSelector('.model-list .model-opt .model-id:text-is("unpriced/model")');
    const search = p.locator('.model-list .model-search input');
    check(await search.getAttribute('aria-label') === 'Search models', 'the sheet\'s search field has its own label', await search.getAttribute('aria-label'));
    const sb = await search.boundingBox();
    check(sb && sb.y >= 0 && sb.y + sb.height <= 400, 'at 360 by 400 the sheet\'s search field is in view', JSON.stringify(sb));
    check(await search.evaluate((el) => el === document.activeElement), 'the search field has focus when the sheet opens');
    await search.fill('gemma');
    check((await ids(p)).length === 42, 'typing in the sheet filters the list', (await ids(p)).length);
    const box = await p.locator('.model-list').boundingBox();
    check(box && box.width >= 359, 'the phone sheet runs the full width', JSON.stringify(box));
    check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the phone page does not scroll sideways');
    // Scroll the list to its end: the search field and the sort row stay at its top.
    await p.locator('.model-list').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const sbAfter = await search.boundingBox();
    const headAfter = await p.locator('.model-list .model-head').boundingBox();
    check(sbAfter && sbAfter.y >= 0 && sbAfter.y + sbAfter.height <= 400 && headAfter && headAfter.y < 400, 'scrolled to the end, the search field and sort row stay at the top of the list', JSON.stringify({ sbAfter, headAfter }));
    // No option row shows above the search field: what is painted just above it is the sticky header, never a row.
    const topBox = await p.locator('.model-list .model-top').boundingBox();
    const rowAbove = await p.evaluate((y) => { const el = document.elementFromPoint(window.innerWidth / 2, y - 2); return !!el?.closest('.model-opt'); }, topBox.y);
    check(!rowAbove && topBox.y <= sbAfter.y, 'no option row shows above the sticky search and sort row after scrolling', JSON.stringify({ topY: topBox.y, searchTop: sbAfter.y, rowAbove }));
    await shot(p, `modelpicker-2-phone-${theme}`);
    await p.context().close();
  }
}

async function toolsFlow() {
  console.log('# tools');
  const p = await page();
  const cat = await api('/api/tools');
  await p.locator('#open-config').first().click();
  await p.waitForSelector('.settings-view');
  await p.locator('.settings-nav .item:has-text("Tools")').click();
  await p.waitForSelector('.tools-card');
  const groups = cat.groups.map((g) => g.name);
  const headings = await p.locator('.settings-inner h3').allInnerTexts();
  check(groups.every((g) => headings.includes(g)), 'every group has its heading', headings);
  const count = cat.groups.reduce((n, g) => n + g.tools.length, 0);
  check(await p.locator('.tools-card details.tool').count() === count, 'a row per tool', `${await p.locator('.tools-card details.tool').count()} of ${count}`);
  check(await p.locator('.tool-name', { hasText: 'send_mail' }).count() === 1, 'send_mail is listed');
  await shot(p, 'tools-1-settings');
  const mail = p.locator('.tools-card details.tool').filter({ hasText: 'send_mail' }).first();
  check(!(await mail.evaluate((el) => el.open)), 'a tool\'s arguments stay folded at rest');
  await mail.locator('summary').click();
  check(await mail.evaluate((el) => el.open), 'a click folds it open');
  const args = await mail.locator('.tool-arg-head code').allInnerTexts();
  check(args.includes('to') && args.includes('body'), 'its arguments name to and body', args);
  check(await mail.locator('.tool-arg-req').count() === 2, 'the required arguments are marked');
  await shot(p, 'tools-2-args');
  check(/harness/i.test(await p.locator('.tool-note').innerText()), 'a note covers the harness tools');
  await p.context().close();
}

// --- Waiting on the human ----------------------------------------------------------------
// On the ITSAs seed.mjs puts in human statuses (agents moved them, so stam mailed the human):
// the attention list at the top of the mail list holds them with the permission requests,
// oldest first, and opens their world; the tree shows each owner's ITSA chip; the world's
// header offers the status's actions; a click stages one and Send applies it (checked against
// the API): Request changes needs text, moves the ITSA back to in_progress, and posts the
// text as the human's comment; Answer does the same for a question; Approve from the ITSA's
// thread (the mail's own buttons) moves needs_test to done. The seed is put back after.
async function attention() {
  console.log('# attention');
  const p = await page();
  const all = await api('/api/itsas');
  const att = await api('/api/itsas/attention');
  const find = (t) => all.find((x) => x.title === t);
  const review = find('Issues section in the sidebar'), decide = find('Check: pick the board layout'), trial = find('Check: try the voice input');
  if (!review || !decide || !trial) { check(false, 'the seeded human-status ITSAs exist (seed.mjs)'); return p.context().close(); }
  check([review, decide, trial].every((x) => att.some((a) => a.id === x.id)), 'the attention endpoint lists them');
  check(JSON.stringify(att.map((a) => a.since)) === JSON.stringify(att.map((a) => a.since).sort()), 'oldest first');
  const asks = await p.locator('#mail-side .mrow.ask').evaluateAll((els) => els.map((e) => e.dataset.attItsa ?? 'perm'));
  const rows = await p.locator('#mail-side .mrow').evaluateAll((els) => els.map((e) => e.classList.contains('ask')));
  check(asks.filter((a) => a !== 'perm').length === att.length, 'the mail list pins every ITSA in a human status', asks);
  check(rows.indexOf(false) === -1 || rows.lastIndexOf(true) < rows.indexOf(false), 'the pinned area comes before the other threads');
  check(JSON.stringify(asks.filter((a) => a !== 'perm')) === JSON.stringify(att.map((a) => a.id)), 'the ITSAs keep the oldest-first order', asks);
  check(/waiting on you/.test(await p.locator('#mail-side .section').innerText()), 'the Mail header counts them');
  await sideTab(p, 'issues');
  check(/waiting on you/.test(await p.locator('#issues-side .section').innerText()), 'the Issues header counts them too');
  const n = (t) => Number(/(\d+) waiting/.exec(t)?.[1] ?? 0);
  // The Issues count also holds agents that wait for your reply, which the mail list doesn't pin.
  // The Issues header's count is a button: it opens the list of everything waiting on you.
  await sideTab(p, 'issues');
  const wbtn = p.locator('#issues-waiting');
  check(await wbtn.isVisible(), 'the Issues header count is a button');
  await wbtn.click();
  const wl = p.locator('.menu.popover [data-waiting-list]');
  await wl.waitFor();
  check(await wl.locator('.wrow').count() === n(await wbtn.innerText()), 'the list has one row per waiting thing', await wl.locator('.wrow').count());
  for (const a of att) check(await wl.locator(`[data-waiting="i:${a.id}"]`).count() === 1, `a row for ${a.key}`);
  check(await wl.locator('[data-waiting^="p:"], [data-waiting^="w:"]').count() >= 1, 'the permission request of an agent has a row too');
  await p.waitForTimeout(500);
  await shot(p, 'waiting-list-light');
  const dk = await page(undefined, null, 'dark');
  await sideTab(dk, 'issues');
  await dk.locator('#issues-waiting').click();
  await dk.locator('.menu.popover [data-waiting-list]').waitFor();
  await dk.waitForTimeout(500);
  await shot(dk, 'waiting-list-dark');
  await dk.context().close();
  await wl.locator(`[data-waiting="i:${review.id}"]`).click();
  await p.waitForSelector(`.itsa-view[data-itsa="${review.id}"]`);
  check(await p.locator('.menu.popover').count() === 0, 'a click on a row closes the list and opens the ITSA');
  await wbtn.click();
  await p.keyboard.press('Escape');
  check(await p.locator('.menu.popover').count() === 0, 'Escape closes the list');
  // The owner's chip in the tree: the tree is in the Agents tab, and the flow has been in Issues.
  await sideTab(p, 'agents');
  const chip = p.locator('#tree .node .ichip').first();
  check(await chip.isVisible(), 'an owner shows a chip for the ITSA it owns in the tree');
  const keyChip = p.locator(`#tree .node:has(.name:text-is("kid")) .ichip`);
  check((await keyChip.innerText()).trim().length > 0 && await keyChip.getAttribute('title').then((t) => /wait.* on you/.test(t ?? '')), "kid's chip counts its ITSAs and says some wait on you", await keyChip.innerText().catch(() => ''));
  await shot(p, 'attention-1-list');

  // Opening one: the world, with the action bar for needs_review.
  await p.locator(`#mail-side .mrow[data-att-itsa="${review.id}"]`).click();
  await p.waitForSelector(`.itsa-view[data-itsa="${review.id}"] .itsa-ask`);
  const view = p.locator(`.itsa-view[data-itsa="${review.id}"]`);
  await p.waitForSelector(`.itsa-view[data-itsa="${review.id}"] [data-itsa-thread="thread"]`);
  same(await view.locator('.itsa-ask .btn').allInnerTexts(), ['Approve', 'Request changes'], 'needs_review offers Approve and Request changes');
  check(/The Issues section is in/.test(await view.locator('[data-itsa-thread]').innerText()), "the thread has the owner's comment");
  check(/needs_review/.test(await view.locator('[data-itsa-thread]').innerText()), "and stam's mail asking for the review");
  check(await view.locator('.badge.warn', { hasText: 'Asks you' }).count() === 1, 'the asking mail is marked');
  await shot(p, 'attention-2-world');
  await view.locator('.itsa-ask [data-act=changes]').click();
  check(await view.locator('.itsa-ask [data-act=changes].staged').count() === 1, 'a click stages the action');
  check(await p.locator('#w-bottom .cmp-send').isDisabled(), 'Request changes can not be sent without text');
  await shot(p, 'attention-3-staged');
  await p.locator('#w-bottom textarea').fill('Check: rename the section to Issues list');
  await p.locator('#w-bottom .cmp-send').click();
  await p.waitForTimeout(1500);
  let got = await api('/api/itsas/' + review.id);
  same(got.status, 'in_progress', 'sending moves the ITSA back to in_progress');
  const thread = await api(`/api/itsas/${review.id}/thread`);
  check(thread.items.some((x) => x.type === 'mail' && x.mail.from_id === 'human' && /rename the section/.test(x.mail.body)), "and posts the human's text as a comment");
  check(await p.locator(`#mail-side .mrow[data-att-itsa="${review.id}"]`).count() === 0, 'the ITSA leaves the attention list');
  check(await view.locator('.itsa-ask').count() === 0, 'and the action bar goes');

  // Answer on needs_input; the staged action is dropped when clicked again.
  await p.locator(`#mail-side .mrow[data-att-itsa="${decide.id}"]`).click();
  await p.waitForSelector(`.itsa-view[data-itsa="${decide.id}"] .itsa-ask`);
  const dv = p.locator(`.itsa-view[data-itsa="${decide.id}"]`);
  same(await dv.locator('.itsa-ask .btn').allInnerTexts(), ['Answer'], 'needs_input offers Answer');
  await dv.locator('.itsa-ask [data-act=answer]').click();
  await dv.locator('.itsa-ask [data-act=answer]').click();
  check(await dv.locator('.itsa-ask .btn.staged').count() === 0, 'clicking the staged action again takes it back');
  await dv.locator('.itsa-ask [data-act=answer]').click();
  await p.locator('#w-bottom textarea').fill('Check: columns per category');
  await p.locator('#w-bottom .cmp-send').click();
  await p.waitForTimeout(1500);
  same((await api('/api/itsas/' + decide.id)).status, 'in_progress', 'the answer moves it on');

  // Approve from the thread: the asking mail's own buttons stage, Send applies.
  // The ITSA's ask thread is its one row in the mail list (S-311), which opens the ITSA; the
  // thread itself opens through the shell, as a link to it does.
  const tid = trial.thread_id ?? (await api('/api/itsas/' + trial.id)).thread_id;
  check(await p.locator(`#mail-side .mrow[data-att-itsa="${trial.id}"][data-ask-thread="${tid}"]`).count() === 1, 'the waiting ITSA is its ask thread\'s one row');
  check(await p.locator(`#mail-side .mrow[data-thread="${tid}"]`).count() === 0, 'and that thread has no second row');
  await p.evaluate((id) => window.stamDebug.shell.showAgentWorld('t:' + id), tid);
  await p.waitForSelector('.thread-view:visible .itsa-ask [data-itsa-act]');
  same(await p.locator('.thread-view:visible .itsa-ask .btn').allInnerTexts(), ['Approve', 'Request changes'], "the thread's asking mail has the buttons");
  await p.locator('.thread-view:visible .itsa-ask [data-itsa-act=approve]').click();
  check(await p.locator('.thread-view:visible .itsa-ask .btn.staged').count() === 1, 'Approve stages');
  check(/Approve/.test(await p.locator('.reply-preview:visible').innerText()), 'the preview shows it');
  await shot(p, 'attention-4-thread');
  await p.locator('#w-bottom .cmp-send').click();
  await p.waitForTimeout(1500);
  same((await api('/api/itsas/' + trial.id)).status, 'done', 'Approve on needs_test closes the ITSA');
  check(await p.locator(`#mail-side .mrow[data-att-itsa="${trial.id}"]`).count() === 0, 'it leaves the attention list');

  // Put the seed back for later runs.
  await api('/api/itsas/' + review.id, { method: 'PATCH', body: JSON.stringify({ status: 'needs_review', by: 'kid' }) });
  await api('/api/itsas/' + decide.id, { method: 'PATCH', body: JSON.stringify({ status: 'needs_input', by: 'helper' }) });
  await api('/api/itsas/' + trial.id, { method: 'PATCH', body: JSON.stringify({ status: 'needs_test', by: 'kid' }) });
  await p.context().close();
  await inputCard();
}

// The suggested input card (S-422, S-429). daemon.sh seeds two pending suggestions with INPUT_SEED=1,
// one from helper and one from kid. Desktop light and dark and phone 360 light and dark show helper's in its mail
// thread and its attention row; helper's is then denied and kid's approved, and the approval must
// send the hash of the text the card shows.
async function inputCard() {
  console.log('# input card');
  const pending = await api('/api/permissions?status=pending');
  const hReq = pending.find((r) => r.kind === 'input' && r.agent_name === 'helper');
  const kReq = pending.find((r) => r.kind === 'input' && r.agent_name === 'kid');
  // Seeded only with INPUT_SEED=1 (daemon.sh): each suggestion mails the human, which other checks count.
  if (!hReq || !kReq) { console.log('skip: no suggestions seeded; start daemon.sh with INPUT_SEED=1'); return; }
  check(true, 'daemon.sh seeded a suggestion from helper and one from kid');
  const threadOf = async (name) => (await api('/api/agents/human/threads?limit=60')).find((t) => JSON.stringify(t).includes(`Input for ${name}:`))?.thread_id;
  // At phone width the mail list sits behind the bottom navigation's Mail tab.
  const openCard = async (p, r, phone = false) => {
    const tid = await threadOf(r.agent_name);
    if (phone) await p.locator('[data-nav="mail"]').click();
    await p.locator(`${phone ? '#inbox-view' : '#mail-side'} .mrow[data-thread="${tid}"]`).first().click();
    await p.waitForSelector(`[data-input-perm="${r.id}"]`);
    return p.locator(`[data-input-perm="${r.id}"]`);
  };
  // The card as it stands: the agent, the machine, the exact text, and the expiry line. The mail
  // shows the card in place of the body, so the text and the reason each appear once in its mail.
  const checkCard = async (card, r, what) => {
    check((await card.locator('.input-to').innerText()).trim() === `→ @${r.agent_name} on ${r.machine}`, `${what}: the card shows → @${r.agent_name} and the machine`, await card.locator('.input-to').innerText());
    check((await card.locator('[data-input-text]').textContent()) === r.text, `${what}: the card shows the exact text`, await card.locator('[data-input-text]').textContent());
    check(/expires in/.test(await card.locator('.input-head').innerText()), `${what}: the card says when it expires`);
    const mail = await card.locator('xpath=ancestor::article[1]').innerText();
    check(mail.split(r.text).length === 2, `${what}: the command appears once in its mail`, mail.split(r.text).length - 1);
    check(mail.split('Only you can approve').length === 2 && !/until 20\d\d-/.test(mail), `${what}: one approval line, no raw timestamp`);
  };
  // Desktop, light: the attention row and the card in its thread (helper's: the long command).
  const dl = await page();
  const row = dl.locator(`#mail-side .mrow[data-thread="${await threadOf('helper')}"]`).first();
  check(await row.count() === 1 && (await row.getAttribute('class')).includes('ask'), 'the suggestion is an attention row in the mail list');
  await row.screenshot({ path: `${out}/input-attention-row.png` });
  const hc = await openCard(dl, hReq);
  await checkCard(hc, hReq, 'desktop light');
  await shot(dl, 'input-desktop-light');
  await dl.context().close();
  // Desktop dark, and phone at 360 px light and dark: kid's suggestion, pending, before any answer.
  for (const [name, size, theme] of [['desktop-dark', undefined, 'dark'], ['phone-360-light', { width: 360, height: 780 }, 'light'], ['phone-360-dark', { width: 360, height: 780 }, 'dark']]) {
    const p = await page(size, null, theme);
    const card = await openCard(p, kReq, !!size);
    await checkCard(card, kReq, name);
    await shot(p, `input-${name}`);
    await p.context().close();
  }
  // A long command at phone width: it wraps in full, and nothing scrolls sideways.
  const lp = await page({ width: 360, height: 780 });
  const lc = await openCard(lp, hReq, true);
  const wide = await lc.locator('[data-input-text]').evaluate((el) => el.scrollWidth - el.clientWidth);
  const sideways = await lp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(wide <= 0 && sideways <= 0, 'the long command wraps at 360 px, with no sideways scroll', { wide, sideways });
  await shot(lp, 'input-phone-360-long');
  await lp.context().close();
  // An answer acts like a reply (S-524): the thread archives and the next mail opens.
  const archivedNow = async (tid) => (await api('/api/agents/human/threads?limit=60&archived=1')).some((t) => t.thread_id === tid) || !(await api('/api/agents/human/threads?limit=60')).some((t) => t.thread_id === tid);
  // The threads, found before the answers archive them (the list holds no archived thread).
  const hTid = await threadOf('helper'), kTid = await threadOf('kid');
  // Deny: nothing is typed, and the thread archives.
  const dn = await page();
  const dc = await openCard(dn, hReq);
  await dc.locator('[data-input-deny]').click();
  await dn.waitForTimeout(1500);
  check((await api('/api/permissions?status=denied')).some((r) => r.id === hReq.id), 'Deny moves the suggestion to denied');
  check(await archivedNow(hTid), 'Deny archives the thread, as a reply does');
  await dn.context().close();
  // Approve: sends the hash of the text the page shows, and nothing else of the text.
  const ap = await page({ width: 360, height: 780 });
  const card0 = await openCard(ap, kReq, true);
  const sent = ap.waitForRequest((q) => q.method() === 'POST' && q.url().endsWith(`/api/permissions/${kReq.id}/answer`));
  await card0.locator('[data-input-approve]').click();
  const body = JSON.parse((await sent).postData() ?? '{}');
  check(body.approve === true && body.text_sha256 === createHash('sha256').update(kReq.text).digest('hex'), 'Approve sends text_sha256 of the shown text', body);
  await ap.waitForTimeout(1500);
  check(await archivedNow(kTid), 'Approve archives the thread, as a reply does');
  // The answered card's lines (status, no buttons, who answered) are checked in InputSuggestion.test.tsx.
  check(['held', 'approved'].includes((await api('/api/permissions')).find((r) => r.id === kReq.id)?.status), 'Approve moves the suggestion to held or approved');
  // The answered card, opened again from the Archived list: no buttons, no red error, who answered.
  await ap.locator('[data-nav="mail"]').click();
  await ap.locator('[data-filter="archived"]').click();
  await ap.locator(`#inbox-view .mrow[data-thread="${kTid}"]`).first().click();
  const answered = ap.locator(`[data-input-perm="${kReq.id}"]`);
  await answered.locator('[data-input-status]').waitFor();
  check(await answered.locator('[role="alert"]').count() === 0 && await answered.locator('[data-input-approve]').count() === 0, 'the answered card shows no error and no buttons');
  await shot(ap, 'input-phone-360-answered');
  await shot(ap, 'input-phone-360-approved');
  await ap.context().close();
}

// Settings › Decision steps: the seeded steps (seed.mjs) listed in plain words, one turned on
// and off, a step added by trigger, question, and action, a test on recent examples, the
// decision log, and Add a step from Settings › Tools. The model is the decide stub, so free.
async function stepsFlow() {
  console.log('# steps');
  const p = await page();
  const stepsNow = async () => (await api('/api/steps')).steps;
  await p.locator('#open-config').first().click();
  await p.waitForSelector('.settings-view');
  await p.locator('.settings-nav .item:has-text("Decision steps")').click();
  await p.waitForSelector('.steps-card');
  const rows = p.locator('.step-row');
  check(await rows.count() >= 3, 'the seeded steps are listed', await rows.count());
  const money = p.locator('.step-row', { hasText: 'Money mail' });
  check(/Before send_mail · Deny the call if yes/.test(await money.innerText()), 'a tool step reads "Before send_mail · Deny the call if yes"', await money.innerText());
  check(/Each mail to you · Flag/.test(await p.locator('.step-row', { hasText: 'Cost mail' }).innerText()), 'an event step reads "Each mail to you · Flag"');
  await shot(p, 'steps-1-list');

  // On and off, saved at once.
  const off = p.locator('.step-row', { hasText: 'New ITSA without an owner' });
  const offId = await off.getAttribute('data-step');
  await off.locator('input[type=checkbox]').click();
  await sleep(400);
  check((await stepsNow()).find((s) => s.id === offId)?.enabled === true, 'the box turns a step on at once');
  await off.locator('input[type=checkbox]').click();
  await sleep(400);
  check((await stepsNow()).find((s) => s.id === offId)?.enabled === false, 'and off again');

  // Add: a trigger, a question, an action, save.
  await p.locator('#add-step').click();
  await p.waitForSelector('.step-form');
  await p.locator('select[name=trigger]').selectOption('event:itsa-status');
  await p.locator('textarea[name=question]').fill('Did an ITSA move to done without a review?');
  await p.locator('.step-actions .choice', { hasText: 'Mail me' }).click();
  await shot(p, 'steps-2-add');
  await p.locator('.step-form button[type=submit]').click();
  await p.waitForSelector('.step-test');
  const added = (await stepsNow()).find((s) => s.question === 'Did an ITSA move to done without a review?');
  same(added && { trigger: added.trigger, action: added.action, name: added.name, threshold: added.threshold },
    { trigger: { kind: 'event', event: 'itsa-status' }, action: 'notify', name: 'Did an ITSA move to done without a', threshold: 0.5 }, 'the added step has its trigger, action, and a name from the question');
  await p.locator('.step-form .type-back').click();
  await p.waitForSelector('.steps-card');
  check(await p.locator('.step-row', { hasText: 'Each ITSA status change · Mail me' }).count() === 1, 'the list shows the added step', await p.locator('.step-meta').allInnerTexts());

  // Test on recent, and the log.
  await money.locator('.step-open').click();
  await p.waitForSelector('.step-dec');
  const acts = await p.locator('.step-dec').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')));
  check(['denied', 'allowed', 'failed-open'].every((a) => acts.includes(a)), 'the log has a denial, an allowed call, and a failed-open check', acts);
  check(/Failed open: /.test(await p.locator('.step-dec[data-action=failed-open]').first().innerText()), 'a failed-open decision shows its error');
  await shot(p, 'steps-3-log');
  await p.locator('.step-test .seg button', { hasText: 'Last 10' }).click();
  await p.locator('#step-test').click();
  await p.waitForSelector('.step-ex');
  const ex = await p.locator('.step-ex').allInnerTexts();
  check(ex.length >= 4, 'the test shows each recent call', ex.length);
  check(ex.some((t) => /^Yes[\s\S]*92%$/.test(t.trim())) && ex.some((t) => /^No[\s\S]*8%$/.test(t.trim())), 'with yes or no and the probability', ex);
  check(ex.some((t) => /^Error/.test(t.trim())), 'a failed example says so', ex);
  await p.locator('.step-test').scrollIntoViewIfNeeded();
  await shot(p, 'steps-4-test');

  // A step with nothing to test on shows the API's note.
  await p.locator('.step-form .type-back').click();
  await p.locator('#add-step').click();
  await p.locator('select[name=trigger]').selectOption('tool:ring_create');
  await p.locator('textarea[name=question]').fill('Is this ring larger than three agents?');
  await p.locator('.step-form button[type=submit]').click();
  await p.waitForSelector('#step-test');
  await p.locator('#step-test').click();
  await p.waitForSelector('.step-note');
  check(/no recorded calls of ring_create/.test(await p.locator('.step-note').innerText()), 'no examples: the note says why', await p.locator('.step-note').innerText());
  await p.locator('.step-form .btn.danger').click(); // the dialog is dismissed: nothing deleted
  check((await stepsNow()).some((s) => s.trigger.tool === 'ring_create'), 'delete asks first');

  // From Settings › Tools.
  await p.locator('.settings-nav .item:has-text("Tools")').click();
  const mail = p.locator('.tools-card details.tool').filter({ hasText: 'send_mail' }).first();
  await mail.locator('summary').click();
  await mail.locator('.tool-step').click();
  await p.waitForSelector('.step-form');
  same(await p.locator('select[name=trigger]').inputValue(), 'tool:send_mail', 'Add a step on a tool opens the form with it picked');
  check(await p.locator('.step-tool-desc').count() === 1, 'with the tool\'s description');
  await p.context().close();
}

// --- Image tab: a staged image opens in a world tab (S-1475) ------------------------------
// One pane in main: a new pane to the right. Two: the pane opposite the focused one. More: a new
// tab in the focused pane. The arrows step through the staged images. Screenshots: imagetab-*.png.
async function imageTabFlow() {
  console.log('# imagetab');
  const png = (c) => ({ name: c + '.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  const p = await page();
  const panes = () => p.locator('#w-main .pane').evaluateAll((ps) => ps.map((x) => ({ id: x.dataset.id, tabs: [...x.querySelectorAll('.tab')].map((t) => t.dataset.key) })));
  await p.locator('#tree .node .name:text-is("helper")').first().click();
  await p.locator('#w-bottom textarea').waitFor();
  await p.locator('#w-bottom input[type=file]:not([data-images])').setInputFiles([png('red'), png('blue')]);
  const staged = p.locator('#w-bottom .cmp-open');
  await staged.first().waitFor();
  check(await staged.count() === 2, 'both staged images are buttons');
  await staged.nth(1).click();
  await p.locator('#w-main .it-view').waitFor();
  let ps = await panes();
  check(ps.length === 2 && ps[1].tabs.length === 1 && ps[1].tabs[0].startsWith('image:'), 'one pane: the image opens in a new pane to the right', ps);
  check(await p.locator('#w-main .it-view .it-count').innerText() === '2 / 2', 'it opens at the clicked image');
  await p.locator('#w-main .it-view').focus();
  await p.keyboard.press('ArrowLeft');
  check(await p.locator('#w-main .it-view .it-count').innerText() === '1 / 2', 'the left arrow key steps back');
  await sleep(400);
  await shot(p, 'imagetab-1-one-pane');
  // Two panes: the image goes to the pane opposite the input's target, even with the image pane
  // focused by a click on it (the input still writes for the agent's pane).
  await p.locator('#w-main .it-view').click();
  await sleep(300);
  await staged.first().click();
  await sleep(300);
  ps = await panes();
  check(ps.length === 2 && ps[0].tabs.every((k) => !k.startsWith('image:')) && ps[1].tabs.filter((k) => k.startsWith('image:')).length === 2, 'two panes: the image opens in the pane opposite the input\'s target', ps);
  check(/helper/.test(await p.locator('#w-bottom textarea').getAttribute('placeholder') ?? ''), 'the input still writes to the agent after an image pane was clicked', await p.locator('#w-bottom textarea').getAttribute('placeholder'));
  await shot(p, 'imagetab-2-two-panes');
  // More than two: a tab in the focused pane.
  await p.locator('#w-main .pane').first().click({ position: { x: 20, y: 60 } });
  await p.evaluate(() => window.stamDebug.shell.splitPane('main', document.querySelector('#w-main .pane').dataset.id, 'down'));
  await sleep(400);
  await p.locator('#w-main .pane').first().click({ position: { x: 20, y: 60 } });
  const before = await panes();
  await staged.first().click();
  await sleep(300);
  ps = await panes();
  check(before.length === 3 && ps.length === 3 && ps[0].tabs.filter((k) => k.startsWith('image:')).length === 1, 'three panes: the image opens as a tab in the focused pane', ps);
  check(await staged.count() === 2 && /helper/.test(await p.locator('#w-bottom textarea').getAttribute('placeholder') ?? ''), 'the input keeps its staged images and writes to the agent', await p.locator('#w-bottom textarea').getAttribute('placeholder'));
  await shot(p, 'imagetab-3-three-panes');
  // The layout is shared: another page hides this page's image tabs and closes none of them.
  const other = await page(undefined, null, 'light', true);
  await other.locator('#tree .node .name:text-is("helper")').first().click();
  await sleep(1000);
  check(await other.locator('#w-main .tab[data-key^="image:"]').count() === 0, 'another page does not show this page\'s image tabs');
  check(await other.locator('#w-main .it-view').count() === 0, 'and makes no view for them');
  await sleep(500);
  check((await panes()).flatMap((x) => x.tabs).filter((k) => k.startsWith('image:')).length === 3, 'and this page keeps all three', await panes());
  await other.context().close();
  await p.context().close();
}

// --- Layout: the daemon's, followed live --------------------------------------------------
// An agent arranges the human's layout through POST /api/layout/ops with `by` (what its
// layout_arrange tool sends); every open page follows, the phone as one pane with every tab
// in its strip. A change on one page shows on the other. Screenshots: layout-*.png.
async function layoutFlow() {
  console.log('# layout');
  const a = await page();
  const b = await page(undefined, null, 'light', true);
  const ph = await page({ width: 360, height: 780 }, null, 'light', true);
  const A = `agent:${helper.id}`;
  const kid = agents.find((x) => x.name === 'kid');
  const panes = (p) => p.locator('#w-main .pane').evaluateAll((ps) => ps.map((x) => ({ id: x.dataset.id, tabs: [...x.querySelectorAll('.tab')].map((t) => t.dataset.key) })));
  const until = async (p, want, what) => {
    let got;
    for (let i = 0; i < 40; i++) { got = await panes(p); if (want(got)) break; await sleep(150); }
    check(want(got), what, got);
  };
  const shows = (p) => p.evaluate(() => window.stamDebug.shell.currentWorld());
  // The human's own navigation stays on its device.
  await a.locator('#tree .node .name:text-is("helper")').first().click();
  await sleep(600);
  check(await shows(a) === helper.id, 'the first page shows the agent it picked', await shows(a));
  check(await layoutCurrent() === null, 'picking an agent doesn\'t move the daemon\'s current world', await layoutCurrent());
  check(await shows(b) === null && await shows(ph) === null, 'the other pages stay where they were', [await shows(b), await shows(ph)]);
  check(await ph.locator('#w-left.mobile-open').count() === 1, 'the phone shows its agent tree');
  await shot(a, 'layout-1-before-desktop');
  await shot(ph, 'layout-1-before-phone');

  // The agent sends the human to its world and opens Usage beside itself, as layout_arrange
  // does: token only, naming itself. Every page moves, and the phone's tree gives way.
  const r = await fetch(origin + '/api/layout/ops', { method: 'POST', headers: { authorization: 'Bearer ' + (agentTokens[helper.id] || token), 'content-type': 'application/json' }, body: JSON.stringify({ by: helper.id, ops: [{ op: 'current', world: helper.id }, { op: 'open', world: 'main', key: 'usage', split: 'right' }] }) });
  check(r.ok, 'the agent\'s layout op is accepted', r.status);
  const two = (ps) => ps.length === 2 && ps[0].tabs.includes(A) && ps[1].tabs.join() === 'usage';
  await until(a, two, 'the first page shows usage beside the agent');
  await until(b, two, 'the second page moves to the agent\'s world, usage beside it');
  check(await shows(b) === helper.id, 'the second page now shows the agent\'s world', await shows(b));
  const daemonPanes = async () => { const l = await api('/api/layout'); const w = l.agentWorlds[helper.id]; return w.root.children.map((c) => c.id); };
  same((await panes(b)).map((x) => x.id), await daemonPanes(), 'the pages\' pane ids are the daemon\'s');
  await until(ph, (ps) => ps.length === 1 && ps[0].tabs.includes(A) && ps[0].tabs.includes('usage'), 'the phone shows one pane, with both tabs in its strip');
  check(await ph.locator('#w-left.mobile-open').count() === 0, 'the phone\'s agent tree closed to show it');
  await sleep(600);
  await shot(a, 'layout-2-after-desktop');
  await shot(ph, 'layout-2-after-phone');
  // On the phone, tapping the other tab shows that pane.
  await ph.locator('.tab[data-key="usage"]').click();
  await until(ph, (ps) => ps.length === 1 && ps[0].tabs.includes('usage'), 'the phone shows the usage pane after a tap');

  // Panes and tabs stay shared: a close and a split made on one page show on the other,
  // with the same pane ids.
  await b.locator('.pane .tab[data-key="usage"] .close').click({ force: true });
  await until(a, (ps) => ps.length === 1 && !ps.some((x) => x.tabs.includes('usage')), 'closing usage on the second page closes it on the first');
  await a.locator('#tree .node .name:text-is("helper")').first().click({ button: 'right' });
  await a.getByRole('menuitem', { name: 'Details' }).first().click();
  await sleep(300);
  const body = await a.locator('#w-main .pane-body').first().boundingBox();
  await drag(a, a.locator(`.tab[data-key="details:${helper.id}"]`), { x: body.x + body.width - 20, y: body.y + body.height / 2 });
  const split = (ps) => ps.length === 2 && ps[1].tabs.join() === `details:${helper.id}`;
  await until(a, split, 'dragging details to the right edge splits the pane');
  await until(b, split, 'the second page follows the split');
  same((await panes(a)).map((x) => x.id), (await panes(b)).map((x) => x.id), 'both pages have the same pane ids after a split made on one');
  same((await panes(a)).map((x) => x.id), await daemonPanes(), 'and the daemon too');

  // Picking another agent on one page leaves the other where it is.
  if (kid) {
    await a.locator('#tree .node .name:text-is("kid")').first().click();
    await sleep(600);
    check(await shows(a) === kid.id && await shows(b) === helper.id, 'picking another agent moves only that page', [await shows(a), await shows(b)]);
    await until(b, split, 'the second page keeps the agent\'s world on screen');
  } else check(false, 'the seed has an agent named kid');
  for (const p of [a, b, ph]) await p.context().close();
}

// The Retros section of the standing Retros parent (S-162): its open items with a kind filter, a
// tap opens an item, the effort table and coverage line. Seeded by seed.mjs: three items, one +1.
async function retros() {
  console.log('# retros');
  const parent = (await api('/api/itsas')).find((x) => x.kind === 'retros');
  check(!!parent, 'the seed has a Retros parent');
  for (const theme of ['light', 'dark']) {
    const p = await page({ width: 1500, height: 900 }, null, theme);
    await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:itsa:' + parent.id);
    const sec = p.locator('.itsa-view[data-itsa="' + parent.id + '"] section[aria-label="Retros"]');
    await sec.waitFor();
    same(await sec.locator('.retro-row .ititle').allInnerTexts(), ['Waits stall on idle panes', 'Mail names are plain text', 'Keep the chip row on one line'], `${theme}: ranked by +1s, then newest`);
    check(await sec.locator('.retro-row').count() === 3, `${theme}: three open items`);
    check(/\+1/.test(await sec.locator('.retro-row').first().innerText()), `${theme}: the +1 count shows`);
    check(/1 archived|No agents archived/.test(await sec.locator('.retro-coverage').innerText()), `${theme}: the coverage line shows`);
    await sec.locator('[data-retro-kind="improve"]').click();
    check(await sec.locator('.retro-row').count() === 1, `${theme}: the improve filter keeps one item`);
    await sec.locator('[data-retro-kind="all"]').click();
    await shot(p, `retros-${theme}`);
    await sec.locator('.retro-row').first().click();
    await p.waitForSelector('.itsa-view:not([data-itsa="' + parent.id + '"])');
    check(true, `${theme}: a tap opens the item`);
    await p.context().close();
  }
  const ph = await page({ width: 360, height: 800 }, null, 'light');
  await ph.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:itsa:' + parent.id);
  const psec = ph.locator('.itsa-view[data-itsa="' + parent.id + '"] section[aria-label="Retros"]');
  await psec.waitFor();
  await psec.scrollIntoViewIfNeeded();
  const box = await ph.locator('.retro-row').first().boundingBox();
  check(box && box.height >= 44, 'a 360 px item row is a 44 px touch target', box);
  check(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal page scroll at 360 px');
  await shot(ph, 'retros-360-light');
  await ph.context().close();
}

// Requirements (S-506): the feature turned on, two requirements and verdicts seeded through the
// API (the checks go to the decide stub, no model), the tree in the sidebar, the requirement's
// world, a waiver, the preview, and an ITSA's Requirements panel; at 360 px and on the desktop,
// light and dark. Every verdict reads as an indication ("likely"), never as fact.
async function requirementsFlow() {
  console.log('# requirements');
  const st = await api('/api/config/settings');
  const before = JSON.parse(st.text);
  const on = (enabled) => api('/api/config/settings', { method: 'POST', body: JSON.stringify({ text: JSON.stringify({ ...before, requirements: { ...(before.requirements ?? {}), enabled, approval: 'human' } }, null, 2) }) });
  await on(true);
  check((await api('/api/req-enabled')).enabled === true, 'requirements are on');
  const root = await api('/api/requirements', { method: 'POST', body: JSON.stringify({ title: 'Testing', text: 'Tests shall be deterministic.', status: 'in_force', level: 'system' }) });
  const leaf = await api('/api/requirements', { method: 'POST', body: JSON.stringify({ parent: root.key, title: 'Tests never call a real AI', text: 'Tests shall never depend on a real AI or LLM; model calls go to stubs.', rationale: 'A test that calls a model is slow, costs, and flakes.', source: 'S-107', status: 'in_force', severity: 'major', mode: 'inform', verification: ['decision'], owner: 'human' }) });
  check(!!root.key && !!leaf.key, 'two requirements are created', [root, leaf]);
  // The ITSA sits under a parent, beside a sibling the stub finds violating: the matrix's issue tree.
  const top = await api('/api/itsas', { method: 'POST', body: JSON.stringify({ title: 'Deterministic tests' }) });
  const it = await api('/api/itsas', { method: 'POST', body: JSON.stringify({ title: 'Check: a stub for the decide model', parent: top.key }) });
  const it2 = await api('/api/itsas', { method: 'POST', body: JSON.stringify({ title: `Smoke test the live model REQ:${leaf.key}=violates`, parent: top.key }) });
  await api(`/api/requirements/${leaf.key}/links`, { method: 'POST', body: JSON.stringify({ target_kind: 'itsa', target: it.key, role: 'allocated_to' }) });
  // Two likely violations on pasted text (the stub reads REQ:KEY=violates), and a check on the ITSA (conforms).
  const c1 = await api('/api/requirements/check', { method: 'POST', body: JSON.stringify({ text: `uses the live model REQ:${leaf.key}=violates`, keys: [leaf.key] }) });
  await api('/api/requirements/check', { method: 'POST', body: JSON.stringify({ text: `calls openrouter in a test REQ:${leaf.key}=violates`, keys: [leaf.key] }) });
  await api('/api/requirements/check', { method: 'POST', body: JSON.stringify({ subject: `itsa:${it.key}`, keys: [leaf.key] }) });
  same(c1.results?.map((r) => r.verdict), ['violates'], 'the stub gives the seeded verdict');

  for (const theme of ['light', 'dark']) {
    const p = await page({ width: 1500, height: 900 }, null, theme);
    await sideTab(p, 'issues');
    const side = p.locator('#req-side');
    await side.waitFor();
    const row = (k) => side.locator(`.irow[data-req="${k}"]`);
    check(await row(root.key).isVisible(), `${theme}: the Requirements section lists the root`);
    check(await row(leaf.key).count() === 0, `${theme}: children wait folded`);
    check(await row(root.key).locator('.rollup.rq .violates').count() === 1, `${theme}: the root's roll-up bar counts the child's likely violation`);
    await row(root.key).locator('.chev').click();
    await row(leaf.key).waitFor();
    check(/likely violates/.test(await row(leaf.key).locator('.rglyph').getAttribute('aria-label')), `${theme}: the child's glyph says likely violates`);
    check(/likely violate/.test(await side.locator('.section').innerText()), `${theme}: the header counts likely violations`);
    await row(leaf.key).click();
    const view = p.locator(`.req-view[data-req-view="${leaf.key}"]`);
    await view.waitFor();
    check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:req:' + leaf.key, `${theme}: a row opens the world w:req:KEY`);
    const head = await view.locator('.itsa-head').innerText();
    check([leaf.key, 'Tests never call a real AI', 'in force', 'major', 'inform', 'you'].every((x) => head.includes(x)), `${theme}: the header shows key, title, status, severity, mode, and owner`, head);
    check(/never depend on a real AI/.test(await view.locator('.rq-shall').innerText()) && /S-107/.test(await view.locator('.rq-why').innerText()), `${theme}: the shall text, rationale, and source show`);
    check(await view.locator(`[data-trace-req="${root.key}"]`).isVisible() && await view.locator(`[data-trace-itsa="${it.key}"]`).isVisible(), `${theme}: the trace shows the parent and the allocated ITSA`);
    const words = await view.locator('.rq-verdicts .rq-word').allInnerTexts();
    // The two seeded violations, the checks on the ITSAs, and the daemon's own checks when they were created.
    check(words.length >= 3 && words.filter((w) => w === 'likely violates').length >= 2 && words.every((w) => /^likely |^unsure/.test(w)), `${theme}: every verdict is worded as likely`, words);
    check(await view.locator('.rq-verdict .pbar-track').count() === words.length, `${theme}: each verdict has a probability bar`);
    // Readable subjects (S-507): a pasted text by its start, an ITSA by key and title as a link; never text:<hash>.
    const subjects = await view.locator('.rq-verdict .rq-subject').allInnerTexts();
    check(subjects.some((x) => x.startsWith('uses the live model')) && !subjects.some((x) => /^text:/.test(x)), `${theme}: a pasted text reads as its start, never its hash`, subjects);
    check(await view.locator(`.rq-verdict button.rq-subject[data-subject-open="itsa"]:has-text("${it.key} Check: a stub")`).count() >= 1, `${theme}: an ITSA subject reads as key and title, as a link`, subjects);
    await shot(p, `requirements-desktop-${theme}`);
    await p.context().close();
  }

  // Waive one verdict, from the world's Waive button and its form.
  const p = await page()
  await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:req:' + leaf.key);
  const view = p.locator(`.req-view[data-req-view="${leaf.key}"]`);
  await view.waitFor();
  const vid = Number(await view.locator('[data-waive]').first().getAttribute('data-waive'));
  await view.locator(`[data-waive="${vid}"]`).click();
  const form = p.locator('[data-waive-form]');
  await form.waitFor();
  check(await form.locator('[data-waive-submit]').isDisabled(), 'Waive waits for a reason');
  await form.locator('textarea').fill('The test reads a fixture named openrouter; no call is made.');
  await shot(p, 'requirements-waive-desktop');
  await form.locator('[data-waive-submit]').click();
  await view.locator(`[data-verdict="${vid}"] [data-waived]`).waitFor();
  check(/false positive/.test(await view.locator(`[data-verdict="${vid}"] [data-waived]`).innerText()), 'the waived verdict stays, marked false positive');
  const got = await api(`/api/requirements/${leaf.key}`);
  same(got.verdicts.find((x) => x.id === vid)?.waiver?.kind, 'false_positive', 'the waiver is stored');
  check(got.precision.false_positives === 1, 'precision counts the false positive', got.precision);
  check(/1 of its last \d+ likely/.test(await view.locator('[aria-label="Precision"]').innerText()), 'the precision section shows the counts', await view.locator('[aria-label="Precision"]').innerText());
  check(/If more than 30% are waived, it switches to observe-only/.test(await view.locator('[aria-label="Precision"]').innerText()), 'the precision line says when it switches to observe-only');
  // An ITSA subject opens the ITSA.
  await view.locator(`button.rq-subject[data-subject-open="itsa"]:has-text("${it.key}")`).first().click();
  await p.waitForFunction((w) => window.stamDebug.shell.currentWorld() === w, 'w:itsa:' + it.id);
  await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:req:' + leaf.key);
  await view.waitFor();
  // Preview: on the stub, it records nothing.
  await view.locator('[data-preview-open]').click();
  const pv = p.locator('[data-preview]');
  await pv.waitFor();
  await p.waitForFunction(() => !/Asking the model/.test(document.querySelector('[data-preview]')?.textContent ?? 'Asking the model'), null, { timeout: 30000 });
  check(!(await pv.locator('.rq-error').count()), 'the preview answers', await pv.innerText());
  same((await api(`/api/requirements/${leaf.key}`)).verdicts.length, got.verdicts.length, 'the preview records nothing');
  await p.keyboard.press('Escape');
  // The ITSA's Requirements panel.
  await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:itsa:' + it.id);
  const panel = p.locator(`.itsa-view[data-itsa="${it.id}"] [data-itsa-reqs]`);
  await panel.waitFor();
  const ptext = await panel.innerText();
  check(ptext.includes(leaf.key) && /allocated to/.test(ptext) && /likely conforms/.test(ptext), 'an ITSA lists its requirements with their latest verdict on it', ptext);
  await shot(p, 'requirements-itsa-panel');
  await p.context().close();

  // The phone: the tree as full-width rows in the Issues tab, the world in one column, Waive in a bottom sheet.
  for (const theme of ['light', 'dark']) {
    const ph = await page({ width: 360, height: 800 }, null, theme);
    await ph.locator('[data-nav="issues"]').click();
    const side = ph.locator('#req-side');
    await side.waitFor();
    await side.locator(`.irow[data-req="${root.key}"] .chev`).click();
    const lrow = side.locator(`.irow[data-req="${leaf.key}"]`);
    await lrow.waitFor();
    const box = await lrow.boundingBox();
    check(box && box.height >= 44 && box.width >= 340, `${theme}: a 360 px requirement row is full width and a touch target`, box);
    await shot(ph, `requirements-360-tree-${theme}`);
    await lrow.click();
    const view = ph.locator(`.req-view[data-req-view="${leaf.key}"]`);
    await view.waitFor();
    check(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${theme}: no horizontal page scroll at 360 px`);
    await shot(ph, `requirements-360-world-${theme}`);
    await view.locator('[aria-label="Recent verdicts"]').scrollIntoViewIfNeeded();
    await shot(ph, `requirements-360-verdicts-${theme}`);
    await view.locator('[data-waive]').first().scrollIntoViewIfNeeded();
    await view.locator('[data-waive]').first().click();
    const sheet = ph.locator('.menu.popover:has([data-waive-form])');
    await sheet.waitFor();
    const sb = await sheet.boundingBox();
    check(sb && Math.abs(sb.y + sb.height - 800) < 2 && sb.width >= 359, `${theme}: Waive opens a bottom sheet`, sb);
    // The sheet slides in: the shot waits for its motion to end.
    await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    await shot(ph, `requirements-360-waive-${theme}`);
    await ph.context().close();
  }
  await complianceFlow({ root, leaf, top, it, it2 });
  await batchApprovalFlow();
  await on(false);
  check((await api('/api/req-enabled')).enabled === false, 'requirements are off again');
}

// The batch approval (S-568): helper's batch of three drafts raises one approval ITSA. Its list shows
// each draft with its text and why; Drop, then Mark obsolete, takes one out; Approve all puts the
// rest in force, and the dropped draft stays out.
async function batchApprovalFlow() {
  console.log('# requirements: batch approval');
  // helper runs on claude-haiku-5-5, which the defaults keep from mailing the human (settings.humanMail.models),
  // and an ask moves its ITSA to a human status. The check lets Haiku mail for this step; the settings are
  // restored in the finally, even when a step fails.
  const cur = JSON.parse((await api('/api/config/settings')).text);
  const setHumanMail = (models) => api('/api/config/settings', { method: 'POST', body: JSON.stringify({ text: JSON.stringify({ ...cur, humanMail: { ...cur.humanMail, models: { ...(cur.humanMail?.models ?? {}), ...models } } }, null, 2) }) });
  let p = null;
  let ph = null;
  try {
    await setHumanMail({ 'claude-haiku-5-5': true });
    const got = await api('/api/requirements/batch', { method: 'POST', body: JSON.stringify({ by: 'helper', requirements: [
      { ref: 'bt', title: 'Batch approval top', text: 'The batch shall be readable.' },
      { parent: 'bt', title: 'One line per draft', text: 'The approval shall list each draft on one line.', rationale: 'Dana approves what they read.', verification: ['decision'], scope: { subjects: ['mail-to-human'] }, mode: 'observe' },
      { parent: 'bt', title: 'Drop keeps the rest', text: 'Dropping a draft shall leave the other drafts as they were.', rationale: 'One weak draft must not block the batch.', verification: ['decision'], scope: { subjects: ['mail-to-human'] }, mode: 'observe' },
    ] }) });
    const k = (title) => got.requirements?.find((r) => r.title === title);
    const [top, one, drop] = ['Batch approval top', 'One line per draft', 'Drop keeps the rest'].map((t) => k(t)?.key);
    const dropRev = k('Drop keeps the rest')?.rev;
    const ask = got.approval?.itsa;
    check(!!ask && got.approval?.to === 'human', 'a batch from helper raises one approval for its three drafts', got);
    const x = await api(`/api/itsas/${ask}`);
    p = await page({ width: 1500, height: 900 }, null, 'light');
    await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:itsa:' + x.id);
    const list = p.locator('[data-req-batch]');
    await list.waitFor();
    const rows = list.locator('[data-batch-item]');
    check(await rows.count() === 3, 'the approval lists each draft in its own row', await rows.count());
    check(await p.locator('.itsa-summary').count() === 0, 'the ITSA summary, which repeats the count, is not shown for a batch');
    const oneText = await list.locator(`[data-batch-item="${one}"]`).innerText();
    check(oneText.includes('The approval shall list each draft on one line.') && oneText.includes('Dana approves what they read.'), 'a row carries the draft\'s text and why', oneText);
    const approveText = await p.locator('[data-act="approve"]').innerText();
    check(/Approve all/.test(approveText), 'the approve button reads Approve all', approveText);
    // A shared token with x-stam-human is not the human: the drop is refused and the draft stays a draft.
    const shared = await fetch(origin + `/api/requirements/asks/${x.id}/drop`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'content-type': 'application/json' }, body: JSON.stringify({ key: drop, obsolete: true, if_rev: dropRev }) });
    check(shared.status === 403, 'a drop with the shared token and x-stam-human is refused', shared.status);
    check((await api(`/api/requirements/${drop}`)).status === 'draft', 'and the draft stays a draft');
    await list.locator(`[data-drop="${drop}"]`).click();
    await list.locator(`[data-drop-obsolete="${drop}"]`).click();
    await list.locator(`[data-batch-item="${drop}"]`).getByText('Dropped, now obsolete').waitFor();
    check((await api(`/api/requirements/${drop}`)).status === 'obsolete', 'Mark obsolete marks only the dropped draft obsolete');
    check(/2 to approve, 1 dropped/.test(await list.locator('.itsa-sec-head').innerText()), 'the count says what is left to approve and what was dropped');
    await shot(p, 'requirements-batch-desktop-light');
    await p.context().close();
    p = null;
    ph = await page({ width: 360, height: 780 }, null, 'light');
    await ph.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:itsa:' + x.id);
    await ph.locator('[data-req-batch]').waitFor();
    check(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the approval has no horizontal page scroll at 360 px');
    await shot(ph, 'requirements-360-batch-light');
    await ph.context().close();
    ph = null;
    // Approve carries the revision of the text it was shown (S-2998).
    const { rev } = await api(`/api/itsas/${x.id}`);
    await api(`/api/itsas/${x.id}/act`, { method: 'POST', body: JSON.stringify({ action: 'approve', text: '', if_rev: rev }) });
    let closed = false;
    for (let i = 0; i < 40 && !closed; i++) { closed = (await api(`/api/itsas/${x.id}`)).status === 'done'; if (!closed) await sleep(200); }
    check(closed, 'Approve all closes the approval');
    check((await api(`/api/requirements/${top}`)).status === 'in_force' && (await api(`/api/requirements/${one}`)).status === 'in_force', 'Approve all puts the two drafts left in force');
    check((await api(`/api/requirements/${drop}`)).status === 'obsolete', 'the dropped draft stays obsolete');
  } finally {
    await api('/api/config/settings', { method: 'POST', body: JSON.stringify({ text: JSON.stringify(cur, null, 2) }) });
    if (p) await p.context().close().catch(() => {});
    if (ph) await ph.context().close().catch(() => {});
  }
}

// The compliance matrix and Settings › Requirements (S-507): requirements down, subjects across,
// from the merge queue or an issue tree; a cell opens the requirement at that verdict. On a phone,
// one card per requirement with a wrapping strip of chips. Settings turns the feature on and off
// and imports a JSON file through POST /api/requirements/batch.
async function complianceFlow({ root, leaf, top, it, it2 }) {
  console.log('# requirements: compliance and settings');
  // The sibling's check comes after the earlier waiver, so its cell shows a live likely violation.
  await api('/api/requirements/check', { method: 'POST', body: JSON.stringify({ subject: `itsa:${it2.key}`, keys: [leaf.key] }) });
  const cell = (k, s) => `[data-cell="${k}|${s}"]`;
  for (const theme of ['light', 'dark']) {
    const p = await page({ width: 1500, height: 900 }, null, theme);
    await sideTab(p, 'issues');
    await p.locator('#req-side [data-compliance-open]').click();
    const view = p.locator('[data-compliance]');
    await view.waitFor();
    check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:compliance', `${theme}: the sidebar opens the compliance world`);
    await view.locator('[data-subjects="queue"]').click();
    check(/Nothing is in the merge queue/.test(await view.innerText()), `${theme}: the merge queue mode says when the queue is empty`);
    await view.locator('[data-subjects="itsa"]').click();
    await view.locator('[data-subject-root]').selectOption(top.id);
    await view.locator('table.rq-matrix').waitFor();
    same(await view.locator('thead .rq-msubj-btn').allInnerTexts(), [top.key, it.key, it2.key], `${theme}: a column per ITSA in the subtree`);
    same(await view.locator('tbody tr').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-matrix-row'))), [root.key, leaf.key], `${theme}: a row per requirement, parents first`);
    const ok = view.locator(`${cell(leaf.key, 'itsa:' + it.key)}`), bad = view.locator(`${cell(leaf.key, 'itsa:' + it2.key)}`);
    check(/likely conforms/.test(await ok.getAttribute('aria-label')) && /likely violates/.test(await bad.getAttribute('aria-label')), `${theme}: each cell says its verdict as likely`, [await ok.getAttribute('aria-label'), await bad.getAttribute('aria-label')]);
    check(/not checked/.test(await view.locator(cell(root.key, 'itsa:' + top.key)).getAttribute('title')), `${theme}: an unchecked pair says so`);
    await shot(p, `requirements-matrix-desktop-${theme}`);
    // A cell opens the requirement's world scrolled to that verdict, which is marked once.
    const vid = (await api(`/api/requirements?verdicts=latest`)).find((x) => x.key === leaf.key).latest.find((v) => v.subject === `itsa:${it2.key}`).id;
    await bad.click();
    const rv = p.locator(`.req-view[data-req-view="${leaf.key}"]`);
    const row = rv.locator(`[data-verdict="${vid}"]`);
    await row.waitFor();
    check(await p.evaluate(() => window.stamDebug.shell.currentWorld()) === 'w:req:' + leaf.key, `${theme}: a cell opens the requirement's world`);
    await p.waitForFunction((id) => { const el = document.querySelector(`[data-verdict="${id}"]`); if (!el) return false; const b = el.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }, vid);
    check(true, `${theme}: the world scrolls to the cell's verdict`);
    await p.context().close();
  }

  // Settings › Requirements on the desktop: the fields, the observe note, turning off and on, Import.
  for (const theme of ['light', 'dark']) {
    const p = await page({ width: 1500, height: 900 }, null, theme);
    await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:config'));
    await p.locator('.settings-nav .item:has-text("Requirements")').click();
    const card = p.locator('[data-req-settings]');
    await card.waitFor();
    const text = await p.locator('.settings-inner').innerText();
    check(['Who approves drafts', 'Default threshold', 'Default mode', 'Daily cap', 'Key prefix', 'Demote after', 'Import'].every((x) => text.includes(x)), `${theme}: Settings › Requirements has every field`, text);
    check(await p.locator('[data-req-observe-note]').isVisible(), `${theme}: on, it notes that seeded requirements start in observe`);
    await shot(p, `requirements-settings-desktop-${theme}`);
    if (theme === 'light') {
      const until = async (fn) => { for (let i = 0; i < 40; i++) { if (await fn()) return true; await sleep(200); } return false; };
      await p.locator('[data-req-enabled]').uncheck();
      check(await until(async () => (await api('/api/req-enabled')).enabled === false), 'unchecking turns requirements off');
      await sideTab(p, 'issues');
      check(await until(async () => !(await p.locator('#req-side').count())), 'and the sidebar section goes at once');
      await p.locator('[data-req-enabled]').check();
      check(await until(async () => (await api('/api/req-enabled')).enabled === true), 'checking turns them on again');
      await p.locator('[data-req-observe-note]').waitFor();
      // Import sends the file's requirements through the batch route (S-508's); its answer is stubbed here.
      let sent = null;
      await p.route('**/api/requirements/batch', (r) => { sent = r.request().postDataJSON(); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ requirements: [{ key: 'R-90' }, { key: 'R-91' }], approval: { itsa: 'S-900' } }) }); });
      await p.locator('[data-req-import-file]').setInputFiles({ name: 'reqs.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ requirements: [{ title: 'A' }, { title: 'B', parent: 'A' }] })) });
      await p.locator('[data-req-import-note]').waitFor();
      same(sent, { requirements: [{ title: 'A' }, { title: 'B', parent: 'A' }] }, 'Import posts the file\'s requirements');
      check(/Imported 2 requirements \(R-90, R-91\)\. Approval asked in S-900/.test(await p.locator('[data-req-import-note]').innerText()), 'and says what it made');
      await p.locator('[data-req-import-file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"title": "A"}') });
      await p.waitForFunction(() => /neither a list/.test(document.querySelector('[data-req-import-note]')?.textContent ?? ''));
      check(true, 'a file without requirements is refused in place');
    }
    await p.context().close();
  }

  // The phone: cards with a wrapping strip of chips, and Settings › Requirements, at 360 px.
  for (const theme of ['light', 'dark']) {
    const ph = await page({ width: 360, height: 800 }, null, theme);
    await ph.locator('[data-nav="issues"]').click();
    await ph.locator('#req-side [data-compliance-open]').click();
    const view = ph.locator('[data-compliance]');
    await view.waitFor();
    await view.locator('[data-subjects="itsa"]').click();
    await view.locator('[data-subject-root]').selectOption(top.id);
    const card = view.locator(`.rq-card[data-matrix-row="${leaf.key}"]`);
    await card.waitFor();
    check(!(await view.locator('table.rq-matrix').count()), `${theme}: no table on a phone`);
    same(await card.locator('.rq-mchip .ct').allInnerTexts(), [top.key, it.key, it2.key], `${theme}: a chip per subject`);
    const chip = await card.locator(cell(leaf.key, 'itsa:' + it2.key)).boundingBox();
    check(chip && chip.height >= 44, `${theme}: a chip is a touch target`, chip);
    check(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.rq-mchips')].every((e) => e.scrollWidth <= e.clientWidth)), `${theme}: nothing scrolls sideways at 360 px`);
    await shot(ph, `requirements-360-matrix-${theme}`);
    await ph.evaluate(() => window.stamDebug.shell.showAgentWorld('w:config'));
    await ph.locator('.settings-nav .item:has-text("Requirements")').click();
    await ph.locator('[data-req-settings]').waitFor();
    check(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}: Settings › Requirements fits 360 px`);
    await shot(ph, `requirements-360-settings-${theme}`);
    await ph.locator('[data-req-import]').scrollIntoViewIfNeeded();
    await shot(ph, `requirements-360-settings-import-${theme}`);
    await ph.context().close();
  }
}

// --- The Alt+A prompt (S-1461) ------------------------------------------------------------
// Alt+A opens a prompt centred over a scrim; typing asks /api/suggest (answered here by a fixture,
// so the cards don't depend on embeddings), a pick sets the recipient, and the message mails
// helper, which is paused, so it costs nothing.
async function suggestFlow() {
  console.log('# suggest');
  const p = await page();
  const asked = [];
  await p.route('**/api/suggest?*', (route) => {
    asked.push(new URL(route.request().url()).searchParams.get('q'));
    route.fulfill({ json: [
      { kind: 'agent', id: helper.id, title: 'helper', snippet: 'the paused fixture agent', score: 0.9 },
      { kind: 'thread', id: 'nope', title: 'A fixture thread', snippet: 'not picked here', score: 0.5 },
    ] });
  });
  const open = async () => {
    await p.keyboard.press('Alt+a');
    await p.waitForSelector('#suggest-modal');
    await p.waitForFunction(() => document.activeElement?.matches('#suggest-modal textarea'));
  };
  await open();
  check(await p.locator('#suggest-scrim').count() === 1, 'Alt+A opens the prompt over a scrim');
  check(await p.locator('#top-world').count() === 0, 'Alt+A no longer opens the assistant');
  await p.keyboard.type('UI check, not real work: ');
  await p.waitForSelector('#suggest-modal .sg-card');
  check(asked.length >= 1 && asked.at(-1) === 'UI check, not real work:', 'typing asks for suggestions', asked);
  same(await p.locator('#suggest-modal .sg-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-suggest'))), [`agent:${helper.id}`, 'thread:nope'], 'the cards show, best first');
  check(/Goes to|No pick/.test(await p.locator('#suggest-modal .cmp-target').innerText()), 'with no pick the box names the default', await p.locator('#suggest-modal .cmp-target').innerText());
  await shot(p, 'suggest-1-cards');
  // Preview (S-1910): Alt+P previews the best card, focus moves into it, Esc closes only the preview
  // (the prompt, the cards and the box focus stay), and Pick does what a click on the card does.
  await p.keyboard.press('Alt+p');
  await p.waitForSelector('[data-preview]');
  check(await p.locator(`[data-preview="agent:${helper.id}"]`).count() === 1, 'Alt+P previews the best card');
  check(await p.evaluate(() => !!document.activeElement?.closest('.menu.popover')), 'focus moves into the preview');
  check(/helper/.test(await p.locator('[data-preview]').innerText()), 'the preview names the agent', await p.locator('[data-preview]').innerText());
  await shot(p, 'suggest-1b-preview');
  await p.keyboard.press('Escape');
  await p.waitForSelector('[data-preview]', { state: 'detached' });
  check(await p.locator('#suggest-modal .sg-card').count() === 2 && await p.locator('#suggest-modal .sg-chip').count() === 0, 'Esc closes the preview and keeps the cards, with no pick');
  check(await p.evaluate(() => document.activeElement?.matches('#suggest-modal textarea')), 'focus returns to the box');
  await p.locator('#suggest-modal [data-suggest="thread:nope"] [data-preview-btn]').click();
  await p.waitForSelector('[data-preview="thread:nope"]');
  check(/not picked here/.test(await p.locator('[data-preview]').innerText()), 'the Preview button shows a mail card\'s text', await p.locator('[data-preview]').innerText());
  await p.keyboard.press('Escape');
  await p.waitForSelector('[data-preview]', { state: 'detached' });
  // The mouse is over the mail card, so Alt+P previews that highlighted card.
  await p.keyboard.press('Alt+p');
  await p.waitForSelector('[data-preview="thread:nope"]');
  await p.locator('[data-preview-pick]').click();
  await p.locator('#suggest-modal .sg-chip[data-pick="thread:nope"]').waitFor();
  check(true, 'Pick in the preview picks the card, as a chip');
  await p.locator('#suggest-modal .sg-unpick').click();
  await p.waitForSelector('#suggest-modal .sg-card');
  // Arrow up then Enter picks the best card instead of sending; the others go.
  await p.keyboard.press('ArrowUp');
  await p.keyboard.press('Enter');
  check(await p.locator('#suggest-modal .sg-chip[data-pick="agent:' + helper.id + '"]').count() === 1, 'Enter on a card picks it, as a chip');
  check(await p.locator('#suggest-modal .sg-card:visible').count() === 0, 'the other cards hide');
  check(await p.evaluate(() => document.activeElement?.matches('#suggest-modal textarea')), 'the box keeps the focus');
  const n = asked.length;
  await p.keyboard.type('more words ');
  await p.waitForTimeout(500);
  same(asked.length, n, 'a pick stops the suggesting');
  await shot(p, 'suggest-2-picked');
  // Removing the chip asks again; picking by click sets it back.
  await p.locator('#suggest-modal .sg-unpick').click();
  await p.waitForSelector('#suggest-modal .sg-card');
  check(asked.length > n, 'removing the pick asks again', asked.length);
  await p.locator(`#suggest-modal [data-suggest="agent:${helper.id}"] .sg-pick`).click();
  const w = `GUAVA${Date.now() % 10000}`;
  await p.keyboard.type(w);
  await p.keyboard.press('Enter');
  await p.waitForSelector('#suggest-modal', { state: 'detached' });
  check(true, 'sending closes the prompt');
  let m = null;
  for (let i = 0; i < 20 && !m; i++) {
    m = (await api(`/api/agents/${helper.id}/threads?limit=50`)).flatMap((t) => t.mails).find((x) => x.from_id === 'human' && (x.body ?? '').includes(w));
    if (!m) await sleep(500);
  }
  check(!!m && m.recipients.some((r) => r.id === helper.id), 'the message reached the picked agent as mail', m);
  // Escape closes it, and Alt+A toggles it.
  await open();
  await p.keyboard.press('Escape');
  await p.waitForSelector('#suggest-modal', { state: 'detached' });
  await open();
  await p.keyboard.press('Alt+a');
  await p.waitForSelector('#suggest-modal', { state: 'detached' });
  check(true, 'Escape and a second Alt+A close it');
  // The preview over the prompt: back closes the preview alone and focus returns to the box; a click on
  // the scrim closes the preview and the prompt, and the prompt stays closed (the history settles).
  await open();
  await p.keyboard.type('UI check, not real work: ');
  await p.waitForSelector('#suggest-modal .sg-card');
  await p.keyboard.press('Alt+p');
  await p.waitForSelector('[data-preview]');
  await p.goBack();
  await p.waitForSelector('[data-preview]', { state: 'detached' });
  check(await p.locator('#suggest-modal').count() === 1 && await p.locator('#suggest-modal .sg-card').count() === 2, 'back closes the preview and leaves the prompt and its cards');
  check(await p.evaluate(() => document.activeElement?.matches('#suggest-modal textarea')), 'focus returns to the box after back');
  await p.keyboard.press('Alt+p');
  await p.waitForSelector('[data-preview]');
  await p.mouse.click(4, 4);
  await p.waitForSelector('#suggest-modal', { state: 'detached' });
  await p.waitForTimeout(500);
  check(await p.locator('#suggest-modal').count() === 0 && await p.locator('[data-preview]').count() === 0, 'a scrim click with the preview open closes both, and the prompt stays closed');
  // The closed prompt kept its draft; clear it so the Go to checks that follow start empty.
  await open();
  await p.keyboard.press('Control+a');
  await p.keyboard.press('Backspace');
  await p.keyboard.press('Escape');
  await p.waitForSelector('#suggest-modal', { state: 'detached' });
  // Go to (S-1463): reached by keyboard, it opens the agent, closes the prompt and drafts the text
  // in the agent's box; a second Go to adds its text after the first draft.
  const goTo = async (text) => {
    await open();
    await p.keyboard.type(text + ' ');
    await p.waitForSelector('#suggest-modal .sg-card');
    await p.locator(`#suggest-modal [data-suggest="agent:${helper.id}"] [data-go]`).focus();
    await p.keyboard.press('Enter');
    await p.waitForSelector('#suggest-modal', { state: 'detached' });
  };
  await goTo('first thought');
  await p.waitForTimeout(300);
  same((await p.locator('#w-bottom textarea').inputValue()).trim(), 'first thought', 'Go to puts the text in the agent\'s box as a draft');
  await shot(p, 'suggest-3-goto');
  await goTo('second thought');
  await p.waitForTimeout(300);
  same((await p.locator('#w-bottom textarea').inputValue()).trim(), 'first thought\n\nsecond thought', 'a second Go to keeps the draft and adds after it');
  await p.locator('#w-bottom textarea').fill('');
  await ccPillsStep(p);
  // The bottom bar in suggestion mode (S-1474): Settings has nothing to write to, so the bar suggests as you type,
  // sends mail only, and the mail carries a looking-at note.
  await p.locator('#open-config').click();
  await p.locator('.settings-nav').waitFor();
  await p.locator('#w-bottom textarea').click();
  await p.keyboard.type('UI check, not real work: ');
  await p.waitForSelector('#w-bottom .sg-card');
  check(await p.locator('#w-bottom .cmp-mode').count() === 0, 'the bar has no Direct/Mail toggle in suggestion mode');
  await shot(p, 'suggest-4-bottom-bar');
  await p.locator('#w-bottom [data-suggest="agent:' + helper.id + '"] .sg-pick').click();
  await shot(p, 'suggest-5-bottom-bar-picked');
  await p.context().close();
  // The same on a phone (S-1474): Settings has nothing to write to, so the bar is there and suggests.
  const ph = await page({ width: 390, height: 844 });
  await ph.route('**/api/suggest?*', (route) => route.fulfill({ json: [{ kind: 'agent', id: helper.id, title: 'helper', snippet: 'the paused fixture agent', score: 0.9 }, { kind: 'thread', id: 'nope', title: 'A fixture thread', snippet: 'not picked here', score: 0.5 }] }));
  await ph.locator('#open-config').click();
  await ph.locator('.settings-nav').waitFor();
  check(await ph.locator('#w-bottom .composer').isVisible(), 'the phone bar shows on Settings, which has nothing to write to');
  await ph.locator('#w-bottom textarea').click();
  await ph.keyboard.type('UI check, not real work: ');
  await ph.waitForSelector('#w-bottom .sg-card');
  check(await ph.locator('#w-bottom .cmp-mode').count() === 0, 'the phone bar has no Direct/Mail toggle in suggestion mode');
  await shot(ph, 'suggest-6-phone-cards');
  await ph.locator('#w-bottom [data-suggest="agent:' + helper.id + '"] .sg-pick').click();
  await shot(ph, 'suggest-7-phone-picked');
  await ph.context().close();
}

// cc pills (S-1464): the bottom box on helper suggests as the human types, with a higher floor than
// Alt+A: helper itself (the recipient) and a far match don't show, kid does, as a pill on the box's
// top border that covers no text. A pick switches the box to Mail and adds kid as a cc. The mail
// is caught here, so kid gets nothing.
async function ccPillsStep(p) {
  const kid = agents.find((a) => a.name === 'kid');
  if (!kid) { console.log('skip: no kid agent for the cc pills'); return; }
  await p.unroute('**/api/suggest?*');
  await p.route('**/api/suggest?*', (route) => route.fulfill({ json: [
    { kind: 'agent', id: helper.id, title: 'helper', score: 0.95 },
    { kind: 'agent', id: kid.id, title: 'kid', score: 0.8 },
    { kind: 'thread', id: 'nope', title: 'A far thread', score: 0.4 },
  ] }));
  let posted = null;
  await p.route('**/api/mail', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted = route.request().postDataJSON();
    return route.fulfill({ json: { id: 'mfixture', thread_id: 'mfixture' } });
  });
  const ta = p.locator('#w-bottom textarea');
  const geometry = () => p.evaluate(() => {
    const box = document.querySelector('#w-bottom .cmp-box').getBoundingClientRect();
    const pill = document.querySelector('#w-bottom .cmp-pill').getBoundingClientRect();
    const text = document.querySelector('#w-bottom textarea').getBoundingClientRect();
    return { mid: (pill.top + pill.bottom) / 2, border: box.top, pillBottom: pill.bottom, textTop: text.top };
  });
  for (const [label, size] of [['desktop', { width: 1500, height: 900 }], ['phone', { width: 390, height: 800 }]]) {
    await p.setViewportSize(size);
    await ta.click();
    await ta.fill('');
    await p.keyboard.type('UI check, cc pills ');
    await p.waitForSelector('#w-bottom .cmp-pill');
    same(await p.locator('#w-bottom .cmp-pill').evaluateAll((els) => els.map((e) => e.getAttribute('data-cc-suggest'))), [`agent:${kid.id}`], `${label}: only kid shows, not the recipient or a far match`);
    const g = await geometry();
    check(Math.abs(g.mid - g.border) <= 2, `${label}: the pill is centred on the box's top border`, g);
    check(g.pillBottom <= g.textTop, `${label}: the pill covers none of the text`, g);
    await shot(p, `suggest-4-ccpills-${label}`);
  }
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.locator(`#w-bottom [data-cc-suggest="agent:${kid.id}"]`).click();
  check(await p.locator('#w-bottom .cmp-pill').count() === 0, 'a picked pill goes');
  same(await p.locator('#w-bottom .cmp-to-n').innerText(), '+1', 'the stam icon counts the cc');
  check(await p.evaluate(() => document.activeElement?.matches('#w-bottom textarea')), 'the box keeps the focus after a pick');
  await shot(p, 'suggest-5-ccpills-picked');
  await p.keyboard.press('Enter');
  for (let i = 0; i < 20 && !posted; i++) await sleep(100);
  check(!!posted && posted.to.includes(helper.id) && posted.to.includes(kid.id), 'the pick switched the box to Mail and the mail cc\'s kid', posted);
  await p.unroute('**/api/mail');
  await ta.fill('');
}

for (const f of flows) {
  if (f === 'tabs') await tabs();
  else if (f === 'rank') await rank();
  else if (f === 'notes') await notes();
  else if (f === 'assistant') await assistant();
  else if (f === 'archive') await archive();
  else if (f === 'spawn') await spawnFlow();
  else if (f === 'types') await typesFlow();
  else if (f === 'permissions') await permissionsFlow();
  else if (f === 'tools') await toolsFlow();
  else if (f === 'modelpicker') await modelPicker();
  else if (f === 'steps') await stepsFlow();
  else if (f === 'cos') await cos();
  else if (f === 'mail') await mailFlow();
  else if (f === 'maillink') await mailLink();
  else if (f === 'search') await search();
  else if (f === 'suggest') await suggestFlow();
  else if (f === 'itsa') await itsa();
  else if (f === 'board') await board();
  else if (f === 'work') await work();
  else if (f === 'legend') await legend();
  else if (f === 'itsalinks') await itsaLinks();
  else if (f === 'itsachip') await itsaChip();
  else if (f === 'itsamail') await itsaMail();
  else if (f === 'itsabeside') await itsaBeside();
  else if (f === 'retros') await retros();
  else if (f === 'term') await term();
  else if (f === 'machines') await machinesFlow();
  else if (f === 'system') await systemFlow();
  else if (f === 'rules') await rules();
  else if (f === 'back') await back();
  else if (f === 'attention') await attention();
  else if (f === 'layout') await layoutFlow();
  else if (f === 'imagetab') await imageTabFlow();
  else if (f === 'requirements') await requirementsFlow();
  else { console.error('unknown flow ' + f); failures++; }
}
await browser.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
