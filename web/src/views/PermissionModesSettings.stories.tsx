import { useState } from 'react'
import { PermissionModesSettings } from './PermissionModesSettings'
import { OnMount } from '../stories/helpers'
import { PERMISSION_MODES, STALE_AGENTS } from '../stories/settingsFixtures'
import { ds, reply, type Story } from '../stories/types'

type Setting = { harness: Record<string, string>; types: Record<string, string> }
const TYPES = { developer: { harness: 'claude' }, 'fixture-tester': { harness: 'opencode' }, 'fixture-review': { harness: 'codex' } }
const HARNESSES = ['claude', 'codex', 'opencode']
const DEFAULT: Setting = { harness: { claude: 'auto', codex: 'auto', opencode: 'auto' }, types: {} }
const BYPASS: Setting = { harness: { claude: 'bypass', codex: 'auto', opencode: 'auto' }, types: { 'fixture-tester': 'bypass' } }
const STALE = { ...PERMISSION_MODES, stale: STALE_AGENTS }

function Host({ start = DEFAULT, readOnly = false, run }: { start?: Setting; readOnly?: boolean; run?: (el: HTMLElement) => void }) {
  const [v, setV] = useState(start)
  return (
    <OnMount run={run ?? (() => {})}>
      <div style={{ maxWidth: 760, padding: 16 }}>
        <PermissionModesSettings value={v} types={TYPES} harnesses={HARNESSES} set={setV} rev={0} readOnly={readOnly} why="Shared by all machines; change it on fixture-home." />
      </div>
    </OnMount>
  )
}
// Presses Apply once the stale list has drawn.
const apply = (el: HTMLElement) => {
  const go = () => {
    const b = [...el.querySelectorAll<HTMLButtonElement>('.perm-stale .btn')].find((x) => x.textContent?.startsWith('Apply'))
    if (b) b.click(); else setTimeout(go, 30)
  }
  go()
}

export const stories: Story[] = [{
  name: 'Permission modes settings',
  group: 'Settings',
  what: 'Settings › Permission modes: the mode a new agent starts in. One select per harness sets the default, and one per agent type overrides it or follows the harness. Under them, the running agents that follow the settings but still run another mode are listed with their current and wanted mode, and Apply switches them. The result lists the agents switched and the ones skipped, with the reason.',
  when: 'Settings, Permission modes. The harness and type selects save at once like the rest of Settings (`PATCH /api/config/settings` with the `permissionModes` key); the list reads `GET /api/permission-modes` and refetches after each save. Apply calls `POST /api/permission-modes/apply`, which only the human can call.',
  code: ['web/src/views/PermissionModesSettings.tsx#PermissionModesSettings', 'web/src/permission-modes.ts#offeredModes', 'web/src/permission-modes.ts#followsSettings'],
  rules: [
    "A select offers only the modes its harness lists as `offered`: Ask is Claude Code only, because only its prompts reach stam's permission requests. A saved mode the harness does not offer stays in the list, disabled and marked (not offered), so the select never shows another value and it cannot be picked again.",
    'Choosing Bypass asks to confirm first; declining leaves the select and the saved setting as they were. While any harness or type is on Bypass, a warning note in `--status-warning-fg` on `--status-warning-bg` names which (' + ds('State vocabulary') + ').',
    "A stale row shows the agent, its harness, and `current → wanted` in the mono face. An OpenCode agent is marked as skipped by Apply, because it keeps its session's rules until its next new session; an agent whose last switch failed shows the reason and says Apply tries again.",
    'Apply is a primary button, disabled while it runs and when nothing is stale. Its result stays under the list: the agents switched, and those skipped with their reason.',
    'On a phone each setting row stacks its label over the select, and a stale row wraps its note under the agent (' + ds('Density') + ').',
    "Read-only (a peer without the home's page): the selects and Apply are disabled with the shared-settings title.",
  ],
  states: [
    { name: 'Defaults', routes: { 'GET /api/permission-modes': PERMISSION_MODES }, render: () => <Host /> },
    { name: 'Bypass on, agents to apply', routes: { 'GET /api/permission-modes': STALE }, render: () => <Host start={BYPASS} /> },
    { name: 'Applied', routes: { 'GET /api/permission-modes': STALE, 'POST /api/permission-modes/apply': { applied: [{ name: 'fixture-dev', mode: 'bypass', result: 'restarting after its step' }], skipped: [{ name: 'fixture-flash', reason: "opencode keeps a session's permission rules; it starts in bypass at its next new session" }, { name: 'fixture-review', reason: 'fixture: the launch failed' }], stale: STALE_AGENTS.slice(1) } }, render: () => <Host start={BYPASS} run={apply} /> },
    { name: 'Nothing to apply', routes: { 'GET /api/permission-modes': PERMISSION_MODES }, render: () => <Host start={BYPASS} /> },
    { name: 'Read-only', routes: { 'GET /api/permission-modes': STALE }, render: () => <Host start={BYPASS} readOnly /> },
    { name: 'Load fails', routes: { 'GET /api/permission-modes': reply(503, { error: 'fixture: unreachable' }) }, render: () => <Host /> },
  ],
}]
