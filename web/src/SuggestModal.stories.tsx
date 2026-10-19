import { createRef } from 'react'
import { SuggestBar, SuggestModal } from './SuggestModal'
import type { ComposerHandle } from './Composer'
import { OnMount } from './stories/helpers'
import { ds, type Story } from './stories/types'
import { setUi } from './ui/state'
import type { SearchResult } from './types'

const R = (kind: SearchResult['kind'], id: string, title: string, o: Partial<SearchResult> = {}): SearchResult => ({ kind, id, title, score: 1, ...o })
const RESULTS: SearchResult[] = [
  R('agent', 'fx-dev', 'fixture-dev', { snippet: 'developer · working on the fixture change', meta: 'fixture-machine' }),
  R('thread', 't1', 'Fixture thread: which option to pick', { snippet: 'The fixture reviewer found nothing to change.', meta: 'you, fixture-dev' }),
  R('itsa', 'i1', 'Fixture issue', { snippet: 'Make the fixture build pass on the phone', meta: 'F-1 · in_progress' }),
]
// Types into the box the way a person does; the trailing space asks at once.
const type = (text: string) => (el: HTMLElement) => {
  const box = el.ownerDocument.querySelector<HTMLTextAreaElement>('#suggest-modal textarea, #suggest-bar-story textarea')!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
  box.dispatchEvent(new Event('input', { bubbles: true }))
}
const pick = (sel: string) => (el: HTMLElement) => {
  type('the fixture build fails ')(el)
  const tryPick = (n: number) => {
    const b = el.ownerDocument.querySelector<HTMLButtonElement>(`[data-suggest="${sel}"] .sg-pick`)
    if (b) b.click(); else if (n) setTimeout(() => tryPick(n - 1), 30)
  }
  tryPick(20)
}
const open = () => setUi({ suggestOpen: true })

