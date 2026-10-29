// The Agents sidebar's Work columns (S-697) on a realistic tree: 41 agents with long names, nested
// to depth 4, some with no ITSA. With two columns at 300 px (the desktop sidebar) and 360 px (the
// phone) no item of a row may be partly clipped: a meta item shows whole or not at all, the ITSA
// chip drops after the cost never before it, and the row's ... menu stays inside the tree.
// The name wins the row's width (S-1031): it shows all of it, or at least 10 characters, and it is
// cut only once nothing else in the row is left to give way, or when it alone is wider than the row.
// The page's own agents, ITSAs and fields are replaced by route stubs, so it needs a daemon only to
// serve the page.
//   node web/check/sidebar-cols.mjs [BASE_URL OUT_DIR]   without BASE_URL only the synthetic row runs
import './chromium-lock.mjs'
import { chromiumLaunchOptions } from './chromium-launch.mjs'
import { findPlaywright } from './find-playwright.mjs'
import { readFileSync } from 'node:fs'
const [base, out] = process.argv.slice(2)
const origin = base ? new URL(base).origin : ''
const { chromium, devices } = findPlaywright()
const T0 = '2026-10-14T10:00:00.000Z'
const names = ['sb-columns', 'system-view-review2', 'a-rather-long-agent-name-for-reviewing-the-sidebar', 'dev', 'fixture-ops-with-a-name-that-goes-on', 'x']
const agents = [{ id: 'cos', name: 'cos', role: 'chief of staff', chief_of_staff: true, parents: [] }]
for (let i = 0; i < 40; i++) agents.push({ id: 'a' + i, name: names[i % names.length] + '-' + i, role: 'developer', parents: [i < 6 ? 'cos' : i < 24 ? 'a' + (i - 6) : 'a' + (i % 6)], activity: i % 3 ? 'working' : 'idle', cost: { own: { api: 1.23, sub: 0 }, tree: { api: 12.34, sub: 0 }, mode: 'api' } })
// The row's other items change how much room the cost gets: an agent on another machine adds a server icon,
// and unread mail adds a count badge.
const EXTRAS = { none: {}, machine: { machine: 'other' }, unread: { unread: 12 }, both: { machine: 'other', unread: 12 } }
const fullOf = (extra) => agents.map((a) => ({ harness: 'claude', model: 'claude-opus-5-5', lifecycle: 'active', activity: 'idle', machine: 'ui', cwd: '/x', created_at: T0, updated_at: T0, ...a, ...EXTRAS[extra] }))
const full = fullOf('none')
const link = (r, t) => ({ n: 1, system: 'branch', external_id: 'b', url: 'branch:b', meta: { repo: 'r', review: r && { verdict: r, by: 'x', summary: null, at: T0 }, tests: t && { passed: 14, failed: t, skipped: 0, command: null, at: T0 } } })
const itsasOf = (digits) => full.slice(1).filter((a, i) => i % 2).map((a, i) => ({ id: 'i' + i, key: 'S-' + String(10 ** (digits - 1) + i), parent_id: null, kind: 'issue', title: 'T' + i, summary: null, body: null, status: 'in_progress', owner: a.id, thread_id: null, created_by: 'human', created_at: T0, updated_at: T0, closed_at: null, links: i % 4 === 3 ? [] : [link(['approve', 'request_changes', 'comment'][i % 3], i % 5 === 0 ? 2 : 0)], health: i % 6 === 0 ? 'at_risk' : 'on_track', fields: { fp: i % 2 ? 'High' : '', fq: i % 3 ? 'Mid' : '' } }))
const fields = [{ id: 'fq', key: 'fq', label: 'Quarter', type: 'text', options: null, description: null, hint: null, width: 'm', align: 'start', card: 'none', position: 2 }, { id: 'fp', key: 'fp', label: 'Priority', type: 'text', options: null, description: null, hint: null, width: 'm', align: 'start', card: 'none', position: 1 }]


