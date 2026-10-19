// playwright-core for the checks: web's own devDependency first, then the repo root's node_modules.
// Nothing outside this checkout is searched, so a clone that has run `npm run setup` runs the checks as-is.
import { createRequire } from 'node:module';

const roots = [new URL('..', import.meta.url), new URL('../../', import.meta.url)];
export function findPlaywright() {
  for (const dir of roots) {
    try { return createRequire(dir)('playwright-core'); } catch {}
  }
  throw new Error('playwright-core not found in web/node_modules or node_modules; run `npm run setup` in the repo root (then `npm run install:chromium` for the browser)');
}
