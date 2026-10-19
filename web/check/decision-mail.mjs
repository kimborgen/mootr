// The decision mail row (S-352), in headless Chromium at 360 px light and on desktop, against a
// seeded test daemon (daemon.sh). The agent kid mails the human a pick block; the check finds its
// row pinned in Mail (one row, its thread), screenshots it at both sizes, then has the human reply
// in the thread and checks the row is gone:
//   web/check/run.sh decision-mail
//   node web/check/decision-mail.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/decision-mail-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node decision-mail.mjs BASE_URL OUT_DIR'); process.exit(2); }
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

// kid is a seeded agent (seed.mjs). Its decision mail asks the human to pick, so it waits on them.
const agents = await call('GET', '/api/agents');
const kid = agents.find((a) => a.name === 'kid');
if (!kid) { console.error('no seeded kid agent: restart daemon.sh'); process.exit(2); }
const SUBJECT = 'Which release goes first';
const sent = await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: SUBJECT, body: 'Two releases are ready. Which goes first?\n\n```pick\nthe billing fix\nthe search fix\n```' });
const decisions = await call('GET', '/api/mail/decisions');
const dec = decisions.find((d) => d.mail_id === sent.id);
check('api', !!dec, 'the decision mail is listed', decisions.map((d) => d.subject));

const browser = await chromium.launch(chromiumLaunchOptions());
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
  if (await nav.isVisible()) await press(nav);
  // The row is the decision mail's thread, pinned above the other threads; the thread has one row.
  const row = p.locator(`#mail-side .mrow[data-thread="${dec.thread_id}"]`);
  await row.waitFor();
  check(tag, (await row.count()) === 1, 'the thread has one row', await row.count());
  check(tag, (await row.locator('.s').innerText()) === SUBJECT, 'the row shows the subject', await row.locator('.s').innerText());
  // The waiting marker of the pinned rows: the status slot says decision, and the row takes the waiting style.
  check(tag, (await row.locator('.astat').innerText()) === 'decision', 'the row shows the decision marker', await row.locator('.astat').innerText());
  check(tag, await row.evaluate((el) => el.classList.contains('ask')), 'the row takes the waiting style');
  const box = await row.boundingBox();
  check(tag, !!box && box.x + box.width <= p.viewportSize().width, 'the row fits the width', box);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/decision-mail-${tag}.png` });
  // The human answers in the thread: the row goes.
  if (tag === 'desktop-light') {
    await call('POST', '/api/mail', { from: 'human', to: [kid.id], subject: 'Re: ' + SUBJECT, body: 'The billing fix.', reply_to: sent.id });
    // The thread stays in the list as a plain row: its last message is the human's.
    await p.waitForFunction((tid) => document.querySelector(`#mail-side .mrow[data-thread="${tid}"]`)?.getAttribute('title')?.includes('last from you'), dec.thread_id, { timeout: 15000 });
    const cleared = !(await call('GET', '/api/mail/decisions')).some((d) => d.mail_id === sent.id);
    check(tag, cleared, 'the human reply clears the decision mail');
  }
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
