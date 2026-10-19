import { ds, type Story } from '../stories/types'
import { MotionSettings } from './MotionSettings'

export const stories: Story[] = [{
  name: 'Motion settings',
  group: 'Settings',
  what: 'Settings › Motion: a master toggle for all animation and one toggle for each kind of motion in the sidebar, saved in the human\'s settings so they follow Kim across devices.',
  when: 'Settings, in the Motion section.',
  code: ['web/src/views/MotionSettings.tsx#MotionSettings', 'web/src/motion-gate.ts#MOTION_KINDS'],
  rules: [
    'Every toggle is on by default; the kind toggles are disabled while the master is off.',
    'Rows are touch height (`--size-hit-touch`) on a phone (' + ds('Density') + ').',
    'The system view page is exempt and ignores these toggles; the help text says so.',
  ],
  states: [
    { name: 'All on', render: () => <MotionSettings /> },
    { name: 'Master off', routes: { 'GET /api/config/settings': { text: JSON.stringify({ motion: { all: false } }) } }, render: () => <MotionSettings /> },
    { name: 'One kind off', routes: { 'GET /api/config/settings': { text: JSON.stringify({ motion: { spend: false } }) } }, render: () => <MotionSettings /> },
  ],
}]
