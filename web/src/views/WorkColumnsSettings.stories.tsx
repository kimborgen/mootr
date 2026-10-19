import { WorkColumnsSettings } from './WorkColumnsSettings'
import { settingsRoutes, pressEach } from '../stories/settingsFixtures'
import { OnMount } from '../stories/helpers'
import { ds, pending, reply, type Story } from '../stories/types'

const field = (id: string, key: string, label: string, type: string, o: object = {}) => ({ id, key, label, type, options: null, description: null, hint: null, width: 'm', align: 'start', card: 'chip', position: 0, ...o })
const FIELDS = [
  field('fx-f1', 'stage', 'Stage', 'choice', { position: 1, description: 'Where the work is.', options: [
    { value: 'plan', label: 'Plan', tone: 'muted' }, { value: 'build', label: 'Build', tone: 'accent' }, { value: 'ship', label: 'Ship', tone: 'ok' }, { value: 'stuck', label: 'Stuck', tone: 'bad' },
  ] }),
  field('fx-f2', 'due', 'Due', 'date', { position: 2 }),
]
const routes = (fields: unknown = FIELDS) => ({ ...settingsRoutes(), 'GET /api/itsas/fields': fields })

export const stories: Story[] = [{
  name: 'Work columns settings',
  group: 'Settings',
  what: 'Every column of the Work page in one list, built in and custom, in the order the page shows them. Each row shows or hides its column and moves it: drag on a desktop, up and down arrows by touch or keyboard. Locked columns stay in place. A custom column is an ITSA field every agent fills in; Add column and Edit open a form for its label, type (text, number, choice, link, date, check), options with tones, hint, and key. Remove drops the field and its values from every ITSA.',
  when: 'Settings, Work columns (`workViews`). Show, hide, and order write the Work page\'s working layout in settings; a custom column\'s move also writes the fields\' order. Only you and the chief of staff can add or remove columns; other agents ask the chief of staff.',
  code: ['web/src/views/WorkColumnsSettings.tsx#WorkColumnsSettings', 'web/src/views/work-columns.ts#columnRows', 'web/src/views/work-columns.ts#dropOn'],
  rules: [
    'A row has a show box, a grip (hidden at 760 px or narrower), the label with a Custom badge or a Hidden badge, and the arrows and Edit; a hidden row dims to `--text-muted` and has disabled move arrows until it is shown.',
    'While a row is dragged the source dims to 50% and a `--drop-border` line shows above or below the row it will land on (' + ds('State vocabulary') + ').',
    'After an arrow moves a row, focus stays on that arrow; when the move reached an end and disabled it, the other arrow takes focus, so the keyboard never drops to the page.',
    'On a phone the show box and the icon buttons are `--size-hit-touch` square and the form\'s buttons are at least that tall (' + ds('Density') + ').',
    'A failed load keeps the list it has and shows the reason in `--status-error-fg` with Retry. A tone colours an option\'s chip with the status tokens only; no new colour.',
  ],
  states: [
    { name: 'Built-in columns only', routes: routes([]), render: () => <WorkColumnsSettings cos="fixture-cos" /> },
    { name: 'With custom columns', routes: routes(), render: () => <WorkColumnsSettings cos="fixture-cos" /> },
    { name: 'Edit a column', routes: routes(), render: () => <OnMount run={(el) => { const t = setInterval(() => { const b = el.querySelector<HTMLElement>('[data-col="field:fx-f1"] .wcol-edit'); if (b) { clearInterval(t); b.click() } }, 20) }}><WorkColumnsSettings cos="fixture-cos" /></OnMount> },
    { name: 'Add a column', routes: routes(), render: () => <OnMount run={pressEach('Add column')}><WorkColumnsSettings cos="fixture-cos" /></OnMount> },
    { name: 'Loading', routes: { ...routes(), 'GET /api/itsas/fields': pending() }, render: () => <WorkColumnsSettings cos="fixture-cos" /> },
    { name: 'Failed to load', routes: { ...routes(), 'GET /api/itsas/fields': reply(503, { error: 'fixture: the daemon is unreachable' }) }, render: () => <WorkColumnsSettings cos={null} /> },
  ],
}]
