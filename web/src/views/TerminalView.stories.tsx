import { ds, type Story } from '../stories/types'

// There is no daemon here, so no terminal can connect: a placeholder in the terminal's own
// frame (`.term-view`, `--term-bg`) shows where it sits and its status line.
const Frame = ({ status, lines }: { status: string; lines: string[] }) => (
  <div className="pane" style={{ height: 240 }}>
    <div className="pane-body"><div className="term-view">
      <pre style={{ margin: 0, color: 'var(--term-fg)', fontFamily: 'var(--font-mono)', fontSize: 'var(--type-chrome-md)' }}>{lines.join('\n')}</pre>
      <span className="term-status">{status}</span>
    </div></div>
  </div>
)

export const stories: Story[] = [{
  name: 'Terminal view',
  group: 'Tree and shell',
  what: "An agent's terminal, or a plain shell, as a tab. It mounts one terminal session and keeps it in step with the agent: it connects while the agent runs and reconnects after a restart. All viewers of an agent share one size; the one you type in claims it. A plain terminal's tab asks before it closes, because closing ends its shell. This page shows a placeholder frame, since no terminal can connect without a daemon.",
  when: "An agent's `agent:ID` tab (for an agent whose harness has no conversation view, or when the switch in its pane chooses the terminal), or a plain terminal's `shell:MACHINE:ID` tab (menu: New terminal). On a phone the strip adds a keyboard button, and the bottom bar swaps for a row of the keys a phone keyboard lacks while the terminal has the keyboard.",
  code: ['web/src/views/TerminalView.tsx#TerminalView'],
  rules: [
    'The terminal fills its pane on `--term-bg`, with text in `--term-fg`; its 16 ANSI colours come from the `--ansi-0` to `--ansi-15` tokens, not from xterm\'s defaults, and it re-themes when the theme changes.',
    'The status line sits at the bottom right in `--term-muted` at `--type-chrome-xs` and does not take pointer events. It is empty while the agent runs, and otherwise says why: the agent is not running ("Resume it from its menu."), the agent is gone, or the terminal ended.',
    'Closing a plain terminal asks first: "Close this terminal? Its shell ends." An agent\'s tab closes without asking, since its session lives on.',
    'A new view shows once it is in its pane, and a pane that is being resized settles for 100 ms before the terminal claims the new size, so the program redraws once (' + ds('Motion') + ').',
  ],
  states: [
    { name: 'Agent terminal (placeholder)', render: () => <Frame status="" lines={['$ claude', '', '  fixture-dev is working', '  > Reading web/src/Tree.tsx']} /> },
    { name: 'Plain shell (placeholder)', render: () => <Frame status="" lines={['$ ls', 'docs  src  web', '$ █']} /> },
    { name: 'Agent not running (placeholder)', render: () => <Frame status="fixture-retired is shut down. Resume it from its menu." lines={[]} /> },
    { name: 'Ended shell (placeholder)', render: () => <Frame status="This terminal ended." lines={['$ exit']} /> },
  ],
}]
