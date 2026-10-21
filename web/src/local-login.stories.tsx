import { LocalLogin, offerLogin } from './local-login'
import { OnMount } from './stories/helpers'
import { ds, reply, type Story } from './stories/types'

const DIR = '/run/stam-human/1000'
// Presses Log in once the page has drawn its secret (the button is disabled until then).
const press = (el: HTMLElement) => {
  const go = () => {
    const b = el.querySelector<HTMLButtonElement>('button[type=submit]')
    if (b && !b.disabled) b.click()
    else setTimeout(go, 20)
  }
  go()
}

export const stories: Story[] = [{
  name: 'Local login',
  group: 'Settings',
  what: "The page that makes a browser on 127.0.0.1 the human without Tailscale. It shows a coreutils command naming a code for a secret only this page holds; once root has run it, Log in trades the secret for a session.",
  when: 'On 127.0.0.1 with `auth.localHuman` on, when the stored token is missing or refused. Through tailscale serve it never shows.',
  code: ['web/src/local-login.tsx#LocalLogin', 'web/src/local-login.tsx#commandFor', 'web/src/local-login.tsx#needsLocalLogin'],
  rules: [
    'One column, as wide as `--measure-conversation`; on a phone it fills the width, and the command wraps anywhere so nothing scrolls sideways.',
    'The command is mono on the input surface (`--input-bg`, `--input-border`), and a tap selects all of it.',
    'Log in is a primary button, `--size-hit-touch` tall on a touch screen (' + ds('Buttons') + ').',
    'A refusal shows in `--status-error-fg` as an alert, with the daemon\'s own reason.',
    "Where the daemon's user has passwordless sudo (S-2121), the closing note becomes a warning in `--status-warning-fg` with the shield-alert icon, announced as an alert: there any agent can become root, so the login keeps no agent out.",
  ],
  states: [
    { name: 'Ready', render: () => <LocalLogin dir={DIR} /> },
    { name: 'Passwordless sudo', render: () => <LocalLogin dir={DIR} passwordlessSudo /> },
    {
      name: 'Refused',
      routes: { 'POST /api/human/login': reply(403, { error: 'no such code yet: run the command above first' }) },
      render: () => <OnMount run={press}><LocalLogin dir={DIR} /></OnMount>,
    },
  ],
}, {
  name: 'Login offer',
  group: 'Settings',
  what: "A notice that this page isn't logged in as the human, with Log in to go to the local login. A `stam web` token link on 127.0.0.1 can look, but the daemon refuses its approvals and settings changes.",
  when: "On 127.0.0.1, after the daemon refuses a human action (the app's own human-only reads at boot count) and says a local login is there (`localLogin` in the 403, with `auth.localHuman` on). Stays until dismissed or used; through tailscale serve it never shows.",
  code: ['web/src/local-login.tsx#LoginOffer', 'web/src/local-login.tsx#offerLogin', 'web/src/local-login.tsx#startLogin'],
  rules: [
    "It is the notice bar's standing notice (Notice bar), in the bar's own look: a transient notice covers it while it shows, then it comes back. The text wraps; the buttons never shrink.",
    'Log in is a primary button and Dismiss an icon button, both `--size-hit-touch` on a touch screen (' + ds('Buttons') + ').',
    "Log in reloads into the login page and keeps the token link's token until a login replaces it, so a reload gets the app back.",
    'A state to act on, not a notification: Dismiss hides it until the next refused human action, and Settings keeps a Log in item meanwhile.',
  ],
  states: [
    { name: 'Shown', height: 96, render: () => <OnMount run={() => offerLogin()} /> },
  ],
}]
