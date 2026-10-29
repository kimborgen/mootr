// The switch between an agent's terminal and stam's view of its conversation (S-82), and
// the prompt input's measure under a conversation (S-125), in headless Chromium on desktop
// and at 360 px light, against a test daemon with the fake OpenCode, Codex, and Claude Code:
//   OWN_VIEW=1 VIEW_TOGGLE=1 web/check/run.sh viewtoggle
//   node web/check/viewtoggle.mjs BASE_URL OUT_DIR   (a daemon from OWN_VIEW=1 VIEW_TOGGLE=1 daemon.sh)
// Checks the switch swaps in the same pane and is remembered as the agent's own default,
// Settings' default (and handing switched agents back to it),
// that an agent without a view opens in its terminal with no switch, and that a view the
// daemon refuses gives way to the terminal. No model runs. Screenshots: OUT_DIR/*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node viewtoggle.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
const call = (method, path, body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'content-type': 'application/json', ...(testHuman ? { 'x-stam-test-human': testHuman } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const api = (path) => call('GET', path);

let failures = 0;
const check = (tag, ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};
const agents = await api('/api/agents');
const byName = (n) => agents.find((a) => a.name === n);
for (const n of ['oc', 'cx', 'cc', 'kid']) if (!byName(n)) { console.error(`no agent named ${n}: use a daemon from OWN_VIEW=1 VIEW_TOGGLE=1 web/check/daemon.sh`); process.exit(2); }
check('api', !!byName('oc').view && !!byName('cx').view && !!byName('cc').view, 'OpenCode, Codex, and Claude Code agents have a view', agents.map((a) => [a.name, !!a.view]));
// Every harness has a view; an agent has none until its harness has a session to show (a
// Claude Code agent before its transcript, say). The fake's agents all have one at once, so
// the browser is told kid has none, and its view stream answers as the daemon does then.
const kidId = byName('kid').id;
const noView = async (ctx) => {
  await ctx.route((u) => u.origin === origin && u.pathname === '/api/agents', async (r) => {
    const res = await r.fetch();
    const list = (await res.json()).map((a) => (a.id === kidId ? { ...a, view: null } : a));
    await r.fulfill({ response: res, json: list });
  });
  await ctx.route(`${origin}/api/agents/${kidId}/view`, (r) => r.fulfill({ status: 409, json: { error: 'kid has no Claude Code transcript yet' } }));
};
const settings = async () => JSON.parse((await api('/api/config/settings')).text);
const setGlobal = async (v) => { const s = await settings(); s.agentView = { default: v }; await call('POST', '/api/config/settings', { text: JSON.stringify(s, null, 2) + '\n' }); };
const resetDefaults = async () => { for (const n of ['oc', 'cx', 'cc']) await call('PUT', `/api/agents/${byName(n).id}/default-view`, { view: null }); await setGlobal('conversation'); };

const browser = await chromium.launch(chromiumLaunchOptions());
async function open(tag, opts) {
  const ctx = await browser.newContext({ colorScheme: 'light', ...opts });
  await noView(ctx);
  // The view's sends are the human's own; this header stands in for tailscale serve.
  if (testHuman) await ctx.route(`${origin}/api/agents/*/view/*`, (r) => r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  if (testHuman) await ctx.route(`${origin}/api/voice`, (r) => r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  // Settings writes need the human (config-guard, S-230).
  if (testHuman) await ctx.route(`${origin}/api/config/**`, (r) => (r.request().method() === 'GET' ? r.continue() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } })));
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|404|409/.test(m.text())) check(tag, false, 'no console error', m.text()); });
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { state: 'attached', timeout: 20000 });
  await p.waitForTimeout(1000);
  return p;
}
// What the focused pane shows: its id, its active tab, and the switch's choice.
const pane = (p) => p.evaluate(() => {
  const el = document.querySelector('#w-main .pane.focused') ?? document.querySelector('#w-main .pane');
  // A desktop's switch marks the choice that's on; a phone's one button offers the other.
  const on = el?.querySelector('.view-switch [aria-checked=true]');
  const to = el?.querySelector('.view-switch[data-to]')?.dataset.to;
  const sw = on ? on.getAttribute('aria-label') : to ? (to === 'conversation' ? 'Terminal' : 'Conversation') : null;
  return { id: el?.dataset.id, active: el?.querySelector('.pane-body > .view:not([hidden])')?.dataset.key ?? null, sw, hasSwitch: !!el?.querySelector('.view-switch') };
});
const until = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 10000 }).then(() => true, () => false);
const shows = (p, key) => until(p, (k) => document.querySelector('#w-main .pane.focused .pane-body > .view:not([hidden])')?.dataset.key === k, key);

