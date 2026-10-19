import { Icon, ICON_NAMES } from './Icon'
import { Row } from './stories/helpers'
import { ds, type Story } from './stories/types'

export const stories: Story[] = [{
  name: 'Icon',
  group: 'Primitives',
  what: "Every icon in the UI: Lucide, an absolute 1.5 px stroke at two named sizes, plus stam's own marks (the harnesses, and `stam`, a ring round the bot for stam's own tools, S-1934) drawn on Lucide's grid in the same stroke. One component, so no call site can drift.",
  when: 'Wherever chrome shows an icon: tree rows, tabs, menu items, icon buttons, badges. A name Icon doesn\'t know draws the bot mark.',
  code: ['web/src/Icon.tsx#Icon', 'web/src/icons.ts#ICONS'],
  rules: [
    'Two sizes only: `sm` (16 px, `--icon-sm`) by default and `xs` (14 px, `--icon-xs`) beside 11-12 px text; 18, 22, and 24 px are banned (' + ds('Icons') + ').',
    'A tool call\'s icon is chosen by `src/tool-icons.ts`: `terminal`, `file-text`, `pencil`, `search`, `globe`, `users`, `plug`, `stam`, or `wrench` for an unknown tool.',
    'The stroke is `--icon-stroke`, absolute at every size, so icons match the chrome face\'s stem weight.',
    'Icons inherit `currentColor`; an icon coloured apart from its label is a bug.',
    'Icons centre in the row\'s line box with the 6 px gap (`--space-15`), never on the text baseline.',
  ],
  states: [
    { name: 'Every name at sm', render: () => <Row items={ICON_NAMES.map((n) => ({ label: n, node: <Icon name={n} /> }))} /> },
    { name: 'Harness marks at both sizes', render: () => <Row items={['claude', 'codex', 'opencode'].flatMap((n) => [{ label: n + ' sm', node: <Icon name={n} /> }, { label: n + ' xs', node: <Icon name={n} size="xs" /> }])} /> },
    { name: 'Zoom pair (System view buttons)', render: () => <Row items={['minus', 'plus'].map((n) => ({ label: n, node: <Icon name={n} /> }))} /> },
    { name: 'Unknown name', render: () => <Row items={[{ label: 'no-such-icon', node: <Icon name="no-such-icon" /> }]} /> },
  ],
}]
