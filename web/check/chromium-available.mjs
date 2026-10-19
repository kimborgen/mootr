// Exits 0 if a Chromium the checks can launch is installed, 1 if not (test/run.sh skips the UI
// tests then), printing why on stdout: no web/node_modules (npm run setup), or no Chromium
// (npm run install:chromium).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromiumExe } from './chromium-launch.mjs';

if (chromiumExe()) process.exit(0);
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright-core'));
} catch {
  console.log("web/node_modules isn't installed (run: npm run setup)");
  process.exit(1);
}
// Playwright's own default, for an install in a custom PLAYWRIGHT_BROWSERS_PATH or by version.
if (existsSync(chromium.executablePath())) process.exit(0);
console.log("Playwright's Chromium isn't installed (run: npm run install:chromium)");
process.exit(1);
