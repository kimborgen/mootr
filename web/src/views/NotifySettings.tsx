// Settings, Notifications: install stam as an app, turn on pushes on this device, send a
// test, and list, tune, and remove the devices that get them. Devices live on the daemon
// serving this page; a mail stored on another machine reaches them through it.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { ago } from '../format'
import * as n from '../notify'

const KIND_LABEL: Record<string, string> = { mail: 'Mail to you', permission: 'Permission requests' }

export function NotifySettings() {
  const [info, setInfo] = useState<n.PushInfo | null>(null)
  const [mine, setMine] = useState<string | null>(null)
  const [msg, setMsg] = useState<string>('')
  const [busy, setBusy] = useState(false)
  // Devices are the human's alone: the daemon accepts these requests only through stam's
  // Tailscale address (tailscale serve), never with the token a `stam web` link carries.
  const [denied, setDenied] = useState(false)
  const [, setTick] = useState(0)

  const load = async () => {
    try {
      const [i, sub] = await Promise.all([api<n.PushInfo>('GET', '/api/push'), n.currentSubscription().catch(() => null)])
      setInfo(i)
      setMine(sub ? await n.endpointHash(sub.endpoint) : null)
    } catch (e) { setMsg((e as Error).message); setInfo(null); setDenied(/only the human/.test((e as Error).message)) }
  }
  useEffect(() => { void load(); return n.onInstallChange(() => setTick((t) => t + 1)) }, [])

  const run = async (f: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    setMsg('')
    try { await f(); if (done) setMsg(done) } catch (e) { setMsg((e as Error).message) }
    setBusy(false)
    await load()
  }
  const test = (id: string) => run(async () => {
    const r = await api<{ status: number; error?: string }[]>('POST', '/api/push/test', { device: id })
    if (r[0]?.error) throw new Error(`The push service refused it: ${r[0].error}`)
  }, 'Sent. It should show within a few seconds.')

  const me = info?.devices.find((d) => d.endpoint_hash === mine)
  const supported = n.pushSupported()
  const blocked = supported && Notification.permission === 'denied'
  const iosTab = n.isIos() && !n.standalone()

  let install: React.ReactNode = null
  if (n.standalone()) install = null
  else if (n.canInstall()) install = <button className="btn primary" id="install-app" onClick={() => void n.install()}><Icon name="download" />Install mootr</button>
  else if (n.isIos()) install = <p className="muted" id="install-ios">In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>, and open mootr from the home screen. iOS 16.4 and later sends notifications only to the installed app.</p>
  else install = <p className="muted">Your browser's menu can install mootr as an app, where it offers one.</p>

  let device: React.ReactNode
  if (denied) device = <p className="muted" id="push-denied">Set up notifications from mootr's HTTPS address (the https:// link <code>stam web</code> prints, such as one served by Tailscale), where your login signs you in. A link with a token can't.</p>
  else if (iosTab) device = <p className="muted">Install mootr on the home screen first (above), then turn notifications on from there.</p>
  else if (!supported) device = <p className="muted">This browser doesn't support push notifications.</p>
  else if (blocked) device = <p className="muted">Notifications are blocked for this site. Allow them in the browser's site settings, then come back.</p>
  else if (me) device = (
    <div className="row">
      <span className="tag-on"><Icon name="bell" size="xs" />On for {me.label}</span>
      <button className="btn" disabled={busy} onClick={() => void test(me.id)}><Icon name="send" />Send a test</button>
      <button className="btn" disabled={busy} onClick={() => void run(() => n.disablePush(me.id), 'Turned off on this device.')}><Icon name="bell-off" />Turn off</button>
    </div>
  )
  else device = <button className="btn primary" id="push-on" disabled={busy || !info} onClick={() => void run(() => n.enablePush(info!), 'On. Send a test to check it.')}><Icon name="bell" />Turn on for this device</button>

  return (
    <>
      <p className="lede">A notification for each mail to you and each permission request, with mootr closed. A tap opens the thread; on Android, a request has Approve and Deny on the notification itself.</p>
      {install ? <><h3>Install as an app</h3><div className="set-card notify-card">{install}</div></> : null}
      <h3>This device</h3>
      <div className="set-card notify-card">{device}{msg && !denied ? <p className="muted notify-msg" role="status">{msg}</p> : null}</div>
      <h3>Devices</h3>
      <div className="set-card" id="push-devices">
        {info?.devices.length ? info.devices.map((d) => (
          <div className="set-row device-row" key={d.id} data-device={d.id}>
            <div className="set-label">
              <b><Icon name="smartphone" size="xs" />{d.label}{d.endpoint_hash === mine ? <span className="muted"> · this device</span> : null}</b>
              <p>{d.last_error ? `Last push failed: ${d.last_error}` : d.last_ok_at ? `Last push ${ago(d.last_ok_at)}` : `Added ${ago(d.created_at)}`}</p>
            </div>
            <div className="set-ctl">
              <div className="seg" role="group" aria-label={`What pushes to ${d.label}`}>
                {info.kinds.map((k) => (
                  <button key={k} className={d.kinds.includes(k) ? 'on' : ''} aria-pressed={d.kinds.includes(k)}
                    onClick={() => void run(() => api('PATCH', `/api/push/devices/${d.id}`, { kinds: d.kinds.includes(k) ? d.kinds.filter((x) => x !== k) : [...d.kinds, k] }))}>{KIND_LABEL[k] ?? k}</button>
                ))}
              </div>
              <button className="icon-btn" title="Send a test" aria-label={`Send a test to ${d.label}`} disabled={busy} onClick={() => void test(d.id)}><Icon name="send" /></button>
              <button className="icon-btn" title="Remove" aria-label={`Remove ${d.label}`} disabled={busy}
                onClick={() => { if (confirm(`Stop notifications on ${d.label}?`)) void run(() => d.endpoint_hash === mine ? n.disablePush(d.id) : api('DELETE', `/api/push/devices/${d.id}`)) }}><Icon name="trash-2" /></button>
            </div>
          </div>
        )) : <p className="muted">No device has notifications on.</p>}
      </div>
    </>
  )
}
