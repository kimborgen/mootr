// The launch options every Chromium check passes to chromium.launch. The newest headless shell
// Playwright installed (chromium_headless_shell-N, whatever N is) is used, so a check doesn't
// hardcode a revision the machine may not have.
// Import it after chromium-lock.mjs.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

// PLAYWRIGHT_BROWSERS_PATH is Playwright's own override of where `npm run install:chromium` puts it.
const CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? process.env.PLAYWRIGHT_BROWSERS_PATH : `${homedir()}/.cache/ms-playwright`;
const SHELL = 'chrome-headless-shell-linux64/chrome-headless-shell';

// The newest chromium_headless_shell-N with a shell binary, by revision number; undefined if none.
export function chromiumExe() {
  let revs = [];
  try { revs = readdirSync(CACHE).filter((d) => /^chromium_headless_shell-\d+$/.test(d)); } catch {}
  revs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return revs.map((d) => `${CACHE}/${d}/${SHELL}`).find(existsSync);
}

export function chromiumLaunchOptions() {
  return { executablePath: chromiumExe() };
}
