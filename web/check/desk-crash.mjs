// The Agents desk's header steps (S-3489) on a test daemon: node desk-crash.mjs BASE_URL OUT_DIR
// The crash was width-driven: at some desk widths the header's step up and step back alternated, and React stopped the page
// ("Couldn't show this view", error #185). This loads the page fresh at the widths that crashed, then resizes in place from 1440
// down to 761 px one pixel at a time (at 760 px and below the page is the phone list, which has no desk table), and fails if the crash text shows at any of them. Run it with SEED_PHONE_LIST=1
// (web/check/run.sh desk-crash). Prints one line per check; exits 1 on a fail.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node desk-crash.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium } = findPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const origin = new URL(base).origin;
const token = new URLSearchParams(new URL(base).hash.slice(1)).get('token') ?? '';
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };
const CRASH = "Couldn't show this view";
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
const p = await ctx.newPage();
p.setDefaultTimeout(20000);
p.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
const open = async (w) => {
  await p.setViewportSize({ width: w, height: 900 });
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('[data-nav="left"], .agents-desk, #tree', { timeout: 30000 }).catch(() => {});
  await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:agents'));
  await p.waitForTimeout(800);
};

// The desk is drawn when its table is in the page and the crash text is not: a blank page is a failure too.
const drawn = () => p.locator('section.agents-desk table.agents-table').count().then((n) => n === 1);

// Fresh loads at the widths the crash was seen at.
const fresh = [1130, 1129, 1120];
const freshCrashed = [];
const freshBlank = [];
for (const w of fresh) {
  await open(w);
  if (await p.getByText(CRASH).count()) freshCrashed.push(w);
  else if (!(await drawn())) freshBlank.push(w);
}
check(`a fresh load at ${fresh.join(', ')} px draws the desk`, freshCrashed.length === 0 && freshBlank.length === 0,
  [freshCrashed.length ? `crashed at ${freshCrashed.join(', ')}` : '', freshBlank.length ? `no table at ${freshBlank.join(', ')}` : ''].filter(Boolean).join('; '));

// One resize in place from 1440 down to 761 px, one pixel at a time.
await open(1440);
const crashed = [];
const blank = [];
for (let w = 1440; w >= 761; w--) {
  await p.setViewportSize({ width: w, height: 900 });
  await p.waitForTimeout(120);
  if (await p.getByText(CRASH).count()) { crashed.push(w); await p.screenshot({ path: `${out}/crash-${w}.png` }); break; }
  if (!(await drawn())) { blank.push(w); await p.screenshot({ path: `${out}/blank-${w}.png` }); break; }
}
check('the desk never shows "Couldn\'t show this view" from 1440 down to 761 px', crashed.length === 0, crashed.length ? `crashed at ${crashed[0]} px` : '');
check('the desk has its table at every step from 1440 down to 761 px', blank.length === 0, blank.length ? `no table at ${blank[0]} px` : '');
await browser.close();
console.log(failed ? `${failed} failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
