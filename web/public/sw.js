// stam's service worker: phone notifications only. It has no fetch handler and caches
// nothing, so the page, its scripts, and a deploy load exactly as without it.
// The daemon serves it at /sw.js, so its scope is the whole page.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// The page hands over its token (a `stam web` link signs in with one; through
// `tailscale serve` the login does) and this device's name, for answering from a
// notification and for renewing the subscription.
const STORE = 'stam-sw'
const remember = async (key, value) => (await caches.open(STORE)).put('/__' + key, new Response(value))
const recall = async (key) => { const r = await (await caches.open(STORE)).match('/__' + key); return r ? r.text() : '' }
self.addEventListener('message', (e) => {
  if (e.data?.type === 'hello') e.waitUntil(Promise.all([remember('token', e.data.token || ''), remember('label', e.data.label || '')]))
})

const api = async (method, path, body) => {
  const token = await recall('token')
  return fetch(path, { method, headers: { 'content-type': 'application/json', 'x-stam-human': '1', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) })
}

// Mail notifications stack (S-416): up to GROUP_AT - 1 threads show one notification each,
// replacing the thread's own; from GROUP_AT threads on, one summary ("3 mails waiting")
// replaces them and keeps each thread's title, body, and mail, so a close can take one out of it
// and bring the rest back as their own when the count drops. Only mail notifications group and
// close with it: a permission request has its own Approve and Deny and stays until answered.
const GROUP_AT = 3
const SUMMARY = 'stam-mail-summary'
const look = { icon: '/web/icon-192.png', badge: '/web/badge-96.png' }

const isMail = (n) => n.data?.kind === 'mail'

// The threads of mail waiting, from the individual notifications and the summary's own list.
function mailItems(ns) {
  const items = new Map()
  for (const n of ns) {
    if (!isMail(n)) continue
    if (n.data.summary) for (const t of n.data.threads) items.set(t.thread, t)
    else items.set(n.data.thread || n.tag, { thread: n.data.thread || n.tag, title: n.data.title, body: n.data.body, mail_id: n.data.mail_id })
  }
  return items
}

// Shows the notifications that stand for these threads. `latest` is the thread that just came
// (it alerts); without one nothing alerts: the set only shrank.
async function showMail(items, latest) {
  const ns = await self.registration.getNotifications()
  const shown = new Set(ns.filter((n) => isMail(n) && !n.data.summary).map((n) => n.tag))
  if (items.size >= GROUP_AT) {
    const list = [...items.values()]
    const text = list.slice(0, 3).map((t) => `${t.title}: ${t.body}`).join(' · ') + (list.length > 3 ? ` · +${list.length - 3} more` : '')
    await self.registration.showNotification(`${list.length} mails waiting`, { body: text, tag: SUMMARY, renotify: !!latest, silent: !latest, ...look, data: { kind: 'mail', summary: true, threads: list } })
    ns.filter((n) => isMail(n) && !n.data.summary).forEach((n) => n.close())
    return
  }
  ns.filter((n) => isMail(n) && n.data.summary).forEach((n) => n.close())
  for (const t of items.values()) {
    if (t.thread !== latest && shown.has(t.thread)) continue
    await self.registration.showNotification(t.title, { body: t.body, tag: t.thread, renotify: t.thread === latest, silent: t.thread !== latest, ...look, data: { kind: 'mail', thread: t.thread, title: t.title, body: t.body, mail_id: t.mail_id } })
  }
}