async function run(tag, phone) {
  await resetDefaults();
  const p = await open(tag, phone ? { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } } : { viewport: { width: 1440, height: 900 } });
  const select = async (name) => {
    // On the name: a node's badges (its ITSAs, say) open menus of their own.
    if (phone) { await p.locator('[data-nav="left"]').tap(); await p.waitForTimeout(300); await p.locator(`#tree .node .name:text-is("${name}")`).first().tap(); }
    else await p.locator(`#tree .node .name:text-is("${name}")`).first().click();
    await p.waitForTimeout(500);
  };
  const press = (label) => (phone ? p.locator(`#w-main .pane.focused .view-switch[data-to="${label.toLowerCase()}"]`).tap() : p.locator(`#w-main .pane.focused .view-switch [aria-label="${label}"]`).click());
  const shot = (name) => p.screenshot({ path: `${out}/${tag === 'desktop' ? 'desktop' : '360-light'}-${name}.png` });
  const oc = byName('oc').id, cx = byName('cx').id, cc = byName('cc').id, kid = byName('kid').id;

  // Settings' default is the conversation (S-173): oc opens in it, with the switch above it.
  await select('oc');
  check(tag, await shows(p, 'view:' + oc), 'an agent opens in its conversation by default');
  await press('Terminal');
  check(tag, await shows(p, 'agent:' + oc), 'and the switch goes to its terminal');
  const t = await pane(p);
  check(tag, t.sw === 'Terminal', 'the switch shows, on Terminal', t);
  if (phone) {
    const sizes = await p.locator('#w-main .pane.focused .view-switch').evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }));
    check(tag, sizes.length === 1 && sizes.every((s) => s >= 43.5), 'the switch is one button, at least 44 px', sizes);
    const label = await p.locator('#w-main .pane.focused .tab.active .label').evaluate((l) => l.scrollWidth > 0 && l.clientWidth >= Math.min(l.scrollWidth, 24));
    check(tag, label, 'the agent\'s tab keeps its name in sight');
    const sw = await p.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth);
    check(tag, sw, 'no sideways scroll');
  }
  await shot('switch-terminal');

  // The switch swaps in place: same pane, the conversation instead of the terminal.
  await press('Conversation');
  check(tag, await shows(p, 'view:' + oc), 'Conversation shows the conversation');
  const c = await pane(p);
  check(tag, c.id === t.id && c.sw === 'Conversation', 'in the same pane, with the switch on Conversation', { before: t, after: c });
  const tabs = await p.locator('#w-main .tab').evaluateAll((ts) => ts.map((x) => x.dataset.key));
  check(tag, !tabs.includes('agent:' + oc), 'the terminal tab gave way rather than staying beside it', tabs);
  await p.waitForSelector('.ov .ov-msg');
  await p.waitForTimeout(500);
  // S-125: the prompt input takes the conversation's measure, centred, on a desktop; full width on a phone.
  const m = await p.evaluate(() => {
    const cmp = document.querySelector('#w-bottom .composer').getBoundingClientRect(), bar = document.querySelector('#w-bottom').getBoundingClientRect();
    const col = document.querySelector('.ov-scroll > .ov-col').getBoundingClientRect();
    return { w: cmp.width, colW: col.width, left: cmp.left - bar.left, right: bar.right - cmp.right, barW: bar.width, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  });
  if (phone) check(tag, m.w >= m.barW - 40, 'the prompt input stays full width', m);
  else check(tag, m.w <= 48 * m.rem + 1 && Math.abs(m.left - m.right) < 4 && Math.abs(m.w - m.colW) < 2, 'the prompt input takes the conversation\'s measure, centred', m);
  await p.locator('.ov-msg[data-id="msg_seed0053"]').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(300);
  await shot('switch-conversation');
  await shot('opencode');

  // The switch remembers: what the human picked becomes the agent's own default.
  const own = async () => (await api('/api/agents')).find((a) => a.id === oc)?.default_view;
  const settle = async (v) => { for (let i = 0; i < 20 && (await own()) !== v; i++) await p.waitForTimeout(100); return (await own()) === v; };
  check(tag, await settle('conversation'), 'switching to Conversation makes it the agent\'s own default');
  await press('Terminal');
  check(tag, await shows(p, 'agent:' + oc), 'Terminal shows the terminal again');
  check(tag, (await pane(p)).id === t.id, 'still in the same pane');
  check(tag, await settle('terminal'), 'and switching back remembers the terminal');
  await press('Conversation');
  await settle('conversation');
  await select('kid');
  await select('oc');
  check(tag, await shows(p, 'view:' + oc), 'selecting the agent again opens what was last picked');

  // Settings' default: Conversation, from Settings › Agent view.
  if (phone) { await p.locator('[data-nav="left"]').tap(); await p.waitForTimeout(300); await p.locator('#open-config').tap(); }
  else await p.locator('#open-config').click();
  await p.waitForTimeout(300);
  await p.locator('.settings-nav .item', { hasText: 'Agent view' }).click();
  await p.locator('.choice', { hasText: 'Conversation' }).click();
  await p.waitForTimeout(500);
  check(tag, (await settings()).agentView?.default === 'conversation', 'Settings saves the default');
  check(tag, /oc \(conversation\)/.test(await p.locator('.settings-inner').innerText()), 'Settings lists the agents with their own choice');
  await shot('settings');
  // Settings can hand switched agents back to its default.
  await p.locator('.settings-inner button', { hasText: 'Use this default for them too' }).click();
  check(tag, await settle(null), 'Use this default for them too clears the agents\' own choice');

  // Every harness opens in its conversation now; one without a view, in its terminal.
  await select('cx');
  check(tag, await shows(p, 'view:' + cx), 'a Codex agent opens in its conversation');
  await p.waitForSelector('.ov .ov-msg[data-id="m-1"] .mb-tests', { state: 'attached' }).then(() => check(tag, true, 'the Codex reply\'s tests block renders'), () => check(tag, false, 'the Codex reply\'s tests block renders'));
  await p.waitForTimeout(300);
  await shot('codex');
  await select('cc');
  check(tag, await shows(p, 'view:' + cc), 'a Claude Code agent opens in its conversation');
  await until(p, () => !!document.querySelector('.ov .ov-tool') && !!document.querySelector('.ov .mb-callout'))
    .then((ok) => check(tag, ok, 'the Claude Code exchange shows its tool call and the reply\'s callout'));
  await p.waitForTimeout(300);
  await shot('claude');
  await select('kid');
  check(tag, await shows(p, 'agent:' + kid), 'an agent without a view opens in its terminal');
  check(tag, !(await pane(p)).hasSwitch, 'and has no switch');

  // A view the daemon refuses gives way to the terminal (here, put there by an agent's op).
  await call('POST', '/api/layout/ops', { ops: [{ op: 'swap', world: kid, key: 'agent:' + kid, with: 'view:' + kid }] });
  check(tag, await shows(p, 'agent:' + kid), 'a refused view falls back to the terminal');
  await p.context().close();
}

await run('desktop', false);
await run('360-light', true);
await resetDefaults();
await browser.close();
console.log(failures ? `FAIL: ${failures} view switch check(s)` : 'PASS: view switch checks');
process.exit(failures ? 1 : 0);