const failures = []
async function run(b, name, device, viewport, cols, digits, extra) {
  const itsas = itsasOf(digits)
  const ctx = await b.newContext({ ...(device ?? {}), viewport })
  const json = (body) => (r) => r.fulfill({ json: body })
  await ctx.route(origin + '/api/agents', json(fullOf(extra)))
  await ctx.route(origin + '/api/itsas', json(itsas))
  await ctx.route(origin + '/api/itsas/fields', json(fields))
  await ctx.route(origin + '/api/config/settings', (r) => r.request().method() === 'GET' ? r.fulfill({ json: { text: JSON.stringify({ sidebarCols: { main: { cols } } }) } }) : r.fulfill({ json: { text: '{}' } }))
  const p = await ctx.newPage()
  await p.goto(base)
  await p.waitForSelector('#tree .node', { timeout: 20000 })
  await p.waitForSelector('#tree[data-cols]', { timeout: 20000 })
  await p.waitForTimeout(1000)
  const r = await p.evaluate(() => {
    const bad = []
    let deep = 0
    // The characters a name shows: a clipped name reports all of its text, so when it doesn't fit,
    // the painted run is the box less the ellipsis, and only the longest prefix that fits is drawn.
    const drawnChars = (el) => {
      const t = el.firstChild
      if (!t || t.nodeType !== 3) return 0
      const cs = getComputedStyle(el)
      let fit = el.clientWidth
      if (el.scrollWidth > el.clientWidth + 1) {
        const s = document.createElement('span')
        s.textContent = '…'
        s.setAttribute('style', `position:absolute;left:-9999px;white-space:pre;font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};letter-spacing:${cs.letterSpacing};font-variant-numeric:${cs.fontVariantNumeric}`)
        el.appendChild(s)
        fit -= s.getBoundingClientRect().width
        s.remove()
      }
      const range = document.createRange()
      for (let i = t.length; i > 0; i--) {
        range.setStart(t, 0); range.setEnd(t, i)
        if (range.getBoundingClientRect().width <= fit + 0.5) return i
      }
      return 0
    }
    const tr = document.querySelector('#tree').getBoundingClientRect()
    for (const n of document.querySelectorAll('#tree .node')) {
      const meta = n.querySelector('.meta'); const mr = meta.getBoundingClientRect()
      const depth = Math.round((parseFloat(n.style.paddingLeft) - 8) / 14)
      if (depth === 4) deep++
      const shown = (c) => { const r = c.getBoundingClientRect(); return r.width > 0 && r.top < mr.bottom - 1 && r.bottom > mr.top }
      for (const c of meta.children) {
        if (!shown(c)) continue
        const r = c.getBoundingClientRect()
        if (r.right > mr.right + 0.5 || r.left < mr.left - 0.5 || c.scrollWidth > c.clientWidth + 1) bad.push({ depth, why: 'item partly clipped', el: c.className, w: r.width, cw: c.clientWidth, sw: c.scrollWidth, mw: mr.width })
      }
      // The visible own cost lies fully inside its cost box and the meta: its digits are never cut.
      const own = meta.querySelector('.cost-own')
      if (own && shown(own)) {
        const o = own.getBoundingClientRect(); const cb = own.parentElement.getBoundingClientRect()
        if (o.right > cb.right + 0.5 || o.left < cb.left - 0.5 || o.right > mr.right + 0.5 || o.left < mr.left - 0.5) bad.push({ depth, why: 'own cost cut off', own: [o.left, o.right], cost: [cb.left, cb.right], meta: [mr.left, mr.right] })
      }
      const chip = meta.querySelector('.ichip'); const cost = meta.querySelector('.cost')
      if (chip && cost && shown(cost) && !shown(chip)) bad.push({ depth, why: 'cost shows while the ITSA chip is dropped' })
      // The name wins the row's width (S-1031): all of it, or at least 10 characters, and it is cut
      // only when nothing else is left in the row to give way. A clipped-away item still reports its
      // own width, so count what shows inside the box that clips it, the meta or the row itself.
      const name = n.querySelector('.name')
      const nr = n.getBoundingClientRect()
      const visible = (c, box) => {
        const r = c.getBoundingClientRect()
        return Math.min(r.right, box.right) - Math.max(r.left, box.left) > 8 && r.top < box.bottom - 1 && r.bottom > box.top
      }
      const drawn = drawnChars(name)
      const len = name.textContent.length
      const avail = nr.right - parseFloat(getComputedStyle(n).paddingRight) - name.getBoundingClientRect().left
      if (drawn < Math.min(10, len)) bad.push({ depth, why: 'name shows under 10 characters', shows: drawn, of: len, w: name.getBoundingClientRect().width, text: name.textContent })
      // Cut while the row still has something to give way to, and while the name alone would fit.
      else if (drawn < len && name.scrollWidth <= avail + 1 && ([...meta.children].some((c) => visible(c, mr)) || [...n.querySelectorAll('.wcol')].some((c) => visible(c, nr)))) bad.push({ depth, why: 'name cut while a column, cost or ITSA chip is still in the row', shows: drawn, of: len, text: name.textContent })
      const hv = n.querySelector('.hover-actions')
      if (hv && getComputedStyle(hv).display !== 'none' && hv.getBoundingClientRect().right > tr.right + 0.5) bad.push({ depth, why: 'row menu past the tree edge' })
    }
    return { bad, deep }
  })
  const ok = r.deep > 0 && !r.bad.length
  name += `, key S-${'1'.padEnd(digits, '0')}, ${extra}`
  if (!ok) failures.push(name)
  console.log(ok ? 'ok  ' : 'FAIL', name, `(${r.deep} rows at depth 4)`, r.bad.length ? JSON.stringify(r.bad.slice(0, 4)) : '')
  await ctx.close()
}
const browser = await chromium.launch(chromiumLaunchOptions())
for (const cols of base ? [['field:fp', 'field:fq'], ['review', 'tests']] : []) {
  // The ITSA chip's width follows its key, so each key length puts a different item first in the line.
  for (const digits of [1, 5]) for (const extra of ['none', 'both']) {
    await run(browser, '300 px sidebar, ' + cols, null, { width: 1280, height: 800 }, cols, digits, extra)
    await run(browser, '360 px phone, ' + cols, devices['Pixel 7'], { width: 360, height: 740 }, cols, digits, extra)
  }
}

