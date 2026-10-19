import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import '../style.css'
import { followTree, openAgent, openWorld, selectAgent, selectIssue, enterTree, exitTree } from './actions'
import { api, hash, token } from './api'
import { LocalLogin, needsLocalLogin } from './local-login'
import { App, applyTheme, initialTheme } from './App'
import { glyphHtml } from './Glyph'
import { itsaKeyLink, openFromMail } from './itsa/itsa'
import { onLiveConnection, startLive } from './live'
import { esc } from './format'
import * as mb from './mail/mailblocks'
import { handleRefClick } from './mail/refClicks'
import { prLinkClick } from './mail/prLinks'
import { loadDiffRepos } from './diff/diffRepos'
import { registerAppRefResolvers } from './mail/refResolvers'
import * as shell from './shell/layout'
import { applyLiveEvent, getData, loadThresholds, onAgentsChanged, refresh, refreshItsas, refreshMachines, refreshSlow, setData, startPolls, subscribe } from './store'
import { BASE_FONT, sessions } from './term/TermSession'
import { toast } from './ui/menu'
import { initNotify } from './notify'
import { init as initNavHistory } from './nav-history'
import { initPhone } from './ui/phone'
import { keepKey, validKey } from './views/registry'
import type { PlainShell } from './types'
import { addDraft, loadOutbox } from './outbox'
import { parseFileLink } from './files/fileKey'
import { parseDiffLink } from './diff/diffKey'
import { openDiff, openFile } from './files/open'
import { DEFAULT_STATE, parseUsageHash, pinMeasure, setUsageState } from './usage/state'

// "@name" in a mail links the agent: its mark and name in link ink, never a chip.
mb.configure({
  mention: (name) => {
    const a = getData().agents.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name)
    return a ? `<a href="#" class="mention" data-open-agent="${a.id}">${glyphHtml(a)}${esc(a.name)}</a>` : null
  },
  // An "S-12" key in a mail opens that ITSA, with its live status.
  itsa: itsaKeyLink,
})
// "#494" and "Settings › Spending" in a mail link to what they name (S-1484).
registerAppRefResolvers()
document.addEventListener('click', (e) => { if (!handleRefClick(e)) prLinkClick(e) })
document.addEventListener('click', (e) => {
  const l = (e.target as Element).closest<HTMLElement>('[data-open-itsa]')
  if (l) { e.preventDefault(); openFromMail(l.dataset.openItsa!, l) }
})

// A new permission request opens the left side and says so once.
let seenPerms = new Set<string>()
function watchPerms() {
  let last = getData().perms
  subscribe(() => {
    const { perms, agents } = getData()
    if (perms === last) return
    last = perms
    const fresh = perms.filter((r) => !seenPerms.has(r.id))
    for (const r of perms) seenPerms.add(r.id)
    if (fresh.length) {
      if (!shell.isPhone() && !shell.worldOpen('left')) shell.toggleWorld('left', true)
      toast(`${agents.find((a) => a.id === fresh[0].agent_id)?.name ?? 'An agent'} asks for permission. It's at the top of your mail.`)
    }
  })
}

