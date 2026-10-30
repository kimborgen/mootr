// The requirements poll on a phone (S-4609): with requirements on, nothing is read while the Agents tab is
// open, and opening the Issues tab reads the flag at once, not on the next 8 s tick. Counts the reads of
// GET /api/req-enabled. Needs a throwaway daemon (daemon.sh) and costs nothing.
//   node web/check/reqpoll.mjs BASE_URL OUT_DIR
import './chromium-lock.mjs'
import { chromiumLaunchOptions } from './chromium-launch.mjs'
import { mkdirSync } from 'node:fs'
import { findPlaywright } from './find-playwright.mjs'

const [base, out] = process.argv.slice(2)
if (!base || !out) { console.error('usage: node web/check/reqpoll.mjs BASE_URL OUT_DIR'); process.exit(2) }
mkdirSync(out, { recursive: true })
const { chromium } = findPlaywright()
const u = new URL(base)
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? ''
// The test key stands in for tailscale serve, the only proof of the human for settings writes (daemon.sh's testHuman=).
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? ''
const api = (path, init) => fetch(u.origin + path, { ...init, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'x-stam-test-human': testHuman, 'content-type': 'application/json' } }).then((r) => r.json())

let failed = 0
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++ }
// Waits for a state, up to `ms`; true when it held.
const until = async (page, fn, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await page.waitForTimeout(50) }
  return fn()
}

const before = JSON.parse((await api('/api/config/settings')).text)
const requirements = (enabled) => api('/api/config/settings', { method: 'POST', body: JSON.stringify({ text: JSON.stringify({ ...before, requirements: { ...(before.requirements ?? {}), enabled, approval: 'human' } }, null, 2) }) })
const browser = await chromium.launch(chromiumLaunchOptions())
try {
  await requirements(false)
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, colorScheme: 'light' })
  const page = await ctx.newPage()
  let reads = 0
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/req-enabled') reads++ })
  await page.goto(base)
  await page.locator('[data-nav="left"]').tap()
  await page.locator('#w-left.phone-left').waitFor({ timeout: 15000 })

  // Requirements turn on while Agents is open: the section is off screen, so the poll reads nothing.
  reads = 0
  await requirements(true)
  // A quiet window longer than one 8 s tick: a poll that ignored the section would read here.
  await page.waitForTimeout(9000)
  check(reads === 0, `Agents open with requirements on: no flag read in 9 s (got ${reads})`)

  // Each opening of Issues reads the flag within a second, not on the next tick.
  for (let cycle = 1; cycle <= 3; cycle++) {
    const seen = reads
    await page.locator('[data-nav="issues"]').tap()
    const read = await until(page, () => reads > seen, 1000)
    check(read, `Issues shown, cycle ${cycle}: the flag is read within 1 s (reads ${seen} -> ${reads})`)
    await page.locator('#req-side').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('[data-nav="left"]').tap()
    await page.locator('#w-left.phone-left').waitFor({ timeout: 5000 })
  }

  // Back on Agents, the poll stops again.
  reads = 0
  await page.waitForTimeout(9000)
  check(reads === 0, `Agents open again: no flag read in 9 s (got ${reads})`)
  await page.screenshot({ path: `${out}/reqpoll-phone-agents.png` })
  await ctx.close()
} finally {
  await requirements(before.requirements?.enabled ?? false)
  await browser.close()
}
process.exit(failed ? 1 : 0)
