// The blocking line on an ask (S-351), in headless Chromium at 360 px light and on desktop,
// against a seeded test daemon (daemon.sh). The agent kid declares a wait for your reply tied to
// the ask of the seeded ITSA that waits on you, and its harness raises a permission dialog (a
// PermissionRequest hook). The check finds the line on the ask's Mail row and its bar, and on the
// dialog's Mail row and its bar, and screenshots them at both sizes:
//   web/check/run.sh ask-block
//   node web/check/ask-block.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/ask-block-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node ask-block.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
const humanHeaders = testHuman ? { 'x-stam-test-human': testHuman } : {};
// A write that names helper or kid (by, from, agent, or an agent's waits path) goes with that agent's own token
// (daemon.sh's agents=, S-545): the shared token can't act as an agent that has one.
const agentTokens = JSON.parse(new URLSearchParams(u.hash.slice(1)).get('agents') || '{}');
const ownToken = (path, body) => agentTokens[body?.by ?? body?.from ?? body?.agent] || agentTokens[path.match(/^\/api\/agents\/([\w-]+)\/waits\//)?.[1]];
const call = (method, path, body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + (ownToken(path, body) || token), 'x-stam-human': '1', 'content-type': 'application/json', ...humanHeaders }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

let failures = 0;
// check(TAG, OK, WHAT, DETAIL): the detail is printed when the check fails.
const check = (tag, ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};

// The seeded ITSA in needs_input (seed.mjs), and kid, its owner: kid's wait for the human is tied to its ask.
const attention = await call('GET', '/api/itsas/attention');
const ask = attention.find((x) => x.title === 'Human attention: one list');
const agents = await call('GET', '/api/agents');
const kid = agents.find((a) => a.name === 'kid');
if (!ask?.ask_mail_id || !kid) { console.error('no seeded ask or kid agent: restart daemon.sh'); process.exit(2); }
const declared = await call('POST', `/api/agents/${kid.id}/waits/declared`, { on: 'human', thread: ask.ask_mail_id, note: 'the attention list', by: kid.id });
check('api', !!declared.id, 'kid declares a human wait tied to the ask', declared);
const row = (await call('GET', '/api/agents')).find((a) => a.name === 'kid');
const tied = row.waits.find((w) => w.id === declared.id);
check('api', tied?.thread === ask.ask_thread_id, 'the wait carries the ask thread', tied?.thread);

// kid's harness raises a permission dialog: a pending request with dialog=1 in its own thread.
await call('POST', `/api/hook/claude/${kid.id}`, { hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: { file_path: '/elsewhere/ask-block.log' } });
const dialog = (await call('GET', '/api/permissions?status=pending')).find((r) => r.agent_id === kid.id && r.dialog);
check('api', !!dialog, 'kid has a pending permission dialog', dialog?.action);

const browser = await chromium.launch(chromiumLaunchOptions());
const LINE = 'Holds ' + ask.key + ' · @kid is stopped until you answer';
const ROW = '@kid stopped';
const sizes = [
  { name: '360', ctx: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }, tap: true },
  { name: 'desktop', ctx: { viewport: { width: 1280, height: 800 } }, tap: false },
];
for (const size of sizes) {
  const tag = `${size.name}-light`;
  const ctx = await browser.newContext({ ...size.ctx, colorScheme: 'light' });
  if (testHuman) await ctx.route(`${origin}/api/**`, (r) => r.request().method() === 'GET' ? r.continue() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  const press = (loc) => (size.tap ? loc.tap() : loc.click());
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  // The phone shows one pane at a time, so it takes the Mail tab; the desktop keeps the list in view.
  const nav = p.locator('[data-nav="mail"]');
  // On the phone the Inbox page lists the ask as its thread's row, with the ITSA's chip; the desktop keeps the sidebar list.
  const onPhone = await nav.isVisible();
  if (onPhone) await press(nav);
  const side = onPhone ? '#inbox-view' : '#mail-side';
  const att = onPhone ? p.locator(`#inbox-view .mrow:has([data-chip="itsa"][title="${ask.title}"])`).first() : p.locator(`#mail-side .mrow[data-att-itsa="${ask.id}"]`);
  await att.waitFor();
  const rowLine = await att.locator('[data-ask-block]').innerText().catch(() => 'none');
  check(tag, rowLine === ROW, 'the ask row shows its short blocking line', rowLine);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/ask-block-mail-${tag}.png` });
  // The dialog's row: a pending dialog stops kid, shown in short form on its row.
  const dialogRow = p.locator(`${side} .mrow[title*="asks to use Read"]`).filter({ has: p.locator('[data-ask-block]') }).first();
  const dialogRowLine = await dialogRow.locator('[data-ask-block]').innerText().catch(() => 'none');
  check(tag, dialogRowLine === ROW, 'the dialog row shows its short blocking line', dialogRowLine);
  await press(att);
  // The ask's bar: in the ITSA's header, or in the ask thread's view when the ask sits in another thread.
  const bar = p.locator('[data-itsa-ask] [data-ask-block]').first();
  await bar.waitFor();
  const barLine = await bar.innerText();
  check(tag, barLine === LINE, 'the ask bar shows the blocking line', barLine);
  const box = await bar.boundingBox();
  check(tag, !!box && box.x + box.width <= p.viewportSize().width, 'the line fits the width', box);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/ask-block-bar-${tag}.png` });
  // The dialog's thread: its approval bar names kid as stopped. On the phone the list is hidden
  // while the ITSA shows, so the check goes back to the Mail tab first.
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { state: 'attached', timeout: 20000 });
  if (onPhone) await press(nav);
  await dialogRow.waitFor();
  await press(dialogRow);
  const dialogBar = p.locator('[data-perm-pending] [data-ask-block]').first();
  await dialogBar.waitFor();
  const dialogBarLine = await dialogBar.innerText();
  check(tag, dialogBarLine === '@kid is stopped until you answer', 'the dialog bar names the stopped agent', dialogBarLine);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/ask-block-dialog-${tag}.png` });
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