async function onPush(p) {
  // Withdrawn mail: close the notifications of those mails and show nothing; the summary loses them
  // too. A newer mail in the thread replaced the notification under the same tag, and stays.
  if (p.kind === 'close') {
    const gone = new Set(p.mail_ids || [])
    const ns = await self.registration.getNotifications()
    const items = mailItems(ns)
    let inSummary = false
    for (const [thread, t] of items) if (thread === p.tag && (!t.mail_id || gone.has(t.mail_id))) { items.delete(thread); inSummary = true }
    ns.filter((n) => n.tag === p.tag && !n.data?.summary && (!n.data?.mail_id || gone.has(n.data.mail_id))).forEach((n) => n.close())
    if (inSummary && ns.some((n) => isMail(n) && n.data.summary)) await showMail(items)
    return
  }
  if (p.kind === 'mail') {
    const items = mailItems(await self.registration.getNotifications())
    items.set(p.tag, { thread: p.tag, title: p.title, body: p.body, mail_id: p.mail_id })
    return showMail(items, p.tag)
  }
  // Approve and Deny show where the platform has notification actions (Android, desktop
  // Chrome); elsewhere (iOS) a tap opens the request. Only a push that says it is not a
  // suggested input (S-422) gets them: a push without perm_kind gets none, so an input never
  // shows Approve. The human reads an input's text on the card, then approves there.
  const actions = p.kind === 'permission' && !!p.perm_kind && p.perm_kind !== 'input' && (self.Notification?.maxActions ?? 0) >= 2
    ? [{ action: 'approve', title: 'Approve' }, { action: 'deny', title: 'Deny' }] : []
  return self.registration.showNotification(p.title, {
    body: p.body, tag: p.tag, renotify: true, ...look,
    data: p, actions, requireInteraction: p.kind === 'permission',
  })
}

// Every update reads the notifications on screen and rewrites them, so two at once would overwrite
// each other's summary and lose threads: they run one at a time, in the order they arrived.
let queue = Promise.resolve()

self.addEventListener('push', (e) => {
  let p
  try { p = e.data.json() } catch { p = { kind: 'mail', title: 'mootr', body: e.data ? e.data.text() : '', tag: 'stam' } }
  queue = queue.then(() => onPush(p)).catch(() => {})
  e.waitUntil(queue)
})

async function openThread(thread) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const win = wins.find((w) => new URL(w.url).origin === self.location.origin)
  if (win) {
    if (thread) win.postMessage({ type: 'open-thread', thread })
    return win.focus()
  }
  return self.clients.openWindow(thread ? '/#thread=' + encodeURIComponent(thread) : '/')
}

self.addEventListener('notificationclick', (e) => {
  const p = e.notification.data || {}
  e.notification.close()
  // A suggested input is never answered from a notification: its text is read on the card.
  if ((e.action === 'approve' || e.action === 'deny') && p.permission_id && p.perm_kind && p.perm_kind !== 'input') {
    // Answered from the notification. A request held on another machine is answered at that machine's serve
    // origin, with no token (its tailscale serve proves the human sent it, S-544); if that fails, or on this
    // machine, the page's daemon answers (and forwards, where it still may). If both fail (answered elsewhere,
    // signed out, unreachable), the request opens so the human sees why.
    const body = { approve: e.action === 'approve', note: e.action === 'approve' ? 'I authorize' : '', machine: p.machine }
    // Why the direct attempt failed rides in the fallback body (`direct`), so the daemon can log it (S-426).
    const fail = { why: '' }
    const direct = async () => {
      if (!p.origin) { fail.why = 'no origin in the push'; return null }
      try {
        const r = await fetch(p.origin + `/api/permissions/${p.permission_id}/answer`, { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'content-type': 'application/json', 'x-stam-human': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
        if (!r.ok) fail.why = `HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`
        return r
      } catch (err) {
        fail.why = `${err && err.name}: ${err && err.message}`
        return null
      }
    }
    e.waitUntil(direct()
      .then((r) => (r && r.ok ? r : api('POST', `/api/permissions/${p.permission_id}/answer`, { ...body, direct: fail.why.slice(0, 300) + ' (origin ' + (p.origin || 'none') + ')' })))
      .then((r) => (r.ok ? undefined : openThread(p.thread)), () => openThread(p.thread)))
    return
  }
  e.waitUntil(openThread(p.thread))
})

// The browser renewed the subscription: tell the daemon, keeping this device's name.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const sub = e.newSubscription ?? (await self.registration.pushManager.subscribe(e.oldSubscription.options))
    await api('POST', '/api/push/devices', { subscription: sub.toJSON(), replaces: e.oldSubscription?.endpoint, label: (await recall('label')) || 'A device', origin: self.location.origin })
  })())
})
