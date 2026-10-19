import { Glyph, PlainGlyph, StateGlyph } from './Glyph'
import { STATES } from './legend'
import { AGENTS, agent, byName } from './stories/fixtures'
import { Row } from './stories/helpers'
import { ds, type Story } from './stories/types'

export const stories: Story[] = [{
  name: 'Agent mark',
  group: 'Primitives',
  what: "An agent's mark: its harness icon in the harness hue, inside a ring in its state's colour. A pip at the ring's corner gives the states that need telling apart a shape too: a dot for working, a hollow dot for waiting, ! for blocked, × for errored, bars for paused. Stopped agents fade to the disabled tone.",
  when: "Before every agent's name: the agent tree, tabs, menus that list agents, mail headers and @mentions in mail (as HTML through `glyphHtml`), and the legend. While stam's own view of the agent is open, its live word on the turn (running, asking) wins over the agent list.",
  code: ['web/src/Glyph.tsx#Glyph', 'web/src/Glyph.tsx#StateGlyph', 'web/src/Glyph.tsx#glyphHtml', 'web/src/Glyph.tsx#PlainGlyph', 'web/src/format.ts#STATE_COLOR'],
  rules: [
    "State owns the ring's colour (`--st-working`, `--st-idle`, `--st-blocked`, `--st-errored`, `--st-paused`, `--st-off`); the harness hue (`--h-claude`, `--h-codex`, `--h-opencode`) colours only the icon, so a colour never means two things. See " + ds('In stam') + '.',
    'Colour is never the only signal: the pip and the ring style (dashed while starting, dotted while waiting) carry the state too.',
    'The ring never spins or pulses: motion confirms causality and never performs (' + ds('Motion') + ').',
    'The mark is 20 px with the icon at `--icon-xs`; it sits in a row whose full height is the target, never a target itself.',
  ],
  states: [
    { name: 'Each harness, working', render: () => <Row items={['claude', 'codex', 'opencode'].map((h) => ({ label: h, node: <Glyph agent={agent({ id: 'h-' + h, name: 'fixture-' + h, harness: h, activity: 'working' })} /> }))} /> },
    { name: 'Every state', render: () => <Row items={STATES.map((s) => ({ label: s.label, node: <StateGlyph state={s.state} /> }))} /> },
    { name: 'Fixture agents', render: () => <Row items={AGENTS.map((a) => ({ label: a.name, node: <Glyph agent={a} /> }))} /> },
    { name: 'Stopped, and a plain mark', render: () => <Row items={[{ label: 'shut down', node: <Glyph agent={byName('fixture-retired')} /> }, { label: 'plain (the human, a shell)', node: <PlainGlyph name="user" /> }]} /> },
  ],
}]
