// Local human login (S-613), on a phone (360 px) and a desktop (1280 px). Run by web/check/locallogin.sh:
//   node web/check/locallogin.mjs URL OUT_DIR      (this user stands in for root: it runs the page's command without sudo)
// Per size: the page with no token shows the login and the command to run (coreutils only, no stam); Log in
// before running it shows the daemon's refusal; after running it the page logs in, the app boots, and a human-only route answers; Settings' Log out returns to the login. No
// horizontal scroll. Screenshots: OUT_DIR/locallogin-<size>-<login|refused|app>.png.
import './chromium-lock.mjs';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const [url, out] = process.argv.slice(2);
if (!out) { console.error('usage: node locallogin.mjs URL OUT_DIR'); process.exit(2); }
// The human's step, as the page shows it, run as this user (the test's stand-in for root) under root's umask.
const vouch = (command) => execSync(`umask 077 && ${command.replace(/(^|&& )sudo /g, '$1')}`, { encoding: 'utf8', shell: '/bin/sh' });
mkdirSync(out, { recursive: true });
const find = (pkg) => {
  for (const dir of [new URL('..', import.meta.url).pathname, process.cwd() + '/']) { try { return createRequire(dir)(pkg); } catch {} }
  throw new Error('playwright-core not found; run npm ci in web');
};
const { chromium } = find('playwright-core');
const shells = (() => { try { return readdirSync(`${homedir()}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() } catch { return [] } })();
const exe = ['chromium_headless_shell-1217', ...shells].map((d) => `${homedir()}/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--disable-dev-shm-usage'] });
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`); if (!ok) failures++; };

const sizes = [['phone', { width: 360, height: 740 }, true], ['desktop', { width: 1280, height: 800 }, false]];
for (const [name, viewport, touch] of sizes) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, colorScheme: 'light' });
  const page = await ctx.newPage();
  const shot = (what) => page.screenshot({ path: `${out}/locallogin-${name}-${what}.png` });
  const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await page.goto(url + '/');
  const shown = await page.waitForSelector('#local-login', { timeout: 15000 }).then(() => true, () => false);
  check(`${name}: the page with no token asks for a code`, shown);
  check(`${name}: the login has no horizontal scroll`, await noScroll());
  await shot('login');
  const command = await page.waitForFunction(() => document.getElementById('local-login-command')?.textContent || '', null, { timeout: 10000 }).then((h) => h.jsonValue(), () => '');
  const cmdOk = /^sudo \/usr\/bin\/install -d -m 755 \/\S+ \/\S+ && sudo \/usr\/bin\/install -m 644 \/dev\/null \/\S+\/[a-z2-7]{26}$/.test(command) && !/(^|\s)stam(\s|$)|PATH=/.test(command);
  check(`${name}: the login shows the coreutils command with a code`, cmdOk, command);
  await page.click('#local-login button[type=submit]');
  const refused = await page.waitForSelector('.local-login-error', { timeout: 10000 }).then((e) => e.textContent(), () => '');
  check(`${name}: Log in before running the command shows the refusal`, /no such code yet/.test(refused ?? ''), refused);
  await shot('refused');
  vouch(command);
  await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => {}), page.click('#local-login button[type=submit]')]);
  const booted = await page.waitForFunction(() => !document.getElementById('local-login') && document.getElementById('root')?.childElementCount, null, { timeout: 15000 }).then(() => true, () => false);
  check(`${name}: the code logs in and the app boots`, booted);
  const status = await page.evaluate(async () => (await fetch('/api/voice', { headers: { authorization: 'Bearer ' + localStorage.getItem('stamToken') } })).status);
  check(`${name}: the session is the human (a human-only route answers)`, status === 200, String(status));
  await shot('app');
  await page.goto(url + '/#view=config');
  const out1 = await page.waitForSelector('#local-logout', { timeout: 15000 }).then(() => true, () => false);
  check(`${name}: Settings offers Log out`, out1);
  if (out1) {
    await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => {}), page.click('#local-logout')]);
    check(`${name}: Log out returns to the login`, await page.waitForSelector('#local-login', { timeout: 15000 }).then(() => true, () => false));
  }
  await ctx.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
