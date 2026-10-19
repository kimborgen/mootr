import { ToolsSettings } from './ToolsSettings'
import { OnMount } from '../stories/helpers'
import { ds, pending, reply, type Story } from '../stories/types'

const CATALOG = {
  groups: [
    { name: 'Mail', tools: [
      { name: 'send_mail', description: 'Send a message to one or more agents.', inputSchema: { type: 'object', properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipients: an id, a name, or all.' },
        body: { type: 'string', description: 'The message text.' },
        reply_to: { type: 'string', description: 'The mail this answers, so the reply joins its thread.' },
      }, required: ['to', 'body'] } },
      { name: 'read_mail', description: 'Read one message by id.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The mail id.' } }, required: ['id'] } },
    ] },
    { name: 'Agents', tools: [
      { name: 'whoami', description: 'Your own registry entry.', inputSchema: { type: 'object', properties: {} } },
      { name: 'spawn_agent', description: 'Start a new agent.', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['developer', 'reviewer'], description: 'The saved role to start.' }, task: { type: 'string' } }, required: ['task'] } },
    ] },
  ],
  harnessTools: { note: 'Each harness also brings its own tools (files, shell, search). stam does not list or change those.' },
}

export const stories: Story[] = [{
  name: 'Tools settings',
  group: 'Settings',
  what: 'A read-only catalogue of every MCP tool stam offers its agents, grouped. Each tool is a fold that shows its name and a one-line description and opens to its arguments (name, type, and a "required" mark) and an Add a step button that opens the new decision step form with that tool as its trigger.',
  when: 'Settings, Tools. It loads `GET /api/tools` when it opens. Add a step takes you to Settings, Decision steps, with the form open.',
  code: ['web/src/views/ToolsSettings.tsx#ToolsSettings'],
  rules: [
    'A tool row is `--size-row-menu` tall at least; its name is mono (`--font-mono`, `--type-chrome-sm`) and its description `--text-muted`, indented under the name.',
    'A fold opens to its arguments: each has its name and type in mono, a "required" mark in uppercase `--text-muted`, and its description, with `--border-subtle` rules between them.',
    'On a phone Add a step is `--size-hit-touch` tall (' + ds('Density') + ').',
    'Read-only: nothing here changes a setting, so it has no saved or error state of its own; a failed load shows the error text alone.',
  ],
  states: [
    { name: 'Catalogue', routes: { 'GET /api/tools': CATALOG }, render: () => <OnMount run={(el) => el.querySelector('details')?.setAttribute('open', '')}><ToolsSettings onAddStep={() => {}} /></OnMount> },
    { name: 'Loading', routes: { 'GET /api/tools': pending() }, render: () => <ToolsSettings /> },
    { name: 'Failed to load', routes: { 'GET /api/tools': reply(503, { error: 'fixture: the daemon is unreachable' }) }, render: () => <ToolsSettings /> },
  ],
}]
