// The boot shell: the built page with its JS bundle held back, so the shell is what shows.
// Needs no daemon. Serves web/dist itself and holds every module script until RELEASE_MS passes.
//   node web/check/boot.mjs OUT_DIR
// Screenshots: OUT_DIR/boot-<size>-<theme>.png, at 360 and 1280 px, light and dark.
import { createServer } from 'node:http'
import { readFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { chromiumLaunchOptions } from './chromium-launch.mjs'
import { findPlaywright } from './find-playwright.mjs'

const { chromium } = findPlaywright()
const out = process.argv[2]
if (!out) { console.error('usage: node web/check/boot.mjs OUT_DIR'); process.exit(2) }
mkdirSync(out, { recursive: true })
const dist = join(new URL('..', import.meta.url).pathname, 'dist')
const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const server = createServer((req, res) => {
  const p = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/web\//, ''))
  const f = existsSync(p) && statSync(p).isFile() ? p : join(dist, 'index.html')
  res.writeHead(200, { 'content-type': type[extname(f)] ?? 'application/octet-stream' })
  res.end(readFileSync(f))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/web/`
const browser = await chromium.launch(chromiumLaunchOptions())
const sizes = [['360', 360, 740], ['desktop', 1280, 800]]
let failed = 0
try {
  for (const [name, width, height] of sizes) for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.addInitScript((t) => localStorage.setItem('stam/theme', t), theme)
    // Hold the bundle: the shell must be what the viewer sees while the JS is still on its way.
    await page.route(/\/web\/assets\/.*\.js$/, () => {})
    await page.goto(base, { waitUntil: 'commit' })
    await page.waitForSelector('.boot')
    const shell = await page.locator('.boot').count()
    const mark = await page.locator('.boot-mark').isVisible()
    const nav = await page.locator('.boot-nav').isVisible()
    const side = await page.locator('.boot-side').isVisible()
    const ok = shell === 1 && mark && (name === '360' ? nav && !side : side && !nav)
    console.log(`${ok ? 'ok  ' : 'FAIL'} boot ${name} ${theme}: shell=${shell} mark=${mark} nav=${nav} side=${side}`)
    if (!ok) failed++
    await page.screenshot({ path: join(out, `boot-${name}-${theme}.png`) })
    await ctx.close()
  }
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
