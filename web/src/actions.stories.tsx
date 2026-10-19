import { AssistantLabel, agentMenu } from './actions'
import { AGENTS, agent, byName } from './stories/fixtures'
import { OnMount } from './stories/helpers'
import { showMenu } from './ui/menu'
import { ds, type Story } from './stories/types'

const open = (name: string) => () => showMenu(12, 12, agentMenu(byName(name)))

export const stories: Story[] = [{
  name: 'Agent menu',
  group: 'Tree and shell',
  what: "The menu of one agent: open its world, show it beside the current one, a terminal in its folder, the tree view, its conversation or terminal, details, instructions and inbox, then add a child, pause, restart, compact, reconnect MCP, switch permission mode, shut down, archive and stop now. An agent that is not running gets Resume and Forget instead.",
  when: "A right-click on an agent's row in the tree, a long press on a phone, or its **more** button (`web/src/Tree.tsx`), and the agent's pane header menu (`web/src/App.tsx`). The items are built from the agent's lifecycle and view, so they differ per agent.",
  code: ['web/src/actions.tsx#agentMenu', 'web/src/actions.tsx#treeItem', 'web/src/actions.tsx#agentAction'],
  rules: [
    'A menu row is `--size-row-menu`; on a phone `--size-hit-touch` (' + ds('Density') + ').',
    'Stop now and Forget use the `danger` tone, and Stop now, Forget and Archive ask with a confirm before acting; Shut down acts at once.',
    'Items that do not apply are left out, not disabled, so the list never shows a dead option.',
    "The permission item switches the agent between Auto and Bypass as the human's own pick, which then stays over Settings › Permission modes (the other choices, Ask and Follow settings, are in the agent's details). It asks to confirm, and says Bypass runs every action without asking.",
  ],
  states: [
    { name: 'A running agent', height: 460, render: () => <OnMount run={open('fixture-dev')} /> },
    { name: 'A paused agent', height: 460, render: () => <OnMount run={open('fixture-paused')} /> },
    { name: 'A stopped agent', height: 300, render: () => <OnMount run={open('fixture-retired')} /> },
  ],
}, {
  name: 'Assistant label',
  group: 'Composer',
  what: "The target label shown in the prompt input while the box writes to the executive assistant: its mark, the word Assistant, and what the human is looking at, so \"this\" in a message has a meaning (`viewContext`). With no assistant running yet, a plain bot mark stands in.",
  when: 'After the human picks Assistant in the stam icon\'s recipient menu in the prompt input, in the bottom bar and the top world (`web/src/actions.tsx#assistantOpts`). `assistantOpts.to` makes the agent choices of that menu (parent, intake, cos), which write by mail.',
  code: ['web/src/actions.tsx#AssistantLabel', 'web/src/actions.tsx#viewContext', 'web/src/actions.tsx#assistantOpts'],
  rules: [
    'The agent mark keeps its state colour; the context text is `muted` so the label stays one quiet line (' + ds('In stam') + ').',
    'It truncates, never wraps, in the bar.',
    'The context line names the page world the human is looking at (Settings, Usage, or the process view), so "this" in a message has a meaning.',
  ],
  states: [
    { name: 'Assistant running', data: { agents: [...AGENTS, agent({ id: 'fx-asst', name: 'fixture-assistant', kind: 'assistant', activity: 'idle' })] }, render: () => <div className="story-pad"><AssistantLabel /></div> },
    { name: 'No assistant yet', render: () => <div className="story-pad"><AssistantLabel /></div> },
  ],
}]
