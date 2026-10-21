// Installing stam as an app and phone notifications: the service worker (public/sw.js,
// served at /sw.js), the install prompt, and this device's push subscription.
import { api, token } from './api'

export interface PushDevice { id: string; endpoint_hash: string; label: string; kinds: string[]; created_at: string; last_ok_at: string | null; last_error: string | null }
export interface PushInfo { publicKey: string; kinds: string[]; devices: PushDevice[] }

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
// Opened from the home screen (or installed on a desktop), not in a browser tab.
export const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
// iPhone and iPad (which reports itself as a Mac with touch): push only once added to the home screen.
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// A name for this device in the list, from what the browser says about itself.
export function deviceLabel(): string {
  const ua = navigator.userAgent
  const os = /Android/.test(ua) ? 'Android' : isIos() ? (/iPad/.test(ua) || !/iPhone/.test(ua) ? 'iPad' : 'iPhone') : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser'
  return `${os} · ${browser}${standalone() ? ' (app)' : ''}`
}

// Chromium offers installing through beforeinstallprompt; the page keeps the event until
// the human asks, and listeners hear when it comes and goes.
interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
let installEvent: InstallPrompt | null = null
const listeners = new Set<() => void>()
export const canInstall = () => !!installEvent
export function onInstallChange(f: () => void) { listeners.add(f); return () => { listeners.delete(f) } }
export async function install(): Promise<boolean> {
  const e = installEvent
  if (!e) return false
  await e.prompt()
  const { outcome } = await e.userChoice
  installEvent = null
  listeners.forEach((f) => f())
  return outcome === 'accepted'
}

let registration: Promise<ServiceWorkerRegistration | null> = Promise.resolve(null)

// Registers the service worker and opens a thread when a notification's tap asks for one.
export function initNotify(openThread: (thread: string) => void) {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installEvent = e as InstallPrompt
    listeners.forEach((f) => f())
  })
  addEventListener('appinstalled', () => { installEvent = null; listeners.forEach((f) => f()) })
  if (!('serviceWorker' in navigator)) return
  registration = navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(async (r) => {
    await navigator.serviceWorker.ready
    ;(r.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'hello', token, label: deviceLabel() })
    return r
  }, () => null)
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-thread' && e.data.thread) openThread(String(e.data.thread))
  })
}

// The daemon never serves a device's endpoint (a capability URL); it serves this hash, SHA-256 in hex.
export async function endpointHash(endpoint: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const r = await registration
  return r ? r.pushManager.getSubscription() : null
}

const keyBytes = (b64u: string) => {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

// Asks for permission, subscribes with the daemon's key, and registers this device.
export async function enablePush(info: PushInfo): Promise<PushDevice> {
  const r = await registration
  if (!r) throw new Error("This browser didn't start mootr's service worker.")
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.')
  let sub = await r.pushManager.getSubscription()
  // A subscription made with another key (another daemon, or a new key) can't be used.
  const key = sub?.options.applicationServerKey
  if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== info.publicKey) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.publicKey) })
  return api<PushDevice>('POST', '/api/push/devices', { subscription: sub.toJSON(), label: deviceLabel(), origin: location.origin })
}

export async function disablePush(deviceId?: string) {
  const sub = await currentSubscription()
  if (deviceId) await api('DELETE', `/api/push/devices/${deviceId}`).catch(() => {})
  await sub?.unsubscribe()
}
