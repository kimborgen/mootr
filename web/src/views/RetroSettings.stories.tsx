import type { Itsa } from '../types'
import { RetroSettings, type Retro } from './RetroSettings'
import { ds, type Story } from '../stories/types'

const T = '2026-10-01T09:00:00.000Z'
const page: Itsa = { id: 'fx-retros', key: 'S-1', parent_id: null, kind: 'retros', title: 'Retros', summary: null, body: null, status: 'in_progress', owner: null, thread_id: null, created_by: 'fixture-cos', created_at: T, updated_at: T, closed_at: null }
const base: Retro = {
  digest: { enabled: true, day: 'daily', hour: 9 },
  lastDigest: new Date(Date.now() - 20 * 3600000).toISOString(),
  steward: { enabled: true },
  reminders: { enabled: true },
  epic: { minReporters: 3, maxWindowShare: 50 },
}
const show = (retro: Retro, o: { disabled?: boolean } = {}) => <RetroSettings retro={retro} lastDigest={retro.lastDigest} disabled={o.disabled} why="Shared by all machines; change it on fixture-home." set={() => {}} />

export const stories: Story[] = [{
  name: 'Retros settings',
  group: 'Settings',
  what: 'Settings › Retros: the self-retro loop. The digest (on or off, day, hour; mailed to the owner of the Retros ITSA, or the chief of staff), the retro steward, the reminders agents get, the epic retro offer, and a link to the Retros page. Each control saves its own sub-key through the settings deep-path setter, so a change to one keeps the others even while an earlier save is still in flight.',
  when: 'Settings, Retros section. On a daemon that is not the settings home, the shared controls are disabled with the reason on hover; Last digest is always this machine\'s own.',
  code: ['web/src/views/RetroSettings.tsx#RetroSettings'],
  rules: [
    'Rows are the Settings rows: label and help on the left, control on the right; on a phone they stack and controls are `--size-hit-touch` tall (' + ds('Density') + ').',
    'On/off settings are checkboxes, never switches (' + ds('Buttons') + '). Day and hour are selects, so a phone opens its own picker.',
    'Number fields save when the field is left or on Enter, clamped to their range.',
    'Only design-system tokens; the page adds no colour, size or duration.',
  ],
  states: [
    { name: 'Defaults', data: { itsas: [page] }, render: () => show(base) },
    { name: 'Weekly, steward and reminders off', data: { itsas: [page] }, render: () => show({ ...base, digest: { enabled: true, day: 'fri', hour: 17 }, steward: { enabled: false }, reminders: { enabled: false }, lastDigest: null }) },
    { name: 'Digest off', data: { itsas: [page] }, render: () => show({ ...base, digest: { ...base.digest, enabled: false } }) },
    { name: 'Shared, read-only on a peer', data: { itsas: [page] }, render: () => show(base, { disabled: true }) },
    { name: 'No Retros page yet', data: { itsas: [] }, render: () => show(base) },
  ],
}]
