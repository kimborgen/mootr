import { TreeCheckSettings, type TreeCheck } from './TreeCheckSettings'
import { ds, type Story } from '../stories/types'

const show = (treeCheck: TreeCheck, o: { disabled?: boolean } = {}) => <TreeCheckSettings treeCheck={treeCheck} disabled={o.disabled} why="Shared by all machines; change it on fixture-home." set={() => {}} onEdit={() => {}} />

export const stories: Story[] = [{
  name: 'Tree check settings',
  group: 'Settings',
  what: 'Settings › Chief of staff: the periodic tree check. A checkbox turns it on, a number sets the hours between checks, and a button opens the checklist the notice carries. While on, the daemon keeps exactly one recurring notice for the chief of staff.',
  when: 'Settings, Chief of staff section. On a daemon that is not the settings home, the controls are disabled with the reason on hover.',
  code: ['web/src/views/TreeCheckSettings.tsx#TreeCheckSettings'],
  rules: [
    'Rows are the Settings rows: label and help on the left, control on the right; on a phone they stack and controls are `--size-hit-touch` tall (' + ds('Density') + ').',
    'On and off is a checkbox, never a switch (' + ds('Buttons') + ').',
    'The hours field saves when it is left or on Enter; an empty or invalid entry goes back to the saved value, and a number is clamped to 0.25-168 hours.',
    'Only design-system tokens; the page adds no colour, size or duration.',
  ],
  states: [
    { name: 'Off (default)', render: () => show({}) },
    { name: 'On every 4 hours', render: () => show({ enabled: true, everyHours: 4 }) },
    { name: 'On every 90 minutes', render: () => show({ enabled: true, everyHours: 1.5 }) },
    { name: 'Shared, read-only on a peer', render: () => show({ enabled: true, everyHours: 4 }, { disabled: true }) },
  ],
}]
