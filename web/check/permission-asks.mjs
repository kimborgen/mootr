// Answered requests leave Mail's "waiting on you" (S-609), in headless Chromium at 360 px, light and
// dark, against a seeded test daemon (daemon.sh). The agent kid asks the human for two permissions
// and adds its own wait_for human about them, as @allow-rules did; the human answers both requests.
// The check screenshots Mail and finds no row for them, and the waiting count back where it was:
//   web/check/run.sh permission-asks
//   node web/check/permission-asks.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/permission-asks-360-{light,dark}.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node permission-asks.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
const humanHeaders = testHuman ? { 'x-stam-test-human': testHuman } : {};
// A write that names kid (agent, by, or its waits path) goes with kid's own token (daemon.sh's agents=, S-545).
const agentTokens = JSON.parse(new URLSearchParams(u.hash.slice(1)).get('agents') || '{}');
const ownToken = (path, body) => agentTokens[body?.by ?? body?.agent] || agentTokens[path.match(/^\/api\/agents\/([\w-]+)\/waits\//)?.[1]];
const call = (method, path, body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + (ownToken(path, body) || token), ...(ownToken(path, body) ? {} : { 'x-stam-human': '1', ...humanHeaders }), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

let failures = 0;
const check = (tag, ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};

const agents = await call('GET', '/api/agents');
const kid = agents.find((a) => a.name === 'kid');
if (!kid) { console.error('no seeded kid agent: restart daemon.sh'); process.exit(2); }
async function act() {
  const ask = (action) => call('POST', '/api/permissions', { agent: kid.id, action, reason: 'auto mode blocks it', details: '', audience: 'human' });
  const waitFor = (note) => call('POST', `/api/agents/${kid.id}/waits/declared`, { on: 'human', by: kid.id, note, timeout_minutes: 120 });
  const r1 = await ask('Commit the allow rules');
  await waitFor('auto-mode block on commit; and PR #128 merge running in background');
  await waitFor(`answer to ${r1.id} (commit of allow rules)`);
  const r2 = await ask('Merge PR #129');
  await waitFor(`merge authorization for PR #129 (${r2.id})`);
  for (const r of [r1, r2]) {
    const a = await call('POST', `/api/permissions/${r.id}/answer`, { approve: true, note: 'I authorize' });
    check('api', a.status === 'approved', `the human approves ${r.id}`, a);
  }
  // The seed's own wait on the human (your reply on the deploy) stays; kid's waits about the requests go.
  const left = (await call('GET', `/api/agents/${kid.id}/waits`)).filter((w) => w.kind === 'human' && /auto-mode|answer to|merge authorization/.test(w.detail ?? '')).map((w) => w.detail);
  check('api', left.length === 0, 'no wait about the requests is left', left);
}

// The number in the Inbox page's "N to answer" (what waits on you), 0 without one.
const waitingCount = async (p) => Number((await p.locator('#inbox-view').innerText()).match(/(\d+) to answer/)?.[1] ?? 0);
let baseline = 0;
const browser = await chromium.launch(chromiumLaunchOptions());
for (const theme of ['light', 'dark']) {
  const tag = `360-${theme}`;
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 740 }, colorScheme: theme });
  if (testHuman) await ctx.route(`${origin}/api/**`, (r) => r.request().method() === 'GET' ? r.continue() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); } catch {} }, theme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  const nav = p.locator('[data-nav="mail"]');
  if (await nav.isVisible()) await nav.tap();
  await p.waitForSelector('#inbox-view');
  // The list has loaded its rows.
  await p.waitForFunction(() => document.querySelectorAll('#inbox-view .mrow').length > 0, null, { timeout: 15000 });
  await p.waitForTimeout(1500);
  // The seed has its own asks: what waits on you before kid asks is what waits after the answers.
  if (theme === 'light') {
    baseline = await waitingCount(p);
    await act();
    // Both answered requests' threads show as rows, and the toast of the new request (3.5 s) is gone.
    await p.waitForFunction(() => [...document.querySelectorAll('#inbox-view .mrow')].filter((r) => /Permission: (Merge PR #129|Commit the allow)/.test(r.title ?? '')).length === 2, null, { timeout: 20000 });
    await p.waitForTimeout(4500);
  }
  // A row shows only its topic chip (S-1075): the full subject is on its title attribute.
  const side = (await p.locator('#inbox-view').innerText()) + '\n' + (await p.locator('#inbox-view .mrow').evaluateAll((rs) => rs.map((r) => r.title).join('\n')));
  check(tag, (await waitingCount(p)) === baseline, `The Inbox counts ${baseline} to answer, as before the asks`, side.split('\n').filter((l) => /to answer|waiting/.test(l)));
  for (const note of ['auto-mode block on commit', 'answer to ', 'merge authorization']) check(tag, !side.includes(note), `no row for "${note}"`);
  const badge = await p.locator('[data-nav="mail"] .badge.warn').allInnerTexts();
  check(tag, Number(badge[0] ?? 0) === baseline, `the Mail tab's waiting badge is ${baseline}`, badge);
  await p.screenshot({ path: `${out}/permission-asks-${tag}.png` });
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
