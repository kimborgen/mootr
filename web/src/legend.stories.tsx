import { showLegend } from './legend'
import { Icon } from './Icon'
import { OnMount } from './stories/helpers'
import { ds, type Story } from './stories/types'

const open = (el: HTMLElement) => showLegend(el.querySelector('button')!)

export const stories: Story[] = [{
  name: 'Agent states legend',
  group: 'Primitives',
  what: "What the agent tree's marks mean: each state's mark with one plain line, then the row's badges. Agent tooltips name the state with the same line (`stateHelp`).",
  when: 'The ? in the Agents header opens it as a popover; on a phone, a sheet at the bottom.',
  code: ['web/src/legend.tsx#showLegend', 'web/src/legend.tsx#STATES', 'web/src/legend.tsx#stateHelp', 'web/src/ui/menu.tsx#showPopover'],
  rules: [
    'A popover is the menu surface (`--menu-bg`, `--radius-md`, `--shadow-float`) holding content instead of items (' + ds('Modals and menus') + ').',
    'It enters at `--duration-base` and exits at 0 ms; Escape or the ✕ closes it and returns focus to the ?.',
    'Each state keeps its own channel: colour and shape on the mark, the label in words.',
  ],
  states: [
    { name: 'Open', height: 640, render: () => <OnMount run={open}><button className="icon-btn" aria-label="What the marks mean"><Icon name="circle-help" /></button></OnMount> },
  ],
}]