// Deep links from `stam web` (#agent=NAME, #view=config, #view=work, #view=system, #view=process, #view=swipe), an ITSA by
// its key (#itsa=S-12), and a notification's tap or a link to a thread (#thread=ID). Read at
// startup, and again whenever the hash changes with the app open.
const HASH_VIEWS = ['config', 'work', 'system', 'process', 'usage', 'swipe', 'inbox'] as const
// `#view=files` opens the Files world, and `#file=HOST:PATH[#Lline]` one file (S-1526), and `#diff=REPO:N` one PR's diff (S-1531).
const HASH_VIEWS_ALL = [...HASH_VIEWS, 'files'] as const
function openHash(h: URLSearchParams) {
  const deep = h.get('agent') && getData().agents.find((a) => a.id === h.get('agent') || a.name === h.get('agent'))
  if (deep) openAgent(deep.id)
  const view = HASH_VIEWS_ALL.find((v) => v === h.get('view'))
  // A Usage link carries its tab, period, measure and scope; they are set before the page shows.
  // A link that names a measure pins it, so the Settings default (S-663) doesn't override it.
  if (view === 'usage') { const hashState = parseUsageHash(h); if (hashState.measure) pinMeasure(); setUsageState({ ...DEFAULT_STATE, ...hashState }) }
  if (view) openWorld(view)
  if (h.get('thread')) shell.showAgentWorld('t:' + h.get('thread'))
  const file = h.get('file') && parseFileLink(h.get('file')!)
  if (file) openFile(file.host, file.path, file.line)
  const diff = h.get('diff') && parseDiffLink(h.get('diff')!)
  if (diff) openDiff(diff.repo, diff.pr)
  const key = h.get('itsa')
  if (key) openItsaKey(key.toUpperCase())
}
// The ITSAs load after the boot, so a key not known yet opens once they arrive.
function openItsaKey(key: string) {
  const find = () => getData().itsas.find((x) => x.key === key)
  const it = find()
  if (it) return selectIssue(it.id)
  if (getData().loaded.itsas) return
  const stop = subscribe(() => {
    if (!getData().loaded.itsas) return
    stop()
    const x = find()
    if (x) selectIssue(x.id)
  })
}

async function boot() {
  initPhone()
  // On 127.0.0.1 with auth.localHuman on and no accepted token, the page asks for a login code (S-613).
  const loginDir = await needsLocalLogin(token)
  if (loginDir) {
    applyTheme(initialTheme())
    createRoot(document.getElementById('root')!).render(<LocalLogin dir={loginDir} />)
    return
  }
  // The boot fetches don't depend on each other, so they start together (S-150). The lists
  // start with them: threads and rings name agents, so they follow the agent list.
  const fonts = document.fonts.load(`${BASE_FONT}px 'Source Code Pro Variable'`).catch(() => {})
  applyTheme(initialTheme())
  const health = api<{ machine: string }>('GET', '/api/health').then((h) => setData({ machine: h.machine })).catch(() => {})
  void loadOutbox()
  const agents = refresh()
  const shells = api<PlainShell[]>('GET', '/api/shells').then((s) => setData({ shells: s })).catch(() => {})
  agents.then(refreshSlow)
  refreshItsas()
  refreshMachines()
  await Promise.all([fonts, health, loadThresholds(), agents, shells])
  seenPerms = new Set(getData().perms.map((r) => r.id))
  shell.init({
    valid: validKey,
    keep: keepKey,
    keepWorld: (id) => (id.startsWith('t:') || id.startsWith('w:') ? true : !!getData().agents.find((a) => a.id === id)),
  })
  onAgentsChanged(followTree)
  watchPerms()
  loadDiffRepos() // which PR links open in-app (S-1533), so the first mail and Work row already know
  createRoot(document.getElementById('root')!).render(<App />)
  openHash(hash)
  // A link whose hash changes while the app is open (another tab, a pasted link) opens too.
  addEventListener('hashchange', () => openHash(new URLSearchParams(location.hash.slice(1))))
  initNotify((thread) => shell.showAgentWorld('t:' + thread))
  if (shell.isPhone() && !shell.currentWorld()) shell.toggleWorld('left', true)
  // The places the browser's back and forward move between, from here on.
  initNavHistory()
  setData({ booted: true })
  // The live stream (S-457): apply its events, and slow the fallback polls while it's
  // connected, restoring them when it breaks.
  onLiveConnection(startPolls)
  startPolls(false)
  startLive()
  setInterval(refreshSlow, 8000)
  setInterval(refreshMachines, 5000)
}
boot()

// For headless UI checks.
// `live` applies a fake event from the daemon's stream, as if it had arrived (the system view's flights).
Object.assign(window, { stamDebug: { sessions, shell, selectAgent, enterTree, exitTree, addDraft, live: applyLiveEvent } })
