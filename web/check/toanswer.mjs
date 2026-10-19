// The To answer tab (S-984), in headless Chromium at 360 px light and on desktop, against a seeded test
// daemon (daemon.sh): the inbox list has no plain "agent waits" row, To answer lists a pending pick mail
// (opening its thread), and answering it removes it.
//   web/check/run.sh toanswer
//   node web/check/toanswer.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/toanswer-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node toanswer.mjs BASE_URL OUT_DIR'); process.exit(2); }
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


// kid is a seeded agent (seed.mjs). Its pick mail waits on the human; the To answer tab lists it, and it
// leaves once the human answers it.
const agents = await call('GET', '/api/agents');
const kid = agents.find((a) => a.name === 'kid');
if (!kid) { console.error('no seeded kid agent: restart daemon.sh'); process.exit(2); }
const SUBJECT = 'Which release ships first';
const sent = await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: SUBJECT, body: 'Two releases are ready. Which ships first?\n\n```pick\nthe billing fix\nthe search fix\n```' });
// A plain question: kid mails it, then waits for the human's reply in its thread. Its row is the thread, not the chat.
const QSUBJECT = 'Should the rollout wait for Friday';
const question = await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: QSUBJECT, body: 'Do you want to hold the rollout until Friday?' });
await call('POST', `/api/agents/${kid.id}/waits/declared`, { on: 'human', thread: question.ask_mail_id ?? question.id, note: 'your reply on the rollout date', by: kid.id });

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
  const nav = p.locator('[data-nav="mail"]');
  if (await nav.isVisible()) await press(nav);
  const list = p.locator('#mail-side .mail-side-list');
  await list.waitFor();
  check(tag, (await list.locator('[data-waiting]').count()) === 0, 'the inbox list holds no plain "agent waits for your reply" row');
  // The four view toggles sit on their own row and never clip or overlap: on a desktop each lies inside
  // #mail-side; on a phone the row scrolls, so each must lie inside the row's scrollable width.
  const geo = await p.evaluate(() => {
    const side = document.querySelector('#mail-side').getBoundingClientRect();
    const row = document.querySelector('#mail-side .mail-views');
    const rr = row.getBoundingClientRect();
    const boxes = [...row.querySelectorAll('.mail-toggle')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), l: r.left, r: r.right, top: r.top, b: r.bottom }; });
    const title = document.querySelector('#mail-side .section').getBoundingClientRect();
    return { side: { l: side.left, r: side.right }, row: { l: rr.left, r: rr.right, top: rr.top, scrollW: row.scrollWidth, clientW: row.clientWidth }, boxes, titleBottom: title.bottom };
  });
  check(tag, geo.boxes.length === 4, 'four view toggles', geo.boxes.map((b) => b.t));
  check(tag, geo.boxes.every((b, i) => i === 0 || b.l >= geo.boxes[i - 1].r - 0.5 || b.top >= geo.boxes[i - 1].b - 0.5), 'the toggles do not overlap', geo.boxes);
  check(tag, geo.row.top >= geo.titleBottom - 0.5, 'the toggles sit below the title row', geo);
  if (size.tap) check(tag, geo.row.scrollW >= geo.boxes.at(-1).r - geo.row.l && geo.row.scrollW >= geo.row.clientW, 'the phone toggle row scrolls to its last toggle', geo.row);
  else check(tag, geo.boxes.every((b) => b.l >= geo.side.l && b.r <= geo.side.r), 'every toggle lies inside the mail side', geo);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/toanswer-inbox-${tag}.png` });
  const toggle = p.locator('#mail-side [data-to-answer]');
  check(tag, /^To answer \(\d+\)$/.test((await toggle.innerText()).trim()), 'the To answer button shows its count', await toggle.innerText());
  await press(toggle);
  const row = list.locator(`.mrow[data-thread="${sent.thread_id}"]`);
  await row.waitFor();
  check(tag, (await row.locator('.s').innerText()) === SUBJECT, 'To answer lists the pick mail, opening its thread, not the chat');
  const qrow = list.locator(`.mrow[data-thread="${question.thread_id}"]`);
  await qrow.waitFor();
  check(tag, (await qrow.locator('.s').innerText()) === QSUBJECT, 'a wait tied to a mail thread is that thread\'s row');
  check(tag, (await list.locator('[data-waiting]', { hasText: 'your reply on the rollout date' }).count()) === 0, 'To answer has no chat-opening row for the thread-tied wait');
  const box = await row.boundingBox();
  check(tag, !!box && box.x + box.width <= p.viewportSize().width, 'the row fits the width', box);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/toanswer-items-${tag}.png` });
  // Answering it removes it.
  if (tag === 'desktop-light') {
    await call('POST', '/api/mail', { from: 'human', to: [kid.id], subject: 'Re: ' + SUBJECT, body: '> Which ships first?\n\nChose **the billing fix**.', reply_to: sent.id });
    await row.waitFor({ state: 'detached', timeout: 15000 });
    check(tag, true, 'answering the mail removes it from To answer');
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}/toanswer-after-${tag}.png` });
  }
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
