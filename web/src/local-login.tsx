// Local human login (S-613): on one machine without Tailscale, the page on 127.0.0.1 becomes the human once
// root vouches for the code it shows, with coreutils alone (`sudo /usr/bin/install ... DIR/CODE`): nothing of
// stam's, which agents could edit, runs as root. The code names a secret only this page holds, which it then posts. The daemon answers with a session token, kept like a `stam web` token
// (localStorage, this origin only) and sent as the Bearer; a 401 drops it.
import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { setStanding } from './ui/menu'

const TOKEN_KEY = 'stamToken'
const KIND_KEY = 'stamTokenKind'
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']

export const onLoopback = (): boolean => LOOPBACK.includes(location.hostname)
export function isLocalSession(): boolean {
  try { return localStorage.getItem(KIND_KEY) === 'local-human' } catch { return false }
}
// Forgets the stored token, so the next load asks for a code (or the `stam web` link) again.
export function dropToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(KIND_KEY) } catch {}
}

const WANT_KEY = 'stamLoginWanted'

// Whether to show the login instead of the app: only on 127.0.0.1, only when the stored token (if any) is
// refused or the human asked to log in (LoginOffer), and only with auth.localHuman on. Through tailscale serve
// nothing changes. Returns the folder the command names (the daemon user's) and whether that user has
// passwordless sudo, or null for the app. An asked-for
// login keeps the stored token until the login replaces it, so a reload without logging in gets the app back.
export type LoginInfo = { dir: string; passwordlessSudo: boolean }
export async function needsLocalLogin(token: string): Promise<LoginInfo | null> {
  if (!onLoopback()) return null
  let wanted = false
  try { wanted = sessionStorage.getItem(WANT_KEY) === '1'; sessionStorage.removeItem(WANT_KEY) } catch {}
  try {
    if (!wanted) {
      const r = await fetch('/api/health', { headers: token ? { authorization: 'Bearer ' + token } : {} })
      if (r.status !== 401) return null
      dropToken()
    }
    const d = await (await fetch('/api/human/login')).json()
    return d?.enabled === true && typeof d.dir === 'string' ? { dir: d.dir, passwordlessSudo: d.passwordlessSudo === true } : null
  } catch { return null }
}

// The offer to log in (S-2121): the daemon refused a human action from this page on 127.0.0.1 (the app's own
// human-only reads at boot count) and said a local login is there. A state to act on, not a notification: it is
// the notice bar's standing notice (ui/menu.tsx), which a transient notice covers only while it shows. Dismissed,
// it comes back with the next refusal. Log in reloads into the login page; once offered, the Settings nav keeps a
// Log in too (loginOffered).
let offered = false
export function offerLogin(): void {
  offered = true
  setStanding(<LoginOffer />)
}
export const loginOffered = (): boolean => offered
export function startLogin(): void {
  try { sessionStorage.setItem(WANT_KEY, '1') } catch {}
  location.reload()
}
export function LoginOffer() {
  return (
    <div className="toast login-offer" id="login-offer" role="alert">
      <span>This page isn't logged in as the human, so mootr refuses approvals and settings changes here.</span>
      <button className="btn primary" type="button" onClick={startLogin}>Log in</button>
      <button className="icon-btn" type="button" aria-label="Dismiss" title="Dismiss" onClick={() => setStanding(null)}><Icon name="x" /></button>
    </div>
  )
}

// What the human runs: an empty root-owned file named by the code, in folders made readable whatever the
// user's umask (sudo keeps it). Absolute paths, since some sudo setups keep the caller's PATH, which agents
// can edit.
export function commandFor(dir: string, name: string): string {
  const base = dir.slice(0, dir.lastIndexOf('/'))
  return `sudo /usr/bin/install -d -m 755 ${base} ${dir} && sudo /usr/bin/install -m 644 /dev/null ${dir}/${name}`
}

export async function logout(token: string): Promise<void> {
  await fetch('/api/human/logout', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
  dropToken()
  location.reload()
}

// RFC 4648 base32, lower case, no padding, as the daemon computes it (src/local-human.ts nameOf).
function base32(b: Uint8Array): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let acc = 0
  let out = ''
  for (const x of b) {
    acc = ((acc << 8) | x) & 0xffff
    bits += 8
    while (bits >= 5) out += abc[(acc >>> (bits -= 5)) & 31]
  }
  return bits ? out + abc[(acc << (5 - bits)) & 31] : out
}
const base64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
// A fresh 128-bit secret, which stays in this page's memory, and the name root vouches for: the first 128 bits
// of its SHA-256. An agent reading the terminal sees only the name.
export async function newSecret(): Promise<{ secret: string; name: string }> {
  const secret = base64url(crypto.getRandomValues(new Uint8Array(16)))
  return { secret, name: await nameOf(secret) }
}
export async function nameOf(secret: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
  return base32(h.subarray(0, 16))
}

export function LocalLogin({ dir, passwordlessSudo = false }: { dir: string; passwordlessSudo?: boolean }) {
  const [pair, setPair] = useState<{ secret: string; name: string } | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void newSecret().then(setPair) }, [])
  const command = pair ? commandFor(dir, pair.name) : ''
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pair) return
    setBusy(true)
    setMsg('')
    try {
      const r = await fetch('/api/human/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: pair.secret }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || typeof d.token !== 'string') throw new Error(d.error || `HTTP ${r.status}`)
      try { localStorage.setItem(TOKEN_KEY, d.token); localStorage.setItem(KIND_KEY, 'local-human') } catch {}
      location.reload()
    } catch (err) {
      setMsg((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <main className="local-login" id="local-login">
      <h1><Icon name="lock" />Log in to mootr</h1>
      <p className="lede">In a terminal outside mootr (not an agent's, not a mootr web shell, where sudo's remembered password would let others act as root), run this, then press Log in. It works once, for 5 minutes; the login lasts 12 hours or until mootr restarts.</p>
      <form onSubmit={submit}>
        <code id="local-login-command">{command}</code>
        <button className="btn primary" type="submit" disabled={busy || !pair}>Log in</button>
      </form>
      {msg && <p className="local-login-error" role="alert">{msg}</p>}
      {passwordlessSudo
        ? <p className="local-login-warn" role="alert" id="local-login-sudo"><Icon name="shield-alert" />Your user has passwordless sudo, so any agent can become root and log in as you: this login keeps no agent out. Require a password for sudo, or run agents as another Unix user.</p>
        : <p className="muted">Agents run as your Unix user. Where they have passwordless sudo, this login doesn't keep them out; for real isolation, run agents as another Unix user.</p>}
    </main>
  )
}
