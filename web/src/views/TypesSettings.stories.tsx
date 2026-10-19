import { useState } from 'react'
import { TypesSettings } from './TypesSettings'
import { REGISTRY } from '../stories/settingsFixtures'
import { OnMount } from '../stories/helpers'
import { AGENTS } from '../stories/fixtures'
import { ds, type Story } from '../stories/types'

type Reg = typeof REGISTRY
function Host({ reg = REGISTRY, readOnly = false, open }: { reg?: Reg; readOnly?: boolean; open?: string }) {
  const [r] = useState(reg)
  return (
    <OnMount run={(el) => { if (open) el.querySelector<HTMLElement>(open)?.click() }}>
      <TypesSettings reg={r} agents={AGENTS.map((a) => ({ ...a, type: a.role === 'developer' ? 'developer' : undefined }))} onChanged={async () => {}} openInstructions={() => {}} readOnly={readOnly} why="Shared by all machines; change it on fixture-home." />
    </OnMount>
  )
}

export const stories: Story[] = [{
  name: 'Agent types settings',
  group: 'Settings',
  what: 'The saved roles a manager spawns by name, such as a developer or a reviewer. The list shows each type as a card with its harness mark, name, model and effort, a count of running agents, and its description; reviewer types are grouped first, with the default reviewer and any fallback marked. A card opens a form for the type\'s harness, model, effort, who it hears about, who it may mail, its review settings, and the brief its first task is written into. A reviewer can review as one agent or as a ring of other types.',
  when: 'Settings, Agent types (`agentTypes`); an old link to Settings, Reviewers opens it too. Saving writes the user\'s registry.json through `POST /api/types/NAME`; removing a shipped type hides it. Instructions for a type are edited under Settings, Instructions, where Edit instructions links.',
  code: ['web/src/views/TypesSettings.tsx#TypesSettings', 'web/src/views/type-form.ts#setReviewsAs', 'web/src/views/type-form.ts#typePayload'],
  rules: [
    'A type is a choice card (`.choice`): a `--border-default` outline with `--radius-sm`, the hover wash `--control-hover-bg`, and a chevron that says the card opens a form.',
    'The name takes lowercase letters, digits and dashes, up to 41 characters; a ring needs at least 2 members and a max of 1 round or more; a name already used is refused. Each refusal shows under the form in `--status-error-fg`.',
    'A ring type has no harness, model, or effort: choosing Ring hides them, and going back to One agent brings back the ones it had.',
    'The default reviewer can be changed only by making another type the default.',
    'Read-only (a peer without the home\'s page): the list and forms open to view, every control is disabled, and Add and Save are gone.',
    'Danger takes secondary geometry with danger ink (' + ds('Buttons') + '); Remove asks to confirm.',
  ],
  states: [
    { name: 'Types', render: () => <Host /> },
    { name: 'Edit a type', render: () => <Host open='[data-type="developer"]' /> },
    { name: 'Edit a reviewer', render: () => <Host open='[data-type="fixture-reviewer"]' /> },
    { name: 'Edit a ring', render: () => <Host open='[data-type="fixture-ring"]' /> },
    { name: 'New reviewer', render: () => <Host open="#add-reviewer" /> },
    { name: 'Read-only', render: () => <Host readOnly open='[data-type="developer"]' /> },
    { name: 'No other types', render: () => <Host reg={{ ...REGISTRY, types: {} } as unknown as Reg} /> },
  ],
}]
