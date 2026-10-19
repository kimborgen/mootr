import { InventoryBody, InventoryView, TypeInventoryView } from './InventoryView'
import { block, composed, large, layer, small } from './inventory-fixture'
import { ds, pending, reply, type Story } from '../stories/types'

const failed = { ...small, layers: [layer('system-prompt', 'System prompt', 'stam-generated', [block('system-prompt', 'Working with others', { summaryState: 'failed', summary: undefined }), block('system-prompt', 'Mail to your user', { summaryState: 'failed', summary: undefined })])] }
const reg = { harnesses: { claude: {}, codex: {}, opencode: {} }, types: { developer: { harness: 'claude' }, reviewer: { harness: 'codex' } } }

export const stories: Story[] = [{
  name: 'Inventory',
  group: 'Settings',
  what: 'Everything one agent, or an agent type on a harness, receives before its first turn, as layers of blocks. The header gives the estimated total and a bar per layer, with the MCP tool schemas (the biggest layer) in the warning tone. Flags list what stam can prove: a file given twice, an empty layer, skills a harness cannot load. Each block is a card: title and size, a two-line summary, chips for where it sits, and the full text on tap.',
  when: 'An agent\'s Inventory tab (its menu, or the pane menu), and Settings › Instructions › Inventory by type, which adds a type and a harness picker. Read-only.',
  code: ['web/src/views/InventoryView.tsx#InventoryView', 'web/src/views/InventoryView.tsx#TypeInventoryView', 'web/src/views/InventoryView.tsx#InventoryBody'],
  rules: [
    'Block cards are `surface-raised` with a hairline and no shadow; the size is a neutral badge (' + ds('Buttons') + ').',
    'A summary is `text-secondary` and clamps to two lines. A model\'s summary carries a muted "auto" chip; a pending, failed, or off summary says so in words, never by colour alone. After about two minutes of waiting the view stops asking, the summaries read "not ready yet", and a Refresh button above the total asks again.',
    'A block its type switched off, or replaced, is struck through with a chip "Switched off by TYPE" or "Replaced by TYPE"; the block in its place carries "Replaces global (TYPE)". Word and glyph, never colour alone. These entries add no tokens: the layer total counts what the agent is sent.',
    'Rows are `--size-row-menu`, and `--size-hit-touch` on a phone (' + ds('Density') + '). Nothing animates; the view asks again every few seconds while a summary is pending.',
    'Only design-system tokens; the view adds no colour, size or duration.',
  ],
  states: [
    { name: 'Agent, few blocks', routes: { 'GET /api/agents/fx-dev/inventory': small }, render: () => <InventoryView id="fx-dev" /> },
    { name: 'Agent, realistic scale', routes: { 'GET /api/agents/fx-dev/inventory': large }, render: () => <InventoryView id="fx-dev" /> },
    { name: 'Summary failed', routes: { 'GET /api/agents/fx-dev/inventory': failed }, render: () => <InventoryView id="fx-dev" /> },
    { name: 'Summaries not ready', render: () => <InventoryBody inv={{ ...small, layers: failed.layers.map((l) => ({ ...l, blocks: l.blocks.map((b) => ({ ...b, summaryState: 'pending' as const })) })) }} gaveUp onRefresh={() => {}} /> },
    { name: 'Type composition', routes: { 'GET /api/agents/fx-dev/inventory': composed }, render: () => <InventoryView id="fx-dev" /> },
    { name: 'Loading', routes: { 'GET /api/agents/fx-dev/inventory': pending() }, render: () => <InventoryView id="fx-dev" /> },
    { name: 'Error', routes: { 'GET /api/agents/fx-dev/inventory': reply(503, { error: 'fixture: unreachable' }) }, render: () => <InventoryView id="fx-dev" /> },
    { name: 'Type and harness pickers', routes: { 'GET /api/registry': reg, 'GET /api/types/developer/inventory': small }, render: () => <TypeInventoryView /> },
    { name: 'Body only', render: () => <InventoryBody inv={small} /> },
  ],
}]
