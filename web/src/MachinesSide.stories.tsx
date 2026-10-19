import { MachinesSide } from './MachinesSide'
import { OnMount, Side } from './stories/helpers'
import { ds, type Story } from './stories/types'
import { setUi } from './ui/state'
import type { Machine } from './types'

const GB = 1e9
const machine = (name: string, { cpuPct = 20, ramPct = 40, swapPct = 0, ...o }: Partial<Machine> & { cpuPct?: number; ramPct?: number; swapPct?: number } = {}): Machine => {
  const cpu = cpuPct, ram = ramPct, swap = swapPct
  return {
    name, online: true, ts: Date.parse('2026-10-01T09:00:00.000Z'),
    cpu: { pct: cpu, cores: [cpu, Math.min(100, cpu + 10), cpu - 5, Math.min(100, cpu + 3)], count: 4 },
    ram: { pct: ram, used: (16 * GB * ram) / 100, total: 16 * GB },
    swap: { pct: swap, used: (4 * GB * swap) / 100, total: swap ? 4 * GB : 0 },
    load: [1.2, 0.9, 0.7], ...o,
  }
}
const CALM = [machine('fixture-a'), machine('fixture-b', { cpuPct: 35, ramPct: 55 })]
const folded = (on: boolean) => () => setUi({ machinesFolded: on })
// Opens the first line's details the way the pointer (a desktop) or a tap (a phone) does.
const openFirst = (el: HTMLElement) => {
  const row = el.querySelector<HTMLElement>('.machine-row')!
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  row.click()
}

export const stories: Story[] = [{
  name: 'Machines',
  group: 'Tree and shell',
  what: 'The Machines section of the left sidebar, above its footer: one line per computer that runs a stam daemon, with three small meters for CPU, RAM, and swap from 0 to 100 percent and no numbers. The details (percentages, used and total GB, load average, each core) open from the line. The header folds the section and counts the offline machines.',
  when: 'The left sidebar, once the daemon has reported at least one machine; with none, the section does not draw. On a phone it sits in the Agents tab under the tree. Hovering a line (a desktop) or tapping it (a phone) opens the details; leaving the line or the details closes them.',
  code: ['web/src/MachinesSide.tsx#MachinesSide'],
  rules: [
    'A line is `--size-row-tree` high, and `--size-hit-touch` on a phone (760 px and below); the fold header gets the same minimum on a phone (' + ds('Density') + ').',
    'A meter is a 26 × 6 px track in `--status-neutral-bg`. Its fill is `--status-neutral-fg`, `--status-warning-fg` from 80%, and `--status-error-fg` from 95%. Colour is never the only signal: each meter carries its letter (C, R, S) and an accessible label with the percentage.',
    'An offline machine shows its name in `--text-muted` and the word offline in place of the meters; its details say its daemon may be stopped.',
    'On a desktop the details are a popover that opens to the right of the line, clear of the sidebar, so it never sits under the pointer; on a phone a tap opens them as a sheet (' + ds('Menus, overlays, and inputs') + ').',
    'The fold state is kept per browser. Meters have no animation (' + ds('Motion') + ').',
  ],
  states: [
    { name: 'Calm', data: { machines: CALM }, setup: folded(false), render: () => <Side><MachinesSide /></Side> },
    { name: 'In a sidebar pane, never folded', data: { machines: CALM }, setup: folded(true), render: () => <Side><MachinesSide pane /></Side> },
    { name: 'Busy, warning and error levels', data: { machines: [machine('fixture-a', { cpuPct: 85, ramPct: 82, swapPct: 10 }), machine('fixture-b', { cpuPct: 97, ramPct: 96, swapPct: 97 })] }, setup: folded(false), render: () => <Side><MachinesSide /></Side> },
    { name: 'One machine offline', data: { machines: [CALM[0], machine('fixture-b', { online: false })] }, setup: folded(false), render: () => <Side><MachinesSide /></Side> },
    { name: 'Folded, one offline', data: { machines: [CALM[0], machine('fixture-b', { online: false })] }, setup: folded(true), render: () => <Side><MachinesSide /></Side> },
    { name: 'Details open', height: 360, overlay: '.machines-pop', data: { machines: [machine('fixture-a', { cpuPct: 85, ramPct: 82, swapPct: 10 }), CALM[1]] }, setup: folded(false), render: () => <OnMount run={openFirst}><Side><MachinesSide /></Side></OnMount> },
    { name: 'No machines', data: { machines: [] }, setup: folded(false), render: () => <><Side><MachinesSide /></Side><p className="muted">The section draws nothing.</p></> },
  ],
}]
