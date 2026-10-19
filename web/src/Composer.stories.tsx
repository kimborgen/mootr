import { Composer } from './Composer'
import { Glyph } from './Glyph'
import { ApiError } from './api'
import { submit } from './outbox'
import { byName } from './stories/fixtures'
import type { Agent } from './types'
import { OnMount, holdTimers } from './stories/helpers'
import { ds, type Story } from './stories/types'

const dev = byName('fixture-dev')
const target = (key: string) => ({ key, enabled: true, name: dev.name, label: <><Glyph agent={dev} /><b>{dev.name}</b></>, placeholder: `Message ${dev.name}` })
const noop = async () => {}
// The recipient menu's choices: the fixture's chief of staff, assistant-less, mailed by `to`.
const recipients = { send: noop, label: () => 'Assistant', to: (a: Agent) => ({ id: a.id, name: a.name, glyph: <Glyph agent={a} />, label: <b>{a.name}</b>, placeholder: `Write to ${a.name}`, send: noop }) }
// Opens the stam icon's menu for the frame, then ticks cc rows by name.
const openMenu = (tick: string[] = []) => (el: HTMLElement) => {
  el.querySelector<HTMLElement>('.cmp-to')?.click()
  for (const n of tick) setTimeout(() => [...document.querySelectorAll<HTMLElement>('.menu .rm-cc')].find((b) => b.textContent?.includes(n))?.click(), 0)
}
const DRAFT = 'stam/draft/'
// A target's text draft lives in sessionStorage (Composer.tsx#Composer), which the box reads when it mounts.
const draft = (key: string, text: string) => () => { try { sessionStorage.setItem(DRAFT + key, text) } catch {} }
const VOICE = { 'GET /api/voice': { configured: true } }
// What /api/suggest answers for the cc pills: an agent, a thread and an ITSA, all near enough, and one too far.
const PILLS = { 'GET /api/suggest': [
  { kind: 'agent', id: 'fx-review', title: 'fixture-review', score: 0.82 },
  { kind: 'thread', id: 'th-fx', title: 'Fixture build fails on the example module', score: 0.71 },
  { kind: 'itsa', id: 'it-fx', title: 'S-1 Example', score: 0.64 },
  { kind: 'agent', id: 'fx-ops', title: 'fixture-ops', score: 0.4 },
] }
// Clicks a pill once it has come.
const pickPill = (key: string) => (el: HTMLElement) => {
  let n = 0
  const go = () => { const b = el.querySelector<HTMLElement>(`[data-cc-suggest="${key}"]`); if (b) b.click(); else if (n++ < 40) setTimeout(go, 25) }
  go()
}
const LONG = Array.from({ length: 14 }, (_, i) => `Step ${i + 1}: read the fixture notes in docs/example.md, then summarise what changed in the example module.`).join('\n')

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
// Puts files in the box as a paste of the file picker would.
function attach(el: HTMLElement) {
  if (typeof DataTransfer === 'undefined') return
  const input = el.querySelector<HTMLInputElement>('input[type=file]')!
  const dt = new DataTransfer()
  dt.items.add(new File(['fixture log line\n'], 'fixture-build.log', { type: 'text/plain' }))
  dt.items.add(new File([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], 'fixture-shot.png', { type: 'image/png' }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
// Arms the paperclip for the frame, the way a touch hold of `--duration-hold` does: the hold's
// timer runs at once, so the accent ring the screenshot shows is the state that ships (S-776).
function armHold(el: HTMLElement) {
  const btn = el.querySelector<HTMLElement>('.cmp-attach')
  if (!btn) return
  const st = window.setTimeout
  window.setTimeout = ((fn: TimerHandler) => { if (typeof fn === 'function') fn(); return 0 }) as unknown as typeof window.setTimeout
  try {
    const e = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(e, 'pointerType', { value: 'touch' })
    btn.dispatchEvent(e)
  } finally { window.setTimeout = st }
}
const outbox = (key: string, kind: 'pending' | 'failed') => () => holdTimers(() => {
  submit({ key, target: dev.name, text: 'Run the example check again and tell me what fails.', files: [], mode: 'direct',
    send: () => (kind === 'pending' ? new Promise(() => {}) : Promise.reject(new ApiError('fixture: the daemon refused it', 400))) })
})

export const stories: Story[] = [{
  name: 'Prompt input',
  group: 'Composer',
  what: "The box the human writes in: a text area that grows with its text up to 280 px, with a bar under it. The bar holds the attach button, the voice button when dictation is configured, the stam icon, which opens the recipient menu, the target's label, and send. There is no hint text; a notice (sent, failed) shows between the label and send for a few seconds. Pasting or dropping images and files adds them above the text. Where an agent can be reached two ways, a Direct and Mail toggle sits beside send: Direct types into the agent's terminal, Mail sends the text as mail from the human, in a thread of its own. The stam icon opens the recipient menu. Write to: this agent, its parent, intake, cos or the assistant (those that exist; the current one is ticked); the message goes there as mail, or to the assistant. cc, in Mail mode or when writing to an agent: ticks for the agents already cc'd and for cos, intake and the assistant, and a search for any other live agent. The cc agents get the same mail. The icon wears the accent and a +N count while a cc or another recipient is chosen, so the box keeps no cc row. Each target keeps its own draft, so switching panes loses nothing, and the text survives a reload.",
  when: "On a desktop the one input in the bottom world (`web/src/App.tsx`), whatever the main world shows: the focused agent or terminal, a mail thread's reply, an ITSA's comment (with its staged action), cos for the Work page, or nothing to write to. On a phone a mail thread and an ITSA keep their own box in the view (`web/src/views/ThreadView.tsx`, `web/src/views/ItsaView.tsx`); the top world keeps its own for the assistant. On a desktop Enter sends and Shift+Enter adds a line; a phone's Enter adds a line and send is the button.",
  code: ['web/src/Composer.tsx#Composer', 'web/src/outbox.ts#submit', 'web/src/outbox.ts#useOutbox'],
  rules: [
    'Text put back into the box by a restore (a failed send, a draft from the strip) is saved as the target\'s draft at once, like typed text, so a draft that moves to another target (a view falling back to the terminal) takes it along (S-1764).',
    'A sent message goes to the outbox at once and the box clears; the strip above the box shows rows that are sending, failed, or saved as drafts, so a slow daemon never blocks writing (S-373).',
    'Attach, voice, assistant, clear, draft and cancel are `icon-btn`s; send (`cmp-send`) and the Direct and Mail halves are their own controls. On a phone send, cancel, draft and the one-button mode toggle are `--size-hit-touch` (' + ds('Density') + ').',
    'The recipient menu is the menu layer\'s popover (a bottom sheet on a phone); its rows are radios (Write to) and checkboxes (cc), each with a tick, never colour alone, `--size-row-menu` high and `--size-hit-touch` on a phone. Arrow keys move between rows, Enter picks, Esc closes and returns the focus to the icon. The recipient itself is never listed as a cc, and choosing a cc agent as recipient drops it from the cc.',
    'A choice shows without the menu: the icon\'s label reads "Recipient: name, cc N", it takes the accent and a +N badge when it isn\'t the default, and the label names the agent. The icon stays on a phone while there is text only when something other than the default is chosen.',
    'Mode is never colour alone: the active half of the toggle is `aria-pressed` and carries the `on` fill. On a phone the toggle collapses to one button that shows the current mode.',
    'The recording dot and level bar are the only motion in the box; they show a live microphone, never decoration (' + ds('Motion') + ').',
    'A staged image is a button: a click opens it big in a tab of the main world (an image viewer with arrows to the other staged images); a phone opens the full-screen viewer instead (S-1475).',
    'A failed send never loses the text: clicking its row puts the message back in the box, before whatever was typed since.',
    'The box in the bottom world follows the main world (S-1436): its target changes with the focused tab, each target keeping its draft, and a failed row put back goes to its own target\'s draft when the box has moved on. Where the main world has nothing to write to the box stays, disabled, with a one-line placeholder saying why.',
    'On a touch screen a tap on the attach button opens the file picker, and a hold of `--duration-hold` opens the image-only picker (recent screenshots) when the finger lifts, since Android sends no click after a hold (S-703).',
    'While an agent\'s turn runs and its harness can be interrupted, the send button is Stop (`cmp-send cmp-stop`, named "Stop") while the box is empty, in either mode; with text or files it is Send. A failed stop shows under the box in error ink, not as a toast.',
    'At the hold threshold the hold buzzes once and the paperclip takes an accent ring (`--focus-ring-width` in `--accent`), so the finger knows to lift and get the screenshots picker; a plain `--accent-subtle` fill alone sat at 1.18:1 and read as nothing (S-776). The ring clears on lift, on a move or scroll away, and on `pointercancel`.',
  ],
  states: [
    { name: 'Empty, direct', render: () => <div className="story-pad"><Composer target={target('story:empty')} onSend={noop} /></div> },
    { name: 'Mail and Direct toggle', data: { promptDefaultMode: 'direct' }, render: () => <div className="story-pad"><Composer target={target('story:toggle')} onSend={noop} mail={noop} /></div> },
    { name: 'Mail mode', data: { promptDefaultMode: 'mail' }, setup: draft('story:mail', 'Can you summarise where the example work stands?'), render: () => <div className="story-pad"><Composer target={target('story:mail')} onSend={noop} mail={noop} /></div> },
    { name: 'Recipient menu', data: { promptDefaultMode: 'mail' }, render: () => <OnMount run={openMenu()}><div className="story-pad"><Composer target={{ ...target('story:menu'), to: dev.id }} onSend={noop} mail={noop} assistant={recipients} /></div></OnMount> },
    { name: 'Recipient menu, cc ticked', data: { promptDefaultMode: 'mail' }, render: () => <OnMount run={openMenu(['fixture-review'])}><div className="story-pad"><Composer target={{ ...target('story:menu-cc'), to: dev.id }} onSend={noop} mail={noop} assistant={recipients} /></div></OnMount> },
    { name: 'Mail with cc', data: { promptDefaultMode: 'mail' }, setup: draft('story:cc', 'Please check the example build and tell cos.'), render: () => <div className="story-pad"><Composer target={{ ...target('story:cc'), to: dev.id }} onSend={noop} mail={noop} /></div> },
    { name: 'Mail only (agent not running)', render: () => <div className="story-pad"><Composer target={target('story:nodirect')} onSend={noop} mail={noop} noDirect="fixture-dev isn't running" /></div> },
    { name: 'Reply under a thread', setup: draft('thread:story', 'Yes, go ahead with the second option.'), render: () => <div className="story-pad"><Composer className="inline" target={{ key: 'thread:story', enabled: true, name: 'the thread', label: <b>Reply</b>, placeholder: 'Reply to the thread' }} onSend={noop} /></div> },
    { name: 'Attachments', render: () => <OnMount run={attach}><Composer target={target('story:files')} onSend={noop} /></OnMount> },
    { name: 'Hold armed (recent screenshots)', render: () => <OnMount run={armHold}><Composer target={target('story:hold')} onSend={noop} /></OnMount> },
    { name: 'Voice button', routes: VOICE, render: () => <div className="story-pad"><Composer target={target('story:voice')} onSend={noop} /></div> },
    { name: 'Send in flight', setup: outbox('story:pending', 'pending'), render: () => <div className="story-pad"><Composer target={target('story:pending')} onSend={noop} /></div> },
    { name: 'Failed send', setup: outbox('story:failed', 'failed'), render: () => <div className="story-pad"><Composer target={target('story:failed')} onSend={noop} /></div> },
    { name: 'Long draft', setup: draft('story:long', LONG), render: () => <div className="story-pad"><Composer target={target('story:long')} onSend={noop} /></div> },
    { name: 'Staged action on an ITSA comment', setup: draft('story:itsa', 'Needs a rebase first.'), render: () => <div className="story-pad"><Composer target={{ key: 'story:itsa', enabled: true, name: 'the ITSA', label: <b>S-1 Example</b>, placeholder: 'Comment on S-1' }} staged onSend={noop} /></div> },
    { name: 'Running, Stop in the send place', render: () => <div className="story-pad"><Composer target={target('story:running')} onSend={noop} onStop={noop} /></div> },
    { name: 'Running with a draft, Send', data: { promptDefaultMode: 'mail' }, setup: draft('story:running-draft', 'Also check the phone.'), render: () => <div className="story-pad"><Composer target={target('story:running-draft')} onSend={noop} mail={noop} onStop={noop} /></div> },
    { name: 'Stop failed, error under the box', render: () => <div className="story-pad"><Composer target={target('story:stop-failed')} onSend={noop} onStop={noop} stopError="Stop failed: the daemon refused it (409)" /></div> },
    { name: 'Direct off, Mail on (prompts go to the terminal)', data: { promptDefaultMode: 'direct' }, render: () => <div className="story-pad"><Composer target={{ ...target('story:direct-off'), placeholder: 'Mail fixture-dev' }} onSend={noop} mail={noop} noDirect="Prompts are typed into its terminal" /></div> },
    { name: 'Disabled, with why', render: () => <div className="story-pad"><Composer target={{ key: 'none', enabled: false, placeholder: 'Open an agent, a thread or an ITSA to write' }} onSend={noop} /></div> },
    { name: 'Disabled (nothing to write to)', render: () => <div className="story-pad"><Composer target={{ key: 'none', enabled: false, placeholder: 'No agent selected' }} onSend={noop} /></div> },
  ],
}, {
  name: 'cc pills',
  group: 'Composer',
  what: "Suggestions for who else could get what the human is typing, as small pills on the prompt input's top border: an icon and a short title each, at most three. A pick only adds a cc, and several are allowed: an agent gets the mail too, a mail thread's participants get it, an ITSA has the mail filed on it (one per mail; a second ITSA replaces the first). The picks show in the recipient menu, where a click drops one, and the stam icon's +N counts them. A pick in a box sending Direct switches it to Mail, where cc means something.",
  when: 'In every prompt input that can send mail: the bottom bar on an agent (Direct or Mail), a mail thread\'s reply, the top world on a chief of staff. Not in the Alt+A prompt, which suggests recipients itself (`web/src/SuggestModal.tsx#SuggestModal`), an ITSA comment, the assistant, or a terminal. It asks `/api/suggest` on a space or once the typing pauses, as Alt+A does, and a new ask aborts the one in flight. With Rescore prompt suggestions on (`decisions.suggestRescore`, off by default), 800 ms after the last keystroke the rescored order replaces the pills for that same text, as in Alt+A.',
  code: ['web/src/CcPills.tsx#CcPills', 'web/src/CcPills.tsx#useCcSuggest', 'web/src/cc-pills.ts#ccPills', 'web/src/cc-pills.ts#ccPayload'],
  rules: [
    'Only near matches show: a score of at least `CC_FLOOR` (0.5), above the 0.35 the Alt+A prompt shows, since the human didn\'t open this box to be routed. The recipient, what is already cc\'d, and agents that aren\'t live never show.',
    'The pills sit centred on the box\'s top border, half above and half below. While they show, the box takes room above it for their top half and under the border for their bottom half and a `--space-15` gap, so they never cover the text; the room stays until the box empties, so the text doesn\'t jump as pills come and go.',
    'A pill is `--size-hit-min` high with `--radius-lg`, `--accent-subtle-border` and `--input-bg`, its title in `--type-chrome-xs`, cut with an ellipsis at three `--space-12`. On a touch screen its target reaches `--size-hit-touch`, and the room above and under the border grows to match, so the target covers neither the outbox strip nor the text (' + ds('Density') + ').',
    'Pressing a pill keeps the caret in the box, so a phone\'s keyboard stays up.',
  ],
  states: [
    { name: 'Suggesting', data: { promptDefaultMode: 'mail' }, routes: PILLS, setup: draft('story:pills', 'Please check the example build '),
      render: () => <div className="story-pad"><Composer target={{ ...target('story:pills'), to: dev.id }} onSend={noop} mail={noop} /></div> },
    { name: 'Direct, before a pick', data: { promptDefaultMode: 'direct' }, routes: PILLS, setup: draft('story:pills-direct', 'Please check the example build '),
      render: () => <div className="story-pad"><Composer target={{ ...target('story:pills-direct'), to: dev.id }} onSend={noop} mail={noop} /></div> },
    { name: 'Agent picked (now Mail, +1)', data: { promptDefaultMode: 'direct' }, routes: PILLS, setup: draft('story:pills-picked', 'Please check the example build '),
      render: () => <OnMount run={pickPill('agent:fx-review')}><Composer target={{ ...target('story:pills-picked'), to: dev.id }} onSend={noop} mail={noop} /></OnMount> },
    { name: 'Long draft', data: { promptDefaultMode: 'mail' }, routes: PILLS, setup: draft('story:pills-long', LONG + ' '),
      render: () => <div className="story-pad"><Composer target={{ ...target('story:pills-long'), to: dev.id }} onSend={noop} mail={noop} /></div> },
  ],
}]
