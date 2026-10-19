import { NotifySettings } from './NotifySettings'
import { ds, reply, type Story } from '../stories/types'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const DEVICES = [
  { id: 'fx-d1', endpoint: 'https://push.example.com/fixture-1', label: 'Android · Chrome', kinds: ['mail', 'permission'], created_at: ago(9 * 86400000), last_ok_at: ago(3600000), last_error: null },
  { id: 'fx-d2', endpoint: 'https://push.example.com/fixture-2', label: 'Mac · Firefox', kinds: ['mail'], created_at: ago(30 * 86400000), last_ok_at: null, last_error: 'fixture: the push service refused it (410)' },
  { id: 'fx-d3', endpoint: 'https://push.example.com/fixture-3', label: 'iPhone · Safari', kinds: ['permission'], created_at: ago(2 * 86400000), last_ok_at: null, last_error: null },
]
const info = (devices = DEVICES) => ({ 'GET /api/push': { publicKey: 'fixture-key', kinds: ['mail', 'permission'], devices } })

export const stories: Story[] = [{
  name: 'Notifications settings',
  group: 'Settings',
  what: 'Phone and desktop pushes for each mail to you and each permission request, with mootr closed. It installs mootr as an app, turns pushes on for this device, sends a test, and lists every device that gets them, with the last push, which kinds each takes, a test, and a remove. A tap on a push opens the thread; on Android a request has Approve and Deny on the notification.',
  when: 'Settings, Notifications (`notify`). Devices live on the daemon serving this page; a mail stored on another machine reaches them through it. The daemon accepts these requests only through mootr\'s Tailscale address, never with a `stam web` token link, so there the page explains how to set it up instead.',
  code: ['web/src/views/NotifySettings.tsx#NotifySettings'],
  rules: [
    'The This device card depends on the browser: Install mootr (primary button) where the browser offers an install, an Add to Home Screen note on iOS, "This browser doesn\'t support push notifications." where there is no push, "Notifications are blocked for this site" when the permission is denied, and Turn on for this device otherwise. The frames below show whichever the story page\'s own browser gives.',
    'A device row\'s kinds are a segmented control, each segment a pressed-state button (`aria-pressed`); on a phone segments are `--size-hit-touch` tall (' + ds('Buttons') + ').',
    'A device that failed shows "Last push failed: REASON"; one that never pushed shows when it was added; otherwise when the last push went through.',
    'On a peer without the home\'s page the section is read-only like the other shared settings: its controls are disabled with the reason on hover.',
    'Remove asks to confirm; the answer to a test or a refusal shows under the card as a polite status line (`role="status"`).',
  ],
  states: [
    { name: 'Devices', routes: info(), render: () => <NotifySettings /> },
    { name: 'No device yet', routes: info([]), render: () => <NotifySettings /> },
    { name: 'Not the human\'s address', routes: { 'GET /api/push': reply(403, { error: 'fixture: only the human may do this' }) }, render: () => <NotifySettings /> },
    { name: 'Failed to load', routes: { 'GET /api/push': reply(503, { error: 'fixture: the daemon is unreachable' }) }, render: () => <NotifySettings /> },
  ],
}]
