import { WorkColumnsSettings } from './WorkColumnsSettings'
import { settingsRoutes, pressEach } from '../stories/settingsFixtures'
import { itsaData, TREE } from '../stories/itsaFixtures'
import { OnMount } from '../stories/helpers'
import { ds, pending, reply, type Story } from '../stories/types'

const field = (id: string, key: string, label: string, type: string, o: object = {}) => ({ id, key, label, type, options: null, description: null, hint: null, width: 'm', align: 'start', card: 'meta', kinds: null, position: 0, ...o })
const STAGE = field('fx-f1', 'stage', 'Stage', 'choice', { position: 1, description: 'Where the work is.', options: [
  { value: 'plan', label: 'Plan', tone: 'muted' }, { value: 'build', label: 'Build', tone: 'accent' }, { value: 'ship', label: 'Ship', tone: 'ok' }, { value: 'stuck', label: 'Stuck', tone: 'bad' },
] })
const DUE = field('fx-f2', 'due', 'Due', 'date', { position: 2 })
const REVIEW = field('fx-f3', 'review-note', 'Review note', 'text', { position: 3, kinds: ['issue'] })
const FIELDS = [STAGE, DUE, REVIEW]
const routes = (fields: unknown = FIELDS) => ({ ...settingsRoutes(), 'GET /api/itsas/fields': fields })
// Clicks a control once it has drawn: the stories' opening press, for a state that starts on a form.
const clickWhenShown = (...labels: string[]) => (el: HTMLElement) => {
  const t = setInterval(() => {
    const b = [...el.querySelectorAll<HTMLElement>('button, [role=tab]')].find((x) => labels.includes(x.getAttribute('aria-label') ?? x.textContent ?? ''))
    if (!b) return
    clearInterval(t)
    b.click()
  }, 20)
}

export const stories: Story[] = [{
  name: 'Fields and cards settings',
  group: 'Settings',
  what: 'Settings › Fields and cards: a Fields tab and a Table tab. Fields lists every ITSA field an agent fills in, with the kinds it applies to and where it shows, Table and the issue card. Edit opens the field\'s form: its name, type, kinds, options with tones, what agents put here, hint, and width and alignment. Add field starts a new one. Remove drops the field and its values on every ITSA. The Table tab shows, hides and orders the Work page\'s columns, built in and custom, for the current view, and does not add or edit fields. The Issue card tab is the card\'s slot editor: on a desktop, a live preview and each slot\'s items; on a phone, a sticky preview over one list per slot, edited by touch. Either one resets to the default card.',
  when: 'Settings, Fields and cards (`#cfg=fields/fields`, `#cfg=fields/table`). The field definitions are written through the fields API only, which the daemon guards for the chief of staff; the Table tab writes the Work page\'s working layout (`workViews`) and a custom column\'s order.',
  code: ['web/src/views/WorkColumnsSettings.tsx#WorkColumnsSettings', 'web/src/views/WorkColumnsSettings.tsx#FieldEditor', 'web/src/views/work-columns.ts#payloadOf', 'web/src/views/work-columns.ts#columnRows'],
  rules: [
    'The tabs are a segmented control (`.seg`): on a phone it spans the width, each button `--size-hit-touch` tall. The active tab is `.on` (accent-subtle, primary text); tabs change colour, not weight (' + ds('Developer rules') + ').',
    'Each field row is one 44 px touch target on a phone (`--size-hit-touch`): the label with its type badge, the key, then two muted lines, "Applies to" and "Shown in". A row is a button; Edit is its pencil.',
    'Applies to is "All kinds" (no kinds stored) or the kinds picked, as a checkbox each; a kind typed in is added to the list. The daemon refuses a save it cannot store, and the refusal shows in `--status-error-fg` at the foot of the form.',
    'The Issue card tab is listed on a phone too, where it is the touch editor (IssueCardPhoneEditor): the tabs are the same on both.',
    'The form fits 360 px with no sideways scroll; its controls are `--size-hit-touch` tall on a phone (' + ds('Density') + ').',
  ],
  states: [
    { name: 'No fields', routes: routes([]), render: () => <WorkColumnsSettings cos="fixture-cos" /> },
    { name: 'One field', routes: routes([STAGE]), render: () => <WorkColumnsSettings cos="fixture-cos" /> },
    { name: 'Many fields', routes: routes(), data: itsaData(TREE), render: () => <WorkColumnsSettings cos="fixture-cos" /> },
    { name: 'Field limited to kinds', routes: routes([REVIEW]), data: itsaData(TREE), render: () => <WorkColumnsSettings cos="fixture-cos" /> },
    { name: 'Edit with the kinds picker', routes: routes(), data: itsaData(TREE), render: () => <OnMount run={clickWhenShown('Edit Review note')}><WorkColumnsSettings cos="fixture-cos" /></OnMount> },
    { name: 'Refused save', routes: { ...routes(), 'PATCH /api/itsas/fields/fx-f2': reply(400, { error: 'due (number): expected a number' }) }, data: itsaData(TREE),
      render: () => <OnMount run={(el) => { clickWhenShown('Edit Due')(el); const t = setInterval(() => { const s = el.querySelector<HTMLButtonElement>('.wcol-form button[type=submit]'); if (!s) return; clearInterval(t); s.click() }, 40) }}><WorkColumnsSettings cos="fixture-cos" /></OnMount> },
    { name: 'Table tab', routes: routes(), render: () => <OnMount run={clickWhenShown('Table')}><WorkColumnsSettings cos="fixture-cos" /></OnMount> },
    { name: 'Add a field', routes: routes(), render: () => <OnMount run={pressEach('Add field')}><WorkColumnsSettings cos="fixture-cos" /></OnMount> },
    { name: 'Issue card tab', routes: routes(), data: itsaData(TREE), render: () => <OnMount run={clickWhenShown('Issue card')}><WorkColumnsSettings cos="fixture-cos" /></OnMount> },
    { name: 'Loading', routes: { ...routes(), 'GET /api/itsas/fields': pending() }, render: () => <WorkColumnsSettings cos="fixture-cos" /> },
    { name: 'Failed to load', routes: { ...routes(), 'GET /api/itsas/fields': reply(503, { error: 'fixture: the daemon is unreachable' }) }, render: () => <WorkColumnsSettings cos={null} /> },
  ],
}]