export const stories: Story[] = [{
  name: 'Write and pick where',
  group: 'Composer',
  what: "The prompt input alone, centred over the dimmed page: the human writes first, and stam suggests where it could go. Suggestions are compact cards above the box (an icon, the title, one line of snippet, and the kind: Agent, Mail, or Issue), best first, nearest the box. A pick sets the recipient as a chip in the box's bar and hides the other cards; the chip's x removes it and suggesting starts again. An agent pick mails the agent, a thread pick replies in that thread, an ITSA pick mails its owner filed on the ITSA. With no pick, the message mails the top target (the Alt+C overlay's choice) marked `routing_uncertain`. Each card has a Go to button at its end (the `actions` slot): it opens that agent, thread, or ITSA, closes the prompt, and moves the text and files into that world's prompt input as a draft, added after any draft the box already holds. A failed send put back from the box's outbox strip brings its pick back with it.",
  when: 'Alt+A on a desktop (Alt+C opens the assistant overlay instead); on a phone, "Write and pick where…" in the pane menu. It asks `GET /api/suggest` with the recently visited ids on a space, or 300 ms after the last keystroke, and a new ask aborts the one in flight. With Rescore prompt suggestions on (Settings › Tiny models, `decisions.suggestRescore`, off by default), 800 ms after the last keystroke it asks `GET /api/suggest/rescore`, and the rescored order replaces the one shown, for that same text only; a newer text aborts it, and a null answer keeps the shown order. Arrow up from the box walks the cards, Enter picks one; sending closes it. Esc, the close button, the scrim, a second Alt+A, or back closes it; Esc while a voice recording runs discards the recording and keeps the prompt open. Go to is a button in the tab order, so the keyboard reaches it. With no pick, the top target is fixed when Send is pressed, so a retry goes where the first try did.',
  code: ['web/src/SuggestModal.tsx#SuggestModal', 'web/src/SuggestModal.tsx#SuggestCard', 'web/src/SuggestModal.tsx#openSuggest', 'web/src/suggest-pick.ts#routeFor', 'web/src/suggest-pick.ts#sendOn', 'web/src/suggest-pick.ts#goTo', 'web/src/Composer.tsx#handoffDraft'],
  rules: [
    'The panel is a raised overlay like the search palette: `--overlay-panel-bg`, `--radius-lg`, `--shadow-raised`, over `--surface-scrim`, up to 720 px wide. Its bottom sits at 40vh, so the box stays put while cards come and go above it (' + ds('Menus, overlays, and inputs') + ').',
    'A card is `--size-row-menu` on a desktop; the selected or hovered card uses `--accent-subtle`, as does the pick chip.',
    'On a phone (760 px and below) it fills the screen above the navigation with no scrim or entry animation; the cards take the room and the box sits at the bottom, by the keyboard. Each card and the chip\'s x are `--size-hit-touch` (44 px), and pressing a card keeps the caret in the box, so the keyboard stays up.',
    'Go to is a text button with a chevron in `--accent-text`; on a phone it is at least `--size-hit-touch` square (' + ds('Menus, overlays, and inputs') + ').',
    'It enters with `menu-in` over `--duration-base` (' + ds('Motion') + ').',
  ],
  states: [
    { name: 'Empty', height: 360, overlay: '#suggest-modal', setup: open, render: () => <SuggestModal /> },
    { name: 'Suggestions', height: 420, overlay: '#suggest-modal', routes: { 'GET /api/suggest': RESULTS }, setup: open, render: () => <OnMount run={type('the fixture build fails ')}><SuggestModal /></OnMount> },
    { name: 'Picked', height: 360, overlay: '#suggest-modal', routes: { 'GET /api/suggest': RESULTS }, setup: open, render: () => <OnMount run={pick('agent:fx-dev')}><SuggestModal /></OnMount> },
    { name: 'No suggestions', height: 360, overlay: '#suggest-modal', routes: { 'GET /api/suggest': [] }, setup: open, render: () => <OnMount run={type('zzzz ')}><SuggestModal /></OnMount> },
  ],
}, {
  name: 'Bottom bar suggestions',
  group: 'Composer',
  what: "The bottom bar's prompt input when the main world has nothing to write to (Settings, Usage, Process, a requirement, nothing selected): it behaves as the Alt+A prompt, in place. As the human types, suggestion cards (agent, mail thread, ITSA) appear above the box, a pick sets the recipient as a chip, each card has Go to, and with no pick the message mails the default top target. It sends mail only, so there is no Direct/Mail toggle. Every mail carries a system note for its recipient, `The human was looking at: CONTEXT (may or may not be relevant).`, where CONTEXT is the one-line description of the main world (the placeholder the disabled box showed before).",
  when: 'A desktop or a phone whose main world is a pane `bottomTarget` reports as `none` (on a phone the bar shows only in this state, besides an agent or terminal). The box and its draft are the bottom bar\'s (key `suggest-bottom`); switching to an agent or thread brings back that target\'s own box and draft. Go to opens the item and moves the text there as a draft.',
  code: ['web/src/SuggestModal.tsx#SuggestBar', 'web/src/SuggestModal.tsx#useSuggest', 'web/src/composer-target.ts#bottomTarget', 'web/src/suggest-pick.ts#sendOn'],
  rules: [
    'The cards sit between the page and the box in the bottom world, capped at 40vh and scrolling; the box does not move as they come and go (' + ds('Menus, overlays, and inputs') + ').',
    'The same card, chip and Go to rules as the Alt+A prompt; on a phone the bar sits above the navigation like the other prompt boxes, and each card is a touch-size row.',
    'The context is plain text, one line, 200 characters at most on the server; the note is in the recipient\'s `read_mail`, after the body.',
  ],
  states: [
    { name: 'Settings, empty', height: 160, overlay: '#suggest-bar-story', render: () => <div id="suggest-bar-story"><SuggestBar composerRef={createRef<ComposerHandle>()} context="Settings" /></div> },
    { name: 'Settings, suggestions', height: 360, overlay: '#suggest-bar-story', routes: { 'GET /api/suggest': RESULTS }, render: () => <div id="suggest-bar-story"><OnMount run={type('the fixture build fails ')}><SuggestBar composerRef={createRef<ComposerHandle>()} context="Settings" /></OnMount></div> },
  ],
}]
