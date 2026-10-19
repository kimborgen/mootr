// A thread reply advances to the next mail only once the daemon accepts it (S-509), checked by
// touch at 360 px: a draft set aside, a refused send, and a slow send with a draft typed while it
// waits. The slow and refused sends are held or refused by the check (route), so the daemon sees
// nothing it doesn't get; the draft and the accepted reply are real. Needs a test daemon (daemon.sh).
//   node web/check/reply-advance.mjs BASE_URL OUT_DIR
// Screenshots: OUT_DIR/reply-advance-<step>.png. Prints one line per check; exits 1 if any failed.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { findPlaywright } from './find-playwright.mjs';
import { mkdirSync } from 'node:fs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node reply-advance.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });

const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const browser = await chromium.launch(chromiumLaunchOptions());
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} [360-light] ${name}${detail ? ': ' + String(detail).slice(0, 200) : ''}`); };

const archived = async () => (await fetch(`${u.origin}/api/agents/human/threads?limit=60&archived=1`, { headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } }).then((r) => r.json())).map((x) => x.thread_id);
const rows = (p) => p.locator('.cmp-outbox .ob-row').evaluateAll((els) => els.map((e) => e.className.replace('ob-row ', '')));

// Opens the mail list, then the thread at `index` (the second row is below the first, so the next one exists).
// A fresh browser context per step, so the page opens on the mail list and not the thread it had.
async function freshPage() {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 740 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  await p.goto(base);
  await p.waitForTimeout(1500);
  return p;
}
async function openThread(p, index) {
  await p.locator('[data-nav="mail"]').tap();
  await p.waitForTimeout(400);
  const tid = await p.locator('#mail-side .mrow[data-thread]:not([data-decision])').nth(index).getAttribute('data-thread');
  await p.locator(`.mrow[data-thread="${tid}"]`).tap();
  await p.waitForSelector('.thread-view:visible .msg', { timeout: 10000 });
  await p.waitForTimeout(400);
  return tid;
}
const shown = (p) => p.locator('.pane .tab.active').getAttribute('data-key');
const ta = (p) => p.locator('.thread-reply textarea:visible');

// 1. A draft set aside: the thread stays, nothing archives.
{
  const p = await freshPage();
  const tid = await openThread(p, 1);
  await ta(p).tap(); await ta(p).fill('Draft, not sent yet.');
  await p.locator('.thread-reply .cmp-draft:visible').tap();
  await p.waitForTimeout(1200);
  check('a draft keeps the thread open', (await shown(p)) === 'thread:' + tid, await shown(p));
  check('and the thread is not archived', !(await archived()).includes(tid));
  check('and its draft row shows', (await rows(p)).includes('draft'), (await rows(p)).join());
  await p.screenshot({ path: `${out}/reply-advance-draft.png` });
  await p.context().close();
}

// 2. A refused send: the thread stays, the failed row shows.
{
  const p = await freshPage();
  const tid = await openThread(p, 2);
  let posts = 0;
  await p.route('**/api/mail', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++;
    return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"refused by the check"}' });
  });
  await ta(p).tap(); await ta(p).fill('Refused by the check.');
  await p.locator('.thread-reply .cmp-send:visible').tap();
  await p.waitForTimeout(1200);
  await p.unroute('**/api/mail');
  check('a refused send is tried once', posts === 1, posts);
  check('a refused send keeps the thread open', (await shown(p)) === 'thread:' + tid, await shown(p));
  check('and the thread is not archived', !(await archived()).includes(tid));
  check('and its failed row shows', (await rows(p)).includes('failed'), (await rows(p)).join());
  await p.screenshot({ path: `${out}/reply-advance-failed.png` });
  await p.context().close();
}

// 3. A slow send, with a draft typed while it waits: the thread stays after the reply is accepted.
{
  const p = await freshPage();
  const tid = await openThread(p, 3);
  let release;
  const gate = new Promise((r) => { release = r; });
  await p.route('**/api/mail', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await gate;
    return route.fallback();
  });
  await ta(p).tap(); await ta(p).fill('Slow reply.');
  await p.locator('.thread-reply .cmp-send:visible').tap();
  await p.waitForTimeout(400);
  check('a slow send stays pending, and the thread stays open', (await rows(p)).includes('pending') && (await shown(p)) === 'thread:' + tid);
  await ta(p).tap(); await ta(p).fill('Draft while the reply waits.');
  await p.locator('.thread-reply .cmp-draft:visible').tap();
  await p.waitForTimeout(400);
  release();
  await p.waitForTimeout(2500);
  await p.unroute('**/api/mail');
  check('once accepted, the thread stays open while a draft waits', (await shown(p)) === 'thread:' + tid, await shown(p));
  check('and it is not archived', !(await archived()).includes(tid));
  check('the draft row is still there', (await rows(p)).includes('draft'), (await rows(p)).join());
  await p.screenshot({ path: `${out}/reply-advance-draft-after-accept.png` });
  await p.context().close();
}

await browser.close();
process.exit(failed ? 1 : 0);
