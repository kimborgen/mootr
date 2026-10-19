import { ViewBoundary } from './ViewBoundary'
import { ds, type Story } from '../stories/types'

const Boom = (): never => { throw new TypeError("Cannot set properties of undefined (setting 'path')") }

export const stories: Story[] = [{
  name: 'View error',
  group: 'Primitives',
  what: "A view that throws while it renders: its pane shows what failed and a Retry, and the rest of the app (the sidebar, other panes and tabs) keeps working.",
  when: 'Every view a tab or pane shows sits in one (ViewPortals in registry.tsx). Inside a view, a mail component that throws on odd content already falls back to a plain code block, so this is the last line, not the usual one (S-2084).',
  code: ['web/src/views/ViewBoundary.tsx#ViewBoundary', 'web/src/views/registry.tsx#ViewHost', 'web/src/views/registry.tsx#ViewPortals'],
  rules: [
    'The error stack is the empty-state one with one retry action, and the body states the failure factually (' + ds('Empty, loading, and error') + ').',
    'Retry renders the view again; nothing else resets it.',
    "The view's element belongs to ViewHost, outside the boundary, so a view that throws after it mounted shows its error in the same pane, not nowhere.",
  ],
  states: [
    { name: 'A view that threw', render: () => <div style={{ height: 320 }}><ViewBoundary viewKey="itsa:story"><Boom /></ViewBoundary></div> },
  ],
}]
