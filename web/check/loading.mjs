// The loading marks: the mail and Issues lists show the animated stam-logo loader (S-1451) while
// their first load is held back, then the rows (or the empty state) once it arrives. On the desktop
// it also checks the motion: every keyframe moves only transform or opacity, the arc turns, and
// under reduced motion the turn is still while the arc's breathe runs on. The held requests are the human's
// threads and the ITSA list; both wait HOLD_MS on a Playwright route, then go to the daemon.
// Needs a throwaway daemon (daemon.sh) and costs nothing.
//   node web/check/loading.mjs BASE_URL OUT_DIR
// Screenshots: OUT_DIR/loading-<size>-<theme>-<step>.png, at 360 and 1280 px, light and dark.
import './chromium-lock.mjs'
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { findPlaywright } from './find-playwright.mjs'

const [base, out] = process.argv.slice(2)
if (!base || !out) { console.error('usage: node web/check/loading.mjs BASE_URL OUT_DIR'); process.exit(2) }
const { chromium } = findPlaywright()
mkdirSync(out, { recursive: true })
const HOLD_MS = 3000
const browser = await chromium.launch(chromiumLaunchOptions())
let failed = 0
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++ }
// The loader's motion, once it has faded in: only transform and opacity animate, and the arc's
// computed transform moves between two samples (so it really turns, not just sits there).
const motion = async (page, tag) => {
  await page.locator('#mail-side .stam-loader').evaluate((el) => new Promise((r) => {
    const done = () => getComputedStyle(el).opacity === '1' ? r() : requestAnimationFrame(done); done()
  }))
  const props = await page.evaluate(() => [...new Set(document.querySelector('#mail-side .stam-loader').getAnimations({ subtree: true })
    .flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)))))])
  check(props.length && props.every((p) => p === 'transform' || p === 'opacity'), `motion ${tag}: only transform and opacity animate (${props})`)
  const turn = () => page.evaluate(() => getComputedStyle(document.querySelector('#mail-side .stam-loader-arc')).transform)
  const a = await turn()
  await page.waitForFunction((t) => getComputedStyle(document.querySelector('#mail-side .stam-loader-arc')).transform !== t, a, { timeout: 2000 }).catch(() => {})
  const b = await turn()
  check(a !== b, `motion ${tag}: the arc turns (${a} -> ${b})`)
}
try {
  for (const [name, width, height] of [['360', 360, 740], ['desktop', 1280, 800]]) for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
    const page = await ctx.newPage()
    await page.addInitScript((t) => localStorage.setItem('stam/theme', t), theme)
    // Hold the human's threads and the ITSA list, then let them through.
    const hold = (route) => new Promise((r) => setTimeout(r, HOLD_MS)).then(() => route.continue())
    await page.route(/\/api\/agents\/human\/threads/, hold)
    await page.route(/\/api\/itsas(\?.*)?$/, hold)
    await page.goto(base)
    const tag = `${name}-${theme}`
    const desktop = name === 'desktop'
    await page.waitForTimeout(1000)
    if (desktop) {
      const m = await page.locator('#mail-side .stam-loader').count()
      const i = await page.locator('#issues-side .stam-loader').count()
      check(m === 1 && i === 1, `loading ${tag}: mail and Issues show the loader (${m}, ${i})`)
      await motion(page, tag)
    }
    await page.screenshot({ path: join(out, `loading-${tag}-loading.png`) })
    await page.waitForFunction(() => !document.querySelector('.stam-loader'), null, { timeout: 15000 })
    check(true, `loaded ${tag}: the loaders went away once the lists arrived`)
    await page.screenshot({ path: join(out, `loading-${tag}-loaded.png`) })
    await ctx.close()
  }
  // Reduced motion: the turn, bob and blink zero with the duration tokens; the breathe stays.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.route(/\/api\/agents\/human\/threads/, () => {})
  await page.goto(base)
  await page.locator('#mail-side .stam-loader').waitFor({ timeout: 15000 })
  const r = await page.evaluate(() => {
    const arc = document.querySelector('#mail-side .stam-loader-arc')
    const byName = Object.fromEntries(arc.getAnimations().map((a) => [a.animationName, a.effect.getComputedTiming().duration]))
    const bot = document.querySelector('#mail-side .stam-loader-bot').getAnimations().map((a) => a.effect.getComputedTiming().duration)
    return { turn: byName['stam-loader-turn'], breathe: byName['stam-loader-breathe'], bot }
  })
  // A zero-length loop has no active phase, so the browser may drop it from getAnimations().
  check((r.turn ?? 0) === 0 && r.bot.every((d) => d === 0), `reduced: the turn and bob are still (${r.turn ?? 'none'}, ${r.bot.length ? r.bot : 'none'})`)
  check(r.breathe > 0, `reduced: the arc still breathes (${r.breathe} ms)`)
  await page.screenshot({ path: join(out, 'loading-desktop-reduced.png') })
  await ctx.close()
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
