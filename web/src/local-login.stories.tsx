import { LocalLogin } from './local-login'
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
  code: ['web/src/local-login.tsx#LocalLogin', 'web/src/local-login.tsx#commandFor'],
  rules: [
    'One column, as wide as `--measure-conversation`; on a phone it fills the width, and the command wraps anywhere so nothing scrolls sideways.',
    'The command is mono on the input surface (`--input-bg`, `--input-border`), and a tap selects all of it.',
    'Log in is a primary button, `--size-hit-touch` tall on a touch screen (' + ds('Buttons') + ').',
    'A refusal shows in `--status-error-fg` as an alert, with the daemon\'s own reason.',
  ],
  states: [
    { name: 'Ready', render: () => <LocalLogin dir={DIR} /> },
    {
      name: 'Refused',
      routes: { 'POST /api/human/login': reply(403, { error: 'no such code yet: run the command above first' }) },
      render: () => <OnMount run={press}><LocalLogin dir={DIR} /></OnMount>,
    },
  ],
}]