// One synthetic row with two long field columns, the case that clipped the cost: the meta (ITSA chip, own
// cost, model chip) gets 8 px at depth 4 in a 300 px tree. The page is the shipped CSS and font, with no
// app and no stubs, so it checks the CSS rules alone. The visible own cost must lie fully inside its
// cost box and the meta, at each depth and width, with and without an ITSA chip.
const font = '@font-face {font-family: "Source Sans 3 Variable";font-weight:200 900;src:url(data:font/woff2;base64,' + readFileSync(new URL('../fonts/source-sans-3-roman.woff2', import.meta.url)).toString('base64') + ')}'
const css = font + ['tokens.css', 'tokens-stam.css', 'style.css'].map((x) => readFileSync(new URL('../' + x, import.meta.url), 'utf8').replace(/@import[^;]+;/g, '')).join('\n')
const sp = await browser.newPage({ viewport: { width: 1000, height: 800 } })
for (const viewport of [1000, 360]) for (const width of [300, 360]) for (const chip of [true, false]) for (const depth of [0, 1, 2, 3, 4]) {
  await sp.setViewportSize({ width: viewport, height: 800 })
  await sp.setContent(`<style>${css}</style><div class="tree" data-cols="2" style="width:${width}px"><div class="node" style="padding-left:${8 + 14 * depth}px"><span class="chev"></span><span class="glyph">●</span><span class="name">root-long-agent-name</span><span class="wcols"><span class="wcol f">long field</span><span class="wcol f">long field</span></span><span class="meta">${chip ? '<span class="ichip"><span class="sglyph">●</span>S-697</span>' : ''}<span class="cost"><span class="cost-own">$1.23</span></span><span class="chip mcode">OP</span></span><span class="hover-actions"><button class="icon-btn">…</button></span></div></div>`)
  await sp.evaluate(() => document.fonts.ready)
  const bad = await sp.evaluate(() => {
    const m = document.querySelector('.meta').getBoundingClientRect()
    const own = document.querySelector('.cost-own'); const o = own.getBoundingClientRect(); const c = own.parentElement.getBoundingClientRect()
    const shown = o.top < m.bottom - 1 && o.bottom > m.top
    return shown && (o.left < c.left - 0.5 || o.right > c.right + 0.5 || o.left < m.left - 0.5 || o.right > m.right + 0.5) ? { own: [o.left, o.right], cost: [c.left, c.right], meta: [m.left, m.right] } : null
  })
  const name = `synthetic row, ${viewport} px page, ${width} px tree, depth ${depth}, ${chip ? 'with' : 'without'} ITSA chip`
  if (bad) { failures.push(name); console.log('FAIL', name, 'own cost cut off', JSON.stringify(bad)) } else console.log('ok  ', name)
}
// The meta clips its items at its own edge (S-4066), so the Open ask link's keyboard focus ring must be inset and lie inside
// the meta's box. Focus comes from the keyboard, as a user's Tab does, so :focus-visible is set.
await sp.setViewportSize({ width: 1000, height: 800 })
await sp.setContent(`<style>${css}</style><div class="tree" style="width:300px"><div class="node" style="padding-left:8px"><span class="chev"></span><span class="name">root-long-agent-name</span><span class="meta"><button class="open-ask" type="button"><svg class="i" viewBox="0 0 24 24"></svg>Open ask</button><span class="cost"><span class="cost-own">$1.23</span></span></span><span class="hover-actions"><button class="icon-btn">…</button></span></div></div>`)
await sp.evaluate(() => document.fonts.ready)
await sp.keyboard.press('Tab')
const ring = await sp.evaluate(() => {
  const b = document.querySelector('.open-ask'); const m = document.querySelector('.meta')
  const r = b.getBoundingClientRect(); const mr = m.getBoundingClientRect()
  return { focused: b.matches(':focus-visible'), shadow: getComputedStyle(b).boxShadow, inside: r.left >= mr.left - 0.5 && r.right <= mr.right + 0.5 && r.top >= mr.top - 0.5 && r.bottom <= mr.bottom + 0.5 }
})
const ringName = 'focused Open ask ring is inset and inside the meta'
if (ring.focused && ring.shadow.includes('inset') && ring.inside) console.log('ok  ', ringName)
else { failures.push(ringName); console.log('FAIL', ringName, JSON.stringify(ring)) }
await browser.close()
process.exit(failures.length ? 1 : 0)
